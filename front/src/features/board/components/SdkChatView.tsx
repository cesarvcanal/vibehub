import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Brain,
  ChevronRight,
  CircleHelp,
  CornerDownLeft,
  ListTodo,
  Loader2,
  MessageSquare,
  Pencil,
  Reply,
  ShieldAlert,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { wsUrl } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/providers/auth";
import { TerminalComposer } from "@/features/board/components/TerminalComposer";
import { LinkifiedText, Markdown, SenderTag } from "@/features/board/components/ChatView";
import { originRole } from "@/features/board/lib/chat";
import { ultraKeywords } from "@/features/board/lib/ultraWords";
import { workingStage, type WorkingKind } from "@/features/board/lib/workingStage";
import { reconnectDelay, type ConnectionState } from "@/features/board/lib/reconnect";
import { JumpToLatest, useStickToBottom } from "@/features/board/components/JumpToLatest";
import {
  buildDecisionReply,
  decisionReplies,
  decisionSummary,
  parseDecisionReply,
  pendingDecisions,
  splitProseQuestion,
  type PendingDecision,
} from "@/features/board/lib/pendingDecisions";
import {
  INITIAL_SDK_STATE,
  SDK_ERROR_NO_DETAIL,
  SDK_ERROR_TURN_FAILED,
  TERMINAL_ACTIVITY_NOTE,
  TURN_INTERRUPTED_EDIT_NOTE,
  TURN_INTERRUPTED_NOTE,
  answerQuestion,
  applySdkEvent,
  appendUserRow,
  decidePermission,
  deliveredUserTexts,
  dropUserRow,
  currentActivity,
  groupSdkRows,
  markInterruptRequested,
  markUserEdited,
  parseSdkFrame,
  settleUserRow,
  toolHeadline,
  type SdkActivity,
  type SdkChatState,
  type SdkQuestionAnswer,
  type SdkRow,
} from "@/features/board/lib/sdkChat";
import {
  OUTBOX_ACK_TIMEOUT_MS,
  addToOutbox,
  dropFromOutbox,
  markUndelivered,
  newCid,
  overdueMessages,
  readOutbox,
  reconcileOutbox,
  retryOutbox,
  writeOutbox,
  type OutboxMessage,
} from "@/features/board/lib/sdkOutbox";
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

/** How often the outbox is checked for a send whose receipt never came. */
export const OUTBOX_TICK_MS = 2_000;

/**
 * What "Continuar de onde parou" actually sends — a NEW turn asking the agent to pick the work up,
 * because that is the only honest resume the SDK offers: an interrupted turn cannot be un-cut.
 * Kept in pt-BR on purpose, like the supersede wrapper (see the back's `buildSupersedeText`): it is
 * the user's own speech act to his agent, not panel chrome.
 */
