import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bell, ChevronRight, Loader2, MessageSquare, Square, TerminalSquare, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { wsUrl } from "@/lib/ws";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { boardApi } from "@/features/board/api";
import { TerminalComposer } from "@/features/board/components/TerminalComposer";
import { reconnectDelay, type ConnectionState } from "@/features/board/lib/reconnect";
import { groupChatRows, mergeEvent, parseChatFrame, type ChatEvent } from "@/features/board/lib/chat";
import { mdBlocks, mdInline } from "@/features/board/lib/markdown";
import { t as translate, useT } from "@/i18n";

/**
 * The card's session, read as a conversation.
 *
 * This is the SAME agent the terminal pane shows — same tmux session, same process, same history.
 * What changes is what crosses the wire: the terminal streams a repainting screen (a spinner alone
 * is thousands of frames an hour, and a phone rasterises every one of them), while this streams one
 * event per message. That is why the switch exists, and why leaving this mounted instead of the
 * terminal is the cheap state to sit in.
 *
 * What it CANNOT show is the TUI's own interactive moments: a permission prompt, a plan approval,
 * `/login`. Those never reach the transcript because they are drawn on the screen, so when the
 * agent goes quiet mid-turn this view says so and points at the terminal instead of pretending.
 */

/** After this long with no new event while the agent is "working", offer the terminal. */
export const QUIET_HINT_MS = 60_000;

/**
 * How long a freshly connected stream is given to replay its tail before an empty screen is called
 * empty. Long enough for the server's first frames, short enough that a genuinely new card does not
 * sit staring at a spinner.
 */
export const REPLAY_GRACE_MS = 600;

export interface ChatViewProps {
  cardId: string;
  /**
   * Is this card the one on screen? Card views stay mounted behind the one you are reading (the
   * deck), so the transcript keeps streaming — but the composer under it must not take the keyboard
   * away from the card that IS on screen.
   */
  active?: boolean;
  /** true = the agent's turn is running (the card's status dot is green). */
  working: boolean;
  /** Uploads an image and resolves with its path inside the runner (appended to the message). */
  onUploadImage?: (file: File) => Promise<string | null>;
  onStatus?: (state: ConnectionState) => void;
  /** Switches the card to the terminal — the way out of everything this view cannot do. */
  onOpenTerminal?: () => void;
  ariaLabel?: string;
  className?: string;
}

