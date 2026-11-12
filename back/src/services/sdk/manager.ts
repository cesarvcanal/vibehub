import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import * as registry from "../board/registry.js";
import { syncPendingQuestion } from "./pendingQuestion.js";
import { onCardBackgroundProbe, onCardDefaultEffortProbe, onCardDriverProbe, onCardEffortApplier, reportCardStatusFromDriver, type DriverActivity } from "../board/agentState.js";
import { onCardInUseProbe, onCardSessionKill } from "../board/workspace.js";
import { HISTORY_REPLAY_LIMIT, appendHistory, appendHistoryReported, clearHistoryBeforeLastClear, readHistory, replayableHistoryEvent, rewindHistory, unwrapEditedMessage, type HistoryEvent } from "./history.js";
import { clearInflightMarker, inflightPreview, writeInflightMarker, type InflightBackground, type InflightMarker } from "./inflight.js";
import { forgetDriverKeys, noteDriverEventFor, onOutsideTurn } from "./mirror.js";
import { dropOldest } from "./insertionOrder.js";
import { loadQuestionDrafts, saveQuestionDrafts, type StoredQuestionDraft } from "./questionDrafts.js";
import { createLineReader } from "../../utils/lineReader.js";
import { writeCardCatalog } from "./catalog.js";
import { normalizeRateLimit, type RateLimitInfo } from "./rateLimit.js";
import { normalizeContextUsage, type ContextUsageInfo } from "./contextUsage.js";
import { forgetCardWorkflows, lastWorkflowRuns, readAgentFeed, watchCardWorkflows } from "./workflow.js";
import { InvalidWorkflowIdError } from "./workflowProbe.js";
import { InvalidDetailIdError, readAgentTimeline, readToolDetail } from "./detail.js";
import { readCardChanges, readCardFileDiff } from "../maestro/changes.js";
import { mergeTaskEvent, taskSnapshot, toolResultEvent, type AgentTaskEvent, type RawTaskEvent, type RawToolResultEvent } from "./toolResult.js";
import { isHarnessFiller } from "../chat/chat.js";
import {
  NOTE_CONVERSATION_CLEARED, buildLateAnswerText, buildOrphanAnswerText, mergePeerAnswers, buildSupersedeText, interruptNote, normalizeSlashCommands, withBtwCommand, parseDriverLine, parseSdkClientFrame, parseTypingFrame, parseQuestionDraftFrame, isEmptyQuestionDraft, parseWorkflowFeedFrame, parseDetailFrame, encodeControl,
  type BackgroundTaskInfo, type CatalogEvent, type DriverControl, type DriverEvent, type EffortAckEvent, type QuestionAnswerControl, type QuestionDraft, type StopHow, type UserQuestionItem,
  type WorkflowFeedEvent, type WorkflowFeedRequest, type DetailRequest, type ResultEvent,
} from "./protocol.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { observeDriverEvent } from "../events/cardEvents.js";
import { logger } from "../../utils/logger.js";

/**
 * SDK DRIVER MANAGER — ONE driver process per card, owned by the BACKEND, not by a websocket.
 *
 * The bug this closes (the reload-mid-turn bug): the driver used to be spawned per
 * CONNECTION and torn down in the socket's close handler — the user sent a message on the native
 * chat, hit Cmd+Shift+R, the socket died and killed the driver MID-TURN. The answer never reached
 * the transcript, and the reconnect's fresh driver resumed the session without continuing the
 * pending turn: the message was silently swallowed.
 *
 * The manager decouples the turn from the page:
 *  - `ensureDriverSession` spawns AT MOST one driver per card and hands every later connect the
 *    same live process (two tabs of one card multiplex one driver — never two);
 *  - the manager itself listens to the driver's stdout: history persistence, mirror dedupe keys
 *    and resume-id persistence all live HERE, the side that survives — a turn keeps flowing into
 *    `sdk-history` with zero pages open;
 *  - `attachSocket` fans events out to every connected socket and funnels controls (user message,
 *    interrupt, permission decision) into the one stdin; a socket closing merely detaches it;
 *  - end of life: `stopCardDriver` (wired into `killCardSession` via `onCardSessionKill`, so
 *    pause/hibernate/restart/delete/model-switch all end the driver), plus an IDLE timer — a
 *    driver with no sockets AND no running turn for `DRIVER_IDLE_MS` shuts down on its own (the
 *    persisted resume id brings the conversation back on the next connect).
 *
 * The runner reaper never touches a live driver: the driver is not a `claude`/watcher process, its
 * SDK subprocesses hang off it (never ppid 1 while it lives), and `reapCandidates` additionally
 * refuses anything carrying the driver's path (see services/reaper/reaper.ts).
 */

/** No sockets AND no running turn for this long ⇒ the driver shuts down (resume covers the rest). */
export const DRIVER_IDLE_MS = 15 * 60_000;

/**
 * For how long a background task alone holds up a driver nobody is watching.
 * A deploy wait lasts minutes; an `npm run dev` or `tail -f` in the background never ends, and
 * without a cap it kept the driver (and the card) awake forever — before this rule the idle stop
 * knocked it down in 15 min. Past the cap the normal idle applies. With a tab open the driver lives
 * anyway, as always.
 */
export const BACKGROUND_HOLD_MAX_MS = 3 * 60 * 60_000;

/** Websocket keepalive — same cadence as the terminal socket (proxies drop idle websockets). */
const KEEPALIVE_MS = 25_000;

/**
 * The floor between two "está digitando" relays from ONE socket. The front already throttles; this
 * is the server's own guard, so a misbehaving tab can never turn keystrokes into a fan-out storm.
 * The "parou" is never held back by it (a stale indicator is the visible bug, not a busy wire).
 */
export const TYPING_RELAY_MIN_MS = 1_000;

/**
 * How long to wait, after the last background task finishes, before taking the card as
 * idle. Almost always the CLI opens a turn on its own to report the result — and that turn's `Stop`
 * is the one that says "aguardando". Only when no turn opened within this interval does the manager speak for it.
 */
const BACKGROUND_SETTLE_MS = 15_000;

/** How many subagents/tasks the session remembers (the oldest finished ones go first). */
const TASKS_MAX = 200;

/**
 * THE RESUME HAS TO TAKE. The CLI coming back from a dead process with background work first opens
 * a turn of ITS OWN — the notification that the task died — and closes it with an empty
 * `result`; sometimes the injected continuation vanishes with it and never becomes a turn (production, 2026-10-20, card
 * 4f4b: 16 min stopped with "Retomando a sessão…" as the last line). After a `result` with nothing
 * from the agent, the resume waits this long for a sign of life before resending the order. It is also the
 * cost of the opposite mistake: a real turn that takes longer than this to give its first sign (contended
 * CPU, MCP coming up) gets the order twice — hence generous, and never more than one resend.
 * Known limit: if the CLI answers its own notification with TEXT and swallows the continuation, that
 * text counts as "it took" — in production only the "No response requested." filler was seen.
 */
export const RESUME_CONFIRM_MS = 45_000;

/** Who signs the lines the panel injects (resume, re-engage): the panel, never a person. */
export const SYSTEM_ORIGIN: MessageOrigin = { kind: "system", name: "vibehub" };

export interface DriverSession {
  cardId: string;
  /** Log label (the card's worktree slug). */
  label: string;
  child: ChildProcessWithoutNullStreams;
  sockets: Set<WebSocket>;
  /** The driver said `ready` — a socket attaching after this gets a synthesized one. */
  ready: boolean;
  /** Latest session id the driver reported — the resume key (also persisted on the card). */
  lastSessionId?: string;
  /**
   * The card's transcript directory inside the runner (`/root/.claude/projects/<slug>`). It is the
   * root of where the harness writes a workflow's journal, and the ONLY reason the manager knows
   * it: see `workflowDirs` below. Absent = this driver was spawned without it and the fleet simply
   * is not watched.
   */
  transcriptDir?: string;
  /** Turns in flight or queued in the driver: +1 per user send, -1 per result. */
  activeTurns: number;
  /**
   * The BACKGROUND tasks alive in this driver's CLI (the last `background_tasks`): work
   * that goes on after the turn's `result`. Session state, like the catalog — resent to whoever
   * connects later, never recorded — and, while it is not empty, the driver is NOT idle.
   */
  backgroundTasks: BackgroundTaskInfo[];
  /**
   * The state of each SUBAGENT (or task) spawned by a call, by that call's id — what
   * the fleet and the tray show (counters, the sentence of what it is doing now, the end). Session state:
   * resent to whoever connects; only the END goes into the history.
   */
  tasks: Map<string, AgentTaskEvent>;
  /**
   * The last plan limit warning PER WINDOW (`five_hour`, `seven_day`, …), as the CLI emitted it.
   * Session state: resent to whoever connects later, never recorded.
   */
  rateLimits: Map<string, RateLimitInfo>;
  /**
   * The last reading of how much of the context window the session takes (the meter next to the "está
   * digitando"). Session state, like the limit warning: resent to whoever connects, never recorded.
   */
  contextUsage?: ContextUsageInfo;
  /**
   * When the compaction in progress started (ms) — absent outside of it. State, like the meter: whoever
   * opens the card in the middle of the /compact gets the bar counting from here, and not a stopped chat.
   */
  compacting?: { startedAt: number; trigger?: "manual" | "auto" };
  /** When the set stopped being empty — the start of the `BACKGROUND_HOLD_MAX_MS` count. */
  backgroundSince?: number;
  /** The settling of the card's status after the background emptied (see BACKGROUND_SETTLE_MS). */
  backgroundSettleTimer?: NodeJS.Timeout;
  /**
   * The session's command CATALOGUE (what the chat's "/" menu offers), as last reported by the
   * driver. Kept HERE, next to `ready`: it is session state, not conversation — it is never
   * written to the history, and a page that attaches later gets it replayed from this field
   * instead of waiting for the next `init` (which only comes with the next turn).
   */
  catalog?: CatalogEvent;
  /** The account's reasoning level, as the driver announced it at boot (`effort_default`). */
  defaultEffort?: string;
  /** Effort switches waiting for the driver's `effort_ack`, by id: the level asked for and who to answer. */
  pendingEffortSwitches: Map<string, PendingEffortSwitch>;
  idleTimer: NodeJS.Timeout | null;
  /** Rolling tail of the driver's stderr — what a post-mortem has to say (see STDERR_TAIL_MAX). */
  stderrTail: string;
  /** The session was stopped or its child closed — a new ensure must spawn anew. */
  closed: boolean;
  /**
   * A stop was asked for and the aborted turn has not reported back yet: the note that will
   * NARRATE the cut in the conversation (see `interruptNote`). It is flushed with the turn's
   * `result` — not when the interrupt is sent — so it lands AFTER the last deltas the aborting turn
   * still emits, right under the sentence that stops mid-way instead of on top of it.
   */
  pendingInterruptNote?: string;
  /**
   * WHO STOPPED the turn in progress and how — kept until the turn closes. A question the driver
   * closes without an answer in the meantime was cancelled by that person, and the card says so.
   */
  stopCause?: { by?: string; how: StopHow };
  /**
   * Background tasks that FINISHED and whose completion notice the CLI has not delivered yet — it
   * opens a turn for it when the model is free. Until then the notice is work a deploy would erase.
   */
  pendingNotices: string[];
  /**
   * An AUTOMATIC resume (injectSystemTurn) that has not produced anything yet. `marker` is its
   * in-flight marker: the first text or tool call rewrites it with `progressed: true` — the proof the
   * boot sweep needs to resume it again after another deploy (see ./resume.ts). Until then the vigia
   * (RESUME_CONFIRM_MS) watches it; `reengaged` = the order already went again once, so the next
   * stall is a note, never a third send. A person's turn clears it.
   */
  resumeWatch?: { marker: InflightMarker; reengaged: boolean; timer?: NodeJS.Timeout };
  /**
   * Consecutive turns the API knocked down with a transient failure (network, DNS, overload, 5xx) and the new
   * scheduled attempt (see API_RETRY_DELAYS_MS). A turn that closes without error, or a message from the
   * person, resets the count.
   */
  apiRetry?: { failures: number; timer?: NodeJS.Timeout };
  /** Counter of the main agent's signs of life (delta, reasoning, tool) — the watcher compares it. */
  agentSignals: number;
  /** The in-flight work marker this manager wrote last (null/absent = none). */
  marker?: InflightMarker;
  /**
   * A turn the CLI ITSELF opened — with no message on stdin: the background task ended, the
   * scheduled wakeup fired. It does not go through `activeTurns` (nobody sent anything), but it is work in
   * flight all the same: it was in one of these turns that the agent called the deploy and the card stopped silently (production,
   * 2026-10-19). It closes on its `result`.
   */
  autonomousTurn: boolean;
  /** The status this driver last wrote to the card's dot (see `syncBoardStatus`). */
  boardStatus?: registry.CardStatus;
  /** A scheduled wakeup (ScheduleWakeup) still to fire: the reason, as the agent described it. */
  pendingWakeup?: string;
  /**
   * THE EDITS IN FLIGHT, oldest first — one entry per `edit_user` written to stdin, consumed in
   * order by the `rewound` answers that come back. A `rewound` that belongs to nothing (a driver
   * reporting twice, a stale frame) finds the queue empty and cuts nothing.
   *
   * `original` is the message being replaced (the log's cut point); `text` is the CORRECTED
   * version. Both are needed because the two shapes of an edit reach the model with DIFFERENT
   * words — the clean text after a rewind, the supersede wrapper when the rewind is refused — and
   * only the driver chooses. The mirror's dedupe is registered at send time with the wrapper, so
   * a rewind left the transcript line unrecognised and the terminal mirror published the corrected
   * message a second time: one more bubble UNDER the one just corrected (production, 2026-10-01).
   *
   * A QUEUE and not one slot because nothing stops a second edit from going out before the first
   * is answered (with no turn running the screen dispatches an edit immediately). With one slot
   * the second overwrote the first, and then the first `rewound` cut the log at the WRONG message —
   * deleting a correction the person wrote and the model had already read.
   */
  rewinds: Array<{ original: string; text: string; first?: boolean }>;
  /**
   * THE RECEIPTS ALREADY ISSUED — `cid` → the send the driver already read (`AcceptedSend`): the durability
   * promise the first send earned and the line it writes.
   *
   * The bubble's "Reenviar" sends the SAME words with the SAME `cid`, on purpose: it exists for
   * the case where the receipt was lost, not the message (the socket dropped between the append and the `user_ack`,
   * which is then silently discarded; or the browser's deadline expired while this connection was still
   * being set up). Without this memory the resend became a NEW message: a second line in the
   * history, a second turn, and the agent executing twice an instruction that may be
   * destructive. An already accepted cid is not a message — it is the claim for a receipt, and the receipt is all
   * it gets back.
   */
  acceptedCids: Map<string, AcceptedSend>;
  /** Cancels the mirror subscription (conversation coming from the Terminal tab). Lives as long as the driver lives. */
  offOutside?: () => void;
  /**
   * THE QUESTIONS THIS DRIVER ASKED — every `user_question` it emitted, closed or not. The
   * driver keeps its own only in memory; a pending card in the history that is NOT here is an
   * ORPHAN: whoever opened it died (deploy, crash, hibernation) and this driver never heard of it.
   * It never leaves here when closed: the driver's `question_result` reaches the disk AFTER reaching
   * here, and a read in the middle of that path would take its question for an orphan (duplicated result).
   */
  ownQuestions: Set<string>;
  /**
   * WHAT EACH PERSON HAS ALREADY TICKED on a still open question card, by question id → name of
   * whoever is writing. So that whoever opens the card in the middle of another person's answer sees their draft in the
   * first frame, and so the answer carries along what the others ticked (`mergePeerAnswers`).
   * Mirrored ON DISK (./questionDrafts.ts): a deploy in the middle of four questions erased everything
   * (production, 2026-11-03). Closing the tab does NOT erase — only the closed question does (`forgetQuestionDrafts`).
   */
  questionDrafts: Map<string, Map<string, StoredQuestionDraft>>;
  /**
   * ORPHAN question cards still open (from a driver that died: the deploy). They count as a pending
   * decision just like the live driver's — the card lights up "precisa de você" until someone answers.
   */
  orphanAsks: Set<string>;
  /** How many open tabs of each person are touching each card — 0 = they left ("ausente"). */
  draftLive: Map<string, Map<string, number>>;
  /** The drafts stored on disk have already gone into `questionDrafts`. */
  draftsLoaded: Promise<void>;
  /**
   * THIS DRIVER'S CARDS and where each one stands. A second answer to an already answered card becomes a
   * message for the model to compare (`answerLate`), instead of dying as "no pending question". Only
   * memory, with a cap (`QUESTION_CARDS_MAX`).
   */
  questionCards: Map<string, QuestionCard>;
  /**
   * THE DECISIONS THE TURN IS WAITING FOR NOW — the ids of `user_question` and `permission_request` this
   * driver opened that have not come back yet (`question_result` / `permission`). Not empty = the turn
   * is stopped on a person, and the card shows "precisa de você" instead of "trabalhando" (see
   * `syncAwaitingDecision`). It empties when the turn closes and when the driver dies.
   */
  openAsks: Set<string>;
  /** What this driver last wrote to the card's `awaitingDecisionAt` (true = stamped). */
  awaitingDecision: boolean;
  /** Orphans this manager has already CLOSED: a late click on them gets the error, never silence. */
  settledOrphans: Set<string>;
  /** Orphans with an answer ON ITS WAY: the second click (another tab, double click) becomes nothing. */
  answeringOrphans: Set<string>;
  /**
   * The per-message orphan sweep has already run. An orphan is a question from a PREVIOUS driver: after
   * this driver came up no new one can be born, so one sweep is enough — without reading the whole
   * history on every message of the session's life.
   */
  orphansSwept: boolean;
}

