import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronRight,
  CircleHelp,
  Loader2,
  MessageSquare,
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
import {
  INITIAL_SDK_STATE,
  TERMINAL_ACTIVITY_NOTE,
  answerQuestion,
  applySdkEvent,
  appendUserRow,
  decidePermission,
  groupSdkRows,
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

  const send = async (raw: string): Promise<void> => {
    const text = raw.replace(/\r$/, "").trim();
    if (!text) return;
    try {
      sendFrame({ type: "user", text });
    } catch (err) {
      toast.error((err as Error).message);
      throw err; // the composer keeps the words
    }
    // The frame is in the driver's stdin the moment send() accepted it — that IS the real state.
    setState((prev) => appendUserRow(prev, text));
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

  /* ------------------------------------------------------------ scrolling */

  const stick = useStickToBottom(state.rows);

  const rendered = React.useMemo(() => groupSdkRows(state.rows), [state.rows]);
  const empty = state.rows.length === 0;

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
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

        {rendered.map((entry) =>
          entry.kind === "tools" ? (
            <SdkToolGroup key={entry.id} rows={entry.rows} />
          ) : (
            <SdkChatRow key={entry.id} row={entry.row} onPermission={answerPermission} onAnswer={answerUserQuestion} />
          ),
        )}

        {/* "Trabalhando…" only while the wire is UP. The driver now SURVIVES a dead socket (it is
            card-owned in the back, not this connection's child), but a disconnected view cannot
            vouch for what it is doing — so the spinner stays honest and yields to the reconnect:
            the live stream relights it within the next delta if the turn is still running. */}
        {connected && state.turnActive ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="sdk-chat-working">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("chat.working")}
          </div>
        ) : null}
      </div>
      <JumpToLatest stick={stick} />
      </div>

      {/* The interrupt button lives INSIDE the composer — right column, above the microphone —
          in the same seat as the transcript chat's stop. The interrupt frame is still this view's. */}
      <TerminalComposer
        className="mt-1.5"
        cardId={cardId}
        active={active}
        onSend={send}
        onUploadImage={onUploadImage}
        interrupt={{ active: state.turnActive, onInterrupt: interrupt, testId: "sdk-interrupt" }}
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
}: {
  row: SdkRow;
  onPermission?: (id: string, allow: boolean) => void;
  onAnswer?: (id: string, answers: SdkQuestionAnswer[]) => void;
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
    if (role !== "self" && row.from) {
      return (
        <div className="flex flex-col items-start" data-testid="sdk-user" data-role={role}>
          <div
            className={cn(
              "max-w-[85%] select-text whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm",
              role === "agent" ? "border-emerald-500/40 bg-emerald-500/10" : "border-border/70 bg-muted/50",
            )}
          >
            <SenderTag from={row.from} />
            <LinkifiedText text={row.text} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-end">
        <div
          data-testid="sdk-user"
          className="max-w-[85%] select-text whitespace-pre-wrap break-words rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm"
        >
          <LinkifiedText text={row.text} />
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
