import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronRight,
  CircleHelp,
  ListTodo,
  Loader2,
  MessageSquare,
  Pencil,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { wsUrl } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/providers/auth";
import { TerminalComposer } from "@/features/board/components/TerminalComposer";
import { LinkifiedText, Markdown, SenderTag } from "@/features/board/components/ChatView";
import { originRole } from "@/features/board/lib/chat";
import { reconnectDelay, type ConnectionState } from "@/features/board/lib/reconnect";
import { JumpToLatest, useStickToBottom } from "@/features/board/components/JumpToLatest";
import { pendingDecisions, splitProseQuestion, type PendingDecision } from "@/features/board/lib/pendingDecisions";
import {
  INITIAL_SDK_STATE,
  TERMINAL_ACTIVITY_NOTE,
  answerQuestion,
  applySdkEvent,
  appendUserRow,
  decidePermission,
  groupSdkRows,
  markUserEdited,
  parseSdkFrame,
  type SdkChatState,
  type SdkQuestionAnswer,
  type SdkRow,
} from "@/features/board/lib/sdkChat";
import { t as translate, useT } from "@/i18n";

/**
 * NATIVE CHAT (beta) — the card's conversation over the Agent SDK driver, not the tmux transcript.
 *
 * The difference is the wire: `/api/cards/:id/sdk` speaks STRUCTURED events (text deltas, tool
 * calls, permission requests, the turn's result), so this view needs no optimistic bubbles, no
 * transcript parsing and no "the terminal might be on a menu" caveats. A message is drawn when the
 * socket ACCEPTS it (its real state), a sensitive action becomes a Permitir/Negar card right here,
 * and the session id in the footer is the resume key the card persists — reopening the card
 * continues this very conversation.
 *
 * Rendered INSTEAD of ChatView when the card opted in (`card.sdkChat`) — the global `sdkDriver`
 * setting still gates the socket server-side, and with it off the driver refuses and this view
 * says so instead of pretending.
 */

/** How long an edit waits for the interrupted turn's result before going anyway (safety net). */
export const EDIT_INTERRUPT_GRACE_MS = 15_000;

export interface SdkChatViewProps {
  cardId: string;
  /** Is this card the one on screen? (see ChatView — the composer must not steal the keyboard) */
  active?: boolean;
  /** Uploads an image and resolves with its path inside the runner (appended to the message). */
  onUploadImage?: (file: File) => Promise<string | null>;
  onStatus?: (state: ConnectionState) => void;
  ariaLabel?: string;
  className?: string;
}