export const RESUME_TURN_TEXT =
  "[continuar] O turno anterior foi interrompido porque comecei a editar uma mensagem e depois " +
  "cancelei a edição. Nada mudou no que eu pedi: continue de onde você parou.";

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
  /**
   * The sends this browser has not seen confirmed yet (see lib/sdkOutbox.ts). They live in
   * localStorage, so the words survive the F5 that used to erase them — a message is only forgotten
   * here when the SERVER says it has it (`user_ack`, or a replay carrying the same text).
   */
  const [outbox, setOutbox] = React.useState<OutboxMessage[]>(() => readOutbox(cardId));
  const outboxRef = React.useRef(outbox);
  outboxRef.current = outbox;
  React.useEffect(() => {
    writeOutbox(cardId, outbox);
  }, [cardId, outbox]);
  /** Reconciliation runs ONCE per connection, when the replay has landed (`ready`). */
  const reconciledRef = React.useRef(false);

  /* ------------------------------------------------------------- websocket */

  React.useEffect(() => {
    setState(INITIAL_SDK_STATE);
    setOutbox(readOutbox(cardId));
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
        reconciledRef.current = false;
        // EVERY connect replays the card's history from the server log (see back/services/sdk/
        // history.ts), so the slate is wiped here — otherwise a reconnect would draw the whole
        // conversation twice. What was on screen comes right back, from disk instead of memory.
        setState(INITIAL_SDK_STATE);
        // The replay tells the story again from disk (the interrupt note included) — a stale
        // "continuar?" offer from before the drop would be guessing about a turn we no longer see.
        setInterruptedForEdit(false);
      };
      next.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const parsed = parseSdkFrame(event.data);
        if (!parsed) return;
        // The RECEIPT: `user_ack` means the back gravou — this browser no longer needs its copy.
        // `user_nack` means it refused, so the copy STAYS (the bubble now says "não entregue").
        if (parsed.type === "user_ack" && parsed.cid) {
          const cid = parsed.cid;
          setOutbox((prev) => dropFromOutbox(prev, cid));
        }
        // A recusa também é uma RESPOSTA: o veredito desta mensagem já saiu, e a fila precisa
        // saber disso — senão ela seguiria "sem recibo" e o watchdog derrubaria este socket (que
        // acabou de provar que está vivo) a cada tique.
        if (parsed.type === "user_nack" && parsed.cid) {
          const cid = parsed.cid;
          setOutbox((prev) => markUndelivered(prev, [cid]));
        }
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

  /**
   * A TURN goes out with a receipt: the words are written to the outbox (disk) BEFORE the frame
   * leaves, and only a `user_ack` takes them off it. This is the whole difference between "o
   * socket aceitou" (which a half-open connection also does, into the void) and "o servidor tem".
   */
  const sendTurn = React.useCallback(
    (frame: { type: "user" | "edit_user"; text: string; original?: string }, shown: string, cid: string): void => {
      const entry: OutboxMessage = { cid, text: shown, at: Date.now(), original: frame.original };
      setOutbox((prev) => addToOutbox(prev, entry));
      try {
        sendFrame({ ...frame, cid });
      } catch (err) {
        // The socket refused it outright: no receipt is coming, so the bubble must not pretend —
        // and the verdict is already given, so the watchdog has nothing left to chase here.
        setOutbox((prev) => markUndelivered(prev, [cid]));
        setState((prev) => settleUserRow(prev, cid, "undelivered"));
        throw err;
      }
    },
    [sendFrame],
  );

  /**
   * RECONCILE on reconnect: the server's replay is the truth about what was recorded. An outbox
   * entry whose text is in the replay was delivered (only its receipt got lost); one that is not
   * there never arrived, and comes back as a bubble marked "não entregue" with its text intact —
   * which is exactly what the F5 used to throw away.
   */
  React.useEffect(() => {
    if (!state.ready || reconciledRef.current) return;
    reconciledRef.current = true;
    const pending = outboxRef.current;
    if (pending.length === 0) return;
    const { delivered, missing } = reconcileOutbox(deliveredUserTexts(state.rows), pending);
    if (delivered.length > 0 || missing.length > 0) {
      // Entregue sai da fila; a que o servidor não tem FICA, já com o veredito dado — a fila é a
      // cópia recuperável dela, e uma entrada vencida que ninguém marca é o que fazia o watchdog
      // derrubar o socket em todo tique.
      setOutbox((prev) => markUndelivered(
        delivered.reduce((acc, m) => dropFromOutbox(acc, m.cid), prev),
        missing.map((m) => m.cid),
      ));
    }
    if (missing.length > 0) {
      setState((prev) => missing.reduce(
        (acc, m) => appendUserRow(acc, m.text, undefined, { cid: m.cid, state: "undelivered" }),
        prev,
      ));
    }
  }, [state.ready, state.rows]);

  /**
   * THE WATCHDOG — the half-open socket, which is what made this bug so hard to see: `send()`
   * succeeded, nothing ever came back, and the browser went on believing the connection was fine
   * for minutes (in production, hours). A send with no receipt after `OUTBOX_ACK_TIMEOUT_MS` is
   * declared undelivered AND the socket is dropped, so the reconnect either proves the message
   * landed (the replay carries it) or brings it back marked, on a connection that works.
   *
   * O veredito é dado UMA vez por envio (`markUndelivered` na fila). A mensagem não entregue
   * continua guardada — é o que a bolha "reenviar/descartar" oferece —, mas o relógio dela já
   * venceu: sem essa marca ela estaria vencida em todo tique, e o watchdog derrubava a cada 2s um
   * socket perfeitamente vivo. Era esse o loop "chat → Iniciando o agente… → histórico inteiro →
   * chat" que deixava a tela piscando (produção, 2026-09-17). Um reenvio zera o relógio e volta a
   * ser cobrável.
   */
  React.useEffect(() => {
    if (outbox.length === 0) return;
    const timer = setInterval(() => {
      const overdue = overdueMessages(outboxRef.current, Date.now(), OUTBOX_ACK_TIMEOUT_MS);
      if (overdue.length === 0) return;
      const cids = overdue.map((m) => m.cid);
      setOutbox((prev) => markUndelivered(prev, cids));
      setState((prev) => cids.reduce((acc, cid) => settleUserRow(acc, cid, "undelivered"), prev));
      const socket = socketRef.current;
      // Drop the socket: the reconnect is the only way to find out whether it was still alive.
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.close(); } catch { /* already closing */ }
      }
    }, OUTBOX_TICK_MS);
    return () => clearInterval(timer);
  }, [outbox.length]);

  /* -------------------------------------------------------------- editing */

  /** The message being edited (a SUPERSEDE — the model read the original; see docs/sdk-driver.md). */
  const [editing, setEditing] = React.useState<{ rowId: string; original: string } | null>(null);
  /** An edit waiting for the interrupted turn to END (its result/aborted) before it goes. */
  const [pendingEdit, setPendingEdit] = React.useState<{ original: string; text: string; cid: string } | null>(null);
  /**
   * Entering edit mode STOPPED a running turn, and nothing has replaced it yet.
   *
   * This is the honest half of the reported bug. The agent no longer keeps answering the message
   * being corrected — but an interrupted turn cannot be un-interrupted, so the screen must not
   * pretend the pause was a freeze. Cancelling the edit surfaces the banner below: the turn WAS
   * cut, and continuing is a deliberate click (a new turn), not magic.
   */
  const [interruptedForEdit, setInterruptedForEdit] = React.useState(false);
  /** The reserved word the CURRENT turn was sent with — what the activity bar reports as effort. */
  const [escalation, setEscalation] = React.useState<{ ultrathink: boolean; ultracode: boolean } | null>(null);

  /** Stop the running turn. `reason` tells the back which note narrates the cut. */
  const sendInterrupt = React.useCallback(
    (reason?: "edit"): boolean => {
      try {
        sendFrame(reason ? { type: "interrupt", reason } : { type: "interrupt" });
      } catch (err) {
        toast.error((err as Error).message);
        return false;
      }
      // The turn's `result` will come back as an error with no words — the reducer needs to know
      // it was US who asked, so it draws nothing instead of a mute red "error" (see sdkChat.ts).
      setState(markInterruptRequested);
      return true;
    },
    [sendFrame],
  );

  /** Push the edit frame. Returns whether the socket took it (a refusal is toasted, not thrown). */
  const dispatchEditFrame = React.useCallback(
    (original: string, text: string, cid: string = newCid()): boolean => {
      try {
        sendTurn({ type: "edit_user", original, text }, text, cid);
        return true;
      } catch (err) {
        toast.error((err as Error).message);
        return false;
      }
    },
    [sendTurn],
  );

  // The deferred half of "interrupt first": the edit goes the moment the interrupted turn reports
  // its result (turnActive falls). The timeout is the safety net — a turn that never closes must
  // not hold the correction hostage forever (the driver queues user turns anyway).
  React.useEffect(() => {
    if (!pendingEdit) return;
    if (!state.turnActive) {
      setPendingEdit(null);
      dispatchEditFrame(pendingEdit.original, pendingEdit.text, pendingEdit.cid);
      return;
    }
    const timer = setTimeout(() => {
      setPendingEdit(null);
      dispatchEditFrame(pendingEdit.original, pendingEdit.text, pendingEdit.cid);
    }, EDIT_INTERRUPT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pendingEdit, state.turnActive, dispatchEditFrame]);

  /* -------------------------------------------------------- replying to a decision */

  /**
   * The decision the composer is currently ANSWERING — the whole point of this screen's honesty:
   * with it armed, what the person types goes to THAT question (and says so, with the question in
   * view); with it null, the same words are a loose message. Nothing here is implicit — arming is
   * always a click, and the X disarms.
   */
  const [replyTo, setReplyTo] = React.useState<PendingDecision | null>(null);

  /**
   * STEP INTO EDIT MODE — and PAUSE the agent while doing it.
   *
   * The bug this closes, in the owner's words: "mandei o texto sem querer, cliquei pra editar, e em
   * vez de ele PAUSAR o raciocínio, ele continua respondendo normalmente". Opening the edit bar
   * used to be a purely local gesture: the driver never heard about it and kept working on the very
   * message being corrected — burning a turn on words that were about to be withdrawn. The stop now
   * goes at the GESTURE, not at the send (which is what the deferred-edit path below already did).
   */
  const beginEdit = React.useCallback(
    (rowId: string, original: string): void => {
      setReplyTo(null); // editing and answering a decision are two different gestures
      setEditing({ rowId, original });
      if (!state.turnActive) return;
      if (sendInterrupt("edit")) setInterruptedForEdit(true);
    },
    [state.turnActive, sendInterrupt],
  );

  const send = async (raw: string): Promise<void> => {
    const text = raw.replace(/\r$/, "").trim();
    if (!text) return;
    // `ultrathink` / `ultracode` in what was just sent: the driver raises the turn's effort for
    // THIS turn only, and the activity bar is where that becomes visible — the panel used to
    // escalate in silence (the word was painted in the bubble and nothing else ever said it took).
    const ultra = ultraKeywords(text);
    setEscalation(ultra.ultrathink || ultra.ultracode ? ultra : null);
    // Anything the person sends REPLACES the interrupted turn — the "continuar?" offer is moot.
    setInterruptedForEdit(false);
    if (replyTo && !editing) {
      // A structured card is settled through its own channel (`question_answer`), so the driver
      // stops waiting and the card itself shows what it got. A prose question has no such channel:
      // the answer goes as a normal turn WRAPPED with the question it answers (see
      // `buildDecisionReply`) — unambiguous for the model, and re-anchorable after a reload.
      if (replyTo.kind === "question") {
        if (!answerUserQuestion(replyTo.rowId, [{ selected: [text] }])) {
          throw new Error(translate("sdk.offline")); // the composer keeps the words
        }
        setReplyTo(null);
        return;
      }
      const wrapped = buildDecisionReply(replyTo.text, text);
      const cid = newCid();
      setState((prev) => appendUserRow(prev, wrapped, undefined, { awaiting: true, cid, state: "sending" }));
      try {
        sendTurn({ type: "user", text: wrapped }, wrapped, cid);
      } catch (err) {
        toast.error((err as Error).message);
        throw err; // the composer keeps the words
      }
      setReplyTo(null);
      return;
    }
    if (editing) {
      const { original } = editing;
      const editCid = newCid();
      if (state.turnActive) {
        // Still running at send time. Either the stop `beginEdit` already sent has not reported
        // back yet (nothing more to do — just wait for it), or a turn started meanwhile (another
        // tab, a message folded in) and THAT one has to be stopped too. Either way the edit only
        // goes when the turn ends (the effect above): it must never land as the answer to a turn
        // the superseded message is still driving.
        if (!interruptedForEdit && !sendInterrupt("edit")) {
          throw new Error(translate("sdk.offline")); // the composer keeps the words
        }
        setPendingEdit({ original, text, cid: editCid });
      } else if (!dispatchEditFrame(original, text, editCid)) {
        throw new Error(translate("sdk.offline")); // the composer keeps the words
      }
      // Drawn now, in both paths: the original dims with its "editada" badge, the new version is
      // the standing message. The history writes the same two lines, so a replay agrees.
      setState((prev) => appendUserRow(markUserEdited(prev, original), text, undefined, {
        awaiting: true,
        cid: editCid,
        state: "sending",
      }));
      setEditing(null);
      return;
    }
    // Drawn FIRST, as "sending": the bubble exists the instant Enter is pressed, but it only
    // claims to be sent when the back says it gravou (`user_ack`) — see lib/sdkOutbox.ts.
    // `awaiting` starts the status ladder: "Preparando…"/"Pensando…" until the driver's first event.
    const cid = newCid();
    setState((prev) => appendUserRow(prev, text, undefined, { awaiting: true, cid, state: "sending" }));
    try {
      sendTurn({ type: "user", text }, text, cid);
    } catch (err) {
      toast.error((err as Error).message);
      throw err; // the composer keeps the words
    }
  };

  /** "Reenviar": the same words, the same receipt id — the back never had them, so this is not a copy. */
  const resendUndelivered = (cid: string): void => {
    const entry = outboxRef.current.find((m) => m.cid === cid);
    if (!entry) return;
    setState((prev) => settleUserRow(prev, cid, "sending"));
    setOutbox((prev) => retryOutbox(prev, entry, Date.now()));
    try {
      sendFrame(entry.original !== undefined
        ? { type: "edit_user", original: entry.original, text: entry.text, cid }
        : { type: "user", text: entry.text, cid });
    } catch (err) {
      toast.error((err as Error).message);
      setOutbox((prev) => markUndelivered(prev, [cid]));
      setState((prev) => settleUserRow(prev, cid, "undelivered"));
    }
  };

  /** "Descartar": the person gave up on this send — the bubble and the stored copy both go. */
  const discardUndelivered = (cid: string): void => {
    setOutbox((prev) => dropFromOutbox(prev, cid));
    setState((prev) => dropUserRow(prev, cid));
  };

  const interrupt = (): void => {
    sendInterrupt();
  };

  /**
   * "Continuar de onde parou" — the only truthful resume this wire has: a NEW turn asking the agent
   * to pick the work back up. The SDK cannot un-interrupt a turn, so the screen says so (the banner)
   * and makes continuing an explicit click instead of faking that nothing happened.
   */
  const resumeInterruptedTurn = (): void => {
    // A turn like any other: drawn as "sending" and taken off the outbox only by its `user_ack`.
    const cid = newCid();
    setState((prev) => appendUserRow(prev, RESUME_TURN_TEXT, undefined, { awaiting: true, cid, state: "sending" }));
    try {
      sendTurn({ type: "user", text: RESUME_TURN_TEXT }, RESUME_TURN_TEXT, cid);
    } catch (err) {
      toast.error((err as Error).message);
      return; // the offer stays on screen — the bubble is already marked undelivered
    }
    setInterruptedForEdit(false);
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

  /** Returns whether the socket took the answer — a refusal must not disarm the reply composer. */
  const answerUserQuestion = (id: string, answers: SdkQuestionAnswer[]): boolean => {
    try {
      sendFrame({ type: "question_answer", id, answers });
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    }
    // Optimistic only in DRAWING — the driver echoes a `question_result`; the first settlement wins.
    setState((prev) => answerQuestion(prev, id, answers));
    return true;
  };

  /** The terminal's Esc gesture: an empty field steps into editing the LAST message of one's own. */
  const editLast = React.useCallback((): void => {
    // Mid-turn Esc keeps meaning "stop", not "edit": the button owns that gesture, and stopping a
    // turn is too big a consequence for a key you may have pressed to dismiss something. The pencil
    // is the explicit way in — and IT does pause the turn (see `beginEdit`).
    if (state.turnActive) return;
    for (let i = state.rows.length - 1; i >= 0; i -= 1) {
      const row = state.rows[i]!;
      // A decision answer is skipped for the same reason its pencil is hidden (see the bubble).
      if (row.kind === "user" && row.edited !== true && parseDecisionReply(row.text) === null
        && originRole(row.from, viewer) === "self") {
        beginEdit(row.id, row.text);
        return;
      }
    }
  }, [state.rows, state.turnActive, viewer, beginEdit]);

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
  /** The explicit replies already given — what anchors an answer under the question it answered. */
  const replies = React.useMemo(() => decisionReplies(state.rows), [state.rows]);
  /** Which rows are STILL waiting — only those offer "Responder" (a stale question must not arm). */
  const pendingIds = React.useMemo(() => new Set(pending.map((d) => d.rowId)), [pending]);

  /**
   * Tray click: scroll to the message, flash it, ARM the composer on it (when a typed line can
   * answer it) and take the cursor there. Arming leaves edit mode — one thing at a time.
   */
  const jumpToDecision = (decision: PendingDecision): void => {
    const el = rowRefs.current.get(decision.rowId);
    el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setFlashId(decision.rowId);
    if (decision.answerable) {
      setEditing(null);
      setReplyTo(decision);
    }
    rootRef.current?.querySelector("textarea")?.focus();
  };

  // THE OTHER TAB (and the agent that gave up waiting): the decision this composer is aimed at
  // stopped being pending — someone answered it elsewhere, it timed out, or Claude moved on. The
  // aim is dropped and said out loud, so the next Enter is never silently a loose message. Our own
  // send clears `replyTo` first, so it never trips this.
  React.useEffect(() => {
    if (!replyTo) return;
    if (pending.some((d) => d.rowId === replyTo.rowId)) return;
    setReplyTo(null);
    toast.message(translate("sdk.replyGone"));
  }, [pending, replyTo]);

  const rendered = React.useMemo(() => groupSdkRows(state.rows), [state.rows]);
  const empty = state.rows.length === 0;

  /* -------------------------------------------------- what is running, right now */

  // The activity bar's three facts: WHAT (the newest tool/reasoning/answer of this turn), for HOW
  // LONG, and whether the turn was escalated by a reserved word.
  const working = connected && (state.awaiting || state.turnActive);
  const activity = React.useMemo(() => (working ? currentActivity(state) : null), [working, state]);
  const seconds = useTurnClock(working);
  /* O verbo e a nota deste instante: é o que troca "Trabalhando…" parado por algo que anda. */
  const stage = workingStage(workingKindOf(activity, state.awaiting, state.ready), seconds);
  React.useEffect(() => {
    if (!working) setEscalation(null);
  }, [working]);

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
        {/* WHAT IS RUNNING — pinned to the top of the conversation for as long as work runs, so a
            long turn never leaves the person scrolling to find out whether anything is happening. */}
        {working ? (
          <SdkActivityBar
            activity={activity}
            seconds={seconds}
            escalation={escalation}
            awaiting={state.awaiting}
            ready={state.ready}
            onJump={stick.scrollToBottom}
          />
        ) : null}

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
                replies={replies}
                replyingTo={replyTo}
                onPermission={answerPermission}
                onAnswer={answerUserQuestion}
                onReply={pendingIds.has(entry.id) ? jumpToDecision : undefined}
                onEdit={beginEdit}
                onResend={resendUndelivered}
                onDiscard={discardUndelivered}
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
        {working ? (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="sdk-chat-working"
            data-phase={workingKindOf(activity, state.awaiting, state.ready)}
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-foreground/90">{t(stage.verb)}</span>
            <span data-testid="sdk-working-note" className="opacity-80">
              {escalation
                ? t("sdk.workingWithEffort", {
                    elapsed: formatElapsed(seconds),
                    note: t(stage.note),
                    effort: escalation.ultracode ? t("sdk.ultracodeOn") : t("sdk.effortHigh"),
                  })
                : t("sdk.workingWith", { elapsed: formatElapsed(seconds), note: t(stage.note) })}
            </span>
          </div>
        ) : null}
      </div>
      <JumpToLatest stick={stick} />
      </div>

      {/* PENDING DECISIONS — the questions still waiting on the user, surfaced right above the
          composer so they never drown in a long turn. Clicking one jumps to it in the chat. */}
      {pending.length > 0 ? <PendingTray pending={pending} active={replyTo} onJump={jumpToDecision} /> : null}

      {/* ANSWERING A DECISION — the missing sentence on this screen: the question is in view, right
          above the field, so what goes with the next Enter is not a guess. The X is the way OUT,
          for the recado solto the person meant to send instead. */}
      {replyTo ? (
        <div
          data-testid="sdk-reply-banner"
          data-row={replyTo.rowId}
          className="mt-1.5 flex items-start gap-1.5 rounded-md border border-sky-500/50 bg-sky-500/10 px-2.5 py-1.5 text-xs"
        >
          <Reply className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sky-600 dark:text-sky-400">{t("sdk.replyingTo")}</div>
            <div className="min-w-0 break-words text-muted-foreground">{replyTo.summary}</div>
          </div>
          <button
            type="button"
            data-testid="sdk-reply-cancel"
            aria-label={t("sdk.replyCancel")}
            title={t("sdk.replyCancel")}
            onClick={() => setReplyTo(null)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-sky-500/20 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* THE TURN WAS CUT, AND SAYING SO BEATS PRETENDING. Entering edit mode stopped the agent;
          the person then cancelled the edit. There is no un-interrupting a turn on this wire, so
          instead of faking a seamless resume the screen states what happened and offers ONE
          explicit way forward — a new turn asking the agent to pick the work back up. Hidden while
          the edit bar is open (the send is the way forward there) and while a turn is running
          (something IS working — there is nothing to continue). */}
      {interruptedForEdit && !editing && !state.turnActive ? (
        <div
          data-testid="sdk-interrupted-banner"
          className="mt-1.5 flex items-start gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-1.5 text-xs"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1 break-words text-muted-foreground">{t("sdk.interruptedForEdit")}</div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 text-[11px]"
            data-testid="sdk-resume-turn"
            onClick={resumeInterruptedTurn}
          >
            {t("sdk.resumeTurn")}
          </Button>
          <button
            type="button"
            data-testid="sdk-interrupted-dismiss"
            aria-label={t("sdk.interruptedDismiss")}
            title={t("sdk.interruptedDismiss")}
            onClick={() => setInterruptedForEdit(false)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-amber-500/20 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* The interrupt button lives INSIDE the composer — right column, above the microphone —
          in the same seat as the transcript chat's stop. The interrupt frame is still this view's. */}
      <TerminalComposer
        className="mt-1.5"
        cardId={cardId}
        active={active}
        onSend={send}
        onUploadImage={onUploadImage}
        placeholder={replyTo ? t("sdk.replyPlaceholder") : undefined}
        commands={state.commands}
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
function PendingTray({
  pending,
  active,
  onJump,
}: {
  pending: PendingDecision[];
  /** The one the composer is aimed at right now — marked so a stack of decisions stays readable. */
  active: PendingDecision | null;
  onJump: (d: PendingDecision) => void;
}) {
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
                data-active={active?.rowId === d.rowId || undefined}
                title={d.answerable ? t("sdk.replyAction") : undefined}
                onClick={() => onJump(d)}
                className={cn(
                  "flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-muted-foreground hover:bg-amber-500/10 hover:text-foreground",
                  active?.rowId === d.rowId && "bg-sky-500/15 text-foreground",
                )}
              >
                {d.kind === "question" ? (
                  <CircleHelp className="h-3 w-3 shrink-0 text-sky-500" />
                ) : (
                  <MessageSquare className="h-3 w-3 shrink-0 text-amber-500/80" />
                )}
                <span className="min-w-0 flex-1 truncate">{d.summary}</span>
                {/* The tray's whole promise in one glyph: clicking here points the composer AT this. */}
                {d.answerable ? <CornerDownLeft className="h-3 w-3 shrink-0 opacity-70" /> : null}
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
          <span data-testid="sdk-tool-group-last" className="min-w-0 truncate opacity-70">
            {toolHeadline(last.name, last.input).title}
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

/**
 * THE TURN'S CLOCK — seconds since the work started, ticking while it runs.
 *
 * "Trabalhando…" with no number is the same word at second 2 and at minute 9, and the difference
 * between those two is the whole question the person is asking the screen. Reset (and the interval
 * dropped) the moment the work stops, so an idle chat holds no timer.
 */
function useTurnClock(active: boolean): number {
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

/**
 * QUAL FASE nomear agora. O que a barra sabe (a atividade viva, se a sessão ainda está subindo)
 * vira a fase que `workingStage` sabe descrever. PURE.
 */
export function workingKindOf(
  activity: { kind: "tool" | "thinking" | "answering" } | null,
  awaiting: boolean,
  ready: boolean,
): WorkingKind {
  if (awaiting && !ready) return "preparing";
  if (activity) return activity.kind;
  return awaiting ? "thinking" : "working";
}

/** Elapsed, the way the CLI writes it: `4s`, `1m 24s`. PURE. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * THE ACTIVITY BAR — pinned to the top of the conversation while something is running.
 *
 * The problem it solves is the one the terminal does not have: in the TUI the status line is always
 * on screen, at the bottom, saying what the agent is doing and for how long. In the chat that
 * information was scattered through the scroll — and a long turn (an agent, a skill, a build) puts
 * it far above the fold, so the person watching a card had to scroll to find out whether anything
 * was still happening.
 *
 * So while a turn is live this bar carries three things and never moves: WHAT is running (the
 * newest tool headline, the reasoning, the answer being written), for HOW LONG, and whether the
 * turn was escalated (`ultrathink`/`ultracode` — the words that cost real money and time). A click
 * jumps to the live edge of the conversation, which is where that work is being drawn.
 */
function SdkActivityBar({
  activity,
  seconds,
  escalation,
  awaiting,
  ready,
  onJump,
}: {
  activity: SdkActivity | null;
  seconds: number;
  escalation: { ultrathink: boolean; ultracode: boolean } | null;
  awaiting: boolean;
  ready: boolean;
  onJump: () => void;
}) {
  const t = useT();
  /* O nome da ferramenta ganha do verbo — "Rodando testes" diz mais que "Executando…". Fora isso,
     é o mesmo vocabulário do indicador lá embaixo (workingStage): verbo que troca, nota que escala. */
  const stage = workingStage(workingKindOf(activity, awaiting, ready), seconds);
  const label = activity?.kind === "tool" && !(awaiting && !ready) ? activity.label : t(stage.verb);
  const effort = escalation ? (escalation.ultracode ? t("sdk.ultracodeOn") : t("sdk.effortHigh")) : null;
  return (
    <button
      type="button"
      onClick={onJump}
      data-testid="sdk-activity-bar"
      data-kind={activity?.kind ?? (awaiting ? "awaiting" : "working")}
      aria-label={t("sdk.activityAria")}
      className={cn(
        "sticky top-0 z-10 -mx-3 -mt-3 flex w-[calc(100%+1.5rem)] items-center gap-2 border-b border-border/60",
        "bg-card/95 px-3 py-1.5 text-left text-xs text-muted-foreground backdrop-blur",
        "hover:text-foreground",
      )}
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span data-testid="sdk-activity-label" className="min-w-0 flex-1 truncate font-medium text-foreground/90">
        {label}
      </span>
      {activity?.background ? (
        <span className="hidden shrink-0 opacity-70 sm:inline">{t("sdk.toolBackground")}</span>
      ) : null}
      <span data-testid="sdk-activity-elapsed" className="shrink-0 opacity-70">
        {t("sdk.workingWith", { elapsed: formatElapsed(seconds), note: t(stage.note) })}
      </span>
      {effort ? (
        <span
          data-testid="sdk-activity-effort"
          className="shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide opacity-80"
        >
          {effort}
        </span>
      ) : null}
    </button>
  );
}

/**
 * ONE TOOL CALL, the way the terminal draws it: the headline, and the detail under it.
 *
 * What it replaces: `Bash` followed by a truncated dump of the input. The agent's own description
 * of what it is doing ("Measuring PDV module size") was in that input and never made it to the
 * screen, and a `Skill(code-review)` that goes off to run in the background looked exactly like a
 * file being read. See `toolHeadline` for the mapping.
 */
function SdkToolRow({ row }: { row: Extract<SdkRow, { kind: "tool" }> }) {
  const t = useT();
  const headline = toolHeadline(row.name, row.input);
  const detail = headline.background ? t("sdk.toolBackground") : headline.detail;
  return (
    <div data-testid="sdk-tool" data-tool={row.name} className="min-w-0 pl-0.5 text-xs">
      <div className="flex items-baseline gap-1.5 text-muted-foreground">
        <Wrench className="h-3 w-3 shrink-0 translate-y-0.5 opacity-70" />
        <span data-testid="sdk-tool-title" className="min-w-0 truncate font-medium text-foreground/90">
          {headline.title}
        </span>
      </div>
      {detail ? (
        <div
          data-testid="sdk-tool-detail"
          data-background={headline.background || undefined}
          className="mt-0.5 flex min-w-0 items-baseline gap-1 pl-[1.1rem] text-muted-foreground/75"
        >
          <span aria-hidden className="shrink-0 select-none opacity-60">⌊</span>
          <span className={cn("min-w-0 truncate", !headline.background && "font-mono")}>{detail}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * O RACIOCÍNIO do modelo, enquanto ele trabalha.
 *
 * O que isto resolve: um turno longo mostrava só um spinner e a palavra "Trabalhando…" — podia ser
 * meio segundo ou dez minutos, e quem esperava não tinha como saber se o agente entendeu o pedido.
 * Agora o pensamento aparece ao vivo, em segundo plano (menor, em itálico, sem o peso da resposta).
 *
 * ABERTO POR PADRÃO, e continua aberto quando o turno acaba (pedido do César, 26/09/2026): ele lê
 * o raciocínio pra saber o que a IA está fazendo, e recolher sozinho no fim escondia justamente a
 * explicação do que acabou de acontecer. Quem não quer ler fecha — e o fechado daquela linha fica
 * fechado.
 */
function SdkThinkingRow({ text, streaming }: { text: string; streaming: boolean }): React.ReactElement {
  const t = useT();
  // Só a escolha EXPLÍCITA da pessoa manda; sem ela, fica aberto — antes ele seguia o turno e se
  // recolhia sozinho no fim, que é exatamente o que estava escondendo o raciocínio.
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const open = choice ?? true;
  return (
    <div data-testid="sdk-thinking" data-streaming={streaming || undefined} data-open={open || undefined}>
      <button
        type="button"
        data-testid="sdk-thinking-toggle"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 hover:text-foreground"
      >
        <Brain className={cn("h-3 w-3 shrink-0", streaming && "animate-pulse")} />
        <span>{t("sdk.reasoning")}</span>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div
          data-testid="sdk-thinking-text"
          className="mt-1 select-text whitespace-pre-wrap break-words border-l-2 border-muted pl-2.5 text-xs italic leading-relaxed text-muted-foreground"
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

function SdkChatRow({
  row,
  replies,
  replyingTo,
  onPermission,
  onAnswer,
  onReply,
  onEdit,
  onResend,
  onDiscard,
}: {
  row: SdkRow;
  /** Explicit replies already given, by the row they answered — what a question shows it received. */
  replies?: Map<string, string>;
  /** The decision the composer is aimed at (so the question it points to says so, in place). */
  replyingTo?: PendingDecision | null;
  onPermission?: (id: string, allow: boolean) => void;
  onAnswer?: (id: string, answers: SdkQuestionAnswer[]) => void;
  /** Arms the composer on this row's question ("Responder"). */
  onReply?: (decision: PendingDecision) => void;
  /** Offered only on one's OWN messages: the pencil that starts editing (a supersede). */
  onEdit?: (rowId: string, original: string) => void;
  /** On a message the server never took: send the very same words again (same receipt id). */
  onResend?: (cid: string) => void;
  /** On a message the server never took: give up on it (bubble and stored copy both go). */
  onDiscard?: (cid: string) => void;
}) {
  const t = useT();
  // Whose screen this is — their own messages render unlabelled, everyone else's carry the sender.
  const viewer = useAuth().user?.username;

  if (row.kind === "question") {
    return <SdkQuestionCard row={row} onAnswer={onAnswer} />;
  }

  if (row.kind === "tool") {
    return <SdkToolRow row={row} />;
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
      <div data-testid="sdk-note" data-note={row.text} className="py-0.5 text-center text-xs italic text-muted-foreground/70">
        {noteText(row.text, t)}
      </div>
    );
  }

  if (row.kind === "command_output") {
    // The CLI's own answer to a local command (/cost, /usage): monospaced and framed, so it reads
    // as what it is — the session reporting, not Claude speaking.
    return (
      <div
        data-testid="sdk-command-output"
        className="whitespace-pre-wrap rounded-md border border-border/70 bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground"
      >
        {row.text}
      </div>
    );
  }

  if (row.kind === "thinking") {
    return <SdkThinkingRow text={row.text} streaming={row.streaming} />;
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
    // An ANSWER to a decision, not a loose message: the bubble carries the question it answered, so
    // "respondi ou só mandei um recado?" is settled by looking at what was sent. The wrapper the
    // model received is unwrapped here — the person reads their own words, with the question above.
    const reply = parseDecisionReply(row.text);
    const replyHeader = reply ? (
      <div data-testid="sdk-user-reply" className="mb-1 flex items-start gap-1 border-b border-current/15 pb-1 text-[10px] text-muted-foreground">
        <Reply className="mt-px h-2.5 w-2.5 shrink-0" />
        <span className="min-w-0 break-words italic">{reply.question}</span>
      </div>
    ) : null;
    const bodyText = reply ? reply.answer : row.text;
    /**
     * A message the SERVER never took (it refused it, or the receipt never came). The bubble says
     * so and hands back the two things the person actually needs: mandar de novo, ou desistir. The
     * words are on disk until one of those happens — the F5 that used to erase them now brings
     * this very bubble back (see lib/sdkOutbox.ts).
     */
    const undelivered = row.state === "undelivered" && row.cid ? (
      <div
        data-testid="sdk-user-undelivered"
        className="mt-1 flex flex-wrap items-center justify-end gap-1.5 text-[10px] text-amber-500"
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span className="min-w-0 text-right italic">{t("sdk.undelivered")}</span>
        <button
          type="button"
          data-testid="sdk-user-resend"
          onClick={() => onResend?.(row.cid as string)}
          className="rounded border border-current/40 px-1.5 py-0.5 font-medium hover:bg-amber-500/10"
        >
          {t("chat.resend")}
        </button>
        <button
          type="button"
          data-testid="sdk-user-discard"
          onClick={() => onDiscard?.(row.cid as string)}
          className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("chat.discard")}
        </button>
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
            {replyHeader}
            <LinkifiedText text={bodyText} />
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
          data-state={row.state}
          data-edited={row.edited || undefined}
          className={cn(
            "max-w-[85%] select-text whitespace-pre-wrap break-words rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm",
            row.edited && "opacity-60",
          )}
        >
          {replyHeader}
          <LinkifiedText text={bodyText} />
          {editedBadge}
          {absorbedTag}
          {undelivered}
        </div>
        {/* The pencil: hover-revealed on a desktop, simply there on touch (no hover to reveal it).
            A superseded message offers no pencil — the standing version is the one to edit. Neither
            does an ANSWER to a decision: its text carries the wrapper, and putting that back in the
            field would show the person plumbing instead of their own words. Answer again instead. */}
        {!row.edited && !reply && row.state !== "undelivered" && onEdit ? (
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
    // What this question RECEIVED, anchored to it — the third question the screen owes the person
    // ("pronto, respondi"). Survives a reload: the answer is read back out of the sent message.
    const answered = replies?.get(row.id);
    const aiming = replyingTo?.rowId === row.id;
    return (
      <div data-testid="sdk-assistant" className="max-w-full select-text text-sm leading-relaxed">
        {prose.body !== "" ? <Markdown text={prose.body} /> : null}
        <div
          data-testid="sdk-prose-question"
          data-answered={answered !== undefined || undefined}
          className={cn(
            "mt-1.5 rounded-md border px-2.5 py-1.5",
            answered !== undefined
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-amber-500/30 bg-amber-500/5",
          )}
        >
          <Markdown text={prose.question} />
          {answered !== undefined ? (
            <div data-testid="sdk-prose-answered" className="mt-1 border-t border-emerald-500/20 pt-1 text-xs text-emerald-600 dark:text-emerald-400">
              {t("sdk.questionAnswered", { answers: answered })}
            </div>
          ) : onReply ? (
            <Button
              size="sm"
              variant={aiming ? "default" : "outline"}
              className="mt-1.5 h-6 text-[11px]"
              data-testid="sdk-prose-reply"
              aria-pressed={aiming}
              onClick={() =>
                onReply({
                  kind: "prose",
                  rowId: row.id,
                  text: prose.question,
                  summary: decisionSummary(prose.question),
                  answerable: true,
                })
              }
            >
              {t("sdk.replyAction")}
            </Button>
          ) : null}
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
          {row.outcome === "answered"
            ? t("sdk.questionAnswered", { answers: chosen.join(" · ") })
            : row.outcome === "superseded"
              ? t("sdk.questionSuperseded")
              : t("sdk.questionUnanswered")}
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

/**
 * A note row's words. Some notes travel as CODES (the back writes them, the reader may be reading
 * in either language); anything else is already a sentence and passes through. PURE.
 */
function noteText(text: string, t: ReturnType<typeof useT>): string {
  if (text.startsWith("resume:")) return t("sdk.resumed", { id: text.slice("resume:".length, "resume:".length + 8) });
  if (text === TERMINAL_ACTIVITY_NOTE) return t("sdk.terminalActivity");
  if (text === TURN_INTERRUPTED_EDIT_NOTE) return t("sdk.noteInterruptedEdit");
  if (text === TURN_INTERRUPTED_NOTE) return t("sdk.noteInterrupted");
  return text;
}

/**
 * WHAT WENT WRONG, IN WORDS. This chat once showed a red bubble reading literally "error" — the
 * turn's failure had no text of its own and the raw value was drawn as-is. Nothing reaches the
 * reader as jargon or as an empty word any more: the known refusals and the reducer's sentinels
 * (see sdkChat.ts) become a sentence that says what happened AND what to do. Anything already
 * written as a sentence by the driver passes through untouched. PURE.
 */
function errorText(text: string, t: ReturnType<typeof useT>): string {
  if (/sdkDriver setting/i.test(text)) return t("sdk.flagOff");
  if (text === SDK_ERROR_NO_DETAIL) return t("sdk.errorNoDetail");
  if (text.startsWith(SDK_ERROR_TURN_FAILED)) {
    const subtype = text.slice(SDK_ERROR_TURN_FAILED.length + 1);
    return subtype === "" ? t("sdk.turnFailed") : t("sdk.turnFailedWhy", { subtype });
  }
  // The driver's process died (idle stop, a crash, a deploy). The front reconnects on its own —
  // which is exactly what the reader cannot tell from "driver exited (code 1)".
  if (/^driver (exited|process error)/i.test(text)) return t("sdk.driverGone", { detail: text });
  if (/^could not install the driver/i.test(text)) return t("sdk.driverInstallFailed", { detail: text });
  if (/^this card no longer exists$/i.test(text)) return t("sdk.cardGone");
  return text;
}