/**
 * How many receipts a session remembers. High enough to cover any resend a person
 * would still make (the browser's outbox keeps few), low enough for the memory not to grow
 * with the conversation. The oldest goes first: a forgotten cid simply becomes a new message again.
 */
const ACCEPTED_CIDS_MAX = 256;

/**
 * A send the driver has ALREADY read: its receipt's durability promise and the history line
 * it tries to write. The line is kept because the write may fail (full disk) AFTER the
 * model has received the message — and then the resend of that cid is the time to write it again, never to
 * send it to the driver once more (see `chargeReceipt`).
 */
interface AcceptedSend {
  persisted: Promise<boolean>;
  line: HistoryEvent;
}

/** Remembers this send's receipt, discarding the oldest ones. The `Map`'s order is insertion order. */
function rememberCid(session: DriverSession, cid: string | undefined, sent: AcceptedSend): void {
  if (!cid) return;
  session.acceptedCids.set(cid, sent);
  dropOldest(session.acceptedCids, ACCEPTED_CIDS_MAX);
}

/**
 * What became of ONE client frame, so the socket that sent it can be TOLD.
 *
 * The bug this exists for (production, 2026-09-17): a send whose driver had just been killed — the
 * idle sweep hibernating a card someone was chatting in — was written into a dead stdin inside a
 * `try {} catch {}`, persisted to the history anyway, and answered with silence. On screen it was
 * a message "enviada" that spun forever; on the next F5 it was either a message nobody ever
 * answered or (when the socket itself was the dead end) no message at all. Nothing in the pipe
 * could tell the difference, because nothing in the pipe ever ANSWERED.
 *
 * Now every user frame gets a verdict: `accepted` once the message is durably in the card's
 * history AND in the driver's stdin, `refused` when the driver is gone (nothing written, nothing
 * persisted — the browser keeps the words and may resend), or `ignored` for a frame that is not a
 * turn (an interrupt, a permission click: those need no receipt).
 */
export type ClientFrameOutcome =
  /** `persisted` resolves `true` once the message is on disk, `false` when that write failed. */
  | { kind: "accepted"; cid?: string; persisted: Promise<boolean> }
  | { kind: "refused"; cid?: string; reason: string }
  /** `sent`: a frame that went out without being a turn (the /btw) — the typing is over all the same. */
  | { kind: "ignored"; sent?: true };

/** How much stderr the post-mortem keeps. Enough for a stack trace, bounded against a chatty child. */
const STDERR_TAIL_MAX = 2000;

const sessions = new Map<string, DriverSession>();

/* ------------------------------------------------------------- test seams */

type DriverSpawner = (file: string, args: string[]) => ChildProcessWithoutNullStreams;

const realSpawner: DriverSpawner = (file, args) =>
  spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

let spawner: DriverSpawner = realSpawner;

/** Test hook: replace (or with null, restore) how the driver child is spawned. */
export function setDriverSpawnerForTesting(fn: DriverSpawner | null): void {
  spawner = fn ?? realSpawner;
}

/** Test hook: stop and forget every live driver session. */
export function resetSdkSessionsForTesting(): void {
  for (const cardId of [...sessions.keys()]) stopCardDriver(cardId);
  sessions.clear();
  lastContextByCard.clear();
}

/** Whether a card has a LIVE driver right now. */
export function hasDriverSession(cardId: string): boolean {
  return liveDriverSession(cardId) !== null;
}

/** The card's LIVE driver, or null — never spawns one. */
export function liveDriverSession(cardId: string): DriverSession | null {
  const session = sessions.get(cardId);
  return session && !session.closed ? session : null;
}

/**
 * Is this card's chat ACTUALLY in use — a page connected to it, or a turn running?
 *
 * This is the veto the idle sweep asks for (see `onCardInUseProbe` in services/board/workspace.ts).
 * It is deliberately narrower than `hasDriverSession`: a driver nobody is connected to and that is
 * doing nothing may be hibernated like any cold card (its own idle stop would kill it anyway), but
 * a card with someone's chat OPEN is a card whose next keystroke can arrive at any instant — and
 * hibernating it kills this driver right under that keystroke, which is exactly what ate messages.
 */
export function isCardChatInUse(cardId: string): boolean {
  const session = sessions.get(cardId);
  if (!session || session.closed) return false;
  return session.sockets.size > 0 || isDriverBusy(session);
}

/**
 * The driver is WORKING: a turn in flight or queued, OR a live background task (a
 * deploy-wait `sleep 200`, a subagent). This second half is what was missing: the turn that
 * fires the task closes right away, and an "idle" driver with nobody in the tab was shut down — killing the
 * work Claude had just said it was waiting for.
 */
function isDriverBusy(session: Pick<DriverSession, "activeTurns" | "autonomousTurn" | "resumeWatch" | "backgroundTasks" | "backgroundSince">): boolean {
  // The resume the watcher is still waiting for counts (see `turnRunning`): hibernating or shutting down for
  // idleness in that window would kill precisely the resume.
  return turnRunning(session) || backgroundHoldLeft(session) > 0;
}

/**
 * A TURN IS RUNNING: someone's (counted) or the one the CLI ITSELF opened (a background task
 * finished, a scheduled wakeup fired, the post-deploy resume going on by itself). A single rule for
 * every place that asks this — the `ready` of whoever connects, the idle stop, the board status. Counting only
 * `activeTurns` made the reopened chat be born "stopped" with the AI working (production, 2026-10-20).
 */
function isTurnInFlight(session: Pick<DriverSession, "activeTurns" | "autonomousTurn">): boolean {
  return session.activeTurns > 0 || session.autonomousTurn;
}

/**
 * THE CARD'S STATUS follows the background (production, 2026-10-20: the board showed "aguardando" with
 * the suite running in the background). While there is a live task, the `Stop` hook's `waiting` counts as
 * `working` (services/board/status.ts); this is the other side — the edges no hook covers:
 *  - the set stopped being empty: `working`, because the `Stop` may have arrived BEFORE this event;
 *  - it emptied and, after BACKGROUND_SETTLE_MS, no turn opened: `waiting`, because no `Stop`
 *    will come to say Claude reached the prompt. Only when the card is still `working`.
 */
function syncBackgroundStatus(session: DriverSession, hadTasks: boolean): void {
  const hasTasks = session.backgroundTasks.length > 0;
  if (hasTasks === hadTasks) return;
  clearTimeout(session.backgroundSettleTimer);
  session.backgroundSettleTimer = undefined;
  if (hasTasks) {
    reportCardStatusFromDriver(session.cardId, "working");
    return;
  }
  session.backgroundSettleTimer = setTimeout(() => {
    session.backgroundSettleTimer = undefined;
    if (session.closed || session.backgroundTasks.length > 0) return;
    if (isTurnInFlight(session)) return;
    void registry.getCard(session.cardId).then((card) => {
      if (card?.status === "working") reportCardStatusFromDriver(session.cardId, "waiting");
    }).catch(() => { /* best-effort, like a hook */ });
  }, BACKGROUND_SETTLE_MS);
  session.backgroundSettleTimer.unref?.();
}

/** A live task, within the cap, holds the card at `working` (see services/board/status.ts). */
function driverHoldsBackgroundWork(cardId: string): boolean {
  const session = sessions.get(cardId);
  if (!session || session.closed) return false;
  return backgroundHoldLeft(session) > 0;
}

/** How much is left of the cap during which background tasks hold the driver (0 = they do not). */
function backgroundHoldLeft(session: Pick<DriverSession, "backgroundTasks" | "backgroundSince">): number {
  if (session.backgroundTasks.length === 0 || session.backgroundSince === undefined) return 0;
  return Math.max(0, session.backgroundSince + BACKGROUND_HOLD_MAX_MS - Date.now());
}

/**
 * What this card's driver is doing right now, for the board's session view (see
 * `onCardDriverProbe` in services/board/agentState.ts): `turn` while a turn is in flight, `idle`
 * for a live driver at the prompt, `none` when there is no driver. Read-only and in-memory.
 */
export function driverActivity(cardId: string): DriverActivity {
  const session = sessions.get(cardId);
  if (!session || session.closed) return "none";
  return isDriverBusy(session) ? "turn" : "idle";
}

/**
 * A turn running in this driver — the same "Trabalhando…" the chat shows. The resume the watcher
 * is still waiting for counts: the boot's empty `result` is not its end, and a dot that blinked
 * "aguardando" there would release the turn-ended notice in the middle of the resume.
 */
function turnRunning(session: Pick<DriverSession, "activeTurns" | "autonomousTurn" | "resumeWatch" | "apiRetry">): boolean {
  // The new attempt scheduled after a transient API failure too: the turn has not ended, it is the
  // network that went down in the middle of it (see API_RETRY_DELAYS_MS).
  return isTurnInFlight(session) || session.resumeWatch !== undefined || session.apiRetry?.timer !== undefined;
}

/**
 * Does this card's native chat driver have a turn running now? A `waiting` that arrives with the turn
 * in flight is a late hook — the SessionStart of a resumed session landing after the turn has
 * already started, or the `Stop` racing ahead of the `result` — and must not clear the dot (see
 * services/board/status.ts).
 */
export function driverTurnRunning(cardId: string): boolean {
  const session = sessions.get(cardId);
  return !!session && !session.closed && turnRunning(session);
}

/**
 * THE CARD'S DOT follows the driver, in process. It lived only on the CLI's hooks — a curl from inside
 * the container, with a 3s deadline — and a lost hook (back deploy, network, driver dead without `Stop`)
 * left the card grey with the chat working, or green with the chat stopped (production, 2026-10-20). The
 * manager knows exactly when a turn opens and closes, so it reports it itself, only when it changes —
 * through the same path as the hooks, which runs a pending pause/restart and the queue on `waiting`.
 */
function syncBoardStatus(session: DriverSession, opts: { force?: boolean } = {}): void {
  if (session.closed && !opts.force) return;
  const status: registry.CardStatus = turnRunning(session) && !session.closed ? "working" : "waiting";
  if (session.boardStatus === status) return;
  session.boardStatus = status;
  void registry.getCard(session.cardId).then((card) => {
    if (card && card.status !== status) reportCardStatusFromDriver(session.cardId, status);
  }).catch(() => { /* best-effort, like a hook */ });
}

/**
 * THE CARD IS WAITING FOR A DECISION: while a question or permission request from this driver is
 * open, the card carries `awaitingDecisionAt` and the icon turns into the amber "precisa de você" — the turn
 * stays open (the dot remains `working` on purpose: `waiting` delivers the queue and runs a
 * pending pause/restart, which would run over the open card), and the spinner made the person think
 * Claude was working. Writes only when it changes; `force` applies to an already closed driver (its exit
 * has to clear the stamp).
 */
function syncAwaitingDecision(session: DriverSession, opts: { force?: boolean } = {}): void {
  if (session.closed && !opts.force) return;
  const awaiting = (session.openAsks.size > 0 || session.orphanAsks.size > 0) && !session.closed;
  if (session.awaitingDecision === awaiting) return;
  session.awaitingDecision = awaiting;
  void registry.setCardAwaitingDecision(session.cardId, awaiting ? Date.now() : null)
    .catch(() => { /* best-effort, como a bolinha */ });
}

/** The driver ended: none of its decisions stays pending — the card's stamp goes with it. */
function dropOpenAsks(session: DriverSession): void {
  session.openAsks.clear();
  syncAwaitingDecision(session, { force: true });
}

/* ---------------------------------------------------------------- helpers */

/** ws sockets expose the raw TCP socket as `_socket`; flushing small frames beats batching them. */
function disableNagle(socket: WebSocket): void {
  const raw = (socket as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })._socket;
  try { raw?.setNoDelay?.(true); } catch { /* the socket is already closing */ }
}

/** Question cards with a stored draft, at most — the oldest goes first. */
const QUESTION_DRAFTS_MAX = 20;
/** This driver's cards remembered for the late answer, at most — the oldest goes first. */
const QUESTION_CARDS_MAX = 50;

/**
 * A question card of this driver. `state`: "open" = nobody answered; "answered" = an answer
 * went to the driver (`by` = who, null with no name); "closed" = closed WITHOUT an answer (deadline, message,
 * stop) — then there is nothing to compare with, and the late answer follows the usual path.
 */
interface QuestionCard {
  questions: UserQuestionItem[];
  state: "open" | "answered" | "closed";
  by?: string | null;
}

/** Makes room for one more key: the oldest goes when the map is at the cap. */
function makeRoom(map: Map<string, unknown>, max: number): void {
  dropOldest(map, max - 1);
}