export function SdkChatView({ cardId, active = true, onUploadImage, onStatus, ariaLabel, className }: SdkChatViewProps) {
  const t = useT();
  // Whose screen this is — the edit affordance belongs only to one's own messages.
  const viewer = useAuth().user?.username;
  const [state, setState] = React.useState<SdkChatState>(INITIAL_SDK_STATE);
  const socketRef = React.useRef<WebSocket | null>(null);
  const statusRef = React.useRef<SdkChatViewProps["onStatus"]>(onStatus);
  statusRef.current = onStatus;
  const [connected, setConnected] = React.useState(false);

  /* ------------------------------------------------------------- websocket */

  React.useEffect(() => {
    setState(INITIAL_SDK_STATE);
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;
    const setStatus = (s: ConnectionState): void => statusRef.current?.(s);

    const connect = (): void => {
      if (disposed || socket || typeof WebSocket === "undefined") return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      let next: WebSocket;
      try {
        next = new WebSocket(wsUrl(`/api/cards/${encodeURIComponent(cardId)}/sdk`));
      } catch {
        scheduleRetry();
        return;
      }
      socket = next;
      socketRef.current = next;
      next.onopen = () => {
        attempt = 0;
        setStatus("open");
        setConnected(true);
        // EVERY connect replays the card's history from the server log (see back/services/sdk/
        // history.ts), so the slate is wiped here — otherwise a reconnect would draw the whole
        // conversation twice. What was on screen comes right back, from disk instead of memory.
        setState(INITIAL_SDK_STATE);
      };
      next.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const parsed = parseSdkFrame(event.data);
        if (!parsed) return;
        setState((prev) => applySdkEvent(prev, parsed));
      };
      next.onerror = () => {
        /* onclose always follows */
      };
      next.onclose = () => {
        if (socket === next) socket = null;
        if (socketRef.current === next) socketRef.current = null;
        setConnected(false);
        if (disposed) return;
        scheduleRetry();
      };
    };

    const scheduleRetry = (): void => {
      if (disposed || retry) return;
      setStatus("reconnecting");
      const delay = reconnectDelay(attempt, Math.random);
      attempt += 1;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      try { socket?.close(); } catch { /* already closing */ }
      socketRef.current = null;
      setStatus("closed");
    };
  }, [cardId]);

  /* ------------------------------------------------------------- sending */

  /** Push one control frame. Throws when the socket is not open — the composer keeps the draft. */
  const sendFrame = React.useCallback((frame: object): void => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(translate("sdk.offline"));
    }
    socket.send(JSON.stringify(frame));
  }, []);

  /* -------------------------------------------------------------- editing */

  /** The message being edited (a SUPERSEDE — the model read the original; see docs/sdk-driver.md). */
  const [editing, setEditing] = React.useState<{ rowId: string; original: string } | null>(null);
  /** An edit waiting for the interrupted turn to END (its result/aborted) before it goes. */
  const [pendingEdit, setPendingEdit] = React.useState<{ original: string; text: string } | null>(null);

  /** Push the edit frame. Returns whether the socket took it (a refusal is toasted, not thrown). */
  const dispatchEditFrame = React.useCallback(
    (original: string, text: string): boolean => {
      try {
        sendFrame({ type: "edit_user", original, text });
        return true;
      } catch (err) {
        toast.error((err as Error).message);
        return false;
      }
    },
    [sendFrame],
  );

  // The deferred half of "interrupt first": the edit goes the moment the interrupted turn reports
  // its result (turnActive falls). The timeout is the safety net — a turn that never closes must
  // not hold the correction hostage forever (the driver queues user turns anyway).
  React.useEffect(() => {
    if (!pendingEdit) return;
    if (!state.turnActive) {
      setPendingEdit(null);
      dispatchEditFrame(pendingEdit.original, pendingEdit.text);
      return;
    }
    const timer = setTimeout(() => {
      setPendingEdit(null);
      dispatchEditFrame(pendingEdit.original, pendingEdit.text);
    }, EDIT_INTERRUPT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pendingEdit, state.turnActive, dispatchEditFrame]);

  const send = async (raw: string): Promise<void> => {
    const text = raw.replace(/\r$/, "").trim();
    if (!text) return;
    if (editing) {
      const { original } = editing;
      if (state.turnActive) {
        // The turn the original message fired is still running: stop it FIRST (the same frame as
        // the stop button), and the edit follows when its result lands (the effect above).
        try {
          sendFrame({ type: "interrupt" });
        } catch (err) {
          toast.error((err as Error).message);
          throw err; // the composer keeps the words
        }
        setPendingEdit({ original, text });
      } else if (!dispatchEditFrame(original, text)) {
        throw new Error(translate("sdk.offline")); // the composer keeps the words
      }
      // Drawn now, in both paths: the original dims with its "editada" badge, the new version is
      // the standing message. The history writes the same two lines, so a replay agrees.
      setState((prev) => appendUserRow(markUserEdited(prev, original), text, undefined, { awaiting: true }));
      setEditing(null);
      return;
    }
    try {
      sendFrame({ type: "user", text });
    } catch (err) {
      toast.error((err as Error).message);
      throw err; // the composer keeps the words
    }
    // The frame is in the driver's stdin the moment send() accepted it — that IS the real state.
    // `awaiting` starts the status ladder: "Preparando…"/"Pensando…" until the driver's first event.
    setState((prev) => appendUserRow(prev, text, undefined, { awaiting: true }));
  };

  const interrupt = (): void => {
    try {
      sendFrame({ type: "interrupt" });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const answerPermission = (id: string, allow: boolean): void => {
    try {
      sendFrame({ type: "permission_decision", id, allow });
    } catch (err) {
      toast.error((err as Error).message);
      return;
    }
    // Optimistic only in DRAWING — the driver echoes the decision; a flip is impossible (first wins).
    setState((prev) => decidePermission(prev, id, allow ? "allowed" : "denied"));
  };

  const answerUserQuestion = (id: string, answers: SdkQuestionAnswer[]): void => {
    try {
      sendFrame({ type: "question_answer", id, answers });
    } catch (err) {
      toast.error((err as Error).message);
      return;
    }
    // Optimistic only in DRAWING — the driver echoes a `question_result`; the first settlement wins.
    setState((prev) => answerQuestion(prev, id, answers));
  };

  /** The terminal's Esc gesture: an empty field steps into editing the LAST message of one's own. */
  const editLast = React.useCallback((): void => {
    if (state.turnActive) return; // mid-turn the gesture would read as a stop — the button does that
    for (let i = state.rows.length - 1; i >= 0; i -= 1) {
      const row = state.rows[i]!;
      if (row.kind === "user" && row.edited !== true && originRole(row.from, viewer) === "self") {
        setEditing({ rowId: row.id, original: row.text });
        return;
      }
    }
  }, [state.rows, state.turnActive, viewer]);

  /* ------------------------------------------------------------ scrolling */

  const stick = useStickToBottom(state.rows);

  /* ----------------------------------------------------- pending decisions */

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const [flashId, setFlashId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 2500);
    return () => clearTimeout(timer);
  }, [flashId]);

  // Derived from the rows — which the sdk-history replays on every connect, so the tray survives
  // F5 exactly like the question cards do.
  const pending = React.useMemo(() => pendingDecisions(state.rows), [state.rows]);

  /** Tray click: scroll to the message, flash it, and put the cursor in the composer. */
  const jumpToDecision = (decision: PendingDecision): void => {
    const el = rowRefs.current.get(decision.rowId);
    el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setFlashId(decision.rowId);
    rootRef.current?.querySelector("textarea")?.focus();
  };

  const rendered = React.useMemo(() => groupSdkRows(state.rows), [state.rows]);
  const empty = state.rows.length === 0;

  return (
    <div ref={rootRef} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={stick.scrollerRef}
        onScroll={stick.onScroll}
        role="log"
        aria-label={ariaLabel ?? t("sdk.aria")}
        aria-live="polite"
        data-testid="sdk-chat-scroller"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain rounded-md border border-border/60 bg-card/30 px-3 py-3"
      >
        {empty && !state.ready ? (
          <div
            data-testid="sdk-chat-loading"
            className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <p>{t("sdk.connecting")}</p>
          </div>
        ) : null}

        {empty && state.ready ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-5 w-5 opacity-60" />
            <p>{t("sdk.empty")}</p>
            <p className="max-w-sm text-xs opacity-70">{t("sdk.emptyHint")}</p>
          </div>
        ) : null}

        {rendered.map((entry) => (
          <div
            key={entry.id}
            ref={(el) => {
              if (el) rowRefs.current.set(entry.id, el);
              else rowRefs.current.delete(entry.id);
            }}
            data-flash={flashId === entry.id || undefined}
            className={cn(flashId === entry.id && "rounded-md ring-2 ring-amber-400/70")}
          >
            {entry.kind === "tools" ? (
              <SdkToolGroup rows={entry.rows} />
            ) : (
              <SdkChatRow
                row={entry.row}
                onPermission={answerPermission}
                onAnswer={answerUserQuestion}
                onEdit={(rowId, original) => setEditing({ rowId, original })}
              />
            )}
          </div>
        ))}

        {/* The STATUS LADDER — one indicator, three rungs, only while the wire is UP (a
            disconnected view cannot vouch for anything; the reconnect relights it). The instant a
            message goes, `awaiting` lights: "Preparando…" while the driver is still booting or
            resuming the session (`ready` false — the cold start), "Pensando…" once the turn is in
            the engine and no token has landed yet. The first driver event clears `awaiting` and the
            plain "Trabalhando…" takes the same seat. Never stacked: one line, its label changes. */}
        {connected && (state.awaiting || state.turnActive) ? (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="sdk-chat-working"
            data-phase={state.awaiting ? (state.ready ? "thinking" : "preparing") : "working"}
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {state.awaiting ? (state.ready ? t("sdk.thinking") : t("sdk.preparing")) : t("chat.working")}
          </div>
        ) : null}
      </div>
      <JumpToLatest stick={stick} />
      </div>

      {/* PENDING DECISIONS — the questions still waiting on the user, surfaced right above the
          composer so they never drown in a long turn. Clicking one jumps to it in the chat. */}
      {pending.length > 0 ? <PendingTray pending={pending} onJump={jumpToDecision} /> : null}

      {/* The interrupt button lives INSIDE the composer — right column, above the microphone —
          in the same seat as the transcript chat's stop. The interrupt frame is still this view's. */}
      <TerminalComposer
        className="mt-1.5"
        cardId={cardId}
        active={active}
        onSend={send}
        onUploadImage={onUploadImage}
        interrupt={{ active: state.turnActive, onInterrupt: interrupt, testId: "sdk-interrupt" }}
        editing={editing ? { text: editing.original } : null}
        onCancelEdit={() => setEditing(null)}
        onEditLast={editLast}
      />

      {/* The footer says which conversation this IS (the resume key) and whether the wire is up. */}
      <div className="mt-1 flex items-center gap-2 px-1 text-[11px] text-muted-foreground/70" data-testid="sdk-chat-footer">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500")} />
        <span>{t("sdk.beta")}</span>
        {state.sessionId ? (
          <span className="min-w-0 truncate font-mono" title={state.sessionId}>
            {t("sdk.session", { id: state.sessionId.slice(0, 8) })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The tray of decisions still waiting on the user — collapsible, with a count badge. Expanded by
 * default: the whole point is that a blocking question never hides. Each entry jumps to (and
 * flashes) its message; answering — by the option card or by a plain message — removes it, because
 * the list is derived from the rows.
 */
function PendingTray({ pending, onJump }: { pending: PendingDecision[]; onJump: (d: PendingDecision) => void }) {
  const t = useT();
  const [open, setOpen] = React.useState(true);
  return (
    <div data-testid="pending-tray" className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-xs">
      <button
        type="button"
        data-testid="pending-tray-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-medium text-amber-600 dark:text-amber-400"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <ListTodo className="h-3.5 w-3.5 shrink-0" />
        <span>{t("sdk.pendingTitle")}</span>
        <span
          data-testid="pending-tray-count"
          className="ml-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
        >
          {pending.length}
        </span>
      </button>
      {open ? (
        <ul className="flex flex-col gap-0.5 px-2 pb-1.5">
          {pending.map((d) => (
            <li key={d.rowId}>
              <button
                type="button"
                data-testid="pending-tray-item"
                data-kind={d.kind}
                onClick={() => onJump(d)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-muted-foreground hover:bg-amber-500/10 hover:text-foreground"
              >
                {d.kind === "question" ? (
                  <CircleHelp className="h-3 w-3 shrink-0 text-sky-500" />
                ) : (
                  <MessageSquare className="h-3 w-3 shrink-0 text-amber-500/80" />
                )}
                <span className="min-w-0 truncate">{d.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A folded run of tool calls — same reading rules as the transcript chat's fold. */
function SdkToolGroup({ rows }: { rows: SdkRow[] }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const last = rows[rows.length - 1];

  return (
    <div data-testid="sdk-tool-group" data-count={rows.length} className="pl-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.actionsHide", { n: rows.length }) : t("chat.actionsShow", { n: rows.length })}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded text-left text-xs text-muted-foreground/80 hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <Wrench className="h-3 w-3 shrink-0 opacity-70" />
        <span className="shrink-0 font-medium">{t("chat.actions", { n: rows.length })}</span>
        {!open && last && last.kind === "tool" ? (
          <span className="min-w-0 truncate font-mono opacity-70">
            {last.name}
            {last.summary ? ` ${last.summary}` : ""}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 space-y-1 border-l border-border/60 pl-2">
          {rows.map((row) => (
            <SdkChatRow key={row.id} row={row} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SdkChatRow({
  row,
  onPermission,
  onAnswer,
  onEdit,
}: {
  row: SdkRow;
  onPermission?: (id: string, allow: boolean) => void;
  onAnswer?: (id: string, answers: SdkQuestionAnswer[]) => void;
  /** Offered only on one's OWN messages: the pencil that starts editing (a supersede). */
  onEdit?: (rowId: string, original: string) => void;
}) {
  const t = useT();
  // Whose screen this is — their own messages render unlabelled, everyone else's carry the sender.
  const viewer = useAuth().user?.username;

  if (row.kind === "question") {
    return <SdkQuestionCard row={row} onAnswer={onAnswer} />;
  }

  if (row.kind === "tool") {
    return (
      <div data-testid="sdk-tool" className="flex items-baseline gap-1.5 pl-0.5 text-xs text-muted-foreground/80">
        <Wrench className="h-3 w-3 shrink-0 translate-y-0.5 opacity-70" />
        <span className="font-mono">{row.name}</span>
        {row.summary ? <span className="min-w-0 truncate opacity-80">{row.summary}</span> : null}
      </div>
    );
  }

  if (row.kind === "permission") {
    return (
      <div
        data-testid="sdk-permission"
        data-outcome={row.outcome}
        className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
      >
        <div className="flex items-center gap-1.5 font-medium text-amber-500">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          {t("sdk.permissionTitle")}
        </div>
        <div className="min-w-0 font-mono text-muted-foreground">
          {row.tool}
          {row.summary ? ` ${row.summary}` : ""}
        </div>
        {row.outcome === "pending" ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              data-testid="sdk-permission-allow"
              onClick={() => onPermission?.(row.id, true)}
            >
              {t("sdk.allow")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              data-testid="sdk-permission-deny"
              onClick={() => onPermission?.(row.id, false)}
            >
              {t("sdk.deny")}
            </Button>
            <span className="text-muted-foreground/70">{t("sdk.permissionTimeoutHint")}</span>
          </div>
        ) : (
          <div className="text-muted-foreground">
            {row.outcome === "allowed" ? t("sdk.allowed") : row.outcome === "timeout" ? t("sdk.timedOut") : t("sdk.denied")}
          </div>
        )}
      </div>
    );
  }

  if (row.kind === "error") {
    return (
      <div
        data-testid="sdk-error"
        className="flex items-start gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 translate-y-0.5" />
        <span className="min-w-0 whitespace-pre-wrap break-words">{errorText(row.text, t)}</span>
        {/* The reconnect loop repeats the SAME refusal; the reducer folds the copies into one row
            and this badge is how the row says it kept happening. */}
        {(row.count ?? 1) > 1 ? (
          <span data-testid="sdk-error-count" className="ml-auto shrink-0 font-mono tabular-nums opacity-80">
            ×{row.count}
          </span>
        ) : null}
      </div>
    );
  }

  if (row.kind === "note") {
    return (
      <div data-testid="sdk-note" className="py-0.5 text-center text-xs italic text-muted-foreground/70">
        {row.text.startsWith("resume:")
          ? t("sdk.resumed", { id: row.text.slice("resume:".length, "resume:".length + 8) })
          : row.text === TERMINAL_ACTIVITY_NOTE
            ? t("sdk.terminalActivity")
            : row.text}
      </div>
    );
  }

  if (row.kind === "user") {
    // Same reading rules as the transcript chat: your own message keeps the right-aligned primary
    // bubble; another card's agent gets the green robot bubble (name links to its card), another
    // person a neutral one with their name.
    const role = originRole(row.from, viewer);
    const editedBadge = row.edited ? (
      <div data-testid="sdk-user-edited" className="mt-1 text-right text-[10px] italic text-muted-foreground/80">
        {t("sdk.edited")}
      </div>
    ) : null;
    // Streaming input: the driver confirmed this send FOLDED into the turn already running — the
    // label says it entered the current turn, so a mid-turn message never looks lost or ignored.
    const absorbedTag = row.absorbed ? (
      <div data-testid="sdk-user-absorbed" className="mt-1 text-right text-[10px] italic text-muted-foreground/80">
        {t("sdk.absorbed")}
      </div>
    ) : null;
    if (role !== "self" && row.from) {
      return (
        <div className="flex flex-col items-start" data-testid="sdk-user" data-role={role} data-edited={row.edited || undefined}>
          <div
            className={cn(
              "max-w-[85%] select-text whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm",
              role === "agent" ? "border-emerald-500/40 bg-emerald-500/10" : "border-border/70 bg-muted/50",
              row.edited && "opacity-60",
            )}
          >
            <SenderTag from={row.from} />
            <LinkifiedText text={row.text} />
            {editedBadge}
            {absorbedTag}
          </div>
        </div>
      );
    }
    return (
      <div className="group flex flex-col items-end">
        <div
          data-testid="sdk-user"
          data-edited={row.edited || undefined}
          className={cn(
            "max-w-[85%] select-text whitespace-pre-wrap break-words rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm",
            row.edited && "opacity-60",
          )}
        >
          <LinkifiedText text={row.text} />
          {editedBadge}
          {absorbedTag}
        </div>
        {/* The pencil: hover-revealed on a desktop, simply there on touch (no hover to reveal it).
            A superseded message offers no pencil — the standing version is the one to edit. */}
        {!row.edited && onEdit ? (
          <button
            type="button"
            data-testid="sdk-edit"
            aria-label={t("sdk.edit")}
            title={t("sdk.edit")}
            onClick={() => onEdit(row.id, row.text)}
            className="mt-0.5 rounded p-1 text-muted-foreground/70 transition-opacity hover:bg-muted hover:text-foreground md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
          >
            <Pencil className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    );
  }

  // Best-effort highlight: when the message CLOSES on a question directed at the user, that final
  // paragraph gets a subtle amber frame so it never drowns in the text above it.
  const prose = row.kind === "assistant" && !row.streaming ? splitProseQuestion(row.text) : null;
  if (prose) {
    return (
      <div data-testid="sdk-assistant" className="max-w-full select-text text-sm leading-relaxed">
        {prose.body !== "" ? <Markdown text={prose.body} /> : null}
        <div
          data-testid="sdk-prose-question"
          className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5"
        >
          <Markdown text={prose.question} />
        </div>
      </div>
    );
  }
  return (
    <div data-testid="sdk-assistant" className="max-w-full select-text text-sm leading-relaxed">
      <Markdown text={row.text} />
      {row.streaming ? <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/60 align-baseline" /> : null}
    </div>
  );
}

/**
 * The agent's QUESTION card — AskUserQuestion rendered as clickable options in the chat.
 *
 * Reading rules: a single-choice single question answers on the CLICK (one gesture, like the
 * permission buttons); multi-select — or several questions at once — collects the picks and sends
 * them with one "Responder". Every question also takes a free-text "Outra resposta…" (sent as the
 * answer when filled). A settled card shows what was chosen; a replayed pending one is clickable
 * again (the driver is still waiting — the timeout is 30 minutes).
 */
function SdkQuestionCard({
  row,
  onAnswer,
}: {
  row: Extract<SdkRow, { kind: "question" }>;
  onAnswer?: (id: string, answers: SdkQuestionAnswer[]) => void;
}) {
  const t = useT();
  const [picked, setPicked] = React.useState<string[][]>(() => row.questions.map(() => []));
  const [other, setOther] = React.useState<string[]>(() => row.questions.map(() => ""));

  const single = row.questions.length === 1 && row.questions[0]?.multiSelect !== true;

  const answersFrom = (pickedNow: string[][], otherNow: string[]): SdkQuestionAnswer[] =>
    row.questions.map((_, i) => {
      const text = (otherNow[i] ?? "").trim();
      return { selected: [...(pickedNow[i] ?? []), ...(text !== "" ? [text] : [])] };
    });

  const complete = row.questions.every((_, i) => (picked[i]?.length ?? 0) > 0 || (other[i] ?? "").trim() !== "");

  const submit = (answers: SdkQuestionAnswer[]): void => onAnswer?.(row.id, answers);

  const toggle = (qi: number, label: string): void => {
    const multi = row.questions[qi]?.multiSelect === true;
    if (single) {
      // One question, one choice: the click IS the answer.
      submit(answersFrom(row.questions.map((_, i) => (i === 0 ? [label] : [])), other.map(() => "")));
      return;
    }
    setPicked((prev) =>
      prev.map((sel, i) => {
        if (i !== qi) return sel;
        if (!multi) return sel.includes(label) ? [] : [label];
        return sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label];
      }),
    );
  };

  if (row.outcome !== "pending") {
    const chosen = (row.answers ?? []).map((a) => a.selected.join(", ")).filter((s) => s !== "");
    return (
      <div
        data-testid="sdk-question"
        data-outcome={row.outcome}
        className="flex flex-col gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs"
      >
        <div className="flex items-center gap-1.5 font-medium text-sky-500">
          <CircleHelp className="h-3.5 w-3.5 shrink-0" />
          {t("sdk.questionTitle")}
        </div>
        {row.questions.map((q, i) => (
          <div key={i} className="min-w-0 text-muted-foreground">{q.question}</div>
        ))}
        <div className="text-foreground/90">
          {row.outcome === "answered" ? t("sdk.questionAnswered", { answers: chosen.join(" · ") }) : t("sdk.questionUnanswered")}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="sdk-question"
      data-outcome="pending"
      className="flex flex-col gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5 font-medium text-sky-500">
        <CircleHelp className="h-3.5 w-3.5 shrink-0" />
        {t("sdk.questionTitle")}
      </div>
      {row.questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1.5">
          {q.header ? <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-500/80">{q.header}</div> : null}
          <div className="text-sm text-foreground">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((opt) => {
              const selected = (picked[qi] ?? []).includes(opt.label);
              return (
                <Button
                  key={opt.label}
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  className="h-7 max-w-full text-xs"
                  data-testid="sdk-question-option"
                  aria-pressed={selected}
                  title={opt.description}
                  onClick={() => toggle(qi, opt.label)}
                >
                  <span className="truncate">{opt.label}</span>
                </Button>
              );
            })}
          </div>
          <input
            type="text"
            data-testid="sdk-question-other"
            aria-label={t("sdk.questionOther")}
            placeholder={t("sdk.questionOther")}
            value={other[qi] ?? ""}
            onChange={(e) => setOther((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const answers = answersFrom(picked, other);
              if (answers[qi]!.selected.length > 0 && (single || complete)) submit(answers);
            }}
            className="h-7 rounded-md border border-border/70 bg-background/80 px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-sky-500/60"
          />
        </div>
      ))}
      {single ? (
        (other[0] ?? "").trim() !== "" ? (
          <Button size="sm" className="h-7 self-start text-xs" data-testid="sdk-question-send" onClick={() => submit(answersFrom(picked, other))}>
            {t("sdk.questionSend")}
          </Button>
        ) : null
      ) : (
        <Button
          size="sm"
          className="h-7 self-start text-xs"
          data-testid="sdk-question-send"
          disabled={!complete}
          onClick={() => submit(answersFrom(picked, other))}
        >
          {t("sdk.questionSend")}
        </Button>
      )}
      <span className="text-muted-foreground/70">{t("sdk.questionTimeoutHint")}</span>
    </div>
  );
}

/** A server refusal worth translating: the flag is off. Anything else is shown as it came. */
function errorText(text: string, t: ReturnType<typeof useT>): string {
  if (/sdkDriver setting/i.test(text)) return t("sdk.flagOff");
  return text;
}
