import * as React from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  Maximize2,
  FileDiff,
  AlertTriangle,
  Brain,
  ChevronRight,
  CircleHelp,
  TriangleAlert,
  CornerDownLeft,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  MessageSquare,
  Pencil,
  Reply,
  ShieldAlert,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNow, usePageVisible } from "@/lib/useNow";
import { wsUrl } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/providers/auth";
import { TerminalComposer } from "@/features/board/components/TerminalComposer";
import { useVoiceCall } from "@/features/voice/useVoiceCall";
import { VoiceCallBar } from "@/features/voice/VoiceCallBar";
import { VoiceCallContext, type VoiceCallControl } from "@/features/voice/ComposerVoiceButton";
import { VoiceTurnBubble } from "@/features/voice/VoiceTurnBubble";
import { typedContext } from "@/features/voice/voiceContext";
import { useVoiceDelegation } from "@/features/voice/useVoiceDelegation";
import { AnswerActions } from "@/features/voice/AnswerActions";
import { readAloud, readAloudError, setReadAloudErrorHandler } from "@/features/voice/readAloud";
import { PlanUsageAlert, cardRateLimitsKey, useCardPlanUsage } from "@/features/board/components/PlanUsage";
import { ContextMeter, ContextNotice } from "@/features/board/components/ContextMeter";
import { planAlert, planWindows } from "@/features/board/lib/planUsage";
import { LinkifiedText, Markdown, SenderTag } from "@/features/board/components/ChatView";
import { SdkQueueTray } from "@/features/board/components/SdkQueueTray";
import { originRole, personOrigin, type MessageOrigin } from "@/features/board/lib/chat";
import {
  applyPeerTyping,
  createTypingSignal,
  nextPeerExpiry,
  peerDisplayName,
  typingNames,
  type PeerTyping,
  type TypingSignal,
} from "@/features/board/lib/peerTyping";
import {
  applyPeerQuestionDraft,
  createDraftSender,
  isEmptyDraft,
  peerDraftsOf,
  readPeerQuestionDraft,
  type PeerQuestionDrafts,
  type QuestionDraft,
} from "@/features/board/lib/peerQuestionDraft";
import { forgetQuestionDraftMemoryForTesting, readQuestionDraft, writeQuestionDraft } from "@/features/board/lib/questionDraftStore";
import { nextIdentity, type ViewerIdentity } from "@/features/board/lib/viewerIdentity";
import { PeerTypingIndicator } from "@/features/board/components/PeerTypingIndicator";
import { SdkAgentCard } from "@/features/board/components/SdkAgentCard";
import { TodoCard } from "@/features/board/components/TodoCard";
import { SdkThreadContext, type SdkThread } from "@/features/board/components/sdkThreadContext";
import { isAgentTool, latestTodoRowId, splitSubagentRows, type SubagentSplit } from "@/features/board/lib/sdkSubagents";
import { WorkflowPanel } from "@/features/board/components/WorkflowPanel";
import {
  WorkflowFeedContext,
  createWorkflowFeedChannel,
  parseWorkflowFeedResponse,
  type WorkflowFeedChannel,
} from "@/features/board/lib/workflowFeed";
import { ultraKeywords } from "@/features/board/lib/ultraWords";
import { workingStage, type WorkingKind } from "@/features/board/lib/workingStage";
import { createReconnectBackoff, type ConnectionState } from "@/features/board/lib/reconnect";
import { reasoningTranslator, useReasoningTranslation } from "@/features/board/lib/reasoningTranslation";
import { JumpToLatest, useStickToBottom } from "@/features/board/components/JumpToLatest";
import { ToolDiffCard } from "@/features/board/components/ToolDiffCard";
import { FleetPanel, FleetRow, SdkDetailContext, SdkDetailHost, SdkFleet, StatusIcon, ToolResultText, useChangedFiles, type DetailView } from "@/features/board/components/SdkDetail";
import { DetailChannelContext, agentElapsedMs, createDetailChannel, parseDetailResponse, toolStatus, type DetailChannel } from "@/features/board/lib/sdkDetail";
import { toolDiff } from "@/features/board/lib/toolDiff";
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
  answerQuestion,
  applySdkEvent,
  appendBtwRow,
  appendUserRow,
  mergeLiveVoiceTurns,
  BTW_EXPIRE_MS,
  expireBtwRows,
  btwQuestion,
  coalesceDeltas,
  decidePermission,
  deliveredUserTexts,
  dropUserRow,
  currentActivity,
  finishedAnswerIds,
  groupSdkRows,
  isSdkDelta,
  liveActivityDetail,
  liveUserCids,
  markInterruptRequested,
  markUserEdited,
  isFirstUserRow,
  parseSdkFrame,
  settleUserRow,
  formatTurnElapsed,
  toolHeadline,
  toolLiveLabel,
  turnHasRoomForMore,
  type SdkActivity,
  type SdkChatState,
  cancelledText,
  errorText,
  noteText,
  type SdkQuestionAnswer,
  type BackgroundTask,
  type SdkEvent,
  type SdkRow,
} from "@/features/board/lib/sdkChat";
import {
  OUTBOX_ACK_TIMEOUT_MS,
  addToOutbox,
  dropFromOutbox,
  markUndelivered,
  newCid,
  overdueMessages,
  planAutoResend,
  readOutbox,
  reconcileOutbox,
  retryOutbox,
  askResend,
  sendMark,
  writeOutbox,
  type OutboxMessage,
} from "@/features/board/lib/sdkOutbox";
import {
  dequeue,
  enqueue,
  foreignToOutbox,
  headOfQueue,
  lastQueued,
  markEditing,
  newQueueId,
  outboxToQueue,
  readQueue,
  releaseEditing,
  updateQueued,
  writeQueue,
  type QueuedMessage,
} from "@/features/board/lib/sdkQueue";
import { getLanguage, t as translate, useT } from "@/i18n";
import { SdkCompactionRow } from "@/features/board/components/SdkCompactionRow";
import { SdkCommandChip } from "@/features/board/components/SdkCommandChip";
import { invokedCommand, type InvokedCommand } from "@/features/board/lib/slashMenu";

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

/** The longest streamed tokens wait for an animation frame (a hidden tab gets none). */
const DELTA_FLUSH_MAX_MS = 100;

export interface SdkChatViewProps {
  cardId: string;
  /** Is this card the one on screen? (see ChatView — the composer must not steal the keyboard) */
  active?: boolean;
  /** Uploads an image and resolves with its path inside the runner (appended to the message). */
  onUploadImage?: (file: File) => Promise<string | null>;
  onStatus?: (state: ConnectionState) => void;
  /** The card is working, per the hooks. Only matters for a turn running in the Terminal tab (the chat
   *  mirrors it and the driver says nothing): it is the only source that the turn is still alive. */
  terminalWorking?: boolean;
  /**
   * Rendered right above the composer: what belongs to the CARD and not to the conversation (the
   * PR blocks). The composer lives in here, so this is the only way to sit next to it from outside.
   */
  footer?: React.ReactNode;
  ariaLabel?: string;
  className?: string;
}

/**
 * The stored messages THIS account may send again: its own, and the ones with no author (recorded
 * before the field existed). One from another account, going out over this connection, would end up under the wrong name. PURE.
 */
function ownSends(outbox: readonly OutboxMessage[], viewer: string | undefined): OutboxMessage[] {
  return outbox.filter((m) => !m.from || m.from.name === viewer);
}