/** The question closed: nobody's draft matters any more (the screen already draws the answered card). */
function forgetQuestionDrafts(session: DriverSession, questionId: string): void {
  if (!session.questionDrafts.delete(questionId)) return;
  session.draftLive.delete(questionId);
  persistQuestionDrafts(session);
}

function persistQuestionDrafts(session: DriverSession): void {
  void saveQuestionDrafts(session.cardId, session.questionDrafts);
}

/** Some tab of `name` is touching this card right now. */
function draftIsLive(session: DriverSession, id: string, name: string): boolean {
  return (session.draftLive.get(id)?.get(name) ?? 0) > 0;
}

/**
 * The frame that tells the other tabs `name`'s draft on a card (empty draft = erased).
 * `away`: the person closed the tab — what they ticked still counts, they are just not answering right now.
 */
function peerQuestionDraftFrame(id: string, name: string, draft: StoredQuestionDraft, away = false): object {
  return {
    type: "peer_question_draft", id, name, picked: draft.picked, other: draft.other,
    ...(draft.at !== undefined ? { at: draft.at } : {}),
    ...(away ? { away: true } : {}),
  };
}

/**
 * What was on disk goes into the new session — without running over what already arrived in it — and goes to the
 * already connected tabs (they arrived before the read finished).
 */
async function restoreQuestionDrafts(session: DriverSession): Promise<void> {
  const stored = await loadQuestionDrafts(session.cardId);
  for (const [id, byName] of stored) {
    let mine = session.questionDrafts.get(id);
    for (const [name, draft] of byName) {
      if (mine?.has(name)) continue;
      if (!mine) {
        makeRoom(session.questionDrafts, QUESTION_DRAFTS_MAX);
        mine = new Map();
        session.questionDrafts.set(id, mine);
      }
      mine.set(name, draft);
      broadcast(session, peerQuestionDraftFrame(id, name, draft, !draftIsLive(session, id, name)));
    }
  }
}

/** One frame to one socket. A socket going away is not an error: its close handler detaches it. */
function sendFrame(socket: Pick<WebSocket, "send">, event: object): void {
  try { socket.send(JSON.stringify(event)); } catch { /* going away */ }
}

/** One frame to every socket of the card — but `except`, the one that already drew it. */
function broadcast(session: DriverSession, event: object, except?: WebSocket): void {
  const frame = JSON.stringify(event);
  for (const socket of session.sockets) {
    if (socket === except) continue;
    try { socket.send(frame); } catch { /* that socket is going away; its close handler detaches it */ }
  }
}

/**
 * The PANEL's own line in the conversation — broadcast to every open tab AND written to the
 * history, so a reload still reads it. Used for the interrupt notes: without them a turn cut
 * mid-sentence looked like Claude simply trailing off.
 */
function emitSystemNote(session: DriverSession, text: string): void {
  const at = Date.now();
  broadcast(session, { type: "system_note", text, at });
  void appendHistory(session.cardId, { type: "system_note", text, at });
}

/** Every clock of the session, in a single exit (close, stop, shutdown): none survives the driver. */
function clearSessionTimers(session: DriverSession): void {
  clearIdleTimer(session);
  clearTimeout(session.backgroundSettleTimer);
  clearTimeout(session.resumeWatch?.timer);
  clearTimeout(session.apiRetry?.timer);
}

function clearIdleTimer(session: DriverSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

/**
 * Arm the idle stop when NOTHING holds the driver: no page connected and no turn in flight. The
 * check runs again when the timer fires — a turn or a socket that showed up in between wins.
 */
function maybeScheduleIdleStop(session: DriverSession): void {
  if (session.closed || session.sockets.size > 0 || isTurnInFlight(session)) return;
  if (session.idleTimer) return;
  // A live background task postpones the clock until the end of its cap (see
  // BACKGROUND_HOLD_MAX_MS) — and only then do the 15 min of idleness start.
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (session.closed || session.sockets.size > 0 || isDriverBusy(session)) return;
    if (session.backgroundTasks.length > 0) {
      logger.info(
        { card: session.label, audit: true, action: "sdk.driver.idle.background-cap", tasks: session.backgroundTasks.map((t) => t.description) },
        "sdk driver held by background tasks past the cap with nobody connected — shutting it down",
      );
    } else {
      logger.info({ card: session.label, audit: true, action: "sdk.driver.idle" }, "sdk driver idle — shutting it down (resume id persisted)");
    }
    stopCardDriver(session.cardId);
  }, backgroundHoldLeft(session) + DRIVER_IDLE_MS);
  session.idleTimer.unref?.();
}

/** One driver event, seen by the SURVIVING side: persist, remember, fan out. */
function applyDriverEvent(session: DriverSession, event: DriverEvent): void {
  // The harness's canned close-out for a turn that died mid-flight ("No response requested.") can
  // also arrive LIVE, as the resumed session's first assistant message. It is filler, not an
  // answer — shown, it reads as Claude dismissing the person's message (the production symptom).
  if (event.type === "assistant_text" && typeof (event as { text?: unknown }).text === "string"
    && isHarnessFiller("assistant", (event as { text: string }).text)) return;
  if (event.type === "assistant_text" || event.type === "tool_use" || event.type === "thinking") {
    noteAgentWork(session, event);
  }
  // Only the MAIN agent proves the resume took — a subagent talking is not the agent continuing.
  if (session.resumeWatch && !(event as { parentToolUseId?: unknown }).parentToolUseId) {
    if (AGENT_SIGNALS.has(event.type)) session.agentSignals += 1;
    if (event.type === "assistant_text" || event.type === "tool_use") {
      putMarker(session, { ...(session.marker ?? session.resumeWatch.marker), progressed: true });
      endResumeWatch(session);
    }
  }
  if (event.type === "ready") {
    session.ready = true;
    // Stamp the manager's live turn count on the frame: a message may already be queued on the
    // fresh driver's stdin (sent before it booted) — the front's spinner must know it.
    event = { ...event, turnActive: isTurnInFlight(session) };
  }
  if ((event.type === "session" || event.type === "result") && event.sessionId && event.sessionId !== session.lastSessionId) {
    session.lastSessionId = event.sessionId;
    // Persist the resume key on the card (board.json) so the NEXT driver spawn — after an idle
    // stop, a pause, a backend restart — continues this very conversation (`--resume`).
    void registry.updateCard(session.cardId, { resumeSessionId: event.sessionId }).catch((err: unknown) => {
      logger.warn({ card: session.label, detail: (err as Error).message }, "could not persist the sdk session id");
    });
  }
  if (event.type === "effort_default") {
    // Pill state, not conversation: it stays in the session and goes on neither to the history nor to the browser.
    const level = (event as { effort?: unknown }).effort;
    if (typeof level === "string" && registry.isValidEffort(level)) session.defaultEffort = level;
    return;
  }
  if (event.type === "effort_ack") {
    settleEffortSwitch(session, event);
    return;
  }
  if (event.type === "catalog") {
    // Normalised HERE, on the side that talks to the browser: the driver forwards what the CLI
    // said, and this is where names are validated, descriptions flattened and the list capped.
    const raw = event as unknown as { commands?: unknown; skills?: unknown; plugins?: unknown; hidden?: unknown };
    event = {
      type: "catalog",
      commands: withBtwCommand(normalizeSlashCommands(raw.commands, { skills: raw.skills, plugins: raw.plugins, hidden: raw.hidden })),
    };
    session.catalog = event;
    // ON DISK too: the driver announces the catalog once, on boot, and the "/" menu needs to exist
    // at the INSTANT of the connect — not after the next driver's boot (see ./catalog.ts).
    void writeCardCatalog(session.cardId, event);
  }
  // THE FLEET BECAME VISIBLE. The `Workflow` tool returns right away and works in the background: the turn
  // ends, the model says "te trago quando voltar" and the chat went silent for minutes — read on the other
  // side as "it finished" (production, 2026-10-02). The journal probe starts here, at the instant
  // of the call, and closes on its own (see services/sdk/workflow.ts): it is what feeds the panel.
  if (event.type === "tool_use" && event.name === "Workflow") startWorkflowWatch(session);
  if (event.type === "tool_result") {
    // The RAW result (capped text + structured) becomes the line's SUMMARY; the raw one does not leave here.
    event = toolResultEvent(event as RawToolResultEvent) as unknown as DriverEvent;
  }
  if (event.type === "task_started" || event.type === "task_progress" || event.type === "task_notification") {
    const raw = event as RawTaskEvent;
    const key = raw.toolUseId || [...session.tasks.values()].find((t) => t.taskId === raw.taskId)?.toolUseId;
    const merged = key ? mergeTaskEvent(session.tasks.get(key), { ...raw, toolUseId: key }, Date.now()) : null;
    if (!merged) return;
    session.tasks.set(merged.toolUseId, merged);
    // Cap: a long session fires hundreds of tasks; the oldest finished ones go first.
    if (session.tasks.size > TASKS_MAX) {
      for (const [id, task] of session.tasks) {
        if (session.tasks.size <= TASKS_MAX) break;
        if (task.status !== "running") session.tasks.delete(id);
      }
    }
    event = taskSnapshot(merged, Date.now()) as unknown as DriverEvent;
  }
  if (event.type === "background_tasks") {
    // Normalised HERE, on the side that talks to the browser (like the catalog): what goes out is only what the
    // screen draws, and a crooked item from the driver does not knock down anybody's tab.
    const raw = (event as { tasks?: unknown }).tasks;
    const tasks: BackgroundTaskInfo[] = Array.isArray(raw)
      ? raw
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && typeof (t as { id?: unknown }).id === "string")
        .map((t) => {
          const id = t.id as string;
          const toolUseId = typeof t.toolUseId === "string" && t.toolUseId
            ? t.toolUseId
            : [...session.tasks.values()].find((task) => task.taskId === id)?.toolUseId;
          return {
            id,
            type: typeof t.type === "string" ? t.type : "",
            description: typeof t.description === "string" ? t.description : "",
            ...(toolUseId ? { toolUseId } : {}),
          };
        })
      : [];
    event = { type: "background_tasks", tasks };
    // A task that LEFT the list finished: its notice reaches the model only on a later turn.
    const still = new Set(tasks.map((t) => t.id));
    for (const gone of session.backgroundTasks) {
      if (!still.has(gone.id)) session.pendingNotices.push(gone.description || gone.type || "tarefa em segundo plano");
    }
    const hadTasks = session.backgroundTasks.length > 0;
    if (tasks.length === 0) session.backgroundSince = undefined;
    else if (!hadTasks) session.backgroundSince = Date.now();
    session.backgroundTasks = tasks;
    syncBackgroundStatus(session, hadTasks);
    syncInflightMarker(session);
    // The idle clock is redone on every change: with a live task it waits for that task's cap; when the
    // last one ends with no turn in flight and nobody watching, NOW the 15 min start — the same
    // point at which a `result` arms it.
    clearIdleTimer(session);
    maybeScheduleIdleStop(session);
  }
  if (event.type === "error" && session.autonomousTurn && session.activeTurns === 0) {
    // The stream dropped in the middle of a turn nobody sent: the driver closes that turn with an
    // aborted `result`, but an error without it (an old driver, a stream that died silently) must not
    // leave the card "trabalhando" forever — with no idle stop and with the deploy marker stuck.
    session.autonomousTurn = false;
    syncInflightMarker(session);
    maybeScheduleIdleStop(session);
  }
  if (event.type === "rate_limit") {
    const info = normalizeRateLimit(event);
    if (!info) return;
    session.rateLimits.set(info.window, info);
    event = { type: "rate_limit", ...info };
  }
  if (event.type === "context_usage") {
    const info = normalizeContextUsage(event);
    if (!info) return;
    session.contextUsage = info;
    if (session.lastSessionId) lastContextByCard.set(session.cardId, { sessionId: session.lastSessionId, info });
    event = { type: "context_usage", ...info };
  }
  if (event.type === "compaction") {
    if (event.phase === "started") {
      session.compacting = { startedAt: Date.now(), ...(event.trigger ? { trigger: event.trigger } : {}) };
      event = { ...event, ...session.compacting };
    } else {
      session.compacting = undefined;
    }
  }
  if (event.type === "turn_absorbed") {
    // Streaming input: this send folded into the turn ALREADY running (the model absorbs it at its
    // next step) — it will not produce its own `result`, so its +1 comes back off. Floor at 1: an
    // absorbed send implies a turn IS in flight, and its own result is still owed.
    session.activeTurns = Math.max(1, session.activeTurns - 1);
  }
  // A stop the person asked for: the note goes out right AFTER this result (below), so the reader
  // sees the truncated answer and then the line explaining why it stops there.
  let interruptNoteToFlush: string | undefined;
  if (event.type === "result") {
    session.activeTurns = Math.max(0, session.activeTurns - 1);
    // The driver already closes the compaction before the result; this is the safety net for an old driver.
    session.compacting = undefined;
    interruptNoteToFlush = session.pendingInterruptNote;
    session.pendingInterruptNote = undefined;
    session.autonomousTurn = false;
    // The turn closed: nothing else waits for an answer inside it (the driver closes the cards the
    // turn left). A turn still in flight (a queued send) keeps its own.
    if (!isTurnInFlight(session)) {
      session.openAsks.clear();
      session.stopCause = undefined;
      syncAwaitingDecision(session);
      // The conversation stopped: if the agent's last speech is a question for the person, the card says so
      // (the decisions tray's "precisa de você", on the board icon).
      void syncPendingQuestion(session.cardId);
    }
    // A resume that closed without the agent producing anything has not taken yet: the watcher decides (see
    // RESUME_CONFIRM_MS) — and the marker stays, so the next deploy knows about it.
    if (session.resumeWatch && !isTurnInFlight(session)) armResumeWatch(session);
    // Before the marker and the dot: the new scheduled attempt keeps both as a turn in flight.
    noteApiOutcome(session, event);
    // The last turn in flight CLOSED: the durable marker comes off — unless work goes on in the
    // background (a task, a scheduled wake-up), which a deploy would kill just the same: then it
    // stays, now saying what is running (see `syncInflightMarker`).
    syncInflightMarker(session);
    maybeScheduleIdleStop(session);
  }
  let silenced = false;
  if (event.type === "rewound") {
    // One answer, one edit: the oldest unanswered one. `ok: false` consumes its entry too (the
    // driver fell back to a supersede — there is nothing to cut, but that edit IS answered).
    const edit = session.rewinds.shift();
    if (event.ok && edit) {
      // A REWIND means the CLEAN text went to the model — not the supersede wrapper this edit was
      // registered with. The transcript will carry those words, and the mirror only drops a line
      // it recognises as the driver's own: without this key it republished the corrected message
      // as if the terminal had just said it, drawing a SECOND bubble under the corrected one.
      if (edit.text !== "") noteDriverEventFor(session.cardId, { type: "user", text: edit.text });
      // The cut note ("…a resposta acima ficou pela metade") loses its subject: the rewind
      // ERASED that half answer. Almost always it has already gone out before this point — the driver's `endStream`
      // WAITS for the dying stream's `result` before announcing the rewind, so the result (and the
      // note with it) comes first, and the one that removes it is the log cut (`dropOrphanInterruptNotes`).
      // This covers the other window: the stream that does not let go within `endStream`'s deadline, and the
      // `rewound` arrives first — it avoids writing a line that would already be born orphaned. Inside the owner's
      // `if`, like the cut: a frame that belongs to no edit does not erase the note of a
      // stop that was someone else's.
      session.pendingInterruptNote = undefined;
      // Which row is the edit's new message, for the screen's cut (see `RewoundEvent.text`).
      event = edit.first ? { ...event, text: edit.text, first: true } : { ...event, text: edit.text };
      // A cut the disk refused is audited as such: the screen and the model are already rewound,
      // and the log still holding the edited-away turn brings it back on the next F5.
      void rewindHistory(session.cardId, edit.original, edit.text, { first: edit.first }).then(
        (dropped) => {
          logger.info(
            { audit: true, action: "sdk.rewind", card: session.label, dropped },
            "the conversation was rewound to before an edited message",
          );
        },
        (err: unknown) => {
          logger.warn(
            { audit: true, action: "sdk.rewind.failed", card: session.label, detail: (err as Error).message },
            "the conversation was rewound, but its chat history could not be cut",
          );
        },
      );
    } else if (!event.ok && event.reason === "not-delivered" && edit) {
      // The original never reached the model, so the driver sent the CLEAN words as a plain turn
      // (no rewind, nothing to cut — the rest of the log still happened). Same two repairs as a
      // rewind: the transcript will carry the clean text, so the mirror must know it as the
      // driver's own, and the log line loses the wrapper the replay would look for.
      if (edit.text !== "") {
        noteDriverEventFor(session.cardId, { type: "user", text: edit.text });
        void unwrapEditedMessage(session.cardId, edit.original, edit.text).catch((err: unknown) => {
          logger.warn(
            { card: session.label, detail: (err as Error).message },
            "could not unwrap the edited message in the sdk chat history",
          );
        });
      }
    } else if (event.ok) {
      // An `ok: true` WITH NO OWNER (a driver repeating itself, a late frame) does not reach the screen: there it is not
      // harmless as it is here. `dropRewoundRows` cuts from the last "edited" line to the last
      // message — and a REFUSED edit leaves that mark forever —, so a lost frame would
      // erase whole turns the model still has. The log already protects itself (no owner,
      // no cut); the screen has no way to.
      silenced = true;
      logger.warn(
        { audit: true, action: "sdk.rewind.orphan", card: session.label },
        "a rewind confirmation arrived for no edit in flight — not forwarded to the screen",
      );
    }
  }
  if (event.type === "user_question") {
    session.ownQuestions.add(event.id);
    makeRoom(session.questionCards, QUESTION_CARDS_MAX);
    session.questionCards.set(event.id, { questions: event.questions, state: "open" });
    // A NEW question is where the conversation is: the orphan from before the restart is no longer what the agent
    // is waiting for (usually it is the same one, asked again by the resume). Once the new one was answered by a click, the old one
    // kept nagging in the tray — only a message swept it.
    void settleOrphanQuestions(session);
  }
  if (event.type === "question_result") {
    forgetQuestionDrafts(session, event.id);
    const card = session.questionCards.get(event.id);
    if (card) {
      // THE VERDICT IS THE DRIVER'S: with no answers, the card closed with nothing to compare — even if an
      // answer was written to stdin (the deadline or a message arrived before it).
      if (!event.answers?.length) card.state = "closed";
      else if (card.state === "open") { card.state = "answered"; card.by = null; }
    }
    const unanswered = !event.answers?.length && !event.timedOut && !event.superseded;
    if (unanswered && session.stopCause) {
      event.cancelledHow = session.stopCause.how;
      if (session.stopCause.by) event.cancelledBy = session.stopCause.by;
    }
  }
  if (event.type === "user_question" || event.type === "permission_request") {
    session.openAsks.add(event.id);
    syncAwaitingDecision(session);
  }
  if ((event.type === "question_result" || event.type === "permission") && event.id) {
    session.openAsks.delete(event.id);
    syncAwaitingDecision(session);
  }
  if (!silenced) broadcast(session, event);
  if (event.type === "conversation_reset" && (event.trigger === undefined || event.trigger === "clear")) {
    // The /clear cleared the model's CONTEXT; the card's log has to go with it, otherwise the F5 brought back the
    // whole conversation and the /clear seemed to have done nothing. Only what came BEFORE the "/clear" goes
    // (see `clearHistoryBeforeLastClear`): what was sent after it the CLI will still run. The
    // erased conversation's workflow panel does not come back on an F5 either. The trigger filter only separates
    // anything if the CLI one day says the cause of the reset: today the driver sends "clear" for all of them (see
    // `conversation_reset` in sdk-driver.mjs), leaving plan mode included.
    void clearHistoryBeforeLastClear(session.cardId).catch((err: unknown) => {
      logger.warn({ card: session.label, detail: (err as Error).message }, "could not clear the sdk chat history");
    });
    forgetCardWorkflows(session.cardId);
    // The erased conversation takes up nothing any more: its meter goes with it (the new session's reading
    // arrives at the end of the /clear's turn).
    session.contextUsage = undefined;
    lastContextByCard.delete(session.cardId);
    emitSystemNote(session, NOTE_CONVERSATION_CLEARED);
  }
  if (interruptNoteToFlush) emitSystemNote(session, interruptNoteToFlush);
  // History + mirror dedupe are MANAGER duties, not socket duties: they must keep happening while
  // no page is open — that is the whole point of the detach.
  noteDriverEventFor(session.cardId, event);
  if (replayableHistoryEvent(event)) void appendHistory(session.cardId, { ...event, at: Date.now() });
  // What a person away from the board hears (services/events/cardEvents.ts): questions,
  // permissions and their outcome. A failure the panel is already retrying is not news yet — only
  // the one it gave up on is.
  if (!(event.type === "result" && session.apiRetry?.timer)) void observeDriverEvent(session.cardId, event);
}