export function ChatView({
  cardId,
  active = true,
  working,
  onUploadImage,
  onStatus,
  onOpenTerminal,
  ariaLabel,
  className,
}: ChatViewProps) {
  const t = useT();
  const [events, setEvents] = React.useState<ChatEvent[]>([]);
  /**
   * Messages sent from here that the transcript has not echoed back yet. Claude Code writes the
   * user line as the turn starts, so this lasts a moment — but without it the field empties and
   * NOTHING appears, which reads as a message that went nowhere.
   */
  const [pending, setPending] = React.useState<{ id: string; text: string }[]>([]);
  const [lastEventAt, setLastEventAt] = React.useState(() => Date.now());
  /**
   * Has the transcript had its say yet?
   *
   * The stream replays its tail the moment it connects, so the first instant of a card is not "no
   * messages" — it is "not known yet", and printing the empty state there tells you a card is empty
   * when it is merely young. This flips once the socket has opened AND either an event arrived or a
   * short grace has passed with nothing.
   */
  const [settled, setSettled] = React.useState(false);

  const statusRef = React.useRef<ChatViewProps["onStatus"]>(onStatus);
  statusRef.current = onStatus;

  /* ------------------------------------------------------------- websocket */

  React.useEffect(() => {
    setEvents([]);
    setSettled(false);
    let socket: WebSocket | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;
    const setStatus = (state: ConnectionState): void => statusRef.current?.(state);

    const connect = (): void => {
      if (disposed || socket || typeof WebSocket === "undefined") return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      let next: WebSocket;
      try {
        next = new WebSocket(wsUrl(`/api/cards/${encodeURIComponent(cardId)}/chat`));
      } catch {
        scheduleRetry();
        return;
      }
      socket = next;
      next.onopen = () => {
        attempt = 0;
        setStatus("open");
        // Connected: the replay is on its way. If nothing has arrived shortly, the card really is
        // empty and the empty state is the truth rather than a guess.
        if (!grace) grace = setTimeout(() => setSettled(true), REPLAY_GRACE_MS);
      };
      next.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const parsed = parseChatFrame(event.data);
        if (!parsed) return; // the heartbeat, or a line that is not an event
        // The stream REPLAYS its tail on every connect, so merge-by-id is what makes a reconnect
        // (or a new session file) idempotent instead of duplicating the history.
        setEvents((prev) => mergeEvent(prev, parsed));
        setLastEventAt(Date.now());
        setSettled(true);
      };
      next.onerror = () => {
        /* onclose always follows; the retry is decided there so it happens once */
      };
      next.onclose = () => {
        if (socket === next) socket = null;
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
      if (grace) clearTimeout(grace);
      if (retry) clearTimeout(retry);
      try { socket?.close(); } catch { /* already closing */ }
      setStatus("closed");
    };
  }, [cardId]);

  /** An optimistic bubble dies when the real message for it arrives. */
  React.useEffect(() => {
    setPending((prev) => {
      if (!prev.length) return prev;
      const said = new Set(events.filter((e) => e.kind === "user").map((e) => e.text.trim()));
      const next = prev.filter((p) => !said.has(p.text.trim()));
      return next.length === prev.length ? prev : next;
    });
  }, [events]);

  /* ------------------------------------------------------------- sending */

  const sendMutation = useMutation({
    mutationFn: (text: string) => boardApi.sendCardChat(cardId, text),
    onError: (error, text) => {
      setPending((prev) => prev.filter((p) => p.text !== text));
      toast.error(apiErrorMessage(error, translate("chat.sendError")));
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => boardApi.sendCardChatKey(cardId, "escape"),
    onError: (error) => toast.error(apiErrorMessage(error, translate("chat.stopError"))),
  });

  const send = (raw: string): void => {
    // The composer speaks terminal ("\r" submits); here the Enter is the server's job.
    const text = raw.replace(/\r$/, "").trim();
    if (!text) return;
    setPending((prev) => [...prev, { id: `local:${Date.now()}:${prev.length}`, text }]);
    sendMutation.mutate(text);
  };

  /* ------------------------------------------------------------ scrolling */

  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  /**
   * Whether the reader is AT the bottom. Scrolling up to re-read something and being yanked back
   * down by the next tool line is the single most annoying thing a live transcript can do.
   */
  const stickRef = React.useRef(true);
  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events, pending, working]);

  /* --------------------------------------------------------------- quiet */

  // A clock only while it can change something: working, and nothing new for a while.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [working]);
  const quietFor = working ? now - lastEventAt : 0;
  const quiet = quietFor >= QUIET_HINT_MS;

  const empty = events.length === 0 && pending.length === 0;
  const rows = React.useMemo(() => groupChatRows(events), [events]);

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        role="log"
        aria-label={ariaLabel ?? t("chat.aria")}
        aria-live="polite"
        data-testid="chat-scroller"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain rounded-md border border-border/60 bg-card/30 px-3 py-3"
      >
        {empty && !settled ? (
          // Connecting, or the replay has not landed yet. Saying "no messages" here would be a lie
          // that lasts exactly as long as the thing you are waiting for.
          <div
            data-testid="chat-loading"
            className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <p>{t("chat.loading")}</p>
          </div>
        ) : null}

        {empty && settled ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-5 w-5 opacity-60" />
            <p>{t("chat.empty")}</p>
            <p className="max-w-sm text-xs opacity-70">{t("chat.emptyHint")}</p>
          </div>
        ) : null}

        {/* Folded: a run of tool calls is ONE block, not fifteen lines that push the reply off the
            screen. See `groupChatRows` — the fold is a pure function of the event list. */}
        {rows.map((row) =>
          row.kind === "tools" ? (
            <ToolGroup key={row.id} events={row.events} />
          ) : (
            <ChatRow key={row.id} event={row.event} />
          ),
        )}
        {pending.map((p) => (
          <ChatRow key={p.id} event={{ id: p.id, kind: "user", at: 0, text: p.text }} sending />
        ))}

        {working ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="chat-working">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("chat.working")}
          </div>
        ) : null}

        {quiet ? (
          <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            <p>{t("chat.quiet")}</p>
            {onOpenTerminal ? (
              <Button size="sm" variant="outline" className="h-7 self-start text-xs" onClick={onOpenTerminal}>
                <TerminalSquare className="mr-1 h-3.5 w-3.5" />
                {t("chat.openTerminal")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-1.5 flex items-end gap-1.5">
        <TerminalComposer
          className="min-w-0 flex-1"
          cardId={cardId}
          active={active}
          onSend={send}
          onUploadImage={onUploadImage}
        />
        {working ? (
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground"
            aria-label={t("chat.stop")}
            title={t("chat.stopHint")}
            disabled={stopMutation.isPending}
            onClick={() => stopMutation.mutate()}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A run of tool calls, folded.
 *
 * What an agent's turn mostly IS, in lines on a screen, is tools: reads, greps, edits, a dozen bash
 * invocations. Rendered flat they bury the two sentences you opened the card for. So the run
 * collapses into one row that says how many and shows the last one — enough to know what it is
 * doing — and clicking it unfolds every call in place. Nothing is hidden, and nothing is lost when
 * it grows: the block keeps its identity while the turn adds to it, so a block you opened stays
 * open.
 */
function ToolGroup({ events }: { events: ChatEvent[] }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const last = events[events.length - 1];

  return (
    <div data-testid="chat-tool-group" data-count={events.length} className="pl-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.actionsHide", { n: events.length }) : t("chat.actionsShow", { n: events.length })}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded text-left text-xs text-muted-foreground/80 hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <Wrench className="h-3 w-3 shrink-0 opacity-70" />
        <span className="shrink-0 font-medium">{t("chat.actions", { n: events.length })}</span>
        {/* Folded, the LAST call is the useful one: it is what the agent is doing right now. */}
        {!open && last ? (
          <span className="min-w-0 truncate font-mono opacity-70">
            {last.tool}
            {last.text ? ` ${last.text}` : ""}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 space-y-1 border-l border-border/60 pl-2">
          {events.map((event) => (
            <ChatRow key={event.id} event={event} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One entry: a message from either side, or the one line a tool call is worth. */
function ChatRow({ event, sending }: { event: ChatEvent; sending?: boolean }) {
  const t = useT();
  const when = event.at ? new Date(event.at).toLocaleString() : undefined;

  if (event.kind === "tool") {
    return (
      <div
        title={when}
        data-testid="chat-tool"
        className="flex items-baseline gap-1.5 pl-0.5 text-xs text-muted-foreground/80"
      >
        <Wrench className="h-3 w-3 shrink-0 translate-y-0.5 opacity-70" />
        <span className="font-mono">{event.tool}</span>
        {event.text ? <span className="min-w-0 truncate opacity-80">{event.text}</span> : null}
      </div>
    );
  }

  if (event.kind === "system") {
    // The harness talking (a background-task notification), not the person. A quiet centered note,
    // never a message bubble, so it reads as an event and not as something Cesar typed.
    return (
      <div
        data-testid="chat-system"
        title={when}
        className="flex items-center justify-center gap-1.5 py-0.5 text-center text-xs text-muted-foreground/70"
      >
        <Bell className="h-3 w-3 shrink-0 opacity-70" />
        <span className="min-w-0 truncate italic">{event.text}</span>
      </div>
    );
  }

  if (event.kind === "user") {
    return (
      <div className="flex justify-end" title={when}>
        <div
          data-testid="chat-user"
          className={cn(
            "max-w-[85%] whitespace-pre-wrap break-words rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm",
            sending && "opacity-60",
          )}
        >
          {event.text}
          {sending ? <span className="ml-2 text-[10px] uppercase opacity-70">{t("chat.sending")}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="chat-assistant" title={when} className="max-w-full text-sm leading-relaxed">
      <Markdown text={event.text} />
    </div>
  );
}

/** The blocks of one answer. See `lib/markdown.ts` for what is understood — and what is not. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {mdBlocks(text).map((block, i) => {
        if (block.type === "code") {
          return (
            // Wide code scrolls INSIDE its own box: a chat that scrolls sideways as a whole is
            // unreadable on the phone this view exists for.
            <pre
              key={i}
              className="overflow-x-auto rounded-md border border-border/60 bg-background/60 p-2 text-xs"
            >
              <code className="font-mono">{block.text}</code>
            </pre>
          );
        }
        if (block.type === "heading") {
          return (
            <p key={i} className={cn("font-semibold", block.level <= 2 ? "text-sm" : "text-[13px]")}>
              <Inline text={block.text} />
            </p>
          );
        }
        if (block.type === "bullets") {
          return (
            <ul key={i} className="ml-4 list-disc space-y-1">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {mdInline(text).map((token, i) => {
        if (token.type === "code") {
          return (
            <code key={i} className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[0.85em]">
              {token.value}
            </code>
          );
        }
        if (token.type === "strong") return <strong key={i}>{token.value}</strong>;
        if (token.type === "link") {
          return (
            <a
              key={i}
              href={token.value}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline underline-offset-2"
            >
              {token.value}
            </a>
          );
        }
        return <React.Fragment key={i}>{token.value}</React.Fragment>;
      })}
    </>
  );
}