export function SdkChatView({ cardId, active = true, onUploadImage, onStatus, terminalWorking = false, footer, ariaLabel, className }: SdkChatViewProps) {
  const t = useT();
  // Whose screen this is — the edit affordance belongs only to one's own messages.
  const me = useAuth().user;
  const viewer = me?.username;
  /**
   * Who THIS tab's sends are from, stamped on its own bubbles and outbox copies. An unstamped own
   * bubble read as "self" for WHOEVER was signed in — so after a switch of account the old
   * account's message showed as the new one's until an F5 replayed it with its real author.
   */
  const selfOrigin = React.useMemo<MessageOrigin | undefined>(
    () => (me ? personOrigin(me) : undefined),
    [me],
  );
  const selfOriginRef = React.useRef(selfOrigin);
  selfOriginRef.current = selfOrigin;
  /**
   * The account this socket speaks for. The back stamps the author ONCE per connection, so a switch
   * of account (SessionGuard revalidates `/auth/me` on focus) must open a NEW connection — the
   * `epoch` moves only on a real switch between two known accounts (see lib/viewerIdentity.ts).
   */
  const [identity, setIdentity] = React.useState<ViewerIdentity>({ id: null, epoch: 0 });
  React.useEffect(() => {
    setIdentity((prev) => nextIdentity(prev, me?.id));
  }, [me?.id]);
  /** "Cesar está digitando…" — who else is writing in this card (see lib/peerTyping.ts). */
  const [peers, setPeers] = React.useState<PeerTyping>({});
  const [peersNow, setPeersNow] = React.useState(() => Date.now());
  /** What the other people on the card are answering in the question cards (lib/peerQuestionDraft.ts). */
  const [peerDrafts, setPeerDrafts] = React.useState<PeerQuestionDrafts>({});
  /** This tab's own outbound typing signal (created below, once `sendFrame` exists). */
  const typingRef = React.useRef<TypingSignal | null>(null);
  /** `commitState` belongs to the socket (the only one that knows the stream's order); everything else uses `setState`. */
  const [state, commitState] = React.useState<SdkChatState>(INITIAL_SDK_STATE);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  /** The rows of RIGHT NOW, for the callbacks that read them without having to be recreated on every event. */
  const rowsRef = React.useRef(state.rows);
  rowsRef.current = state.rows;
  /**
   * Flushes the tokens waiting for the animation frame (see the websocket effect) and says whether there
   * were any. They have already ARRIVED: a local action that decided or wrote without them would be judged by
   * a screen one frame behind — the Enter that goes straight to the socket with a turn just opening, the
   * bubble born before the answer that arrived first.
   */
  const flushStreamRef = React.useRef<() => boolean>(() => false);
  /** Every local write to the conversation goes in AFTER the tokens that have already arrived. */
  const setState = React.useCallback((update: React.SetStateAction<SdkChatState>): void => {
    flushStreamRef.current();
    commitState(update);
  }, []);
  /** The conversation with the already-arrived tokens inside — what a gesture reads to decide. Handlers only. */
  const readSettledState = React.useCallback((): SdkChatState => {
    flushSync(() => {
      flushStreamRef.current();
    });
    return stateRef.current;
  }, []);
  const socketRef = React.useRef<WebSocket | null>(null);
  /**
   * CONDEMN the current socket and reconnect right away (see the watchdog). Filled in by the live connection;
   * outside it, does nothing.
   */
  const abandonSocketRef = React.useRef<() => void>(() => {});
  /** Where the response to a `workflow_feed` is delivered (the workflow panel listens; see lib/workflowFeed.ts). */
  const workflowFeedRef = React.useRef<WorkflowFeedChannel | null>(null);
  /** Where the response to a `detail` is delivered (the modals listen; see lib/sdkDetail.ts). */
  const detailChannelRef = React.useRef<DetailChannel | null>(null);
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
  /**
   * Since when this connection can ANSWER — the floor of the receipt clock (see lib/sdkOutbox.ts).
   *
   * `connected` only says the websocket handshake finished; the server still takes seconds
   * to SERVE the socket (driver install over SSH+docker, transcript probe with a 15s timeout,
   * history replay, spawn) and until then keeps the frames in a buffer, delivering them later. The
   * `ready` is the instant it took over this connection — and it is from it, not from the send, that the deadline
   * counts. `null` = nothing here can accuse anyone.
   */
  const answerableSinceRef = React.useRef<number | null>(null);
  /**
   * THE QUEUE — what was written while a turn was still running (see lib/sdkQueue.ts).
   *
   * Nothing in here has gone to the server yet: these are messages WAITING, drawn right above the text
   * field and still editable. Each one leaves here one at a time, when the previous turn closes —
   * and only at that instant does it move up into the conversation, as a real bubble, with a receipt.
   */
  const [queue, setQueue] = React.useState<QueuedMessage[]>(() => releaseEditing(readQueue(cardId)));
  /** What the queue holds RIGHT NOW, without re-arming the callbacks on every message written. */
  const queueRef = React.useRef(queue);
  queueRef.current = queue;
  React.useEffect(() => {
    writeQueue(cardId, queue);
  }, [cardId, queue]);
  /**
   * The queued message that is BEING EDITED — it left the queue and is in the text field.
   *
   * While it is here it CANNOT be delivered: that is exactly what the owner asked for ("se eu clicar
   * em editar e ela tiver na fila ela não pode ser enviada, pois é como se estivesse cancelada" — "if I
   * click edit and it is in the queue it cannot be sent, because it is as if it were cancelled").
   * It STAYS in the queue, marked (`editing`) and skipped by the dispatch — never out of it: that is what
   * makes an F5 in the middle of the correction give the text back instead of erasing it, and what makes cancelling
   * put it back in its place instead of sending it to the end. Only what the FIELD needs to know lives here.
   */
  const [queueEdit, setQueueEdit] = React.useState<{ id: string; text: string } | null>(null);

  /* ------------------------------------------------------------- websocket */

  React.useEffect(() => {
    commitState(INITIAL_SDK_STATE);
    setPeers({});
    // The old socket's close no longer reports (it is disposed): this connection starts offline.
    setConnected(false);
    setOutbox(readOutbox(cardId));
    // A reload clears the text field, so nothing is being rewritten: the message that was there
    // goes back to being a normal wait, with the text it had before the correction.
    setQueue(releaseEditing(readQueue(cardId)));
    setQueueEdit(null);
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    /**
     * The backoff only resets when the SERVER takes over the connection (`ready`), never on `onopen`: the back
     * accepts the websocket and only afterwards finds out it cannot serve it (driver off, card
     * deleted, install that failed) — it sends the error and closes. Reset on the handshake, this became
     * a reconnect at ~2Hz forever, each one paying the server's whole setup.
     */
    const backoff = createReconnectBackoff(Math.random);
    let disposed = false;
    const setStatus = (s: ConnectionState): void => statusRef.current?.(s);
    /**
     * The TOKENS that arrived in this animation frame. The driver sends one socket frame per token;
     * they go in all at once, on the next frame, so the whole conversation renders once per
     * frame and not once per token. The timer covers the background tab, where rAF does not fire.
     *
     * The wire dropping does not touch this: this wait's timer is born before the reconnect timer and is
     * shorter (`DELTA_FLUSH_MAX_MS` < `RECONNECT_BASE_MS`), so it fires first — the next
     * connection's `onopen` always finds the buffer empty. Only a card/account switch (the cleanup) DISCARDS.
     */
    let pendingDeltas: SdkEvent[] = [];
    let deltaFrame: number | null = null;
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelDeltaFlush = (): void => {
      if (deltaFrame !== null) cancelAnimationFrame(deltaFrame);
      if (deltaTimer !== null) clearTimeout(deltaTimer);
      deltaFrame = null;
      deltaTimer = null;
    };
    const flushDeltas = (): boolean => {
      cancelDeltaFlush();
      if (pendingDeltas.length === 0) return false;
      const batch = coalesceDeltas(pendingDeltas);
      pendingDeltas = [];
      commitState((prev) => batch.reduce(applySdkEvent, prev));
      return true;
    };
    flushStreamRef.current = flushDeltas;
    const discardDeltas = (): void => {
      cancelDeltaFlush();
      pendingDeltas = [];
    };
    const queueDelta = (event: SdkEvent): void => {
      pendingDeltas.push(event);
      if (deltaTimer !== null) return;
      if (typeof requestAnimationFrame === "function") deltaFrame = requestAnimationFrame(flushDeltas);
      deltaTimer = setTimeout(flushDeltas, DELTA_FLUSH_MAX_MS);
    };

    const connect = (): void => {
      if (disposed || socket || typeof WebSocket === "undefined") return;
      setStatus(backoff.attempt === 0 ? "connecting" : "reconnecting");
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
        setStatus("open");
        setConnected(true);
        reconciledRef.current = false;
        // EVERY connect replays the card's history from the server log (see back/services/sdk/
        // history.ts), so the slate is wiped here — otherwise a reconnect would draw the whole
        // conversation twice. What was on screen comes right back, from disk instead of memory.
        commitState(INITIAL_SDK_STATE);
        // The others' drafts too: the back resends the ones still valid right at attach.
        setPeerDrafts({});
        // The replay tells the story again from disk (the interrupt note included) — a stale
        // "continuar?" offer from before the drop would be guessing about a turn we no longer see.
      };
      next.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const parsed = parseSdkFrame(event.data);
        if (!parsed) return;
        if (parsed.type === "ready") backoff.healthy();
        // Ephemeral presence, not conversation: it never reaches the reducer or the rows.
        if (parsed.type === "peer_typing") {
          if (typeof parsed.name === "string") {
            const name = parsed.name;
            const now = Date.now();
            setPeersNow(now);
            setPeers((prev) => applyPeerTyping(prev, name, parsed.active === true, now));
          }
          return;
        }
        if (parsed.type === "peer_question_draft") {
          const peer = readPeerQuestionDraft(parsed);
          if (peer) setPeerDrafts((prev) => applyPeerQuestionDraft(prev, peer.id, peer.name, peer.draft));
          return;
        }
        // The feed of a subagent THIS tab asked for: goes to the panel, never to the reducer or the rows.
        // The detail THIS tab asked for (an action, a subagent, the changes): goes to the modal.
        if (parsed.type === "detail") {
          const detail = parseDetailResponse(parsed as Parameters<typeof parseDetailResponse>[0]);
          if (detail) detailChannelRef.current?.deliver(detail);
          return;
        }
        if (parsed.type === "workflow_feed") {
          const feed = parseWorkflowFeedResponse(parsed);
          if (feed) workflowFeedRef.current?.deliver(feed);
          return;
        }
        // A level switched in the pill took this turn off the keyword's level. The driver says so, in
        // ITS order of the switch and the keyword: the browser's clock cannot tell which came first.
        // ultracode's orchestration stays on, so only ultrathink's "high effort" goes.
        if (parsed.type === "keyword_effort_replaced") {
          setEscalation((prev) => (prev?.ultracode ? prev : null));
          return;
        }
        // The RECEIPT: `user_ack` means the back recorded it — this browser no longer needs its copy.
        // `user_nack` means it refused, so the copy STAYS (the bubble now says "não entregue").
        if (parsed.type === "user_ack" && parsed.cid) {
          const cid = parsed.cid;
          setOutbox((prev) => dropFromOutbox(prev, cid));
        }
        // The refusal is also an ANSWER: this message's verdict is already out, and the queue needs
        // to know it — otherwise it would stay "without receipt" and the watchdog would drop this socket (which
        // has just proven it is alive) on every tick.
        if (parsed.type === "user_nack" && parsed.cid) {
          const cid = parsed.cid;
          setOutbox((prev) => markUndelivered(prev, [cid]));
        }
        if (isSdkDelta(parsed)) {
          queueDelta(parsed);
          return;
        }
        // Any other event goes in AFTER the tokens that arrived before it.
        flushDeltas();
        // A subagent's state carries the time it arrived, on this tab's clock: that is where the
        // running time counts from (the runner's clock may not match the browser's).
        const stamped = parsed.type === "agent_task" ? { ...parsed, receivedAt: Date.now() } : parsed;
        commitState((prev) => applySdkEvent(prev, stamped));
      };
      next.onerror = () => {
        /* onclose always follows */
      };
      next.onclose = () => {
        if (socketRef.current === next) socketRef.current = null;
        // A DISPOSED socket's close lands late — after a reconnect (account switch, card switch) the
        // NEW connection may already be open, and its state is not this one's to clear. Same for a
        // socket the watchdog already replaced (`abandonSocketRef`): it is no longer THE socket.
        if (disposed || socket !== next) return;
        dropConnection(next);
      };
    };

    /** The wire `dead` dropped (or was condemned): the screen goes offline and the reconnect is scheduled. */
    const dropConnection = (dead: WebSocket): void => {
      if (socket === dead) socket = null;
      if (socketRef.current === dead) socketRef.current = null;
      setConnected(false);
      // Who was typing belonged to THAT connection; the next one starts from silence — and so
      // does this tab's own signal (the back already told the others this socket stopped).
      setPeers({});
      typingRef.current?.stop();
      scheduleRetry();
    };

    /**
     * The watchdog CONDEMNED this socket. `close()` alone is not enough: on a half-open socket the
     * browser waits for the closing handshake that never comes (in Chrome, up to 60s) and only then
     * fires `onclose` — the only thing that scheduled the reconnect. During that minute the wire was neither OPEN nor
     * coming back, and every Reenviar fell into "Sem conexão" (production, 2026-11-06). So it is let go
     * here: the handlers come off (the late close does not talk over the new connection) and the reconnect
     * goes out through the usual backoff.
     */
    abandonSocketRef.current = () => {
      const dead = socket;
      if (disposed || !dead) return;
      dead.onopen = null;
      dead.onmessage = null;
      dead.onerror = null;
      dead.onclose = null;
      try { dead.close(); } catch { /* already closing */ }
      dropConnection(dead);
    };

    const scheduleRetry = (): void => {
      if (disposed || retry) return;
      setStatus("reconnecting");
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, backoff.next());
    };

    connect();
    return () => {
      disposed = true;
      abandonSocketRef.current = () => {};
      if (retry) clearTimeout(retry);
      discardDeltas();
      backoff.dispose();
      try { socket?.close(); } catch { /* already closing */ }
      socketRef.current = null;
      setStatus("closed");
    };
  }, [cardId, identity.epoch]);

  /**
   * The browser's local translator only DOWNLOADS the language pack inside a gesture (click, key) —
   * so the gestures on the page, with the interface in Portuguese, prepare it (one model per gesture). Once
   * ready, `prime()` does nothing; the reasoning that was waiting translates itself (`onReady`).
   *
   * `click`/`keyup` in the BUBBLE phase, on purpose: downloading consumes the gesture, and the app acts first (on
   * pointerdown in capture, the person's first click lost the gesture — popup, fullscreen). `click`
   * also covers touch, where pointerdown does not even count as a gesture.
   */
  React.useEffect(() => {
    const prime = (): void => {
      if (getLanguage() === "pt-BR") reasoningTranslator().prime();
    };
    window.addEventListener("click", prime);
    window.addEventListener("keyup", prime);
    return () => {
      window.removeEventListener("click", prime);
      window.removeEventListener("keyup", prime);
    };
  }, []);


  /* ------------------------------------------------------------- sending */

  /** Push one control frame. Throws when the socket is not open — the composer keeps the draft. */
  const sendFrame = React.useCallback((frame: object): void => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(translate("sdk.offline"));
    }
    socket.send(JSON.stringify(frame));
  }, []);

  const workflowFeed = React.useMemo(() => createWorkflowFeedChannel(sendFrame), [sendFrame]);
  workflowFeedRef.current = workflowFeed;
  const detailChannel = React.useMemo(() => createDetailChannel(sendFrame), [sendFrame]);
  detailChannelRef.current = detailChannel;
  /** The stack of open modals (an action opened from inside a subagent goes back to it). */
  const [detailStack, setDetailStack] = React.useState<DetailView[]>([]);
  const detailApi = React.useMemo(() => ({ open: (view: DetailView) => setDetailStack((prev) => [...prev, view]) }), []);

  /**
   * "Está digitando" for the card's other tabs: one frame on the first key, one every few
   * seconds while the person writes, and the "stopped" — never one per key (see lib/peerTyping.ts).
   */
  const typingSignal = React.useMemo(
    () => createTypingSignal((active) => sendFrame({ type: "typing", active })),
    [sendFrame],
  );
  typingRef.current = typingSignal;
  // Leaving the card (or unmounting) is stopping.
  React.useEffect(() => () => typingSignal.stop(), [cardId, typingSignal]);

  /**
   * THIS TAB'S DRAFT on a question card, for the others: what the person marks and writes
   * shows up on the screen of whoever else is on the card, in real time (see lib/peerQuestionDraft.ts).
   */
  const draftSender = React.useMemo(
    () => createDraftSender((id, draft) => sendFrame({
      type: "question_draft", id, picked: draft.picked, other: draft.other, ...(draft.at !== undefined ? { at: draft.at } : {}),
    })),
    [sendFrame],
  );
  React.useEffect(() => () => draftSender.dispose(), [cardId, draftSender]);
  const sendQuestionDraft = React.useCallback((id: string, draft: QuestionDraft) => draftSender.push(id, draft), [draftSender]);

  /** The soonest typing indicator to expire re-renders the view, so a lost "stopped" clears itself. */
  React.useEffect(() => {
    const expiry = nextPeerExpiry(peers, peersNow);
    if (expiry === null) return;
    const timer = setTimeout(() => setPeersNow(Date.now()), Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [peers, peersNow]);
  const typingPeers = typingNames(peers, peersNow, viewer);

  /**
   * THE PLAN LIMIT WARNING, in the right corner of the "está digitando" strip. The live warnings
   * arrive over THIS socket; published to the cache, the meter at the top of the card reads the same ones (see
   * PlanUsage.tsx). The periodic read covers the windows the CLI has not spoken about yet.
   */
  const queryClient = useQueryClient();
  React.useEffect(() => {
    queryClient.setQueryData(cardRateLimitsKey(cardId), state.rateLimits);
  }, [queryClient, cardId, state.rateLimits]);
  const plan = useCardPlanUsage(cardId, active);
  // The chat redraws on every socket frame; the "renova em" countdown moves along, with no clock of its own.
  const alertNow = Date.now();
  const usageAlert = planAlert(planWindows(plan.data?.usage, state.rateLimits, alertNow), state.rateLimits, alertNow);

  /**
   * A TURN goes out with a receipt: the words are written to the outbox (disk) BEFORE the frame
   * leaves, and only a `user_ack` takes them off it. This is the whole difference between "the
   * socket accepted" (which a half-open connection also does, into the void) and "the server has it".
   */
  const sendTurn = React.useCallback(
    (frame: { type: "user" | "edit_user"; text: string; original?: string; first?: boolean; now?: boolean }, shown: string, cid: string): void => {
      const entry: OutboxMessage = {
        cid,
        text: shown,
        at: Date.now(),
        original: frame.original,
        ...(frame.first ? { first: true } : {}),
        from: selfOriginRef.current,
        // What the server ALREADY had with these words, anchored to its clock: the reconciliation
        // only accepts an occurrence beyond these as proof of delivery (yesterday's "sim" does not deliver
        // today's, and the replay window moving does not condemn what arrived — see `sendMark`).
        ...sendMark(deliveredUserTexts(rowsRef.current, viewer), shown),
      };
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
    [sendFrame, viewer],
  );

  /**
   * SEND AGAIN an undelivered message: the same words, the same receipt — the back never had
   * it, or had it and lost the receipt (then the repeated cid is just its receipt being chased, never a second turn).
   *
   * `auto` is the resend the screen does on its own (see `planAutoResend`): it spends one attempt of the plan
   * and does not shout — a failure of it just reschedules. The person's one (the button) resets the plan and reports the error.
   */
  const resendEntry = React.useCallback((entry: OutboxMessage, auto: boolean): void => {
    const { cid } = entry;
    setState((prev) => settleUserRow(prev, cid, "sending"));
    setOutbox((prev) => retryOutbox(prev, entry, Date.now(), sendMark(deliveredUserTexts(rowsRef.current), entry.text), auto));
    try {
      sendFrame(entry.original !== undefined
        ? { type: "edit_user", original: entry.original, text: entry.text, cid, ...(entry.first ? { first: true } : {}) }
        : { type: "user", text: entry.text, cid });
    } catch {
      // No wire along the way: no error. The person's click becomes a REQUEST (it goes out by itself at the
      // first open gate); the automatic one just reschedules.
      setOutbox((prev) => {
        const failed = markUndelivered(prev, [cid]);
        return auto ? failed : askResend(failed, cid, Date.now());
      });
      setState((prev) => settleUserRow(prev, cid, "undelivered"));
    }
  }, [sendFrame]);

  /**
   * RECONCILE on reconnect: the server's replay is the truth about what was recorded. An outbox
   * entry whose text is in the replay was delivered (only its receipt got lost); one that is not
   * there never arrived, and comes back as a bubble marked "não entregue" with its text intact —
   * which is exactly what the F5 used to throw away.
   */
  React.useEffect(() => {
    if (!state.ready || reconciledRef.current) return;
    reconciledRef.current = true;
    // Only the ORPHANS: an entry whose cid still has a bubble on this screen belongs to THIS connection and has
    // an owner (the watchdog). The `ready` arrives before the receipts of what was buffered during setup, so the
    // replay CANNOT bring the in-flight send — judging it here was duplicating it and condemning it.
    const live = liveUserCids(state.rows);
    const pending = outboxRef.current.filter((m) => !live.has(m.cid));
    if (pending.length === 0) return;
    const { delivered, missing: lost } = reconcileOutbox(deliveredUserTexts(state.rows, viewer), pending);
    // The one lost without a verdict goes back to the QUEUE and leaves by itself when the chat is ready — ahead
    // of what was written after it (see `outboxToQueue`).
    const { queued, kept: missing } = outboxToQueue(lost, viewer, Date.now());
    if (queued.length > 0) {
      // The ref right away: the dispatch runs in this SAME commit (also woken by `ready`) and, reading
      // the queue from before, would send ahead what was written after.
      queueRef.current = [...queued, ...queueRef.current];
      setQueue(queueRef.current);
    }
    if (delivered.length > 0 || lost.length > 0) {
      // Delivered (or returned to the queue) leaves the outbox; the one the server does not have STAYS, already with the
      // verdict given — the outbox is its recoverable copy, and an expired entry that nobody
      // marks is what made the watchdog drop the socket on every tick.
      const gone = new Set([...delivered.map((m) => m.cid), ...queued.map((q) => q.cid)]);
      const settle = (prev: OutboxMessage[]): OutboxMessage[] =>
        markUndelivered(prev.filter((m) => !gone.has(m.cid)), missing.map((m) => m.cid));
      // The ref right away, for the same reason as the queue: the automatic resend goes out of this
      // SAME commit's dispatch, and reading the outbox from before it would resend a message the replay has just declared
      // delivered — on a new driver, which does not know the cid, that is a second turn.
      outboxRef.current = settle(outboxRef.current);
      setOutbox(settle);
    }
    if (missing.length > 0) {
      setState((prev) => missing.reduce(
        (acc, m) => appendUserRow(acc, m.text, m.from, { cid: m.cid, state: "undelivered" }),
        prev,
      ));
    }
  }, [state.ready, state.rows, viewer]);

  /**
   * The receipt clock is BORN when the SERVER takes over this connection (the `ready`, which it only sends
   * after the whole setup), not when the browser's `onopen` fires — and dies with it.
   * While it does not exist, no silence can be charged: there is no one to charge.
   */
  React.useEffect(() => {
    const answerable = connected && state.ready;
    answerableSinceRef.current = answerable ? (answerableSinceRef.current ?? Date.now()) : null;
  }, [connected, state.ready]);

  /**
   * THE WATCHDOG — the half-open socket, which is what made this bug so hard to see: `send()`
   * succeeded, nothing ever came back, and the browser went on believing the connection was fine
   * for minutes (in production, hours). A send with no receipt after `OUTBOX_ACK_TIMEOUT_MS` is
   * declared undelivered AND the socket is dropped, so the reconnect either proves the message
   * landed (the replay carries it) or brings it back marked, on a connection that works.
   *
   * The verdict is given ONCE per send (`markUndelivered` in the queue). The undelivered message
   * stays stored — it is what the "reenviar/descartar" bubble offers —, but its clock has already
   * expired: without that mark it would be expired on every tick, and the watchdog dropped every 2s a
   * perfectly live socket. That was the "chat → Iniciando o agente… → whole history →
   * chat" loop that left the screen flickering (production, 2026-09-17). A resend resets the clock and makes it
   * chargeable again.
   *
   * And the verdict is only given about a connection that COULD have answered (`answerableSinceRef`):
   * silence from a server that is still setting up the connection — or from a wire that dropped — is not
   * proof of anything, and treating it as proof was what marked as "não entregue" messages the server
   * had received, dropping mid-setup a socket whose reconnect pays the whole setup
   * again (production, 2026-09-28). With the wire down, the verdict is given by the reconnect's reconciliation,
   * which asks the replay what the server really recorded — an answer, not a guess.
   */
  React.useEffect(() => {
    if (outbox.length === 0) return;
    const timer = setInterval(() => {
      const answerableSince = answerableSinceRef.current;
      if (answerableSince === null) return;
      const overdue = overdueMessages(outboxRef.current, Date.now(), OUTBOX_ACK_TIMEOUT_MS, answerableSince);
      if (overdue.length === 0) return;
      const cids = overdue.map((m) => m.cid);
      setOutbox((prev) => markUndelivered(prev, cids));
      setState((prev) => cids.reduce((acc, cid) => settleUserRow(acc, cid, "undelivered"), prev));
      // Drop the socket: the reconnect is the only way to find out whether it was still alive —
      // and it starts NOW, not when a half-open socket finally finishes closing.
      if (socketRef.current?.readyState === WebSocket.OPEN) abandonSocketRef.current();
    }, OUTBOX_TICK_MS);
    return () => clearInterval(timer);
  }, [outbox.length]);

  /**
   * THE AUTOMATIC RESEND CLOCK — a single timer, armed for the next instant at which the plan
   * changes (an interval expires, a message passes the age ceiling), never a fixed tick. It does not
   * send anything: it only wakes the dispatch, which is the one that knows whether it can send now (see below).
   */
  const [resendClock, setResendClock] = React.useState(0);
  const resendPlan = planAutoResend(ownSends(outbox, viewer), Date.now());
  React.useEffect(() => {
    if (resendPlan.wakeAt === null) return;
    const timer = setTimeout(() => setResendClock((n) => n + 1), Math.max(0, resendPlan.wakeAt - Date.now()));
    return () => clearTimeout(timer);
  }, [resendPlan.wakeAt, resendClock]);

  /* -------------------------------------------------------------- editing */

  /** The message being edited (a SUPERSEDE — the model read the original; see docs/sdk-driver.md). */
  const [editing, setEditing] = React.useState<{ rowId: string; original: string } | null>(null);
  /** An edit waiting for the interrupted turn to END (its result/aborted) before it goes. */
  const [pendingEdit, setPendingEdit] = React.useState<{ original: string; text: string; cid: string; first: boolean } | null>(null);
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
    (original: string, text: string, cid: string = newCid(), first: boolean = false): boolean => {
      try {
        sendTurn({ type: "edit_user", original, text, ...(first ? { first: true } : {}) }, text, cid);
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
      dispatchEditFrame(pendingEdit.original, pendingEdit.text, pendingEdit.cid, pendingEdit.first);
      return;
    }
    const timer = setTimeout(() => {
      setPendingEdit(null);
      dispatchEditFrame(pendingEdit.original, pendingEdit.text, pendingEdit.cid, pendingEdit.first);
    }, EDIT_INTERRUPT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pendingEdit, state.turnActive, dispatchEditFrame]);

  // This tab's side-question deadline: the one the driver never answered (died midway, a
  // deploy) becomes an error instead of "Respondendo…" forever. One timer per question, armed on send.
  const btwTimersRef = React.useRef(new Set<ReturnType<typeof setTimeout>>());
  React.useEffect(() => {
    const timers = btwTimersRef.current;
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, []);
  const armBtwExpiry = React.useCallback((askedAt: number): void => {
    // From the row's SAME `askedAt`: the timer never fires an instant before the deadline the row counts.
    const timer = setTimeout(() => {
      btwTimersRef.current.delete(timer);
      setState((prev) => expireBtwRows(prev, Date.now()));
    }, askedAt + BTW_EXPIRE_MS - Date.now());
    btwTimersRef.current.add(timer);
  }, []);

  /* -------------------------------------------------------- replying to a decision */

  /**
   * The decision the composer is currently ANSWERING — the whole point of this screen's honesty:
   * with it armed, what the person types goes to THAT question (and says so, with the question in
   * view); with it null, the same words are a loose message. Nothing here is implicit — arming is
   * always a click, and the X disarms.
   */
  const [replyTo, setReplyTo] = React.useState<PendingDecision | null>(null);

  /**
   * ONE FIELD, ONE MODE. Correcting a queued message (`queueEdit`), correcting a sent bubble
   * (`editing`) and answering a decision (`replyTo`) compete for the SAME text field — and `send`
   * resolves the Enter by testing one mode after another. Two armed at the same time is the Enter landing
   * in the wrong mode: correcting a bubble wrote OVER the message waiting in the queue. Every
   * gesture that enters a mode goes through here first; the queued one becomes deliverable again, in its place.
   */
  const leaveComposerModes = React.useCallback((): void => {
    setReplyTo(null);
    setEditing(null);
    setQueueEdit(null);
    setQueue(releaseEditing);
  }, []);

  /**
   * The pencil opens the field — and ONLY that. It does not stop the turn.
   *
   * It used to (the earlier request: "cliquei pra editar e ele continua respondendo" — "I clicked to edit and it keeps answering"), and the price showed up
   * in production: clicking edit and CHANGING YOUR MIND killed a turn nobody wanted killed, and a
   * cut turn cannot be uncut — what was left was an offer to "continuar de onde parou" to fix
   * damage the screen itself had done. Clicking edit is not a decision; it is opening the
   * possibility of one. What stops the turn is the SENT correction (see `send`), and the cost of that
   * choice is known: between the pencil and the Enter the agent keeps working on the old message.
   * Extra work is recoverable; a turn killed by mistake is not.
   */
  const beginEdit = React.useCallback((rowId: string, original: string): void => {
    leaveComposerModes();
    setEditing({ rowId, original });
  }, [leaveComposerModes]);

  /* ------------------------------------------------------------ a fila */

  /**
   * THE ACCOUNT SWITCH with messages waiting in the queue: those of ANOTHER account leave the queue and become
   * "não entregue" copies in the outbox (see `foreignToOutbox`) — on screen with the name of who wrote them, never
   * dispatched over this connection. And what was in the field (any mode) belonged to the previous account:
   * it goes too — a queue correction armed here would make the new account's Enter rewrite (or recreate
   * with no author) another person's message.
   */
  React.useEffect(() => {
    const { own, foreign } = foreignToOutbox(queueRef.current, viewer);
    if (foreign.length === 0) return;
    setQueue(own);
    setOutbox((prev) => foreign.reduce((acc, m) => addToOutbox(acc, m), prev));
  }, [viewer]);
  React.useEffect(() => {
    if (identity.epoch === 0) return;
    leaveComposerModes();
    setPendingEdit(null);
  }, [identity.epoch, leaveComposerModes]);
  /** The decisions still waiting on the person (filled in below, where they are derived from the rows). */
  const pendingRef = React.useRef<PendingDecision[]>([]);

  /**
   * DELIVER a turn: the bubble is born in the conversation, the receipt is armed and the words go to the socket.
   * It is the only point at which a message stops being yours and becomes conversation — whether it comes straight from the
   * field (nothing running) or from the queue (the previous turn has just closed).
   */
  const dispatchTurn = React.useCallback(
    (text: string, now = false, cid: string = newCid()): void => {
      // `ultrathink` / `ultracode` in what is going out NOW: the driver raises the effort of THIS turn, and the
      // activity bar is where that becomes visible — the panel used to escalate silently. Read on
      // delivery, not on typing: a message that waited escalates the turn that IT opens.
      const ultra = ultraKeywords(text);
      setEscalation(ultra.ultrathink || ultra.ultracode ? ultra : null);
      // Drawn FIRST, as "sending": the bubble exists the instant it goes, but it only claims to be
      // sent when the back says it recorded it (`user_ack`) — see lib/sdkOutbox.ts. `awaiting` starts
      // the status ladder: "Preparando…"/"Pensando…" until the driver's first event.
      setState((prev) => appendUserRow(prev, text, selfOriginRef.current, { awaiting: true, cid, state: "sending" }));
      sendTurn(now ? { type: "user", text, now: true } : { type: "user", text }, text, cid);
    },
    [sendTurn],
  );

  /** The pencil of a queued message: it goes to the FIELD, and stays marked in the queue (does not leave it). */
  const beginQueueEdit = React.useCallback((id: string): void => {
    const target = queueRef.current.find((m) => m.id === id);
    if (!target) return;
    leaveComposerModes();
    setQueueEdit({ id, text: target.text });
    setQueue((prev) => markEditing(prev, id)); // only one at a time: there is only one text field
  }, [leaveComposerModes]);

  /** The queue's X: the person gave up on this message before Claude read it. */
  const removeQueued = React.useCallback((id: string): void => {
    setQueue((prev) => dequeue(prev, id));
  }, []);

  /**
   * FORCE THE SEND: this message does not wait for the turn to close, it goes now.
   *
   * Waiting is the right default — a message folded into the middle of a reasoning comes in as a context
   * interruption, not as a new question. But not every note wants to wait: "para, tá errado", "o
   * que você tá fazendo?" are meant precisely for NOW. It goes with `now`: if a tool is running,
   * the driver interrupts it and the message opens a new turn — pushed without that, the CLI only read it when
   * the tool returned (a stuck deploy left the person talking to themselves for 24 min). With no
   * tool running, it joins the turn in progress (the `turn_absorbed`). So waiting is the
   * person's CHOICE, not the screen's sentence.
   *
   * With no wire up nothing leaves the queue: forcing a send that cannot happen would only swap a stored
   * message for a condemned bubble — exactly what the queue exists not to do.
   */
  const sendQueuedNow = React.useCallback((id: string): void => {
    const target = queueRef.current.find((m) => m.id === id);
    if (!target) return;
    if (!connected || socketRef.current?.readyState !== WebSocket.OPEN) {
      toast.error(translate("sdk.offline"));
      return;
    }
    setQueue((prev) => dequeue(prev, id));
    try {
      dispatchTurn(target.text, true, target.cid);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [connected, dispatchTurn]);

  /**
   * LEAVE edit mode without sending. A queued message becomes deliverable again, in its place and
   * with the text it had — the X here is "I gave up rewriting", never "throw away what I wrote".
   */
  const cancelEdit = leaveComposerModes;

  /**
   * THE DISPATCH — the queue moves by itself, ONE message at a time, as soon as the previous turn closes.
   *
   * One at a time because that is what "se o Claude ler a mensagem ela sobe" ("if Claude reads the message it moves up") means: the delivered one
   * becomes a bubble, the others keep waiting down there, still editable. A correction of an
   * already-sent message (`editing`/`pendingEdit`) goes first: it owns the next turn.
   */
  React.useEffect(() => {
    // With no wire nobody delivers anything — and "wire" is `readyState`, not `connected`. A dead socket
    // the browser has not noticed yet passes `connected`, and the dispatch pulled the message from the
    // queue to deliver it on it: it left the wait and became the condemned bubble the queue exists
    // to avoid. Both ends (what enters the queue, what leaves it) read the SAME truth.
    if (!connected || socketRef.current?.readyState !== WebSocket.OPEN) return;
    // A sentence that is only in the token buffer is also a half-written sentence: flushing it changes
    // `state`, and this effect runs again already knowing about it.
    if (flushStreamRef.current()) return;
    if (!state.ready) return;
    // The BREATHER, not the end of the turn (see `turnHasRoomForMore`): a fifteen-minute turn held
    // back a "para, tá errado" for fifteen minutes. A breather is there being no HALF-WRITTEN SENTENCE — a
    // tool in progress is not one —, and the message delivered then joins the turn in progress through
    // streaming input: the CLI queues it and the model reads it on the next step.
    if (!turnHasRoomForMore(state)) return;
    if (editing || pendingEdit) return;
    // The AUTOMATIC RESEND goes ahead of the queue: the message that failed was written before everything
    // waiting there, and the conversation cannot reach Claude scrambled. It goes out through the same
    // gate as the queue — wire up, server ready (the reconciliation has already said what it has), turn
    // with room —, so it never fires against a connection that cannot answer, and the dropped wire
    // does not spend an attempt. A correction (`original`) is a supersede: only with the turn stopped.
    const retry = planAutoResend(ownSends(outboxRef.current, viewer), Date.now()).due
      .find((m) => m.original === undefined || !state.turnActive);
    if (retry) {
      // A request from the person (`asked`) goes out as the click it is: it resets the automatic plan.
      resendEntry(retry, retry.asked !== true);
      return;
    }
    // Only what belongs to THIS account goes out over this connection (the server stamps the author by the connection).
    const head = headOfQueue(foreignToOutbox(queueRef.current, viewer).own);
    if (!head) return;
    setQueue((prev) => dequeue(prev, head.id));
    try {
      // One that came back from the outbox goes out with its original receipt: if the server had it, it is just the receipt.
      dispatchTurn(head.text, false, head.cid);
    } catch (err) {
      // `sendTurn` has already marked the bubble as NOT DELIVERED, with resend/discard: the text is in the
      // conversation, recoverable. It does not go back to the queue — two copies of the same message is worse.
      toast.error((err as Error).message);
    }
  }, [queue, connected, state, editing, pendingEdit, dispatchTurn, viewer, outbox, resendClock, resendEntry]);

  const send = async (raw: string): Promise<void> => {
    const text = raw.replace(/\r$/, "").trim();
    if (!text) return;
    // Pressed Enter: whatever happens to the words next (sent, queued, an edit), the typing is over.
    typingSignal.stop();
    // Anything the person sends REPLACES the interrupted turn — the "continuar?" offer is moot.
    if (queueEdit) {
      // Finished editing a queued message: the new text goes IN PLACE of the old one, and only now
      // does it become deliverable again — while it was in the field, not even a closing turn released it.
      setQueue((prev) => updateQueued(prev, queueEdit.id, text, Date.now()));
      setQueueEdit(null);
      return;
    }
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
      // NEVER queued: the question it answers is what is holding the turn. Keeping the
      // answer until the turn ends would be waiting for something that only happens AFTER it.
      const wrapped = buildDecisionReply(replyTo.text, text);
      try {
        dispatchTurn(wrapped);
      } catch (err) {
        toast.error((err as Error).message);
        throw err; // the composer keeps the words
      }
      setReplyTo(null);
      return;
    }
    const chat = readSettledState();
    if (editing) {
      const { original } = editing;
      const editCid = newCid();
      // Words alone cannot say WHICH copy was clicked: a message re-sent after an error has the
      // same ones, and every layer picked the newest — editing the first message edited the second
      // (production, 2026-10-19). The first message is named as such, and the conversation restarts.
      const first = isFirstUserRow(rowsRef.current, editing.rowId);
      if (chat.turnActive) {
        // HERE is where the turn stops — on sending the correction, not on the pencil click (see `beginEdit`).
        // The decision has been made: the message being answered was superseded, and letting the turn
        // run would be spending reasoning on a question that no longer exists. The correction only GOES when
        // that turn reports its end (the effect above): it can never land as the answer of
        // a turn the superseded message is still driving.
        if (!sendInterrupt("edit")) {
          throw new Error(translate("sdk.offline")); // the composer keeps the words
        }
        setPendingEdit({ original, text, cid: editCid, first });
      } else if (!dispatchEditFrame(original, text, editCid, first)) {
        throw new Error(translate("sdk.offline")); // the composer keeps the words
      }
      // Drawn now, in both paths: the original leaves the screen and the new version, with the
      // "editada" badge, is the standing message. The history writes the same two lines, so a
      // replay agrees.
      setState((prev) => appendUserRow(markUserEdited(prev, original, { first }), text, selfOriginRef.current, {
        awaiting: true,
        cid: editCid,
        state: "sending",
        revision: true,
      }));
      setEditing(null);
      return;
    }
    // A TURN IS RUNNING: the message WAITS, right above the field, instead of going straight to the CLI and being
    // folded into the reasoning in progress (the old `turn_absorbed`). While it waits it is still yours —
    // editable, discardable — and it only moves up into the conversation when it is truly delivered.
    //
    // EXCEPT when the turn is STOPPED waiting for the person. A `user_question` leaves the driver
    // blocked inside `canUseTool`/`waitQuestion` with the turn still counted as active, and the
    // only thing that releases it is a user message. Queuing here would be waiting for an end
    // of turn that only the message itself can cause — a half-hour lock, until the timeout.
    //
    // And the DROPPED WIRE is the same wait. A socket drops for mundane reasons — deploy, laptop lid,
    // proxy cutting an idle connection — and comes back in 400ms to 15s (lib/reconnect.ts). Whoever is writing sees
    // none of that: until now the message was born instantly condemned ("não entregue ao servidor",
    // with reenviar/descartar) by a wire that came back two seconds later, and the text was in two
    // places at the same time — in the bubble and in the field, from where the second Enter sent the copy. Whoever only
    // needs to wait for the wire is not lost: it waits in the queue, and the dispatch delivers it when it can.
    // The pending-decision exception applies to BOTH waits, and it is what keeps it safe: the queue's
    // dispatch only moves when the turn closes, so queuing with a question standing — including with
    // the wire down — would be waiting for an end of turn that only the message itself can cause.
    //
    // And the CHAT LOADING too (wire up, server still in setup, no `ready`): the back only keeps
    // the frame in a buffer that an F5 throws away — the queue is what survives it (production, 2026-10-20).
    const wireUp = connected && socketRef.current?.readyState === WebSocket.OPEN;
    // /btw is the question asked PRECISELY with the turn running: waiting for the end of the turn in the queue would be
    // the opposite of the command. It goes out right away, in its own frame, and becomes a pending row — what answers
    // is a separate query, not the turn (see `answerBtw` in sdk-driver.mjs).
    // With the wire down it does NOT wait in the queue: from there it would go out as a plain message — an
    // agent turn, the opposite of the command. It stays in the field, with the warning, for the person to send when it comes back.
    const btw = btwQuestion(text);
    if (btw !== null) {
      if (!wireUp) throw new Error(translate("sdk.offline")); // the composer keeps the words
      const btwId = newCid();
      sendFrame({ type: "btw", id: btwId, question: btw }); // throws offline: the composer keeps the words
      const askedAt = Date.now();
      setState((prev) => appendBtwRow(prev, btwId, btw, askedAt));
      armBtwExpiry(askedAt);
      return;
    }
    try {
      sendOrQueue(text);
    } catch (err) {
      toast.error((err as Error).message);
      throw err; // the composer keeps the words
    }
  };

  /** A new message for the agent: it waits in the queue while it cannot go (see `send`), or goes now. Throws when it cannot. */
  const sendOrQueue = (text: string): void => {
    const chat = readSettledState();
    const wireUp = connected && socketRef.current?.readyState === WebSocket.OPEN;
    const waits = !wireUp || !chat.ready || chat.turnActive || chat.awaiting || pendingEdit;
    if (waits && pendingRef.current.length === 0) {
      setQueue((prev) => enqueue(prev, { id: newQueueId(), text, at: Date.now(), from: selfOriginRef.current }));
      return;
    }
    dispatchTurn(text);
  };

  /*
   * The row handlers below are STABLE (useCallback over refs and stable setters): every row is a
   * memoised `SdkChatRow`, and a handler recreated per render would redraw the whole transcript on
   * every streamed token all the same.
   */

  /** "Reenviar": the same words, the same receipt id — the back never had them, so this is not a copy. */
  const resendUndelivered = React.useCallback((cid: string): void => {
    // Resending ANOTHER account's message would record it under the name of whoever is on the tab now.
    const entry = ownSends(outboxRef.current, viewer).find((m) => m.cid === cid);
    if (!entry) return;
    // WITH NO WIRE (the socket condemned, the reconnect in backoff, the server in setup) the click does not try the
    // socket — trying was the "Sem conexão… Ela fica no campo" of 2026-11-06. It becomes a request, and the dispatch
    // sends it as soon as the chat is ready, ahead of the queue.
    const wireUp = socketRef.current?.readyState === WebSocket.OPEN && readSettledState().ready;
    if (!wireUp) {
      setOutbox((prev) => askResend(prev, cid, Date.now()));
      return;
    }
    resendEntry(entry, false);
  }, [resendEntry, viewer, readSettledState]);

  /** "Descartar": the person gave up on this send — the bubble and the stored copy both go. */
  const discardUndelivered = React.useCallback((cid: string): void => {
    setOutbox((prev) => dropFromOutbox(prev, cid));
    setState((prev) => dropUserRow(prev, cid));
  }, []);

  const interrupt = (): void => {
    sendInterrupt();
  };


  const answerPermission = React.useCallback((id: string, allow: boolean): void => {
    try {
      sendFrame({ type: "permission_decision", id, allow });
    } catch (err) {
      toast.error((err as Error).message);
      return;
    }
    // Optimistic only in DRAWING — the driver echoes the decision; a flip is impossible (first wins).
    setState((prev) => decidePermission(prev, id, allow ? "allowed" : "denied"));
  }, [sendFrame]);

  /** Returns whether the socket took the answer — a refusal must not disarm the reply composer. */
  const answerUserQuestion = React.useCallback((id: string, answers: SdkQuestionAnswer[]): boolean => {
    try {
      sendFrame({ type: "question_answer", id, answers });
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    }
    // Optimistic only in DRAWING — the driver echoes a `question_result`; the first settlement wins.
    setState((prev) => answerQuestion(prev, id, answers));
    return true;
  }, [sendFrame]);

  /** The terminal's Esc gesture: an empty field steps into editing the LAST message of one's own. */
  const editLast = React.useCallback((): void => {
    // THE QUEUE COMES FIRST. The last thing the person wrote is the one waiting down there,
    // and editing it costs nothing — no turn is interrupted, because Claude has not read it yet. It is
    // also the only way to correct it without taking your hand off the keyboard while a turn runs.
    const queued = lastQueued(queueRef.current);
    if (queued) {
      beginQueueEdit(queued.id);
      return;
    }
    // Mid-turn Esc keeps meaning "stop", not "edit": the button owns that gesture, and stopping a
    // turn is too big a consequence for a key you may have pressed to dismiss something. The pencil
    // is the explicit way in — and even it only opens the field: the turn stops when the correction
    // is SENT (see `beginEdit` and `send`).
    const chat = readSettledState();
    if (chat.turnActive) return;
    for (let i = chat.rows.length - 1; i >= 0; i -= 1) {
      const row = chat.rows[i]!;
      // A decision answer is skipped for the same reason its pencil is hidden (see the bubble).
      if (row.kind === "user" && row.edited !== true && parseDecisionReply(row.text) === null
        && originRole(row.from, viewer) === "self") {
        beginEdit(row.id, row.text);
        return;
      }
    }
  }, [readSettledState, viewer, beginEdit, beginQueueEdit]);

  /* ------------------------------------------------------------ voice call */

  /*
   * A VOICE CALL IN THIS CHAT (features/voice/useVoiceCall.ts). Same thread, same composer: the
   * spoken turns are drawn here as they are said and saved into this card's log; what is typed or
   * attached during the call goes to the agent exactly as always, and the voice is told about it
   * as quiet context — it cannot read files or images itself. What the voice delegates goes to the
   * agent too, and the agent's answers come back to it (features/voice/useVoiceDelegation.ts).
   */
  const [sentDuringCall, setSentDuringCall] = React.useState(false);
  const callWorking = connected && (state.awaiting || state.turnActive);
  /** The agent is working on something typed during the call — the call shows it as "thinking". */
  const agentBusyForCall = sentDuringCall && callWorking;
  const call = useVoiceCall({ cardId, agentBusy: agentBusyForCall });
  const callLive = call.snap.state === "live";
  if (!callWorking && sentDuringCall) setSentDuringCall(false);
  const [callBarDismissed, setCallBarDismissed] = React.useState(false);
  const voiceControl = React.useMemo<VoiceCallControl>(
    () => ({
      inCall: call.active,
      start: () => {
        setCallBarDismissed(false);
        call.start();
      },
      stop: call.stop,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [call.active, call.start, call.stop],
  );
  // The chat stops being the one on screen (another card, the terminal tab): the call ends with it
  // — a microphone left open in a conversation nobody is looking at is not a feature.
  React.useEffect(() => {
    if (!active && call.active) call.stop();
  }, [active, call.active, call.stop]);
  const sendFromComposer = React.useCallback(
    async (raw: string): Promise<void> => {
      await send(raw);
      if (!callLive) return;
      const note = typedContext(raw);
      if (note && call.appendContext(note)) setSentDuringCall(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send, callLive, call.appendContext],
  );
  useVoiceDelegation({
    call,
    rows: state.rows,
    // Not `callWorking`: a dropped wire clears `connected` but not the turn, and the delegation must
    // wait for the turn's real end, not answer with whatever was said before the blip.
    turnRunning: state.awaiting || state.turnActive,
    sendToAgent: (text) => {
      sendOrQueue(text);
      setSentDuringCall(true);
    },
  });
  /** The thread as drawn: the saved rows plus the call's turns still being spoken or saved. */
  const displayRows = React.useMemo(() => mergeLiveVoiceTurns(state.rows, call.turns, selfOrigin), [state.rows, call.turns, selfOrigin]);
  const showCallBar = call.active || (call.phase === "error" && !callBarDismissed);

  /* ------------------------------------------------------------ scrolling */

  const stick = useStickToBottom(displayRows);

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
  // Read by `send` (declared above): a standing question changes what Enter means.
  pendingRef.current = pending;
  /** The explicit replies already given — what anchors an answer under the question it answered. */
  const replies = React.useMemo(() => decisionReplies(state.rows), [state.rows]);
  /** Which rows are STILL waiting — only those offer "Responder" (a stale question must not arm). */
  const pendingIds = React.useMemo(() => new Set(pending.map((d) => d.rowId)), [pending]);

  /**
   * Tray click: scroll to the message, flash it, ARM the composer on it (when a typed line can
   * answer it) and take the cursor there. Arming leaves edit mode — one thing at a time.
   */
  const jumpToDecision = React.useCallback((decision: PendingDecision): void => {
    const el = rowRefs.current.get(decision.rowId);
    el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setFlashId(decision.rowId);
    if (decision.answerable) {
      leaveComposerModes();
      setReplyTo(decision);
    }
    rootRef.current?.querySelector("textarea")?.focus();
  }, [leaveComposerModes]);

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

  // What belongs to a SUBAGENT leaves the main thread and goes under the card that fired it.
  // The previous map goes in to be REUSED when no subagent changed: that way a token of the main
  // agent's answer does not swap the context value nor redraw the subagent cards.
  const subagentRowsRef = React.useRef<SubagentSplit["children"] | undefined>(undefined);
  const split = React.useMemo(() => {
    const next = splitSubagentRows(displayRows, subagentRowsRef.current);
    subagentRowsRef.current = next.children;
    return next;
  }, [displayRows]);
  const rendered = React.useMemo(() => groupSdkRows(split.main), [split.main]);
  const latestTodoId = React.useMemo(() => latestTodoRowId(split.main), [split.main]);
  const renderThreadRow = React.useCallback((row: SdkRow) => <SdkChatRow row={row} />, []);
  const thread = React.useMemo<SdkThread>(
    () => ({ subagentRows: split.children, latestTodoId, renderRow: renderThreadRow }),
    [split.children, latestTodoId, renderThreadRow],
  );
  const empty = displayRows.length === 0;

  /* -------------------------------------------------- what is running, right now */

  // The activity bar's three facts: WHAT (the newest tool/reasoning/answer of this turn), for HOW
  // LONG, and whether the turn was escalated by a reserved word.
  // The turn running in the Terminal tab (the interactive `claude`; the chat only mirrors) does not light
  // `turnActive` — what guarantees it is still alive are the card's hooks. Without this the screen looked
  // idle with the AI working (card "POC modo de voz", 2026-10-21).
  const working = connected && (state.awaiting || state.turnActive || (state.terminalBurst && terminalWorking));
  const activity = React.useMemo(() => (working ? currentActivity(state) : null), [working, state]);
  // "Copiar" and "ouvir" only under a FINISHED answer: the current round's waits for everything to stop —
  // the turn, and also the background tasks, which may still change what the AI will say.
  const settled = connected && !working && state.backgroundTasks.length === 0;
  const finishedAnswers = React.useMemo(() => finishedAnswerIds(state.rows, settled), [state.rows, settled]);
  // The sends that ARE catalogue commands (the chip), and which of them the current turn is running: the
  // last one sent, while there is a turn.
  const commandRows = React.useMemo(() => {
    const found = new Map<string, InvokedCommand>();
    let lastUser: string | undefined;
    for (const row of state.rows) {
      if (row.kind !== "user" || row.edited === true) continue;
      lastUser = row.id;
      const command = invokedCommand(row.text, state.commands);
      if (command) found.set(row.id, command);
    }
    return { found, lastUser };
  }, [state.rows, state.commands]);
  const commandRunning = state.awaiting || state.turnActive;
  // A read-aloud of this card does not survive the card being closed nor a voice call.
  React.useEffect(() => {
    setReadAloudErrorHandler((err) => toast.error(translate(readAloudError(err))));
    return () => {
      setReadAloudErrorHandler(undefined);
      if (readAloud.getState()?.cardId === cardId) readAloud.stop();
    };
  }, [cardId]);
  React.useEffect(() => {
    if (callLive) readAloud.stop();
  }, [callLive]);
  /*
   * WHEN the work started — and only that lives here. The clock that ticks every second lives in the two
   * dials (`useTurnClock`): up here it redrew the WHOLE conversation once per
   * second, for the whole turn. Adjusted in render (not in an effect), so the turn's first frame
   * already comes out with the right clock.
   */
  const [workStartedAt, setWorkStartedAt] = React.useState<number | null>(null);
  if (working && workStartedAt === null) setWorkStartedAt(Date.now());
  if (!working && workStartedAt !== null) setWorkStartedAt(null);
  const workingKind = workingKindOf(activity, state.awaiting, state.ready);
  /*
   * THE SCREEN READER. The conversation is a `role="log"` (live region): everything that changes inside it is
   * announced. That is why the clock dials are `aria-hidden` — the stopwatch is for the
   * eyes; announced every second it talked over the conversation — and only the PHASE goes to the ear,
   * in a status region outside the log, which changes when the work changes. And text arriving token by
   * token leaves the log BUSY (`aria-busy`): it is read whole when it closes, not in pieces.
   */
  const lastRow = state.rows[state.rows.length - 1];
  const streaming = lastRow !== undefined && (lastRow.kind === "assistant" || lastRow.kind === "thinking") && lastRow.streaming;
  React.useEffect(() => {
    if (!working) setEscalation(null);
  }, [working]);

  // THE CONTEXT METER closes the line at the end of the log, on the right. If it is the closed answer, it
  // goes INTO the copiar/ouvir row (same height, nothing floating). With "Trabalhando…" (which truncates
  // before it) it sits in the corner, on top. Any other last row (the user's bubble, an
  // error, a tool) would sit under it — then the log reserves a strip at the end (`pb-10`).
  const lastEntry = rendered[rendered.length - 1];
  const meterInAnswer = state.contextUsage !== null && lastEntry?.kind === "row" && finishedAnswers.has(lastEntry.id);
  const meterInCorner = state.contextUsage !== null && !meterInAnswer;
  const meterReservesStrip = meterInCorner && !(working && workStartedAt !== null);

  return (
    <WorkflowFeedContext.Provider value={workflowFeed}>
    <DetailChannelContext.Provider value={detailChannel}>
    <SdkDetailContext.Provider value={detailApi}>
    <div ref={rootRef} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={stick.scrollerRef}
        onScroll={stick.onScroll}
        role="log"
        aria-label={ariaLabel ?? t("sdk.aria")}
        aria-busy={streaming || undefined}
        data-testid="sdk-chat-scroller"
        // `relative` is load-bearing: it makes the scroller the containing block of anything
        // absolute inside the conversation (the diff card's `sr-only` label, for one). Without it
        // those anchor to the wrapper outside, keep their place deep in the history, and give the
        // whole page an empty scroll below the composer.
        className={cn(
          "relative min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain rounded-md border border-border/60 bg-card/30 px-3 py-3",
          meterReservesStrip && "pb-10",
        )}
      >
        {/* WHAT IS RUNNING — pinned to the top of the conversation for as long as work runs, so a
            long turn never leaves the person scrolling to find out whether anything is happening. */}
        {working && workStartedAt !== null ? (
          <SdkActivityBar
            activity={activity}
            startedAt={workStartedAt}
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

        <SdkThreadContext.Provider value={thread}>
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
            ) : entry.kind === "agents" ? (
              <SdkFleet rows={entry.rows} tasks={state.agentTasks} children={split.children} />
            ) : (
              <SdkChatRow
                cardId={cardId}
                row={entry.row}
                answered={replies.get(entry.id)}
                aiming={replyTo?.rowId === entry.id}
                onPermission={answerPermission}
                onAnswer={answerUserQuestion}
                peerDrafts={peerDrafts[entry.id]}
                onDraft={sendQuestionDraft}
                onReply={pendingIds.has(entry.id) ? jumpToDecision : undefined}
                onEdit={beginEdit}
                onResend={resendUndelivered}
                onDiscard={discardUndelivered}
                retrying={entry.row.kind === "user" && entry.row.cid !== undefined && resendPlan.pending.has(entry.row.cid)}
                command={commandRows.found.get(entry.id)}
                commandRunning={commandRunning && commandRows.lastUser === entry.id}
                answerOf={finishedAnswers.has(entry.id) ? cardId : undefined}
                trailing={meterInAnswer && entry === lastEntry ? <ContextMeter usage={state.contextUsage} /> : undefined}
              />
            )}
          </div>
        ))}
        </SdkThreadContext.Provider>

        {/* The STATUS LADDER — one indicator, three rungs, only while the wire is UP (a
            disconnected view cannot vouch for anything; the reconnect relights it). The instant a
            message goes, `awaiting` lights: "Preparando…" while the driver is still booting or
            resuming the session (`ready` false — the cold start), "Pensando…" once the turn is in
            the engine and no token has landed yet. The first driver event clears `awaiting` and the
            plain "Trabalhando…" takes the same seat. Never stacked: one line, its label changes. */}
        {working && workStartedAt !== null ? (
          <SdkWorkingLine
            startedAt={workStartedAt}
            activity={activity}
            awaiting={state.awaiting}
            ready={state.ready}
            escalation={escalation}
            detail={liveActivityDetail(state)}
          />
        ) : null}
      </div>
      <span role="status" data-testid="sdk-working-status" className="sr-only">
        {working ? t(workingStage(workingKind, 0).verb) : ""}
      </span>
      {/* With the meter in the corner, the "ir pro fim" moves up a strip: in a narrow panel the two touched. */}
      <JumpToLatest stick={stick} className={meterInCorner ? "bottom-11" : undefined} />
      {/* Outside the closed answer, the meter lives in the bottom-right corner of the conversation box, on
          top of the log (like the "ir para o fim"), with an opaque background so the scrolling text does not leak through. */}
      {meterInCorner ? (
        <div data-testid="sdk-context-corner" className="absolute bottom-3 right-4 z-10 rounded-full bg-background">
          <ContextMeter usage={state.contextUsage} />
        </div>
      ) : null}
      </div>

      {/* THE WORK THAT CONTINUES AFTER THE TURN — a `sleep` waiting for the deploy, a subagent. The
          "Trabalhando…" went out with the `result`, and without this strip the chat looked idle while
          Claude was still waiting for something (production, 2026-10-07). Only with the wire up: a
          disconnected screen cannot guarantee anything; the reconnect relights it via the back's resend. */}
      {connected && state.backgroundTasks.length > 0 ? <SdkBackgroundTray tasks={state.backgroundTasks} agentTasks={state.agentTasks} rows={state.rows} /> : null}

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


      {/* THE QUEUE — what was written while Claude works, at the ready right above the field,
          in the same strip where the "Trabalhando… 1m20s" status lives. It is not in the conversation because
          Claude has not read it yet: it moves up there the instant it is delivered. Until then it belongs to the
          person — the pencil brings it back to the field, the X throws it away. */}
      {queue.length > 0 ? <SdkQueueTray queue={queue} onEdit={beginQueueEdit} onRemove={removeQueued} onSendNow={sendQueuedNow} /> : null}

      {/* The interrupt button lives INSIDE the composer — right column, above the microphone —
          in the same seat as the transcript chat's stop. The interrupt frame is still this view's. */}
      {/* The context left the smart strip: the full message, above the meter's strip. */}
      <ContextNotice usage={state.contextUsage} className="mt-1.5" />

      {/* One strip, two messages: who is typing on the left; on the right the plan warning. */}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <PeerTypingIndicator names={typingPeers} />
        </div>
        <div className="flex min-w-0 max-w-[75%] items-center justify-end gap-2">
          <PlanUsageAlert alert={usageAlert} now={alertNow} className="min-w-0 shrink" />
        </div>
      </div>

      {showCallBar ? (
        <div className="mt-1.5">
          <VoiceCallBar call={call} agentBusy={agentBusyForCall} onClose={() => setCallBarDismissed(true)} />
        </div>
      ) : null}

      {footer}

      <VoiceCallContext.Provider value={voiceControl}>
      <TerminalComposer
        className="mt-1.5"
        cardId={cardId}
        active={active}
        onSend={sendFromComposer}
        onUploadImage={onUploadImage}
        placeholder={replyTo ? t("sdk.replyPlaceholder") : undefined}
        commands={state.commands}
        interrupt={{ active: state.turnActive, onInterrupt: interrupt, testId: "sdk-interrupt" }}
        editing={
          editing
            ? { text: editing.original }
            : queueEdit
              ? { text: queueEdit.text, hint: t("sdk.queueEditing") }
              : null
        }
        onCancelEdit={cancelEdit}
        onEditLast={editLast}
        onDraftInput={typingSignal.input}
      />
      </VoiceCallContext.Provider>

      {/* The footer says which conversation this IS (the resume key) and whether the wire is up. */}
      <div className="mt-1 flex items-center gap-2 px-1 text-[11px] text-muted-foreground/70" data-testid="sdk-chat-footer">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500")} />
        <span>{t("sdk.beta")}</span>
        <span className="flex-1" />
        <SdkChangesButton rows={state.rows} />
        {state.sessionId ? (
          <span className="min-w-0 truncate font-mono" title={state.sessionId}>
            {t("sdk.session", { id: state.sessionId.slice(0, 8) })}
          </span>
        ) : null}
      </div>
      <SdkDetailHost rows={state.rows} tasks={state.agentTasks} stack={detailStack} onStack={setDetailStack} />
    </div>
    </SdkDetailContext.Provider>
    </DetailChannelContext.Provider>
    </WorkflowFeedContext.Provider>
  );
}

/** "Mudanças": the files Claude and the subagents changed in this conversation — opens the modal. */
function SdkChangesButton({ rows }: { rows: readonly SdkRow[] }) {
  const t = useT();
  const { open } = React.useContext(SdkDetailContext);
  const files = useChangedFiles(rows);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <button
      type="button"
      data-testid="sdk-changes"
      onClick={() => open({ kind: "changes" })}
      className="flex shrink-0 items-center gap-1 rounded border border-border/70 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <FileDiff className="h-3 w-3" />
      <span>{t("sdk.changes.button", { n: files.length })}</span>
      {files.length ? <span className="tabular-nums"><span className="text-emerald-500">+{added}</span> <span className="text-red-500">−{removed}</span></span> : null}
    </button>
  );
}

/**
 * THE "RODANDO EM SEGUNDO PLANO" STRIP — the equivalent of the "1 background task" in Claude
 * Code's footer. Lists what is alive by the description the model itself gave the task, with the SAME design
 * as the conversation's subagent panel: pinned above the field while there is work running. Height
 * ceiling for the same reason as the queue: a sibling of the scroller, it must not squeeze the conversation.
 */
function SdkBackgroundTray({ tasks, agentTasks, rows }: { tasks: readonly BackgroundTask[]; agentTasks: SdkChatState["agentTasks"]; rows: readonly SdkRow[] }) {
  const t = useT();
  const { open } = React.useContext(SdkDetailContext);
  // The strip only exists with work running: the clock ticks while it is in view.
  const now = useNow(usePageVisible());
  return (
    <FleetPanel
      testId="sdk-background-tasks"
      role="status"
      count={tasks.length}
      icon={<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
      title={t("sdk.backgroundTitle", { n: tasks.length })}
      subtitle={t("sdk.backgroundHint")}
      className="mt-1.5 max-h-[20vh] shrink-0 overflow-y-auto overscroll-contain"
    >
      {tasks.map((task) => {
        // The task links to the call that fired it: a subagent opens its timeline; a background Bash
        // opens the action. Without the link (old CLI), it is just the description — no click.
        const id = task.toolUseId;
        const call = id ? rows.find((r) => r.kind === "tool" && r.id === id) : undefined;
        const isAgent = call?.kind === "tool" ? isAgentTool(call.name) : task.type === "local_agent";
        const live = id ? agentTasks[id] : undefined;
        return (
          <FleetRow
            key={task.id}
            testId="sdk-background-task"
            status="running"
            name={task.description.trim() || t("sdk.backgroundUnnamed")}
            now={live?.summary || live?.lastTool || ""}
            actions={live?.toolUses}
            durationMs={agentElapsedMs("running", live, undefined, now)}
            onClick={id ? () => open(isAgent ? { kind: "agent", id } : { kind: "action", id }) : undefined}
          />
        );
      })}
    </FleetPanel>
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
 * between those two is the whole question the person is asking the screen. Only the dials that
 * SHOW the number call this (they are mounted only while work runs, so an idle chat holds no
 * timer): the tick re-renders them, never the conversation around them.
 */
function useTurnClock(startedAt: number): number {
  const [seconds, setSeconds] = React.useState(() => elapsedSeconds(startedAt));
  React.useEffect(() => {
    setSeconds(elapsedSeconds(startedAt));
    const timer = setInterval(() => setSeconds(elapsedSeconds(startedAt)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return seconds;
}

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

/**
 * The STATUS LADDER's line at the live edge of the conversation: the verb of this instant, the
 * clock, and what the model is saying now (or the canned note when it says nothing).
 */
function SdkWorkingLine({
  startedAt,
  activity,
  awaiting,
  ready,
  escalation,
  detail,
}: {
  startedAt: number;
  activity: SdkActivity | null;
  awaiting: boolean;
  ready: boolean;
  escalation: { ultrathink: boolean; ultracode: boolean } | null;
  /** What the model is saying NOW (see `liveActivityDetail`) — null when there is no word of its own. */
  detail: string | null;
}) {
  const t = useT();
  const seconds = useTurnClock(startedAt);
  const kind = workingKindOf(activity, awaiting, ready);
  /* This instant's verb and note: it is what swaps a static "Trabalhando…" for something that moves. */
  const stage = workingStage(kind, seconds);
  return (
    // For the eyes: inside the log the clock would be announced every second (the phase goes through the status).
    <div
      aria-hidden="true"
      // `pr-36`: the right corner of this row belongs to the context meter; the note truncates before it.
      className="flex items-center gap-2 pr-36 text-xs text-muted-foreground"
      data-testid="sdk-chat-working"
      data-phase={kind}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span className="text-foreground/90">{t(stage.verb)}</span>
      {/* THE MODEL'S WORD beats the canned phrase. The canned tail was the same for any
          tool and any reasoning — picked by a table from the clock —,
          and what the person wanted to read ("Medindo o tamanho do módulo PDV", the reasoning in
          progress) was one step away, in the state. The canned one remains the fallback for when
          there is nothing to say: a session starting up has no reasoning to show. */}
      <span data-testid="sdk-working-note" className="min-w-0 truncate opacity-80">
        {escalation
          ? t("sdk.workingWithEffort", {
              elapsed: formatTurnElapsed(seconds),
              note: detail ?? t(stage.note),
              effort: escalation.ultracode ? t("sdk.ultracodeOn") : t("sdk.effortHigh"),
            })
          : t("sdk.workingWith", { elapsed: formatTurnElapsed(seconds), note: detail ?? t(stage.note) })}
      </span>
    </div>
  );
}

/**
 * WHICH PHASE to name now. What the bar knows (the live activity, whether the session is still starting up)
 * becomes the phase `workingStage` knows how to describe. PURE.
 */
function workingKindOf(
  activity: { kind: "tool" | "thinking" | "answering" } | null,
  awaiting: boolean,
  ready: boolean,
): WorkingKind {
  if (awaiting && !ready) return "preparing";
  if (activity) return activity.kind;
  return awaiting ? "thinking" : "working";
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
  startedAt,
  escalation,
  awaiting,
  ready,
  onJump,
}: {
  activity: SdkActivity | null;
  startedAt: number;
  escalation: { ultrathink: boolean; ultracode: boolean } | null;
  awaiting: boolean;
  ready: boolean;
  onJump: () => void;
}) {
  const t = useT();
  const seconds = useTurnClock(startedAt);
  /* The tool's name beats the verb — "Rodando testes" says more than "Executando…". Other than that,
     it is the same vocabulary as the indicator down below (workingStage): a verb that changes, a note that escalates. */
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
      <span data-testid="sdk-activity-elapsed" aria-hidden="true" className="shrink-0 opacity-70">
        {t("sdk.workingWith", { elapsed: formatTurnElapsed(seconds), note: t(stage.note) })}
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
  const { open } = React.useContext(SdkDetailContext);
  const headline = toolHeadline(row.name, row.input);
  const status = toolStatus(row);
  const detail = headline.background ? t("sdk.toolBackground") : headline.detail;
  // PROVISIONAL: the model is still writing the input — the row says what and how much ("Escrevendo x.ts… 12 KB").
  const pending = row.pending === true;
  return (
    <button
      type="button"
      data-testid="sdk-tool"
      data-tool={row.name}
      data-pending={pending || undefined}
      data-status={status}
      disabled={pending}
      title={pending ? undefined : t("sdk.detail.open")}
      onClick={() => open({ kind: "action", id: row.id })}
      className="group -ml-1 block w-[calc(100%+0.25rem)] min-w-0 rounded border border-transparent py-0.5 pl-1.5 pr-1 text-left text-xs enabled:hover:border-border/70 enabled:hover:bg-muted/50"
    >
      <div className="flex items-baseline gap-1.5 text-muted-foreground">
        {/* Moves the icon down to the text line with `top`, not with `translate`: `animate-spin`
            owns `transform`, and a translate there made the spinner just slide 2px and back, without spinning. */}
        <StatusIcon status={status} className="relative top-0.5" />
        <span data-testid="sdk-tool-title" className="min-w-0 flex-1 truncate font-medium text-foreground/90">
          {pending ? toolLiveLabel(row) : headline.title}
        </span>
        {!pending ? <Maximize2 aria-hidden className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" /> : null}
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
      <ToolResultText name={row.name} result={row.result} />
    </button>
  );
}

/**
 * THE model's REASONING, while it works.
 *
 * What this solves: a long turn showed only a spinner and the word "Trabalhando…" — it could be
 * half a second or ten minutes, and whoever was waiting had no way of knowing whether the agent understood the request.
 * Now the thinking shows up live, in the background (smaller, in italics, without the weight of the answer).
 *
 * OPEN BY DEFAULT, and stays open when the turn ends (César's request, 26/09/2026): he reads
 * the reasoning to know what the AI is doing, and collapsing by itself at the end hid precisely the
 * explanation of what had just happened. Whoever does not want to read closes it — and that row's closed state stays
 * closed.
 */
function SdkThinkingRow({ text, streaming }: { text: string; streaming: boolean }): React.ReactElement {
  const t = useT();
  // Only the person's EXPLICIT choice rules; without it, it stays open — before, it followed the turn and
  // collapsed by itself at the end, which is exactly what was hiding the reasoning.
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const open = choice ?? true;
  // IN PORTUGUESE, translated in the browser (zero tokens — see lib/reasoningTranslation). Only the
  // FINISHED block: translating piece by piece would make the text jump while it arrives. `useT()` re-subscribes
  // this component when the language changes, so `getLanguage()` here keeps up.
  const translated = useReasoningTranslation(text, !streaming && getLanguage() === "pt-BR");
  const [showOriginal, setShowOriginal] = React.useState(false);
  const shown = translated !== null && !showOriginal ? translated : text;
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
          {shown}
        </div>
      ) : null}
      {open && translated !== null ? (
        <button
          type="button"
          data-testid="sdk-thinking-original-toggle"
          onClick={() => setShowOriginal(!showOriginal)}
          className="mt-0.5 pl-3 text-[10px] text-muted-foreground/60 hover:text-foreground"
        >
          {showOriginal ? t("sdk.reasoningShowTranslation") : t("sdk.reasoningShowOriginal")}
        </button>
      ) : null}
    </div>
  );
}

/** The conversation's TodoWrite: open only when it is the most recent (see `TodoCard`). */
function SdkTodoRow({ row }: { row: Extract<SdkRow, { kind: "tool" }> }) {
  const { latestTodoId } = React.useContext(SdkThreadContext);
  return <TodoCard row={row} latest={latestTodoId === row.id} />;
}

/** How often the answer still streaming is re-parsed as markdown. */
const STREAMING_MARKDOWN_MS = 100;

/**
 * The answer still streaming. `Markdown` re-parses the WHOLE text on every change, so a growing
 * answer is parsed at most once per `STREAMING_MARKDOWN_MS`; the newest text lands when the window
 * closes even if no token follows, and the settled row goes back to a plain `Markdown`.
 */
function StreamingMarkdown({ text }: { text: string }) {
  const [shown, setShown] = React.useState(text);
  const shownAtRef = React.useRef(Date.now());
  React.useEffect(() => {
    if (text === shown) return;
    const show = (): void => {
      shownAtRef.current = Date.now();
      setShown(text);
    };
    const wait = shownAtRef.current + STREAMING_MARKDOWN_MS - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [text, shown]);
  return <Markdown text={shown} />;
}

/**
 * One row of the conversation. MEMOISED: a streamed token changes only the last row, and every
 * other one — same `row` object (the reducer keeps untouched rows by reference), same primitives,
 * same stable handlers — has nothing new to draw.
 */
const SdkChatRow = React.memo(function SdkChatRow({
  cardId,
  row,
  answered,
  aiming = false,
  onPermission,
  onAnswer,
  peerDrafts,
  onDraft,
  onReply,
  onEdit,
  onResend,
  onDiscard,
  retrying = false,
  command,
  commandRunning = false,
  answerOf,
  trailing,
}: {
  /** The conversation's card — a question card keeps its draft per card (lib/questionDraftStore.ts). */
  cardId?: string;
  row: SdkRow;
  /** The explicit reply this row's question already received — what it shows it got. */
  answered?: string;
  /** Is the composer aimed at THIS row's question (so it says so, in place)? */
  aiming?: boolean;
  onPermission?: (id: string, allow: boolean) => void;
  onAnswer?: (id: string, answers: SdkQuestionAnswer[]) => void;
  /** On a question card: what OTHER people of this card have marked and typed on it so far. */
  peerDrafts?: Readonly<Record<string, QuestionDraft>>;
  /** On a question card: tells the other tabs what this person has marked and typed so far. */
  onDraft?: (id: string, draft: QuestionDraft) => void;
  /** Arms the composer on this row's question ("Responder"). */
  onReply?: (decision: PendingDecision) => void;
  /** Offered only on one's OWN messages: the pencil that starts editing (a supersede). */
  onEdit?: (rowId: string, original: string) => void;
  /** On a message the server never took: send the very same words again (same receipt id). */
  onResend?: (cid: string) => void;
  /** On a message the server never took: give up on it (bubble and stored copy both go). */
  onDiscard?: (cid: string) => void;
  /** On a message the server never took: the screen will resend it by itself (see `planAutoResend`). */
  retrying?: boolean;
  /** On one's own message that IS a catalogue command: drawn as the command chip (`invokedCommand`). */
  command?: InvokedCommand;
  /** That command is the one the running turn is executing. */
  commandRunning?: boolean;
  /** A FINISHED answer (`finishedAnswerIds`): the card it belongs to — it gets "copiar" and "ouvir". */
  answerOf?: string;
  /** Closes this answer's copiar/ouvir row on the right: the context meter, on the last answer. */
  trailing?: React.ReactNode;
}) {
  const t = useT();
  // Whose screen this is — their own messages render unlabelled, everyone else's carry the sender.
  const viewer = useAuth().user?.username;
  // Before the returns (rules of hooks). Once per row: the row's memo and the stable `row` hold it.
  const diff = React.useMemo(() => (row.kind === "tool" ? toolDiff(row.name, row.input) : null), [row]);

  if (row.kind === "question") {
    return (
      <SdkQuestionCard
        cardId={cardId ?? ""}
        row={row}
        onAnswer={onAnswer}
        peers={peerDraftsOf(peerDrafts, viewer)}
        own={viewer ? peerDrafts?.[viewer] : undefined}
        onDraft={onDraft}
      />
    );
  }

  if (row.kind === "tool") {
    // With no input yet, the subagent's or the list's card would come out empty: the provisional one is the live row.
    if (row.pending) return <SdkToolRow row={row} />;
    if (isAgentTool(row.name)) return <SdkAgentCard row={row} />;
    if (row.name === "TodoWrite") return <SdkTodoRow row={row} />;
    return diff ? <ToolDiffCard row={row} diff={diff} /> : <SdkToolRow row={row} />;
  }

  if (row.kind === "workflow") {
    return <WorkflowPanel row={row} />;
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

  if (row.kind === "voice") {
    return <VoiceTurnBubble role={row.role} text={row.text} from={row.from} viewer={viewer} live={row.live} save={row.save} />;
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

  if (row.kind === "btw") {
    // The /btw question lives in a blue card with its own header: in the middle of a long turn it got
    // lost among the reasoning and the tools, and the person was left hunting for what they asked.
    return (
      <div
        data-testid="sdk-btw"
        className="max-w-prose rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm"
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-blue-500">
          <span title={t("sdk.btwLabel")} className="shrink-0">
            <MessageCircleQuestion aria-label={t("sdk.btwLabel")} className="h-3.5 w-3.5" />
          </span>
          {t("sdk.btwTitle")}
        </div>
        <div className="mt-1 whitespace-pre-wrap text-foreground">{row.question}</div>
        <div className="mt-2 border-t border-blue-500/25 pt-2">
          {row.text !== undefined ? (
            <div className="leading-relaxed text-foreground/85"><Markdown text={row.text} /></div>
          ) : row.error !== undefined ? (
            <div className="text-xs leading-5 text-destructive">{t("sdk.btwError", { error: row.error })}</div>
          ) : (
            <Loader2 aria-label={t("sdk.btwPending")} className="my-0.5 h-3.5 w-3.5 animate-spin text-blue-500/70 motion-reduce:animate-none" />
          )}
        </div>
      </div>
    );
  }

  if (row.kind === "compaction") return <SdkCompactionRow row={row} />;

  if (row.kind === "thinking") {
    return <SdkThinkingRow text={row.text} streaming={row.streaming} />;
  }

  // A superseded version is not drawn: the edit replaces the bubble instead of stacking a greyed
  // copy above the new one. The row stays in the state — a rewind cuts the conversation from it.
  if (row.kind === "user" && row.edited === true) return null;

  if (row.kind === "user") {
    // Same reading rules as the transcript chat: your own message keeps the right-aligned primary
    // bubble; another card's agent gets the green robot bubble (name links to its card), another
    // person a neutral one with their name.
    const role = originRole(row.from, viewer);
    const editedBadge = row.revision ? (
      <div data-testid="sdk-user-edited" className="mt-1 text-right text-[10px] italic text-muted-foreground/80">
        {t("sdk.edited")}
      </div>
    ) : null;
    // An ANSWER to a decision, not a loose message: the bubble carries the question it answered, so
    // "did I answer or just send a note?" is settled by looking at what was sent. The wrapper the
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
     * so and hands back the two things the person actually needs: send again, or give up. The
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
        {/* Nobody needs to keep watching: the screen tries again by itself. The button stays there for whoever
            does not want to wait for the interval. */}
        {retrying ? (
          <span data-testid="sdk-user-retrying" className="min-w-0 text-right italic">
            {t("sdk.undeliveredRetrying")}
          </span>
        ) : null}
        {/* Only the author resends: from here the message would go out under the name of whoever is on the tab. */}
        {role === "self" ? (
          <button
            type="button"
            data-testid="sdk-user-resend"
            onClick={() => onResend?.(row.cid as string)}
            className="rounded border border-current/40 px-1.5 py-0.5 font-medium hover:bg-amber-500/10"
          >
            {t("chat.resend")}
          </button>
        ) : null}
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
        <div className="flex flex-col items-start" data-testid="sdk-user" data-role={role} data-revision={row.revision || undefined}>
          <div
            className={cn(
              "max-w-[85%] select-text whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm",
              role === "agent" ? "border-emerald-500/40 bg-emerald-500/10" : "border-border/70 bg-muted/50",
            )}
          >
            <SenderTag from={row.from} />
            {replyHeader}
            <LinkifiedText text={bodyText} />
            {editedBadge}
            {undelivered}
          </div>
        </div>
      );
    }
    if (command && !reply && row.state !== "undelivered") {
      return (
        <div className="group flex flex-col items-end" data-revision={row.revision || undefined}>
          <SdkCommandChip command={command} running={commandRunning} />
          {editedBadge}
        </div>
      );
    }
    return (
      <div className="group flex flex-col items-end">
        <div
          data-testid="sdk-user"
          data-state={row.state}
          data-revision={row.revision || undefined}
          className="max-w-[85%] select-text whitespace-pre-wrap break-words rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm"
        >
          {replyHeader}
          <LinkifiedText text={bodyText} />
          {editedBadge}
          {undelivered}
        </div>
        {/* The pencil: hover-revealed on a desktop, simply there on touch (no hover to reveal it).
            A superseded message is not drawn at all (above). Nor does an ANSWER to a decision: its text carries the wrapper, and putting that back in the
            field would show the person plumbing instead of their own words. Answer again instead. */}
        {!reply && row.state !== "undelivered" && onEdit ? (
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
  const actions = row.kind === "assistant" && answerOf ? <AnswerActions id={row.id} cardId={answerOf} text={row.text} trailing={trailing} /> : null;
  if (prose) {
    // What this question RECEIVED (`answered`), anchored to it — the third question the screen owes
    // the person ("pronto, respondi" — "done, I answered"). Survives a reload: the answer is read back out of the sent message.
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
        {actions}
      </div>
    );
  }
  return (
    <div data-testid="sdk-assistant" className="max-w-full select-text text-sm leading-relaxed">
      {row.streaming ? <StreamingMarkdown text={row.text} /> : <Markdown text={row.text} />}
      {row.streaming ? <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/60 align-baseline" /> : null}
      {actions}
    </div>
  );
});

/**
 * Test hook: forgets the tab's in-memory card drafts — what an F5 erases. The disk
 * (localStorage, lib/questionDraftStore.ts) is already cleared by the test setup on every test.
 */
export function resetQuestionDraftsForTesting(): void {
  forgetQuestionDraftMemoryForTesting();
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
  cardId,
  row,
  onAnswer,
  peers = [],
  own,
  onDraft,
}: {
  /** The conversation's card: the stored draft is per card + question (lib/questionDraftStore.ts). */
  cardId: string;
  row: Extract<SdkRow, { kind: "question" }>;
  onAnswer?: (id: string, answers: SdkQuestionAnswer[]) => void;
  /** Who ELSE is answering this card right now, and what (lib/peerQuestionDraft.ts). */
  peers?: Array<{ name: string; draft: QuestionDraft }>;
  /** THIS person's draft stored on the server — made on another device, or before the browser lost it. */
  own?: QuestionDraft;
  /** Tells the other tabs what this person has already marked and written. */
  onDraft?: (id: string, draft: QuestionDraft) => void;
}) {
  const t = useT();
  // What was already marked and written comes back after a reconnect, an F5 and the deploy that reloads
  // the tab — and stays stored after the click on "Responder" (see lib/questionDraftStore.ts).
  const [initial] = React.useState(() => readQuestionDraft(cardId, row.id));
  const [picked, setPicked] = React.useState<string[][]>(() => initial?.picked ?? row.questions.map(() => []));
  const [other, setOther] = React.useState<string[]>(() => initial?.other ?? row.questions.map(() => ""));
  // WHEN this person last changed the draft (the one from disk brings its own). Against the
  // server's version, the newest wins: what was done on another device is not run over by an old one from here.
  const changedAt = React.useRef(initial?.at ?? 0);
  const touch = (): void => { changedAt.current = Date.now(); };
  React.useEffect(() => {
    writeQuestionDraft(cardId, row.id, { picked, other, at: changedAt.current || undefined });
  }, [cardId, row.id, picked, other]);
  // MY draft stored on the server (the deploy, the closed tab, the other device): comes back to the
  // card when it is newer than the one here — or when there is nothing here.
  const adopted = React.useRef<QuestionDraft | null>(null);
  React.useEffect(() => {
    if (!own || isEmptyDraft(own)) return;
    const localEmpty = picked.every((sel) => sel.length === 0) && other.every((text) => text.trim() === "");
    if (!localEmpty && (own.at ?? 0) <= changedAt.current) return;
    changedAt.current = own.at ?? changedAt.current;
    adopted.current = own;
    setPicked(row.questions.map((_, i) => [...(own.picked[i] ?? [])]));
    setOther(row.questions.map((_, i) => own.other[i] ?? ""));
    // Only the arrival of a new version decides; the current state is read, not observed.
  }, [own]);
  // The SAME draft, for whoever else is on the card — two people answering the same question each
  // in their own way was the problem: only the first answer counts. On mount, it only goes out if there is already
  // something (the card coming back after a reconnect re-announces what it had); empty from birth, no.
  // What has just come from the server does not go back to it.
  const pending = row.outcome === "pending";
  const announced = React.useRef(false);
  React.useEffect(() => {
    if (!pending) return;
    const draft: QuestionDraft = { picked, other, ...(changedAt.current ? { at: changedAt.current } : {}) };
    if (!announced.current) {
      announced.current = true;
      if (isEmptyDraft(draft)) return;
    }
    if (adopted.current) {
      adopted.current = null;
      return;
    }
    onDraft?.(row.id, draft);
  }, [pending, row.id, picked, other, onDraft]);

  const single = row.questions.length === 1 && row.questions[0]?.multiSelect !== true;

  const answersFrom = (pickedNow: string[][], otherNow: string[]): SdkQuestionAnswer[] =>
    row.questions.map((_, i) => {
      const text = (otherNow[i] ?? "").trim();
      return { selected: [...(pickedNow[i] ?? []), ...(text !== "" ? [text] : [])] };
    });

  // Answered by SOMEONE: half mine and half another person's already closes the card — the back merges the
  // others' drafts into what goes to the model (mergePeerAnswers), with each one's name.
  const hasAnswer = (draft: Pick<QuestionDraft, "picked" | "other">, i: number): boolean =>
    (draft.picked[i]?.length ?? 0) > 0 || (draft.other[i] ?? "").trim() !== "";
  const complete = row.questions.every((_, i) => hasAnswer({ picked, other }, i) || peers.some((p) => hasAnswer(p.draft, i)));

  const submit = (answers: SdkQuestionAnswer[]): void => onAnswer?.(row.id, answers);

  const toggle = (qi: number, label: string): void => {
    const multi = row.questions[qi]?.multiSelect === true;
    if (single) {
      // One question, one choice: the click IS the answer.
      submit(answersFrom(row.questions.map((_, i) => (i === 0 ? [label] : [])), other.map(() => "")));
      return;
    }
    touch();
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
              : row.outcome === "cancelled"
                ? cancelledText(row.cancel, t)
                : t("sdk.questionUnanswered")}
        </div>
      </div>
    );
  }

  /** Copies to MY card what the other person marked and wrote on this question ("Usar esta"). */
  const adopt = (qi: number, draft: QuestionDraft): void => {
    touch();
    if (!single) setPicked((prev) => prev.map((sel, i) => (i === qi ? [...(draft.picked[qi] ?? [])] : sel)));
    setOther((prev) => prev.map((v, i) => (i === qi ? draft.other[qi] ?? "" : v)));
  };
  const mine = !isEmptyDraft({ picked, other });
  const peerNames = peers.map((p) => peerDisplayName(p.name)).join(", ");
  // "Respondendo" is whoever has the card open right now. Whoever closed the tab (or was here before a
  // deploy) keeps their marks visible and going to the AI — just does not show as present.
  const present = peers.filter((p) => !p.draft.away);
  const presentNames = present.map((p) => peerDisplayName(p.name)).join(", ");

  return (
    <div
      data-testid="sdk-question"
      data-outcome="pending"
      className="flex flex-col gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5 font-medium text-sky-500">
        <CircleHelp className="h-3.5 w-3.5 shrink-0" />
        {t("sdk.questionTitle")}
        {present.length > 0 ? (
          // WHO ELSE is answering, in the corner of the header: an avatar in the person's color and the same
          // dots as "está digitando" — presence, not alarm.
          <span data-testid="sdk-question-peer-presence" className="ml-auto flex min-w-0 items-center gap-1.5 font-normal">
            <span className="flex -space-x-1">
              {present.map((p) => <PeerAvatar key={p.name} name={p.name} />)}
            </span>
            <span className={cn("truncate", present.length === 1 ? peerTone(present[0]!.name).text : "text-muted-foreground")}>{t("sdk.questionPeerAnswering", { names: presentNames })}</span>
            <span className="flex items-end gap-[2px]" aria-hidden="true">
              {[0, 200, 400].map((delay) => (
                <span
                  key={delay}
                  className={cn("h-1 w-1 animate-typing-dot rounded-full motion-reduce:animate-none", present.length === 1 ? peerTone(present[0]!.name).dot : "bg-muted-foreground")}
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
          </span>
        ) : null}
      </div>
      {row.questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1.5">
          {q.header ? <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-500/80">{q.header}</div> : null}
          <div className="text-sm text-foreground">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((opt) => {
              const selected = (picked[qi] ?? []).includes(opt.label);
              // Marked by ANOTHER person: their dot in the corner of the option, in their color.
              const pickedBy = peers.filter((p) => (p.draft.picked[qi] ?? []).includes(opt.label));
              return (
                <Button
                  key={opt.label}
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  className={cn("relative h-7 max-w-full overflow-visible text-xs", pickedBy.length > 0 && !selected && peerTone(pickedBy[0]!.name).border)}
                  data-testid="sdk-question-option"
                  data-peer-picked={pickedBy.length > 0 || undefined}
                  aria-pressed={selected}
                  title={pickedBy.length > 0
                    ? [opt.description, t("sdk.questionPeerPicked", { names: pickedBy.map((p) => peerDisplayName(p.name)).join(", ") })].filter(Boolean).join(" — ")
                    : opt.description}
                  onClick={() => toggle(qi, opt.label)}
                >
                  <span className="truncate">{opt.label}</span>
                  {pickedBy.length > 0 ? (
                    <span className="absolute -right-1.5 -top-1.5 flex -space-x-1">
                      {pickedBy.map((p) => <PeerAvatar key={p.name} name={p.name} small />)}
                    </span>
                  ) : null}
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
            onChange={(e) => {
              touch();
              const value = e.target.value;
              setOther((prev) => prev.map((v, i) => (i === qi ? value : v)));
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const answers = answersFrom(picked, other);
              if (answers[qi]!.selected.length > 0 && (single || complete)) submit(answers);
            }}
            className="h-7 rounded-md border border-border/70 bg-background/80 px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-sky-500/60"
          />
          {peers.map(({ name, draft }) => {
            const text = (draft.other[qi] ?? "").trim();
            if (text === "") return null;
            const tone = peerTone(name);
            // THE OTHER PERSON'S FIELD, right below mine: dashed in their color, with what they
            // are writing live — and one click to adopt their answer on my card.
            return (
              <div
                key={name}
                data-testid="sdk-question-peer-draft"
                className={cn("flex min-h-7 items-center gap-2 rounded-md border border-dashed px-2 py-1", tone.border, tone.bg)}
              >
                <PeerAvatar name={name} />
                <span className={cn("shrink-0 font-medium", tone.text)}>{peerDisplayName(name)}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{text}</span>
                <button
                  type="button"
                  data-testid="sdk-question-peer-use"
                  onClick={() => adopt(qi, draft)}
                  className={cn("shrink-0 rounded border px-2 py-0.5 text-[11px] font-medium hover:bg-background/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1", tone.border, tone.text)}
                >
                  {t("sdk.questionPeerUse")}
                </button>
              </div>
            );
          })}
        </div>
      ))}
      {peers.length > 0 && mine ? (
        // Only on CONFLICT: both people with something written. Before, the strip was always up.
        <div data-testid="sdk-question-peer-clash" role="status" className="flex items-center gap-1.5 text-amber-500">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("sdk.questionPeerClash", { names: peerNames })}
        </div>
      ) : null}
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
 * EACH PERSON'S COLOR on the question card — like a cursor in a shared document: fixed by name,
 * never the alert amber nor the card's own blue. Whole classes (Tailwind only generates what it reads).
 */
const PEER_TONES = [
  { text: "text-violet-400", border: "border-violet-400/60", bg: "bg-violet-400/10", dot: "bg-violet-400", solid: "bg-violet-400 text-violet-950" },
  { text: "text-emerald-400", border: "border-emerald-400/60", bg: "bg-emerald-400/10", dot: "bg-emerald-400", solid: "bg-emerald-400 text-emerald-950" },
  { text: "text-pink-400", border: "border-pink-400/60", bg: "bg-pink-400/10", dot: "bg-pink-400", solid: "bg-pink-400 text-pink-950" },
  { text: "text-orange-400", border: "border-orange-400/60", bg: "bg-orange-400/10", dot: "bg-orange-400", solid: "bg-orange-400 text-orange-950" },
] as const;

function peerTone(name: string): (typeof PEER_TONES)[number] {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PEER_TONES[hash % PEER_TONES.length]!;
}

/** The dot with the person's initial, in their color. */
function PeerAvatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full font-bold ring-2 ring-background",
        small ? "h-4 w-4 text-[9px]" : "h-[18px] w-[18px] text-[10px]",
        peerTone(name).solid,
      )}
    >
      {peerDisplayName(name).charAt(0)}
    </span>
  );
}