/**
 * Where this card's CURRENT session keeps the workflow rounds and their scripts. Both paths
 * belong to the harness (`<transcriptDir>/<sessionId>/…`) and depend on the session id, which only exists after
 * the first `session`/`result` — before that there is nothing to probe. PURE (given the session state).
 */
function workflowDirs(session: Pick<DriverSession, "transcriptDir" | "lastSessionId">): { runs: string; scripts: string } | null {
  const dir = session.transcriptDir;
  const sessionId = session.lastSessionId;
  if (!dir || !sessionId) return null;
  const base = `${dir.replace(/\/+$/, "")}/${sessionId}`;
  return { runs: `${base}/subagents/workflows`, scripts: `${base}/workflows/scripts` };
}

/** Turns on this card's fleet probe (idempotent — see `watchCardWorkflows`). */
function startWorkflowWatch(session: DriverSession): void {
  watchCardWorkflows(session.cardId, {
    label: session.label,
    dirs: () => workflowDirs(session),
    watchers: () => session.sockets.size,
    publish: (run) => broadcast(session, { type: "workflow_progress", ...run }),
  });
}

/** A subagent's feed for whoever asked, with the reason when it comes back empty because of an error. */
async function feedReply(session: DriverSession, request: WorkflowFeedRequest): Promise<WorkflowFeedEvent> {
  const reply = (items: WorkflowFeedEvent["items"], error?: WorkflowFeedEvent["error"]): WorkflowFeedEvent => ({
    type: "workflow_feed", runId: request.runId, agentId: request.agentId, items, ...(error ? { error } : {}),
  });
  const dirs = workflowDirs(session);
  if (!dirs) return reply([], "no-session");
  try {
    return reply(await readAgentFeed(dirs.runs, request.runId, request.agentId));
  } catch (err) {
    if (err instanceof InvalidWorkflowIdError) return reply([], "invalid-id");
    logger.debug({ card: session.label, detail: (err as Error).message }, "workflow feed probe failed");
    return reply([], "probe-failed");
  }
}

/**
 * The one that answers ONE socket's feed requests. One `docker exec` at a time per tab: a request that
 * arrives with another in flight waits, and only the MOST RECENT waits (the person switched agents — the ones in between
 * no longer matter). Without this, quick clicks or a stubborn socket would pile up probes on the runner.
 */
function createFeedResponder(session: DriverSession, socket: WebSocket): (request: WorkflowFeedRequest) => void {
  let busy = false;
  let next: WorkflowFeedRequest | null = null;
  const run = async (request: WorkflowFeedRequest): Promise<void> => {
    busy = true;
    try {
      const frame = await feedReply(session, request);
      sendFrame(socket, frame);
    } finally {
      busy = false;
      const queued = next;
      next = null;
      if (queued && socket.readyState === WebSocket.OPEN) void run(queued);
    }
  };
  return (request) => {
    if (busy) next = request;
    else void run(request);
  };
}

/** The answer to a detail request (see `parseDetailFrame`), already with the reason when it failed. */
async function detailReply(session: Pick<DriverSession, "cardId" | "label" | "transcriptDir">, request: DetailRequest): Promise<object> {
  const base = { type: "detail", req: request.req, ...(request.id ? { id: request.id } : {}), ...(request.path ? { path: request.path } : {}), ...(request.nonce ? { nonce: request.nonce } : {}) };
  try {
    if (request.req === "changes") return { ...base, data: await readCardChanges(session.cardId) };
    if (request.req === "file") return { ...base, data: await readCardFileDiff(session.cardId, request.path) };
    const dir = session.transcriptDir;
    if (!dir) return { ...base, error: "no-session" };
    const data = request.req === "tool" ? await readToolDetail(dir, request.id) : await readAgentTimeline(dir, request.id);
    return { ...base, data };
  } catch (err) {
    if (err instanceof InvalidDetailIdError) return { ...base, error: "invalid-id" };
    logger.debug({ card: session.label, req: request.req, detail: (err as Error).message }, "detail probe failed");
    return { ...base, error: "probe-failed" };
  }
}

/**
 * The one that answers ONE socket's detail requests: one `docker exec` at a time per tab, and of the queue only
 * the MOST RECENT of each request stays (the same action asked again, the same subagent being
 * refreshed) — quick clicks or the refresh of a timeline do not pile up probes.
 */
export function createDetailResponder(
  session: Pick<DriverSession, "cardId" | "label" | "transcriptDir">,
  socket: Pick<WebSocket, "send" | "readyState">,
  answer: (request: DetailRequest) => Promise<object> = (request) => detailReply(session, request),
): (request: DetailRequest) => void {
  let busy = false;
  const queue = new Map<string, DetailRequest>();
  const run = async (request: DetailRequest): Promise<void> => {
    busy = true;
    try {
      const frame = await answer(request);
      sendFrame(socket, frame);
    } finally {
      busy = false;
      const next = queue.values().next();
      if (!next.done) {
        queue.delete(`${next.value.req}:${next.value.id}:${next.value.path}`);
        if (socket.readyState === WebSocket.OPEN) void run(next.value);
      }
    }
  };
  return (request) => {
    if (busy) {
      const key = `${request.req}:${request.id}:${request.path}`;
      queue.delete(key);
      queue.set(key, request);
      // Cap: whoever asks too much loses the oldest ones.
      dropOldest(queue, 8);
    } else void run(request);
  };
}

/**
 * Each card's last context reading, BY THE SESSION it belongs to — it survives the end of the
 * driver (idle stop, pause). A reopened card that resumes the same session (`--resume`) already shows the
 * meter, without waiting for the next message; a different session does not inherit another's number.
 */
const lastContextByCard = new Map<string, { sessionId: string; info: ContextUsageInfo }>();

/** The id the driver is going to resume, read from the spawn's argv (`--resume <id>`). */
function resumeIdOf(args: readonly string[]): string | undefined {
  const i = args.indexOf("--resume");
  return i >= 0 ? args[i + 1] : undefined;
}

/* ------------------------------------------------------------------- API */

export interface EnsureDriverOpts {
  cardId: string;
  /** Log label (the card's worktree slug). */
  label: string;
  /** The spawn command (built by the route via `sdkDriverCommand` + `resumeTargetFor`). */
  command: { file: string; args: string[] };
  /** The card's transcript dir in the runner — where a workflow's journal lives (optional). */
  transcriptDir?: string;
}

/**
 * The card's ONE driver: returns the live session, or spawns it. Spawning is synchronous, so two
 * simultaneous connects cannot race a second driver into existence.
 */
export function ensureDriverSession(opts: EnsureDriverOpts): DriverSession {
  const existing = sessions.get(opts.cardId);
  if (existing && !existing.closed) return existing;

  const child = spawner(opts.command.file, opts.command.args);
  const session: DriverSession = {
    cardId: opts.cardId,
    label: opts.label,
    child,
    sockets: new Set(),
    ready: false,
    activeTurns: 0,
    autonomousTurn: false,
    agentSignals: 0,
    backgroundTasks: [],
    pendingNotices: [],
    tasks: new Map(),
    rateLimits: new Map(),
    rewinds: [],
    idleTimer: null,
    stderrTail: "",
    closed: false,
    acceptedCids: new Map(),
    ownQuestions: new Set(),
    openAsks: new Set(),
    pendingEffortSwitches: new Map(),
    awaitingDecision: false,
    questionDrafts: new Map(),
    orphanAsks: new Set(),
    draftLive: new Map(),
    draftsLoaded: Promise.resolve(),
    questionCards: new Map(),
    settledOrphans: new Set(),
    answeringOrphans: new Set(),
    orphansSwept: false,
    ...(opts.transcriptDir ? { transcriptDir: opts.transcriptDir } : {}),
  };
  sessions.set(opts.cardId, session);
  const remembered = lastContextByCard.get(opts.cardId);
  if (remembered && remembered.sessionId === resumeIdOf(opts.command.args)) session.contextUsage = remembered.info;
  // What each person had already ticked on the open cards, from before the restart (or from the previous driver).
  session.draftsLoaded = restoreQuestionDrafts(session).catch((err: unknown) => {
    logger.warn({ card: opts.label, detail: (err as Error).message }, "could not restore the question drafts");
  });
  // A "waiting for a decision" stamp left over from a driver that could not clear it (the back went down in the
  // middle of a question): this driver is born with none pending.
  void registry.setCardAwaitingDecision(opts.cardId, null).catch(() => { /* best-effort */ });
  // …except the orphan card still open (the deploy caught the agent waiting): it keeps asking for the person.
  void orphanQuestions(session).then((open) => {
    for (const id of open.keys()) {
      if (!session.settledOrphans.has(id)) session.orphanAsks.add(id);
    }
    syncAwaitingDecision(session);
  }).catch(() => { /* no read, no stamp: the previous path */ });
  // Conversation that came in through the Terminal tab: the driver's open stream is at a point that is no longer the
  // end of the file. Continuing from it orphans the terminal's turn, and an orphaned turn has no point to go back to — that was
  // why editing that message did not rewind. The driver only MARKS; it reconnects on the next send.
  session.offOutside = onOutsideTurn(opts.cardId, () => { writeToDriver(session, { type: "reanchor" }); });
  logger.info({ card: opts.label }, "sdk driver spawned (card-owned, survives the page)");

  // Whole lines only, multibyte characters intact, linear in the line's size (see createLineReader).
  const readLines = createLineReader();
  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of readLines(chunk)) {
      const event = parseDriverLine(line);
      if (event) applyDriverEvent(session, event);
    }
  });
  // EPIPE on the way IN: the child (or the docker exec carrying it) is gone. Without this the
  // error surfaced as an unhandled 'error' event at best and as silence at worst — and the next
  // message was written into the same dead pipe.
  child.stdin.on("error", (err: Error) => {
    logger.warn({ card: opts.label, detail: err.message }, "sdk driver stdin died");
    broadcast(session, { type: "error", message: `driver input closed: ${err.message}` });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    // KEEP the tail, don't just debug-log it: in the original incident the driver died with its
    // stderr invisible (debug level) and its exit frame sent to an already-closed socket — a fully
    // SILENT death. The tail is the post-mortem the exit handler below reports.
    const text = chunk.toString();
    session.stderrTail = (session.stderrTail + text).slice(-STDERR_TAIL_MAX);
    // The driver speaks through `[sdk-driver] …` when it SWALLOWS something on purpose (a stream
    // error that was our own teardown, an internal CLI diagnostic). Swallowing at `debug` level is
    // invisible in production — exactly the blind spot of the silent-death incident —, so
    // those lines go up to `warn`. The rest of the stderr remains boot noise.
    const deliberate = text.includes("[sdk-driver] ");
    const log = deliberate ? logger.warn.bind(logger) : logger.debug.bind(logger);
    log({ card: opts.label, stderr: text.slice(0, 500) }, "sdk driver stderr");
  });
  child.on("error", (err) => {
    logger.warn({ card: opts.label, detail: err.message }, "sdk driver process error");
    broadcast(session, { type: "error", message: `driver process error: ${err.message}` });
  });
  child.on("close", (code) => {
    // The driver died (idle stop, killCardSession, a crash): tell whoever is watching and close
    // their sockets — the front's reconnect loop spawns the successor on its next connect.
    const deliberate = session.closed; // stopCardDriver stamped it BEFORE killing
    clearSessionTimers(session);
    session.closed = true;
    if (sessions.get(opts.cardId) === session) sessions.delete(opts.cardId);
    // The PER-CARD state only belongs to this driver while no successor has taken over the card. A `close` may
    // arrive seconds after `stopCardDriver` (the docker exec takes a while to die), when the model
    // switch or the reconnect has already brought up the next driver — and clearing now would be clearing ITS state.
    const succeeded = sessions.has(opts.cardId);
    // The dedupe memory belongs to the DRIVER: it ended, so the memory ends with it — the successor speaks from scratch.
    if (!succeeded) forgetDriverKeys(opts.cardId);
    // A driver that dies with a turn open sends no `Stop`: without this the dot stayed green on a
    // stopped chat. Only without a successor — the next one already speaks for the card.
    // Except on a DROP someone is going to resume (see below): there `waiting` would be read as "turno
    // terminou" by the events hub, and 10 s later the card went back to working. The resumer sets
    // the dot right if it does not resume (resume.ts).
    const crashWithWork = !deliberate && !succeeded && session.marker !== undefined && crashListeners.size > 0;
    if (!succeeded && session.boardStatus === "working" && !crashWithWork) syncBoardStatus(session, { force: true });
    dropPendingEffortSwitches(session);
    // Whoever was waiting for the answers died with the driver: the card no longer waits for any decision from it.
    if (!succeeded) dropOpenAsks(session);
    else session.openAsks.clear();
    // The mirror subscription too: left up, it would write to a dead driver's stdin.
    session.offOutside?.();
    delete session.offOutside;
    // The fleet probe too: it publishes to THIS session. Left up, it would still refuse to be
    // replaced by the next driver's (the second call only extends the first).
    if (!succeeded) forgetCardWorkflows(opts.cardId);
    // A DROP with work in flight (OOM, kill, the docker exec that died) and the back up: this live
    // process's marker would never be an orphan to the boot sweep — the resumer is warned now.
    if (crashWithWork) {
      const marker = session.marker!;
      for (const listener of crashListeners) {
        try { listener(opts.cardId, marker); } catch (err) {
          // A listener does not bring the close down — but it does not vanish silently either.
          logger.warn({ card: opts.label, detail: (err as Error).message }, "driver crash listener failed (continuing)");
        }
      }
    }
    // A REQUESTED stop (account/model switch, pause, restart, idle) is not a failure: the kill arrives as
    // `code null` and the stderr has only boot noise — announcing "driver exited (code ?)" in red on
    // every account switch was a false alarm. It only closes the sockets; the front's reconnect brings up the successor.
    if (!deliberate) {
      const stderrNote = session.stderrTail.trim() === "" ? "" : ` — stderr: ${session.stderrTail.trim().slice(-400)}`;
      broadcast(session, { type: "error", message: `driver exited (code ${code ?? "?"})${stderrNote}` });
    }
    for (const socket of session.sockets) {
      try { socket.close(); } catch { /* already closed */ }
    }
    session.sockets.clear();
    // A death nobody asked for is NEVER silent: warn with the exit code, the stderr tail and
    // whether a turn was running — the log line that was missing from the incident.
    if (deliberate && (code === 0 || code === null)) {
      logger.debug({ card: opts.label, code }, "sdk driver exited");
    } else {
      logger.warn(
        {
          audit: true,
          action: "sdk.driver.exit",
          card: opts.label,
          code,
          deliberate,
          turnsInFlight: session.activeTurns,
          stderr: session.stderrTail.trim().slice(-STDERR_TAIL_MAX) || undefined,
        },
        "sdk driver exited unexpectedly",
      );
    }
  });
  return session;
}

/**
 * Can this session still TAKE a turn? A driver that died (killed by a hibernate, a crash, an idle
 * stop) leaves a session object whose stdin is closed — and `write()` on it throws asynchronously,
 * which is exactly how a message used to disappear: written nowhere, persisted anyway, answered
 * never. Checked BEFORE anything is recorded.
 */
function canAcceptTurn(session: DriverSession): boolean {
  // `== null` on purpose: a live child reports `exitCode: null`, and a stub/stream that never
  // defines it must read as alive — only an actual exit code means gone.
  const exited = session.child.exitCode != null;
  return !session.closed && !exited && session.child.stdin.writable !== false;
}

/** Push one line into the driver's stdin. Returns false when the pipe refused it. */
function writeToDriver(session: DriverSession, control: DriverControl): boolean {
  try {
    session.child.stdin.write(encodeControl(control));
    return true;
  } catch (err) {
    logger.warn({ card: session.label, detail: (err as Error).message }, "sdk driver stdin refused a control frame");
    return false;
  }
}

/**
 * The card is ALIVE because a person is talking to it — here, not in the terminal.
 *
 * `humanActiveAt` used to be stamped only by keystrokes on the tmux websocket, so a card whose
 * whole conversation happened in the native chat looked untouched to the idle sweep, which
 * hibernated it (killing this very driver) minutes after it was opened. Stamping it here is what
 * makes "estou conversando com esse card" a sign of life the sweep can see (see
 * `lastActivityAt`/`cardsToHibernate` in services/board/workspace.ts).
 */
function noteChatActivity(session: DriverSession): void {
  void registry.markCardHumanActive(session.cardId).catch(() => { /* best effort, never fails a send */ });
}

/**
 * The bookkeeping of a turn the driver just accepted: one more turn running (board status, no idle
 * stop) and its words in the mirror's dedupe memory, so the transcript does not echo them back.
 * Only a PERSON's turn is a sign of life for the idle sweep — a turn the panel injected is not.
 */
function countSentTurn(session: DriverSession, sentText: string, by: "person" | "panel"): void {
  session.activeTurns += 1;
  syncBoardStatus(session);
  clearIdleTimer(session);
  if (by === "person") noteChatActivity(session);
  noteDriverEventFor(session.cardId, { type: "user", text: sentText });
}

/**
 * A turn someone just sent, on the card's OTHER screens — the same frame the replay would draw.
 * The sender drew it already (its own bubble, settled by the receipt), so it never gets it back.
 * Without this, a second person on the card saw "está digitando…", then nothing — the answer arrived
 * without the question, and only an F5 (the replay) brought the message in (production, 2026-10-08).
 */
function relayToPeers(session: DriverSession, sender: WebSocket | undefined, event: HistoryEvent): void {
  broadcast(session, event, sender);
  for (const listener of setupListeners.get(session.cardId) ?? []) listener(event);
}

/**
 * A tab still CONNECTING is in no `session.sockets` yet: the route reads the history (the replay),
 * then awaits for seconds before `attachSocket`. A turn sent in that gap is in neither — the newcomer
 * saw the answer without the question until an F5. The route listens from BEFORE the replay read and,
 * once attached, delivers what the replay missed (`missedDuringSetup`).
 */
const setupListeners = new Map<string, Set<(event: HistoryEvent) => void>>();

export function onPeerTurn(cardId: string, listener: (event: HistoryEvent) => void): () => void {
  let set = setupListeners.get(cardId);
  if (!set) setupListeners.set(cardId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && setupListeners.get(cardId) === set) setupListeners.delete(cardId);
  };
}

/** What was heard during the setup and is NOT already in the replay — never drawn twice. PURE. */
export function missedDuringSetup(heard: readonly HistoryEvent[], replay: readonly object[]): HistoryEvent[] {
  const key = (e: object): string => {
    const { type, at, text, originalText } = e as { type?: unknown; at?: unknown; text?: unknown; originalText?: unknown };
    return JSON.stringify([type, at, text, originalText]);
  };
  const replayed = new Set(replay.map(key));
  return heard.filter((e) => !replayed.has(key(e)));
}

/**
 * ONE client frame (raw text from a websocket — live or buffered while the route was still setting
 * the connection up) funneled into the card's driver. A user message is a TURN: it goes to the
 * driver's stdin AS a user message (never converted, never wrapped), the turn count and the durable
 * in-flight marker (see ./inflight.ts) both move, and the history gets the line with its sender.
 *
 * Returns the frame's VERDICT so the caller can answer the browser (see `ClientFrameOutcome`): a
 * turn is only ever reported `accepted` when it is both in the driver's stdin and on its way to
 * disk — never because a `write()` did not happen to throw.
 */
export function dispatchClientFrame(
  session: DriverSession,
  raw: string,
  origin?: MessageOrigin,
  sender?: WebSocket,
): ClientFrameOutcome {
  const control = parseSdkClientFrame(raw);
  if (!control) return { kind: "ignored" };
  if (control.type === "user" || control.type === "edit_user") {
    // AN ALREADY ISSUED RECEIPT IS NOT A NEW MESSAGE — and it comes BEFORE looking at the driver, because the
    // receipt speaks of DURABILITY, not of intention: the message is stored, and that remains true
    // with the driver dead. Refusing it here would make the bubble ask for a third copy of something the
    // server has. "Reenviar" repeats the same `cid` on purpose: what got lost was the receipt.
    const known = control.cid ? session.acceptedCids.get(control.cid) : undefined;
    if (known) return { kind: "accepted", cid: control.cid, persisted: chargeReceipt(session, known) };
    // The driver is GONE: refuse out loud instead of writing into a closed pipe. Nothing is
    // persisted and no turn is counted, so the browser's copy is the only one — it keeps the words
    // and resends onto the successor driver (the socket's close is already on its way).
    if (!canAcceptTurn(session)) {
      logger.warn(
        { audit: true, action: "sdk.send.refused", card: session.label },
        "a chat message arrived for a driver that is no longer running — refused (the browser keeps it)",
      );
      return { kind: "refused", cid: control.cid, reason: "driver-gone" };
    }
  }
  if (control.type === "edit_user") {
    // A SUPERSEDE: the model already read the original, so the edit goes to the driver as one more
    // NORMAL user turn wearing the supersede wrapper (the driver knows no edit_user control). The
    // history gets the truth in two lines — the marker that greys the original out, and the new
    // message with its CLEAN text (`sent` keeps the wrapped words, the transcript dedupe key).
    const wrapped = buildSupersedeText(control.original, control.text);
    // The DRIVER decides between the two shapes of an edit, because only it knows whether a rewind
    // is safe (see `rewindAndSend` in sdk-driver.mjs): `text` is what the model reads when the
    // conversation can be taken back to before the original, `fallback` the supersede used when it
    // cannot. Either way the edit reaches the model — the choice is never "nothing happens".
    const first = control.first === true ? { first: true } : {};
    if (!writeToDriver(session, { type: "edit_user", original: control.original, text: control.text, fallback: wrapped, ...first })) {
      return { kind: "refused", cid: control.cid, reason: "driver-gone" };
    }
    // Which message a `rewound: ok` will cut the log back to, and which words went in its place.
    // Enqueued BEFORE the driver can answer, and in send order — the answers come back in the same
    // order, one per edit.
    session.rewinds.push({ original: control.original, text: control.text, ...first });
    // The transcript will carry the WRAPPED words — that is what the mirror must not re-emit.
    countSentTurn(session, wrapped, "person");
    const at = Date.now();
    const edited: HistoryEvent = { type: "message_edited", originalText: control.original, ...first, at };
    void appendHistory(session.cardId, edited);
    const line: HistoryEvent = { type: "user", text: control.text, sent: wrapped, at, from: origin };
    const persisted = appendHistoryReported(session.cardId, line);
    relayToPeers(session, sender, edited);
    relayToPeers(session, sender, line);
    // Same durable in-flight promise a plain user turn earns (see #64's boot sweep).
    markPersonTurn(session, { startedAt: at, preview: inflightPreview(control.text), attempts: 0 });
    rememberCid(session, control.cid, { persisted, line });
    void settleOrphanQuestions(session);
    return { kind: "accepted", cid: control.cid, persisted };
  }
  if (control.type === "user") {
    // The "enviar agora" with a tool running STOPS the turn (see `sendUserNow` in the driver) — and with
    // it whatever question is open.
    if (control.now && session.openAsks.size > 0) noteStop(session, origin, "send_now");
    if (!writeToDriver(session, control)) return { kind: "refused", cid: control.cid, reason: "driver-gone" };
    countSentTurn(session, control.text, "person");
    const at = Date.now();
    const line: HistoryEvent = { type: "user", text: control.text, at, from: origin };
    const persisted = appendHistoryReported(session.cardId, line);
    relayToPeers(session, sender, line);
    // The durable "turn in flight" record: if a deploy kills the back (and this driver with it)
    // before the result arrives, the boot sweep finds this marker and the turn is not silently
    // lost. attempts: 0 — a person's own turn always earns one automatic resume.
    markPersonTurn(session, { startedAt: at, preview: inflightPreview(control.text), attempts: 0 });
    rememberCid(session, control.cid, { persisted, line });
    void settleOrphanQuestions(session);
    return { kind: "accepted", cid: control.cid, persisted };
  }
  if (control.type === "btw") {
    // The /btw is NOT a turn: the driver answers it in a separate query (see `answerBtw` in
    // sdk-driver.mjs). No turn count, in-flight marker or log — only the answer, which
    // carries the question, goes into the history. Driver dead: whoever asked knows right away, instead of
    // being left with the pending line forever.
    if (canAcceptTurn(session) && writeToDriver(session, control)) {
      noteChatActivity(session);
    } else {
      if (sender) {
        sendFrame(sender, {
          type: "btw_answer", id: control.id, question: control.question,
          error: "o agente deste card não está rodando — pergunte de novo daqui a pouco",
        });
      }
    }
    return { kind: "ignored", sent: true };
  }
  if (control.type === "question_answer" && !session.ownQuestions.has(control.id)) {
    // ORPHAN: this driver never asked this question. Passing it on returned "no pending question with id"
    // and the answer was lost — it becomes a message (see `answerOrphanQuestion`).
    void answerOrphanQuestion(session, control, origin);
    return { kind: "ignored" };
  }
  if (control.type === "question_answer") {
    const card = session.questionCards.get(control.id);
    if (card?.state === "answered") {
      answerLate(session, card, control, origin);
      return { kind: "ignored" };
    }
    if (card?.state === "open") {
      // The model also reads what the others have already ticked/written on this card, with the name; the card
      // keeps drawing only what the sender ticked.
      const forModel = mergePeerAnswers(control.answers, origin?.name, session.questionDrafts.get(control.id));
      if (writeToDriver(session, { ...control, ...(forModel ? { forModel } : {}) })) {
        card.state = "answered";
        card.by = origin?.name ?? null;
      }
      return { kind: "ignored" };
    }
  }
  if (control.type === "interrupt") noteStop(session, origin, control.reason === "edit" ? "edit" : "stop");
  writeToDriver(session, control);
  if (control.type === "interrupt") {
    // Streaming input: every send is already in the CLI, and the interrupt aborts the running
    // turn — at most ONE result is still owed. (A send queued CLI-side in the last instant can
    // survive the interrupt and run; its extra result is absorbed by the floor-at-zero above.)
    // Clamping here keeps an abandoned backlog from pinning the driver past the idle stop forever.
    session.activeTurns = Math.min(session.activeTurns, 1);
    // The person said STOP: the resume the watcher was waiting for ends here — resending the order afterwards
    // would be the panel undoing their click.
    if (session.resumeWatch) abandonResumeWatch(session);
    // The same for the new attempt after an API failure: stopping is stopping.
    if (session.apiRetry?.timer) cancelApiRetry(session);
    // Only a stop that actually CUT something gets narrated — a stop click with nothing running
    // would otherwise write a note claiming a turn was interrupted when none was.
    if (session.activeTurns > 0) session.pendingInterruptNote = interruptNote(control);
  }
  return { kind: "ignored" };
}

/**
 * ANOTHER PERSON ALREADY ANSWERED THIS CARD: the answer is not lost — it becomes a turn for the model to
 * compare with the previous one (and ask again if they do not match). It does not release the question the
 * agent asked afterwards (`keepQuestions`). The same person again (two tabs, double click) and an
 * empty answer become nothing. The conversation shows only what the person chose; `sent` keeps what
 * the model read.
 */
function answerLate(session: DriverSession, card: QuestionCard, control: QuestionAnswerControl, origin?: MessageOrigin): void {
  if ((origin?.name ?? null) === card.by) return;
  const late = buildLateAnswerText(card.questions, control.answers, origin?.name, card.by);
  if (!late || !canAcceptTurn(session)) return;
  if (!writeToDriver(session, { type: "user", text: late.sent, keepQuestions: true })) return;
  countSentTurn(session, late.sent, "person");
  const line: HistoryEvent = { type: "user", text: late.shown, sent: late.sent, at: Date.now(), from: origin };
  void appendHistoryReported(session.cardId, line);
  relayToPeers(session, undefined, line);
  markPersonTurn(session, { startedAt: Date.now(), preview: inflightPreview(late.shown), attempts: 0 });
}

/**
 * WHO STOPPED THE TURN is recorded — in the audit log and in the session, so the question card that
 * drops along with it says who cancelled it. Before, none of this was kept: the question vanished "sem resposta" and there
 * was no way to know whether it had been the deadline, a click or another person on the same card.
 */
function noteStop(session: DriverSession, origin: MessageOrigin | undefined, how: StopHow): void {
  session.stopCause = { ...(origin?.name ? { by: origin.name } : {}), how };
  logger.info(
    { audit: true, action: "sdk.stop", card: session.label, by: origin?.name ?? null, how, openAsks: session.openAsks.size },
    "turn stopped from the chat",
  );
}

/** A pending question card without the driver that opened it. */
interface OrphanCard {
  questions: UserQuestionItem[];
  /** What was running in the background and died in the restart that left the card up. */
  lostBackground: string[];
}

/**
 * What the history still shows as a PENDING question and the current driver is not waiting for — the
 * orphan cards, with their text. Read from disk: after a deploy the new back has no other
 * memory of them, and the card the screen redraws comes exactly from here.
 */
async function orphanQuestions(session: DriverSession): Promise<Map<string, OrphanCard>> {
  const open = new Map<string, OrphanCard>();
  for (const event of await readHistory(session.cardId, HISTORY_REPLAY_LIMIT, { strict: true })) {
    if (event.type === "user_question") open.set(event.id, { questions: event.questions, lostBackground: [] });
    else if (event.type === "question_result") open.delete(event.id);
    // The restart that left the card up also killed the background (resume.ts): it goes along with the answer.
    else if (event.type === "system_note" && event.lostBackground?.length) {
      for (const card of open.values()) card.lostBackground.push(...event.lostBackground);
    }
  }
  for (const id of [...open.keys()]) {
    if (session.ownQuestions.has(id)) open.delete(id);
  }
  return open;
}

/** Closes a card in every tab and in the history (the F5 reads the same thing). */
function settleQuestionCard(session: DriverSession, result: Extract<DriverEvent, { type: "question_result" }>): void {
  forgetQuestionDrafts(session, result.id);
  if (session.orphanAsks.delete(result.id)) syncAwaitingDecision(session);
  broadcast(session, result);
  void appendHistory(session.cardId, { ...result, at: Date.now() });
  void observeDriverEvent(session.cardId, result);
}

/**
 * SPEAKING IS ANSWERING, for the orphan too — and the conversation MOVING ON is as well: any turn that enters
 * the model (message, automatic resume, another orphan's answer) or a new question from the live
 * driver closes the orphans. With the driver alive, a message releases the card it
 * is waiting for (`supersedePendingQuestions` in the driver). The orphan has no driver for that: it stayed pending
 * in the history and the tray asked again for an answer the person had just given.
 */
async function settleOrphanQuestions(session: DriverSession): Promise<void> {
  if (session.orphansSwept) return;
  session.orphansSwept = true;
  let orphans: Map<string, OrphanCard>;
  try {
    orphans = await orphanQuestions(session);
  } catch (err) {
    session.orphansSwept = false; // the next message tries again
    logger.warn({ card: session.label, detail: (err as Error).message }, "could not sweep orphaned question cards");
    return;
  }
  for (const id of orphans.keys()) {
    if (session.settledOrphans.has(id) || session.answeringOrphans.has(id)) continue;
    session.settledOrphans.add(id);
    settleQuestionCard(session, { type: "question_result", id, superseded: true });
  }
}

/**
 * THE CLICK ON AN ORPHAN (production, 2026-10-07): the deploy killed the driver with the card up; the new
 * driver resumed the conversation without the tool call the answer was supposed to complete. The choices
 * still matter — they go to the model as a MESSAGE, each question quoted next to the choice, and the
 * card closes as answered. It is a turn: it counts, disarms the idle and gets the marker.
 */
async function answerOrphanQuestion(session: DriverSession, control: QuestionAnswerControl, origin?: MessageOrigin): Promise<void> {
  // Marked BEFORE any await: the second click (another tab, double click) arrives in the middle of the
  // disk read and needs to find the slot already taken.
  if (session.answeringOrphans.has(control.id)) return; // the same answer is already on its way
  if (session.settledOrphans.has(control.id)) {
    // Closed right here (by a message, or by another answer): the usual verdict.
    broadcast(session, { type: "error", message: `no pending question with id ${control.id}` });
    return;
  }
  session.answeringOrphans.add(control.id);
  const release = (message: string): void => {
    session.answeringOrphans.delete(control.id);
    broadcast(session, { type: "error", message });
  };
  let orphans: Map<string, OrphanCard>;
  try {
    orphans = await orphanQuestions(session);
  } catch (err) {
    release(`could not read the question card: ${(err as Error).message}`);
    return;
  }
  const orphan = orphans.get(control.id);
  if (!orphan) {
    // It is not pending on disk: already closed (old tab) or it never existed. Nothing goes to the model —
    // the same verdict the driver used to give.
    release(`no pending question with id ${control.id}`);
    return;
  }
  if (!canAcceptTurn(session)) {
    // With no driver there is nobody to deliver to: the screen is warned and the card stays pending for the next one.
    release("driver exited before the answer reached it — answer again once the chat reconnects");
    return;
  }
  // What the OTHERS ticked on this card goes along, with the name — from before the restart included.
  await session.draftsLoaded;
  const forModel = mergePeerAnswers(control.answers, origin?.name, session.questionDrafts.get(control.id));
  const text = buildOrphanAnswerText(orphan.questions, forModel ?? control.answers, orphan.lostBackground);
  if (!writeToDriver(session, { type: "user", text })) {
    release("driver exited before the answer reached it — answer again once the chat reconnects");
    return;
  }
  countSentTurn(session, text, "person");
  markPersonTurn(session, { startedAt: Date.now(), preview: inflightPreview(text), attempts: 0 });
  session.answeringOrphans.delete(control.id);
  session.settledOrphans.add(control.id);
  settleQuestionCard(session, { type: "question_result", id: control.id, answers: control.answers, sent: text });
  // The conversation went on with THIS answer: the other orphans (questions from even older drivers)
  // go with it, as they would with a message.
  void settleOrphanQuestions(session);
  logger.info(
    { audit: true, action: "sdk.question.orphan", card: session.label },
    "an answer to a question whose driver died was delivered as a message",
  );
}

/**
 * CLAIMING A RECEIPT (the same `cid` again): the promise the first send earned — and, if its
 * write FAILED, a new attempt to write the same line. The driver has already read the message, so
 * it never goes back to stdin; only the history was in debt. Without the new attempt, a disk full for
 * an instant left the bubble "não entregue" forever: every Reenviar got the same `false`, and
 * Descartar + typing again made the model execute the instruction twice. The stored promise is
 * SWAPPED for the new one before returning, so two resends in a row chain — the line is written
 * only once.
 */
function chargeReceipt(session: DriverSession, sent: AcceptedSend): Promise<boolean> {
  sent.persisted = sent.persisted.then((onDisk) => onDisk || appendHistoryReported(session.cardId, sent.line));
  return sent.persisted;
}

/**
 * A turn injected by the BACKEND itself (the boot-resume after a deploy killed a turn in flight):
 * same stdin path and same turn accounting as a person's message — the driver receives a NORMAL
 * user turn — but the history line carries system provenance (it must never read as the person's
 * own words) and the in-flight marker carries the attempt count that stops a resume loop.
 */
export function injectSystemTurn(session: DriverSession, text: string, origin: MessageOrigin, attempts: number): void {
  // A refused write is logged by writeToDriver; the close event that follows cleans the session up.
  writeToDriver(session, { type: "user", text });
  recordInjectedTurn(session, text, origin);
  // The resume is a turn like any other: the agent asks again the question the restart cut, and the
  // orphan must not stay up next to it (production, 2026-10-19 — the person answered twice).
  void settleOrphanQuestions(session);
  const marker: InflightMarker = { startedAt: Date.now(), preview: inflightPreview(text), attempts };
  endResumeWatch(session);
  session.resumeWatch = { marker, reengaged: false };
  putMarker(session, marker);
}

/** A PERSON's turn entered the driver: a fresh in-flight marker, and the resume chain starts over. */
function markPersonTurn(session: DriverSession, marker: InflightMarker): void {
  endResumeWatch(session);
  clearTimeout(session.apiRetry?.timer);
  session.apiRetry = undefined;
  // A new turn starts: the CLI folds any pending notice into it.
  session.pendingNotices = [];
  putMarker(session, marker);
}

/** What counts as the main agent giving a sign of life — the long reasoning before the text included. */
const AGENT_SIGNALS: ReadonlySet<string> = new Set([
  "assistant_delta", "assistant_text", "thinking_delta", "thinking", "tool_use_start", "tool_input_progress", "tool_use", "tool_progress",
]);

function endResumeWatch(session: DriverSession): void {
  clearTimeout(session.resumeWatch?.timer);
  session.resumeWatch = undefined;
}

/** The resume ended without taking (Parar, giving up): the marker and the dot stop counting on it. */
function abandonResumeWatch(session: DriverSession): void {
  endResumeWatch(session);
  syncInflightMarker(session);
}

/** Arms (or re-arms) the resume's deadline from now. */
function armResumeWatch(session: DriverSession): void {
  const watch = session.resumeWatch;
  if (!watch) return;
  clearTimeout(watch.timer);
  const signals = session.agentSignals;
  watch.timer = setTimeout(() => checkResumeWatch(session, signals), RESUME_CONFIRM_MS);
  watch.timer.unref?.();
}

/**
 * The deadline expired: there was a sign of life (or a turn opened) since then — wait more; nothing — the
 * continuation got lost in the CLI and the order goes again, ONCE, in words that do not pass for an
 * automatic notice (RESUME_REENGAGE_TEXT). On the second miss, a line in the chat: the card never sits stopped
 * silently, and it never becomes a loop. Firing right on the `result` sent the order twice: on the real CLI the
 * boot's empty `result` arrives seconds BEFORE the real turn (E2E, 2026-10-20).
 */
function checkResumeWatch(session: DriverSession, signalsAtArm: number): void {
  const watch = session.resumeWatch;
  if (!watch || session.closed) return;
  watch.timer = undefined;
  // An open turn or a sign of life: wait more. Re-arming (and not waiting for that turn's `result`)
  // is what prevents a stuck watcher — the turn may end in a stream error, with no `result`.
  if (isTurnInFlight(session) || session.agentSignals !== signalsAtArm) { armResumeWatch(session); return; }
  if (!watch.reengaged && writeInjectedTurn(session, RESUME_REENGAGE_TEXT, SYSTEM_ORIGIN)) {
    watch.reengaged = true;
    syncInflightMarker(session);
    logger.info({ audit: true, action: "sdk.resume.reengage", card: session.label }, "the resumed turn closed without progress — sending the order again");
    return;
  }
  abandonResumeWatch(session);
  emitSystemNote(session, NOTE_RESUME_STALLED);
  maybeScheduleIdleStop(session);
  logger.warn({ audit: true, action: "sdk.resume.stalled", card: session.label }, "the resumed turn did not continue, twice — noted");
}

type CrashListener = (cardId: string, marker: InflightMarker) => void;
const crashListeners = new Set<CrashListener>();

/**
 * Whoever wants to know about a driver that DROPPED (without anyone asking) with work in flight — the in-process
 * resume (resume.ts). Returns the subscription's cancellation.
 */
export function onDriverCrashWithWork(listener: CrashListener): () => void {
  crashListeners.add(listener);
  return () => { crashListeners.delete(listener); };
}

/**
 * The wait before each new attempt of a turn the API knocked down with a TRANSIENT failure — the CLI
 * has already tried on its own before giving up, so the network usually needs minutes, not
 * seconds. One position per attempt: once the list is over, so is the insistence (NOTE_API_RETRY_EXHAUSTED).
 */
export const API_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000];

/** The order the new attempt sends: the previous turn died midway, it did not finish. */
export const API_RETRY_TEXT =
  "O turno anterior foi encerrado no meio por uma falha temporária da API da Anthropic (rede ou servidor). " +
  "Isto NÃO é uma notificação automática: é a ordem de continuar. Confira o estado atual e siga a tarefa " +
  "em andamento até o fim.";

/** The attempts are over (or the last one could not go): the person is told, the card does not go silent. */
export const NOTE_API_RETRY_EXHAUSTED =
  "A API da Anthropic falhou e as novas tentativas automáticas não fizeram o agente continuar. " +
  "Mande uma mensagem para ele seguir de onde parou.";

/**
 * Did the turn end in a TRANSIENT API failure? It is the text with which the CLI closes the turn after
 * exhausting its own attempts ("API Error: Can't reach the API server … (EAI_AGAIN)", "API Error:
 * 529 … overloaded_error", "API Error: Connection error."). Credentials, an invalid request and the plan
 * limit (4xx) do not pass with time — those are left for the person. PURE.
 */
export function isTransientApiFailure(result: string | undefined): boolean {
  const text = String(result ?? "").trim();
  if (!/^API Error\b/i.test(text)) return false;
  if (/^API Error:\s*5\d\d\b/i.test(text)) return true;
  return /can't reach the API|connection error|timed out|overloaded|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed/i
    .test(text);
}

/** Gives up the scheduled new attempt: the dot and the marker stop counting on it. */
function cancelApiRetry(session: DriverSession): void {
  clearTimeout(session.apiRetry?.timer);
  session.apiRetry = undefined;
  syncInflightMarker(session);
  maybeScheduleIdleStop(session);
}

/**
 * THE END OF A TURN, as seen by the API failure count (production, card 8f2a, 23/10/2026: the turn
 * closed on EAI_AGAIN and the card sat at "falhou" until someone wrote "continua"). Transient
 * failure: a note in the chat now and, after that round's wait, the order to continue — unless
 * another turn is already running (a message arrived) or the driver was stopped. Any other
 * end without error resets the count.
 */
function noteApiOutcome(session: DriverSession, event: ResultEvent): void {
  if (!event.isError || !isTransientApiFailure(event.result)) {
    if (!event.isError) {
      clearTimeout(session.apiRetry?.timer);
      session.apiRetry = undefined;
    }
    return;
  }
  clearTimeout(session.apiRetry?.timer);
  const failures = (session.apiRetry?.failures ?? 0) + 1;
  const delay = API_RETRY_DELAYS_MS[failures - 1];
  if (delay === undefined) {
    session.apiRetry = undefined;
    emitSystemNote(session, NOTE_API_RETRY_EXHAUSTED);
    logger.warn({ audit: true, action: "sdk.apiRetry.exhausted", card: session.label, failures, detail: event.result?.slice(0, 200) },
      "the API kept failing after the automatic retries — noted");
    return;
  }
  session.apiRetry = { failures };
  // A message already in the queue is the next turn: it carries the work on itself.
  if (isTurnInFlight(session)) return;
  emitSystemNote(session, `A API da Anthropic falhou por um erro temporário. Nova tentativa automática em ${Math.round(delay / 1000)} s.`);
  const timer = setTimeout(() => {
    const retry = session.apiRetry;
    if (!retry || retry.timer !== timer) return;
    retry.timer = undefined;
    if (session.closed || isTurnInFlight(session)) return;
    if (!writeInjectedTurn(session, API_RETRY_TEXT, SYSTEM_ORIGIN)) {
      // The driver no longer accepts turns: the failure that stayed quiet waiting for this attempt goes public.
      cancelApiRetry(session);
      emitSystemNote(session, NOTE_API_RETRY_EXHAUSTED);
      void observeDriverEvent(session.cardId, event);
      return;
    }
    putMarker(session, { startedAt: Date.now(), preview: inflightPreview(API_RETRY_TEXT), attempts: 0 });
    logger.info({ audit: true, action: "sdk.apiRetry", card: session.label, attempt: failures, delayMs: delay },
      "turn ended by a transient API failure — sent the order to continue");
  }, delay);
  timer.unref?.();
  session.apiRetry.timer = timer;
  logger.info({ audit: true, action: "sdk.apiRetry.scheduled", card: session.label, attempt: failures, delayMs: delay, detail: event.result?.slice(0, 200) },
    "turn ended by a transient API failure — retry scheduled");
}

/**
 * The second chance of a resume that closed WITHOUT ADVANCING — after a deploy or a driver
 * drop; that is why the words do not say which. Production, 2026-10-20: after a deploy, the injected turn came back with only the harness's filler ("No response requested." — which the
 * manager hides), and the card sat stopped until someone wrote. Together with the task notices the
 * CLI attaches ("NOT USER INPUT"), the continuation read as just another automatic notice. This text says the
 * opposite in so many words.
 */
export const RESUME_REENGAGE_TEXT =
  "O painel retomou este card depois de uma interrupção e a sua última resposta não continuou o trabalho. " +
  "Isto NÃO é uma notificação automática: é a ordem de continuar. Confira o estado atual (git status, " +
  "testes, PRs, o que estava rodando) e siga a tarefa em andamento até o fim.";

/** The re-engage did not advance either: no third send — the person is told. */
export const NOTE_RESUME_STALLED =
  "A retomada automática não fez o agente continuar. " +
  "Mande uma mensagem para ele seguir de onde parou.";

/** What the marker says about a turn the CLI itself opened — nobody wrote anything. */
const AUTONOMOUS_TURN_PREVIEW = "(turno aberto pelo próprio Claude: retorno de tarefa em segundo plano ou agendada)";

/**
 * The BACKGROUND WORK alive now, for the marker: the CLI's tasks and the scheduled wakeup.
 * Empty = nothing goes on after the turn.
 */
function backgroundWork(session: DriverSession): string[] {
  const tasks = session.backgroundTasks.map((t) => t.description || t.type || "tarefa em segundo plano");
  for (const notice of session.pendingNotices) tasks.push(`aviso de término ainda não entregue: ${notice}`);
  if (session.pendingWakeup !== undefined) tasks.push(`retorno agendado (ScheduleWakeup): ${session.pendingWakeup}`);
  return tasks;
}

/** Writes the marker with the current background, and remembers it. */
function putMarker(session: DriverSession, base: InflightMarker): void {
  const tasks = backgroundWork(session);
  const { background: previous, ...rest } = base;
  const background: InflightBackground | undefined = tasks.length === 0 ? undefined : {
    tasks,
    since: previous?.since ?? session.backgroundSince ?? Date.now(),
    idle: !turnRunning(session),
  };
  const marker: InflightMarker = background ? { ...rest, background } : rest;
  session.marker = marker;
  void writeInflightMarker(session.cardId, marker);
}

/**
 * The marker follows the session state: it exists while THERE IS work a deploy would kill — someone's
 * turn, a turn the CLI itself opened, a background task, a scheduled
 * wakeup — and goes away when there is nothing left. It only rewrites when what it says changed.
 */
function syncInflightMarker(session: DriverSession): void {
  if (session.closed) return;
  syncBoardStatus(session);
  // The resume that has not taken yet is work in flight: the resend is on its way (see RESUME_CONFIRM_MS).
  const running = turnRunning(session);
  const tasks = backgroundWork(session);
  if (!running && tasks.length === 0) {
    session.marker = undefined;
    void clearInflightMarker(session.cardId);
    return;
  }
  const current = session.marker;
  if (current) {
    const same = (current.background?.tasks ?? []).join("\n") === tasks.join("\n")
      && (tasks.length === 0 || current.background?.idle === !running);
    if (same) return;
    putMarker(session, current);
    return;
  }
  putMarker(session, { startedAt: Date.now(), preview: AUTONOMOUS_TURN_PREVIEW, attempts: 0 });
}

/**
 * A step of the agent (text, reasoning, tool). From the MAIN agent, with no counted turn, it is a turn
 * the CLI opened on its own — a background task's notification, a scheduled wakeup firing.
 * And the main agent's ScheduleWakeup schedules (or cancels) a wakeup: pending work all the same.
 */
function noteAgentWork(session: DriverSession, event: DriverEvent): void {
  if ((event as { parentToolUseId?: unknown }).parentToolUseId) return;
  let changed = false;
  if (session.activeTurns === 0 && !session.autonomousTurn) {
    session.autonomousTurn = true;
    // The turn the CLI opens on its own is where the finished tasks' notices are delivered.
    session.pendingNotices = [];
    // The scheduled wakeup that was pending is, almost always, what has just opened this turn.
    session.pendingWakeup = undefined;
    changed = true;
  }
  if (event.type === "tool_use" && (event as { name?: unknown }).name === "ScheduleWakeup") {
    const input = ((event as { input?: unknown }).input ?? {}) as { stop?: unknown; reason?: unknown; prompt?: unknown };
    if (input.stop === true) session.pendingWakeup = undefined;
    else {
      const why = typeof input.reason === "string" && input.reason.trim() !== "" ? input.reason
        : typeof input.prompt === "string" ? input.prompt : "";
      session.pendingWakeup = inflightPreview(why).slice(0, 120) || "sem descrição";
    }
    changed = true;
  }
  if (changed) syncInflightMarker(session);
}

/**
 * Another card's AGENT talking to this one (`vibehub_send_to_terminal`): a normal user turn of the
 * card's own driver, so it lands in the conversation the card is really having — not in the tmux
 * TUI, whose Claude never rereads what the driver wrote. Also the way a PERSON's order arrives from
 * the external MCP (ChatGPT, `viaNativeChat`).
 *
 * The turn gets the in-flight marker like any other: a deploy kills it just the same, and nobody on
 * the other side retries — the ChatGPT never learns the turn died, the sending agent reads a card
 * still "working". Without it the boot had nothing to resume and the board kept the dead process's
 * `working` (production, card a28ffa23, 2026-10-20). A new order restarts the resume chain (attempts 0).
 * Returns false (nothing recorded) when the driver can no longer take a turn.
 */
export function sendAgentTurn(session: DriverSession, text: string, origin: MessageOrigin): boolean {
  if (!writeInjectedTurn(session, text, origin)) return false;
  markPersonTurn(session, { startedAt: Date.now(), preview: inflightPreview(text), attempts: 0 });
  return true;
}

/** A turn the back writes on its own: to stdin AND to the history, or to neither. */
function writeInjectedTurn(session: DriverSession, text: string, origin: MessageOrigin): boolean {
  if (!canAcceptTurn(session) || !writeToDriver(session, { type: "user", text })) return false;
  recordInjectedTurn(session, text, origin);
  return true;
}

function recordInjectedTurn(session: DriverSession, text: string, origin: MessageOrigin): void {
  countSentTurn(session, text, "panel");
  const line: HistoryEvent = { type: "user", text, at: Date.now(), from: origin };
  void appendHistory(session.cardId, line);
  // Nobody typed it, so nobody drew it: every open tab gets it, or the answer arrives without it.
  relayToPeers(session, undefined, line);
}

/**
 * The RECEIPT a frame earns, sent back to the socket that sent it.
 *
 * `user_ack` means the message is in the card's history on disk — the thing an F5 reads back — so
 * the browser may finally forget its own copy. `user_nack` means the back did NOT take it, and is
 * the browser's cue to keep the words and resend them onto the next driver. A frame with no `cid`
 * (an older client) gets no receipt and behaves exactly as before.
 */
function replyFrameOutcome(socket: WebSocket, outcome: ClientFrameOutcome): void {
  if (outcome.kind === "ignored" || !outcome.cid) return;
  const cid = outcome.cid;
  if (outcome.kind === "refused") {
    sendFrame(socket, { type: "user_nack", cid, reason: outcome.reason });
    return;
  }
  // AFTER the append: the ack promises durability, not intention. A write that FAILED (a full
  // disk) is no ack — the driver has the words, the history does not, and an F5 would lose them: the
  // browser keeps its copy. Its resend carries the same `cid`, so it never becomes a second turn: it
  // retries the history write and earns THAT verdict (see `chargeReceipt`).
  void outcome.persisted.then((onDisk) => {
    sendFrame(socket, onDisk ? { type: "user_ack", cid } : { type: "user_nack", cid, reason: "history-write-failed" });
  });
}

export interface AttachOpts {
  /**
   * Asked for every frame before it reaches the driver. A returned promise HOLDS that frame — and
   * every later frame of this socket, so nothing overtakes it — until it settles (it must never
   * reject). The route uses it so a message from a new author waits for that person's GitHub
   * identity to land in the runner. `undefined` = go now: the common case costs no await.
   */
  beforeTurn?: (raw: string) => Promise<void> | undefined;
}

/**
 * Attach one websocket to the card's live driver: events fan out to it, its controls funnel in.
 * `origin` is who types on THIS socket — stamped on the messages it persists. Detaching (socket
 * close/error) never touches the driver; it only arms the idle stop when nothing else holds it.
 *
 * Returns this socket's FUNNEL — what its `message` listener feeds — so the route can hand it the
 * frames buffered during its setup and they take the same ordered path as the live ones.
 */
export function attachSocket(
  session: DriverSession, socket: WebSocket, origin?: MessageOrigin, opts: AttachOpts = {},
): (raw: string) => void {
  // A socket that is no longer OPEN already fired (or is about to fire) its `close` — before the
  // listener below exists. Attached, it would never be detached: `sockets` never empties, the idle
  // stop never arms, `isCardChatInUse` vetoes the hibernation forever and the ping interval leaks.
  // The route checks this after its own awaits; this is the manager's own guard on its invariant.
  if (socket.readyState !== WebSocket.OPEN) {
    maybeScheduleIdleStop(session);
    return () => undefined;
  }
  disableNagle(socket);
  clearIdleTimer(session);
  session.sockets.add(socket);

  // The reconnect case: the driver said `ready` long ago (it only says it at boot). Without a
  // synthesized one the fresh page would never enable its composer. `turnActive` carries the
  // manager's REAL state: a view remounting mid-turn (Terminal↔Chat, reload)
  // reset its own turn flag and nothing re-lit the "Trabalhando…" spinner until much later.
  if (session.ready) {
    sendFrame(socket, { type: "ready", resume: session.lastSessionId, turnActive: isTurnInFlight(session) });
  }

  // The "/" menu is state, not conversation: it is not in the replayed history, and the driver
  // only announces it once per boot. Without this, a page opened on a card whose driver is already
  // up had no command list until the next turn's `init` — an empty menu on a session full of skills.
  if (session.catalog) {
    sendFrame(socket, session.catalog);
  }

  // Background tasks are state too: a tab that opens (or reloads) while a deploy
  // `sleep` runs needs to see that in the first frame — the CLI's notice only comes on change.
  if (session.backgroundTasks.length > 0) {
    sendFrame(socket, { type: "background_tasks", tasks: session.backgroundTasks });
  }

  // Each subagent's state too (counters, "o que ele faz agora"): the CLI only speaks on change.
  // The time goes up to now (taskSnapshot): the tab counts from what it receives.
  const now = Date.now();
  for (const task of session.tasks.values()) {
    sendFrame(socket, taskSnapshot(task, now));
  }

  // The plan limit warning too: the CLI only emits it when the reading changes, and whoever opens the card
  // with the session at 92% needs to see the strip in the first frame, not after the next answer.
  for (const info of session.rateLimits.values()) {
    sendFrame(socket, { type: "rate_limit", ...info });
  }

  // The context meter too: the reading only comes at the end of a turn, and whoever opens the stopped card
  // needs to see how much the conversation already takes without sending any message.
  if (session.contextUsage) {
    sendFrame(socket, { type: "context_usage", ...session.contextUsage });
  }

  // The compaction in progress: the bar, counting since it started.
  if (session.compacting) {
    sendFrame(socket, { type: "compaction", phase: "started", ...session.compacting });
  }

  // The workflow fleet is of the same nature as the catalog: state, not conversation. It is not in the
  // replayed history, and a tab that opens in the middle of a round (or right after it) needs to
  // draw the panel in the first frame — otherwise the screen goes back to saying, for 4 seconds or
  // forever, that nothing is happening.
  for (const run of lastWorkflowRuns(session.cardId)) {
    sendFrame(socket, { type: "workflow_progress", ...run });
  }

  // THE DRAFTS of the open cards: whoever arrives in the middle of another person's answer sees, right away, what
  // they have already ticked and written — otherwise only on their next touch.
  // Those of whoever already closed the tab (or from before the restart) go marked as absent.
  for (const [id, byName] of session.questionDrafts) {
    for (const [name, draft] of byName) {
      sendFrame(socket, peerQuestionDraftFrame(id, name, draft, !draftIsLive(session, id, name)));
    }
  }

  const keepalive = setInterval(() => {
    try { socket.ping?.(); } catch { /* the close handler cleans up */ }
  }, KEEPALIVE_MS);

  // "ESTÁ DIGITANDO": who types on THIS socket, relayed to the card's OTHER sockets only — the
  // sender knows it is typing. Ephemeral by design: no driver write, no history line, no state
  // beyond these two locals. An unattributed socket has no name to show, so it announces nothing.
  let typingOn = false;
  let typingRelayedAt = 0;
  const relayTyping = (active: boolean): void => {
    if (!origin) return;
    broadcast(session, { type: "peer_typing", name: origin.name, active }, socket);
  };
  const noteTyping = (active: boolean): void => {
    if (active) {
      const now = Date.now();
      // The floor holds for EVERY "digitando", not only a repeat: a "parou" in between must not
      // reopen the window, or a true/false loop would fan out every frame it sends.
      if (now - typingRelayedAt < TYPING_RELAY_MIN_MS) return;
      typingOn = true;
      typingRelayedAt = now;
      relayTyping(true);
      return;
    }
    if (!typingOn) return;
    typingOn = false;
    relayTyping(false);
  };

  // THE QUESTION CARD'S DRAFT: like typing, it goes to the OTHER tabs — but with the content,
  // so that two people on the same card see what the other one is answering before anyone
  // sends (everyone's answers go together to the model, see `mergePeerAnswers`). It stays stored while the question is open, for whoever
  // opens the card later; it never goes to the driver nor to the history.
  const draftedHere = new Set<string>();
  const relayDraft = (id: string, name: string, draft: StoredQuestionDraft, away = false): void => {
    broadcast(session, peerQuestionDraftFrame(id, name, draft, away), socket);
  };
  const countLive = (id: string, name: string, delta: 1 | -1): number => {
    let byName = session.draftLive.get(id);
    if (!byName) {
      byName = new Map();
      session.draftLive.set(id, byName);
    }
    const count = Math.max(0, (byName.get(name) ?? 0) + delta);
    if (count === 0) byName.delete(name);
    else byName.set(name, count);
    if (byName.size === 0) session.draftLive.delete(id);
    return count;
  };
  const noteDraft = (draft: QuestionDraft): void => {
    if (!origin || draft.id === "") return;
    const empty = isEmptyQuestionDraft(draft);
    let byName = session.questionDrafts.get(draft.id);
    const stored = byName?.get(origin.name);
    // THE NEWEST WINS: a tab that comes back with an older draft (the laptop after the phone)
    // does not erase what the person did elsewhere — it gets the new version back.
    if (stored?.at !== undefined && draft.at !== undefined && draft.at < stored.at) {
      sendFrame(socket, peerQuestionDraftFrame(draft.id, origin.name, stored));
      return;
    }
    const next: StoredQuestionDraft = { picked: draft.picked, other: draft.other, ...(draft.at !== undefined ? { at: draft.at } : {}) };
    if (empty) {
      if (draftedHere.delete(draft.id)) countLive(draft.id, origin.name, -1);
      if (!byName?.has(origin.name)) return;
      byName.delete(origin.name);
      if (byName.size === 0) session.questionDrafts.delete(draft.id);
    } else {
      if (!byName) {
        // Cap: a card forgotten open does not accumulate forever.
        makeRoom(session.questionDrafts, QUESTION_DRAFTS_MAX);
        byName = new Map();
        session.questionDrafts.set(draft.id, byName);
      }
      byName.set(origin.name, next);
      if (!draftedHere.has(draft.id)) {
        draftedHere.add(draft.id);
        countLive(draft.id, origin.name, 1);
      }
    }
    persistQuestionDrafts(session);
    relayDraft(draft.id, origin.name, next);
  };
  /**
   * The tab closed: what the person ticked STAYS (stored, and it goes along with the sender's answer); the
   * other screens only stop showing them as "respondendo" — if no other tab of theirs remains on the card.
   */
  const dropDraftsOfThisSocket = (): void => {
    if (!origin) return;
    for (const id of draftedHere) {
      if (countLive(id, origin.name, -1) > 0) continue;
      const draft = session.questionDrafts.get(id)?.get(origin.name);
      if (draft) relayDraft(id, origin.name, draft, true);
    }
    draftedHere.clear();
  };

  const answerFeed = createFeedResponder(session, socket);
  const answerDetail = createDetailResponder(session, socket);

  const deliver = (text: string): void => {
    const outcome = dispatchClientFrame(session, text, origin, socket);
    // The message is out: whoever wrote it stopped typing — even if the front's own "parou" is lost.
    if (outcome.kind === "accepted" || (outcome.kind === "ignored" && outcome.sent)) noteTyping(false);
    replyFrameOutcome(socket, outcome);
  };
  /** The tail of this socket's held frames; null = nothing held, frames go straight through. */
  let held: Promise<void> | null = null;

  const funnel = (text: string): void => {
    const typing = parseTypingFrame(text);
    if (typing !== null) {
      noteTyping(typing);
      return;
    }
    const draft = parseQuestionDraftFrame(text);
    if (draft !== null) {
      noteDraft(draft);
      return;
    }
    // A workflow subagent's feed: on demand, only for this tab — neither driver nor history.
    // The detail of an action, of a subagent or of the card's changes: likewise, only for this tab.
    const detail = parseDetailFrame(text);
    if (detail !== null) {
      answerDetail(detail);
      return;
    }
    const feed = parseWorkflowFeedFrame(text);
    if (feed !== null) {
      answerFeed(feed);
      return;
    }
    const gate = opts.beforeTurn?.(text);
    if (!held && !gate) {
      deliver(text);
      return;
    }
    const next: Promise<void> = (held ?? Promise.resolve())
      .then(() => gate)
      .then(() => deliver(text))
      .catch((err: unknown) => {
        logger.warn({ card: session.label, detail: (err as Error).message }, "a held chat frame could not be delivered");
      });
    held = next;
    void next.then(() => {
      if (held === next) held = null;
    });
  };
  socket.on("message", (raw: Buffer) => funnel(raw.toString()));

  const detach = (): void => {
    clearInterval(keepalive);
    session.sockets.delete(socket);
    // A tab closed mid-sentence must not leave "Cesar está digitando…" on everyone else's screen.
    noteTyping(false);
    dropDraftsOfThisSocket();
    if (session.sockets.size === 0) maybeScheduleIdleStop(session);
  };
  socket.on("close", detach);
  socket.on("error", detach);
  return funnel;
}

/**
 * End a driver's process: stdin first — EOF is the driver's own exit signal (`rl.on("close") →
 * exit 0`), and it reaches across the docker exec — then kill the local client. Best-effort.
 */
function killDriverChild(session: DriverSession): void {
  clearSessionTimers(session);
  session.closed = true;
  try { session.child.stdin.end(); } catch { /* already gone */ }
  try { session.child.kill(); } catch { /* already gone */ }
}

/**
 * Stop a card's driver NOW (pause, hibernate, restart, delete, model/account switch, idle), via
 * `killDriverChild`. Best-effort and idempotent.
 */
export function stopCardDriver(cardId: string): void {
  const session = sessions.get(cardId);
  if (!session) return;
  sessions.delete(cardId);
  killDriverChild(session);
  // A DELIBERATE stop (pause, hibernate, restart, delete, model switch, idle) abandons the turn on
  // purpose — the marker comes off so the next boot does not "resume" something a person ended.
  session.marker = undefined;
  void clearInflightMarker(cardId);
  dropOpenAsks(session);
  dropPendingEffortSwitches(session);
  // The fleet probe is this driver's child: without it there is nobody to publish to and no session to read.
  forgetCardWorkflows(cardId);
  logger.debug({ card: session.label }, "sdk driver stopped");
}

/**
 * How long a switch waits for the driver's answer. The driver answers every switch by its start
 * deadline (12 s from arrival, queue and CLI boot included: EFFORT_SWITCH_START_DEADLINE_MS in
 * sdk-driver.mjs) and, once writing, within the write and the read of the level (4 s each,
 * EFFORT_STEP_TIMEOUT_MS): 20 s at worst, plus slack. A switch that did not start in time never
 * writes later, so giving up here and restarting onto the pin is the truth, not a guess.
 */
export const EFFORT_ACK_TIMEOUT_MS = 25_000;

/** An effort switch written to the driver, waiting for its `effort_ack`. */
interface PendingEffortSwitch {
  requested: string | null;
  settle: (applied: boolean) => void;
}

/**
 * THE CARD'S NEW INTELLIGENCE, in the live session: the driver applies it with `applyFlagSettings` — in the middle
 * of the turn included, the next call to the model already goes out on it — and starts using it for everything that comes
 * (a new stream, the `ultrathink` give-back).
 *
 * Resolves true only once the driver CONFIRMS it (`effort_ack` with no error). Writing to stdin is
 * not enough: the screen said "já valendo" before the session took it, and a refusal only reached
 * the driver's trace. False = no driver, refused, driver gone or no answer in time; the caller then
 * restarts the session onto the level (`applySessionChange`).
 */
export function applyDriverEffort(cardId: string, effort: string | null): Promise<boolean> {
  const session = sessions.get(cardId);
  if (!session || !canAcceptTurn(session)) return Promise.resolve(false);
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn({ audit: true, action: "sdk.effort.timeout", card: session.label, effort }, "the driver never confirmed the intelligence switch");
      settle(false);
    }, EFFORT_ACK_TIMEOUT_MS);
    const settle = (applied: boolean): void => {
      clearTimeout(timer);
      session.pendingEffortSwitches.delete(id);
      resolve(applied);
    };
    session.pendingEffortSwitches.set(id, { requested: effort, settle });
    if (!writeToDriver(session, { type: "set_effort", id, effort })) settle(false);
  });
}

function settleEffortSwitch(session: DriverSession, ack: EffortAckEvent): void {
  const pending = session.pendingEffortSwitches.get(ack.id);
  // Timed out: the caller already went the restart way.
  if (!pending) return;
  if (typeof ack.error === "string") {
    logger.warn({ audit: true, action: "sdk.effort.refused", card: session.label, effort: pending.requested, detail: ack.error }, "the live session refused the intelligence switch");
    pending.settle(false);
    return;
  }
  const appliedEffort = typeof ack.effort === "string" && registry.isValidEffort(ack.effort) ? ack.effort : null;
  // Going back to the account's level says WHICH level that is: an unpinned card's pill reads it here.
  if (pending.requested === null && appliedEffort) session.defaultEffort = appliedEffort;
  // A level other than the one asked for (a plan that caps effort) is still the switch applied: the
  // pill corrects itself from the next call's stamp. Logged for whoever investigates.
  const diverged = pending.requested !== null && appliedEffort !== null && appliedEffort !== pending.requested;
  const log = diverged ? logger.warn.bind(logger) : logger.info.bind(logger);
  log(
    { audit: true, action: "sdk.effort.applied", card: session.label, requested: pending.requested, effort: appliedEffort },
    diverged ? "the live session took the switch on another level" : "the live session confirmed the intelligence switch",
  );
  pending.settle(true);
}

/** The driver is gone: no pending switch will be answered by it. */
function dropPendingEffortSwitches(session: DriverSession): void {
  for (const { settle } of [...session.pendingEffortSwitches.values()]) settle(false);
}

/**
 * The level a session WITHOUT a pinned level uses (the account's default), as the live driver announced it on
 * boot (`effort_default`). Null with no driver or before the announcement.
 */
export function driverDefaultEffort(cardId: string): string | null {
  const session = sessions.get(cardId);
  if (!session || session.closed) return null;
  return session.defaultEffort ?? null;
}

/**
 * Best-effort goodbye on the BACK's own shutdown (SIGTERM from a deploy): end every driver's stdin
 * (EOF is the driver's exit signal, it reaches across the docker exec) and kill the local clients —
 * but KEEP the in-flight markers: they are exactly what tells the next boot which turns this
 * shutdown interrupted (see ./resume.ts). Synchronous and non-blocking — docker stop gives seconds,
 * not promises.
 */
export function shutdownAllDrivers(): void {
  for (const session of sessions.values()) {
    killDriverChild(session);
    if (session.activeTurns > 0) {
      logger.warn(
        { audit: true, action: "sdk.driver.shutdown", card: session.label, turnsInFlight: session.activeTurns },
        "sdk driver shut down with a turn in flight — marker kept for the boot resume",
      );
    }
  }
  sessions.clear();
}

// Every path that ends a card's terminal (pause, hibernate, restart, delete, model/account
// switch) goes through killCardSession — the driver dies with it.
onCardSessionKill((cardId) => stopCardDriver(cardId));

// …and the reverse rule: a card whose native chat is IN USE (a page connected, or a turn running)
// must not be hibernated — hibernating is one of those kill paths, and killing the driver under a
// live conversation is precisely how a message got written into a dead pipe and answered by
// nobody. Close the page and the driver idles out on its own; the card is hibernatable again.
onCardInUseProbe((cardId) => isCardChatInUse(cardId));

// …and the third: WHO answers for this card. The tmux probe does not see the driver (it is a child
// of the back, not of the tmux pane), so without this the session view read the card as "Claude saiu" —
// the "Claude parou" banner over a conversation that was answering.
onCardDriverProbe((cardId) => driverActivity(cardId));

// …the intelligence switched in the pill goes to the live driver, which applies it to the session without restarting (see
// `applyDriverEffort`). With no driver, whoever switches restarts the session onto it, as always.
onCardEffortApplier((cardId, effort) => applyDriverEffort(cardId, effort));

// …and the account's default level, which the driver announces on boot, reaches the pill before the first answer.
onCardDefaultEffortProbe((cardId) => driverDefaultEffort(cardId));

// …and the fourth: a live background task is work — the `Stop` of the turn that fired it must not
// put the card in "aguardando" (see services/board/status.ts).
// The same holds for a turn in flight: the `waiting` that arrives with it open is a late hook.
onCardBackgroundProbe((cardId) => driverHoldsBackgroundWork(cardId) || driverTurnRunning(cardId));
