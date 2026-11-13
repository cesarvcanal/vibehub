/**
 * NATIVE CHAT (SDK driver) — the state rules of `/api/cards/:id/sdk`, kept out of the component.
 *
 * This socket is NOT the transcript reader (`lib/chat.ts`): it is a live, structured stream from
 * the Agent SDK driver. Each connect REPLAYS the conversation so far (the back keeps a per-card
 * event log — see `back/src/services/sdk/history.ts`) and then starts a fresh driver that RESUMES
 * the same conversation by session id. The view resets its state when the socket OPENS, so the
 * reducer's job stays folding a stream of typed events into rows, not idempotent merging. The wire
 * contract lives in `back/src/services/sdk/protocol.ts`.
 */

import { normalizeMessage, parseOrigin, type MessageOrigin } from "@/features/board/lib/chat";
import type { SlashCommandInfo } from "@/features/board/lib/slashMenu";
import type { ServerText } from "@/features/board/lib/sdkOutbox";
import { hasToolDiff } from "@/features/board/lib/toolDiff";
import type { RateLimitInfo } from "@/features/board/lib/planUsage";
import { parseContextUsage, type ContextUsageInfo } from "@/features/board/lib/contextUsage";
import { t as translate, type Translate } from "@/i18n";
import { peerDisplayName } from "@/features/board/lib/peerTyping";
import type { LocalVoiceTurn } from "@/features/voice/voiceTurns";

/* ----------------------------------------------------------------- events */

/** One frame from the SDK socket — the driver's event contract, verbatim (`user` only on replay
 *  and for external sends: another card's agent, another person's message). */
/**
 * Mirror of the types in back/src/services/sdk/workflow.ts (`WorkflowActivity`, `WorkflowAgent`,
 * `WorkflowFeedItem`). The fields the back started sending later are OPTIONAL here: during a
 * blue/green deploy an old back still publishes snapshots without them.
 */
export type WorkflowActivity =
  | { kind: "tool"; tool: string; target: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; since: number };

export interface WorkflowAgentFrame {
  id: string;
  label: string;
  /** `stopped` = it was in flight when the run ended (killed, or the back gave up): it will not answer. */
  status: "running" | "done" | "stopped";
  result?: string;
  phase?: string;
  startedAt?: number;
  lastAt?: number;
  endedAt?: number;
  toolCount?: number;
  /** `toolCount` is a floor: the transcript is longer than what the back read. */
  toolCountPartial?: boolean;
  activity?: WorkflowActivity;
}

export interface WorkflowFeedItem {
  at: number;
  kind: "tool" | "text" | "thinking" | "result";
  tool?: string;
  target?: string;
  text?: string;
}

export interface SdkEvent {
  type:
    | "user"
    | "system_note"
    | "ready"
    | "session"
    | "assistant_delta"
    | "assistant_text"
    | "thinking"
    | "thinking_delta"
    | "tool_use"
    | "tool_use_start"
    | "tool_input_progress"
    | "tool_progress"
    | "tool_result"
    | "agent_task"
    | "detail"
    | "permission"
    | "permission_request"
    | "user_question"
    | "question_result"
    | "message_edited"
    | "turn_absorbed"
    | "rewound"
    | "catalog"
    | "local_output"
    | "btw_answer"
    | "compaction"
    | "background_tasks"
    | "rate_limit"
    | "context_usage"
    | "keyword_effort_replaced"
    | "conversation_reset"
    | "result"
    | "workflow_progress"
    | "workflow_feed"
    | "user_ack"
    | "user_nack"
    | "peer_typing"
    | "peer_question_draft"
    | "voice_turn"
    | "error"
    | "parse_error";
  text?: string;
  sessionId?: string;
  resume?: string;
  /** On `ready`: the back's live turn count says a turn is ALREADY running (reattach mid-turn). */
  turnActive?: boolean;
  id?: string;
  name?: string;
  tool?: string;
  input?: unknown;
  reason?: string;
  decision?: "allow" | "deny";
  sensitive?: boolean;
  timedOut?: boolean;
  isError?: boolean;
  subtype?: string;
  result?: string;
  /** On `btw_answer`: the side question that was answered, and the error when the lookup failed. */
  question?: string;
  error?: string;
  /** On `workflow_progress` (synthesised by the BACK, see back/src/services/sdk/workflow.ts): the
   *  live snapshot of a Workflow's fleet of subagents. `name` carries the script's name. */
  runId?: string;
  agents?: WorkflowAgentFrame[];
  /** On `workflow_feed` (the answer to THIS tab's request, never a broadcast): which subagent, its
   *  latest steps, and why they came back empty when they did (see components/WorkflowPanel.tsx). */
  agentId?: string;
  items?: WorkflowFeedItem[];
  /** The titles of `meta.phases` read from the script by the back, in order. */
  phases?: string[];
  /** When the run started (ms). */
  startedAt?: number;
  /** On `agent_task`: when THIS tab received the frame (its own clock), stamped on arrival. */
  receivedAt?: number;
  /** On `agent_task`: how long the subagent had been silent when the back sent the frame. */
  quietMs?: number;
  /** The count over the WHOLE log — the `agents` list has a cap, this does not. */
  total?: number;
  done?: number;
  at?: number;
  finished?: boolean;
  /** The outcome the harness recorded for the run (`workflow_progress`). Absent while it runs. */
  outcome?: WorkflowOutcome;
  message?: string;
  raw?: string;
  /** Message provenance on `user` events — who sent it (see lib/chat.ts `MessageOrigin`). */
  from?: MessageOrigin;
  /** On `voice_turn`: the spoken turn's id (idempotency key) and who spoke — the person or the voice. */
  vid?: string;
  role?: string;
  /** "terminal" = the event was MIRRORED from the card's TUI transcript, not spoken by the driver. */
  source?: string;
  /** On `conversation_reset`: what reset the conversation ("clear" for a `/clear`). */
  trigger?: string;
  /** On `background_tasks`: the WHOLE live set (replace, never merge) — see `backgroundTasks`. */
  tasks?: BackgroundTask[];
  /** On `rate_limit`: the plan limit reading of ONE window (see `rateLimits`). */
  status?: string;
  window?: string;
  utilization?: number;
  resetsAt?: number;
  /** On `compaction` (the /compact, or the automatic one): the phase, and at the end how much the
   *  conversation took up before and after. Also reads `trigger` ("manual"/"auto"), `durationMs` and
   *  `startedAt` (set by the back on `started`, so whoever connects midway counts the right time). */
  phase?: "started" | "done" | "failed";
  preTokens?: number;
  postTokens?: number;
  /** On `context_usage`: how full the session's context window is (see `contextUsage`). */
  usedTokens?: number;
  maxTokens?: number;
  percent?: number;
  model?: string;
  /** On `catalog`: every skill/command this session can run — what the composer's "/" offers. */
  commands?: SlashCommandInfo[];
  /** On `user_question`: the questions with their selectable options. */
  questions?: SdkQuestion[];
  /** On `question_result`: what the person picked (absent when it timed out / was cancelled). */
  answers?: SdkQuestionAnswer[];
  /**
   * On `question_result`: the person answered BY MESSAGE instead of clicking an option. That is not
   * the same as "no answer" — they answered, just not through the card —, and the row has to say so.
   */
  superseded?: boolean;
  /**
   * On `question_result`: the question dropped because someone STOPPED the turn (the stop button,
   * "enviar agora", an edit) — who (`cancelledBy`) and how (`cancelledHow`). Without this it looked
   * like it had timed out.
   */
  cancelledBy?: string;
  cancelledHow?: QuestionCancel["how"];
  /**
   * On `message_edited`: the superseded message's text — the row it greys out. On `rewound`: the
   * text of the message the rewind cut back to, so the cut starts at THAT row.
   */
  originalText?: string;
  /**
   * On `message_edited` / `rewound`: the edit was of the conversation's FIRST message, so the row
   * is the FIRST with those words, not the newest — a message re-sent after an error has the same
   * words (production, 2026-10-19).
   */
  first?: boolean;
  /**
   * On `rewound`: the edit REWOUND the conversation (the model no longer has the original, the
   * half answer, or the tools between them) and the screen has to drop those rows too. `false`
   * means the driver fell back to a supersede and everything on screen still stands.
   */
  ok?: boolean;
  /**
   * On `user_ack`/`user_nack`: the RECEIPT id of the send being answered (see lib/sdkOutbox.ts).
   * `user_ack` = the back has the message on disk; `user_nack` = the history does NOT have it, so
   * an F5 would lose it: either the back refused it outright (`reason: "driver-gone"`) or the driver
   * took it but the history write failed (`"history-write-failed"`). Either way only this browser
   * holds a durable copy — and while that driver is up, a resend with the same `cid` is never a
   * second turn (the back recognises the receipt and only retries the write, answering with its
   * `user_ack`).
   */
  cid?: string;
  /**
   * On `tool_use`/`assistant_text`: said by a SUBAGENT (Agent/Task), not by the main agent — the id
   * of the tool call that started it. Becomes the row's `parent` (see back protocol `ToolUseEvent`).
   */
  parentToolUseId?: string;
  /** On `tool_input_progress`: bytes of the tool's input generated so far (JSON, throttled). */
  bytes?: number;
  /** On `tool_input_progress`: the file the input names, as soon as its path closed in the JSON. */
  filePath?: string;
  /** On `tool_progress`: how long the tool has been running. */
  elapsedSeconds?: number;
  /** On `tool_result`: the SUMMARY of what the tool returned (the back summarises; see ToolResultSummary). */
  toolResult?: ToolResultSummary;
  /** On `agent_task` (and in the tasks of `background_tasks`): the call that started the subagent. */
  toolUseId?: string;
  /** On `agent_task`: the subagent's numbers and sentence (see `AgentTask`). */
  taskId?: string;
  subagentType?: string;
  taskType?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  lastTool?: string;
  summary?: string;
  description?: string;
  /**
   * On `peer_typing` (relayed by the BACK from the card's other sockets, never persisted): whether
   * the person in `name` is typing. Handled by the view (see lib/peerTyping.ts), not the reducer.
   */
  active?: boolean;
  /**
   * On `peer_question_draft` (relayed like `peer_typing`): what `name` has marked (`picked`) and
   * typed (`other`) so far on the open question card `id`. Handled by the view (see
   * lib/peerQuestionDraft.ts), not the reducer.
   */
  picked?: unknown;
  other?: unknown;
  /** On `peer_question_draft`: the person left the card (closed tab, or before a deploy) — the draft still counts. */
  away?: unknown;
}

/** One live background task (mirror of `BackgroundTaskInfo` in the back's protocol). `toolUseId` =
 *  the call that started it: that is how the tray opens the subagent (or the action). */
export interface BackgroundTask { id: string; type: string; description: string; toolUseId?: string }

/**
 * The SUMMARY of what a tool returned — mirror of the back's `ToolResultSummary`
 * (back/src/services/sdk/toolResult.ts). Numbers, not sentences: the screen translates (`toolResultLine`).
 */
export interface ToolResultSummary {
  isError?: boolean;
  error?: string;
  lines?: number;
  startLine?: number;
  totalLines?: number;
  files?: number;
  matches?: number;
  added?: number;
  removed?: number;
  created?: boolean;
  empty?: boolean;
  interrupted?: boolean;
  background?: boolean;
  agent?: { toolUses?: number; durationMs?: number; tokens?: number };
}

/** The state of ONE subagent/task (mirror of the back's `AgentTaskEvent`), keyed by the call that started it. */
export interface AgentTask {
  toolUseId: string;
  taskId: string;
  status: "running" | "completed" | "failed" | "stopped";
  description?: string;
  subagentType?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  lastTool?: string;
  /** Running: what it is doing now. Finished: the final summary. */
  summary?: string;
  startedAt?: number;
  /** When THIS tab received this state, on its own clock — where the running time counts from. */
  receivedAt?: number;
  /** How long the subagent had been silent when the back sent this state. */
  quietMs?: number;
}

/** One question of a `user_question` (mirror of `UserQuestionItem` in the back's protocol). */
export interface SdkQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** One question's answer — the chosen labels (free text is one more string). */
export interface SdkQuestionAnswer { selected: string[] }

/** Parse one socket frame. Null for anything that is not a JSON object with a type. PURE. */
export function parseSdkFrame(raw: string): SdkEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const e = obj as Partial<SdkEvent>;
  if (typeof e.type !== "string") return null;
  return { ...e, from: parseOrigin(e.from) } as SdkEvent;
}

/** A streamed token: the events the view may hold until the next animation frame. PURE. */
export function isSdkDelta(event: SdkEvent): boolean {
  return event.type === "assistant_delta" || event.type === "thinking_delta";
}

/** Only `type` and `text` set — a delta carrying anything else is applied on its own. */
function isPlainDelta(event: SdkEvent): boolean {
  return isSdkDelta(event) && Object.entries(event).every(([key, value]) => key === "type" || key === "text" || value === undefined);
}

/**
 * Merge CONSECUTIVE plain deltas of the same type into one event, keeping every other event in its
 * place. Applying the result gives the same rows as applying the input one by one — it only changes
 * how many reducer passes (and renders) the frame costs. PURE.
 */
export function coalesceDeltas(events: readonly SdkEvent[]): SdkEvent[] {
  const out: SdkEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && prev.type === event.type && isPlainDelta(prev) && isPlainDelta(event)) {
      out[out.length - 1] = { type: event.type, text: (prev.text ?? "") + (event.text ?? "") };
      continue;
    }
    out.push(event);
  }
  return out;
}

/* ------------------------------------------------------------------- rows */

/** What one permission card is showing: still waiting, or how it ended. */
export type PermissionOutcome = "pending" | "allowed" | "denied" | "timeout";

/**
 * What one question card is showing: still waiting, answered, given up (timeout/cancel) — or
 * SUPERSEDED: the person did not click any option, wrote in the chat, and what they wrote became
 * the answer. "unanswered" would be a lie in that case: they answered, just not through the card.
 */
export type QuestionOutcome = "pending" | "answered" | "unanswered" | "superseded" | "cancelled";

/** Who stopped the turn and took the question down with it (the back stamps it on `question_result`). */
export interface QuestionCancel {
  by?: string;
  how?: "stop" | "send_now" | "edit";
}

export type SdkRow =
  /** A message the person sent. `sent` = it reached the driver's stdin (the socket was open).
   *  `from` = provenance on replayed/external messages: another card's agent, another person.
   *  `edited` = a later version SUPERSEDED this one. Kept in the state (a rewind cuts from it), but
   *  NOT drawn: an edit reads as the bubble changing, not as a second bubble under a greyed one.
   *  `revision` = this row IS the new version of an edited message (it carries the "editada" badge).
   *  `absorbed` = it arrived mid-turn and the driver folded it into the RUNNING turn (streaming
   *  input). Bookkeeping only — the bubble is NOT labelled: whoever is in the conversation sees the
   *  message enter the running turn on their own screen, and the label only repeated that in writing. */
  /** `state`: "sending" = no receipt yet (the socket took the frame, the back has not confirmed);
   *  "sent" = the back saved it (a `user_ack`, or a replay — the only proofs an F5 respects);
   *  "undelivered" = the back refused it (`user_nack`) or the receipt never came, so this browser
   *  holds the only copy and the bubble offers reenviar/descartar. `cid` pairs it with the outbox. */
  | {
      kind: "user";
      id: string;
      text: string;
      state: "sending" | "sent" | "undelivered";
      cid?: string;
      from?: MessageOrigin;
      edited?: boolean;
      revision?: boolean;
      absorbed?: boolean;
      /** When the SERVER recorded it (the replay's / an external frame's `at`). Absent on one's own
       *  live sends — the receipt carries no time. The outbox anchors on it: see `sendMark`. */
      at?: number;
    }
  /** Claude talking. `streaming` while deltas are still landing on it. `parent` = said by the
   *  SUBAGENT started by that tool call (never streaming: subagent deltas are not relayed). */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; parent?: string }
  /**
   * The model's REASONING, while it thinks. Same streaming mechanics as the assistant row
   * (`streaming` while the deltas land), but drawn in the background: it is waiting context, not
   * the answer. It exists because a long turn showed only "Trabalhando…" and whoever was waiting had
   * no idea what was going on. Lives in the session: it is not saved to the history nor replayed.
   */
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  /** One tool call, compact: the name plus a one-line summary of its input. `parent` = made by the
   *  SUBAGENT started by that tool call (drawn under its card, not as the main agent's step).
   *  `pending` = PROVISIONAL: the model opened the call (`tool_use_start`) and is still writing its
   *  input — `inputBytes`/`filePath` say how far it got; the complete `tool_use` replaces the row in
   *  place. `elapsedSeconds` = how long the tool has been running (`tool_progress`). */
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      input?: unknown;
      parent?: string;
      pending?: boolean;
      inputBytes?: number;
      filePath?: string;
      elapsedSeconds?: number;
      /** What the tool RETURNED (summary): it is what says whether it worked — absent while it runs. */
      result?: ToolResultSummary;
      /** Born live (not from the replay): with no result, it IS running — from the replay, there is no telling. */
      live?: boolean;
    }
  /** The "Permitir / Negar" card — a sensitive call waiting on the human (or how it ended). */
  | { kind: "permission"; id: string; tool: string; summary: string; reason?: string; outcome: PermissionOutcome }
  /** The agent's question with clickable options — waiting on the human, or how it was answered. */
  | { kind: "question"; id: string; questions: SdkQuestion[]; outcome: QuestionOutcome; answers?: SdkQuestionAnswer[]; cancel?: QuestionCancel }
  /** Something went wrong and saying so beats swallowing it. `count` > 1 = the SAME error again
      (a reconnect loop against a refused socket) — one banner that counts, not a stack of copies. */
  | { kind: "error"; id: string; text: string; count?: number }
  /** A quiet note (resumed session, turn ended with an error result…). */
  | { kind: "note"; id: string; text: string }
  /**
   * The answer to a LOCAL slash command (`/cost`, `/usage`): the CLI produced it itself, with no
   * model turn. Drawn as its own row rather than as assistant text — nobody said it, the session
   * reported it — and, like the terminal notes, it lives in the session only.
   */
  | { kind: "command_output"; id: string; text: string }
  /**
   * One SPOKEN turn of a voice call held in this chat — what the person said, or what the voice
   * assistant answered (a different model from the card's agent: it talks, it does not act). Saved
   * on the server and replayed like the typed messages; `vid` is its id there, the dedupe key.
   * The view also draws the call's turns that are still being spoken or saved (see
   * `mergeLiveVoiceTurns`): `live` = still being spoken, `save` = this tab's save state.
   */
  | {
      kind: "voice";
      id: string;
      vid: string;
      role: "user" | "assistant";
      text: string;
      at?: number;
      from?: MessageOrigin;
      live?: boolean;
      save?: "saving" | "saved" | "failed";
    }
  /**
   * The answer to a `/btw`: the SIDE question asked with the turn running, answered separately (the
   * main agent never read it). Its own row, never a Claude bubble — it is not the turn speaking.
   */
  | {
      kind: "btw";
      id: string;
      /** The question's id (the one from the `btw` frame), which matches the answer to this row. */
      btwId: string;
      question: string;
      /** When THIS tab asked (ms) — the deadline's clock. Absent on another tab's/replay's row. */
      askedAt?: number;
      /** No `text` nor `error`: still answering. */
      text?: string;
      error?: string;
    }
  /**
   * The conversation's COMPACTION (the /compact, or the automatic one when the window fills up): the
   * bar running while the CLI summarises, and then the divider "antes disto, só o resumo" with the
   * tokens before/after. Without it the chat sat still for a minute and looked frozen.
   */
  | {
      kind: "compaction";
      id: string;
      status: "running" | "done" | "failed";
      /** When it started (ms) — the bar's clock. Absent on replay (the log only keeps the outcome). */
      startedAt?: number;
      trigger?: "manual" | "auto";
      preTokens?: number;
      postTokens?: number;
      durationMs?: number;
      error?: string;
    }
  /**
   * A WORKFLOW'S FLEET, live — the row that was missing.
   *
   * The `Workflow` tool returns at once and works in the background: the turn ended, the chat went
   * silent for minutes and whoever was on the other side read that as "it's done" (production,
   * 2026-10-02). This row is the snapshot the back reads from the run's log: how many subagents
   * have already answered, which are still running, what each one returned. `phases` is the plan
   * declared in the script (`meta.phases`), which arrives through the tool call. Lives only in the
   * session — like the reasoning, it is not saved conversation; whoever reopens the tab gets the
   * back's latest snapshot.
   */
  | {
      kind: "workflow";
      id: string;
      runId: string;
      name: string;
      description?: string;
      phases?: Array<{ title: string; detail?: string }>;
      /** When the run started (ms), according to the back. Absent on an old back. */
      startedAt?: number;
      agents: WorkflowAgentFrame[];
      /** How many subagents the run has and how many have already answered, counted over the whole log. */
      total: number;
      done: number;
      at: number;
      finished: boolean;
      outcome?: WorkflowOutcome;
    };

export type WorkflowOutcome = "completed" | "killed" | "failed";
const WORKFLOW_OUTCOMES: ReadonlySet<unknown> = new Set<WorkflowOutcome>(["completed", "killed", "failed"]);

export interface SdkChatState {
  rows: SdkRow[];
  /** The conversation's resume key, as soon as the driver reports it. */
  sessionId?: string;
  /** The driver said `ready` — messages can go. */
  ready: boolean;
  /** A DRIVER turn is running (something arrived since the last `result`). Replayed history and
   *  terminal-mirrored events never set it: the spinner only claims work the driver is doing. */
  turnActive: boolean;
  /** The conversation's tail is coming from the TERMINAL mirror (one "atividade no terminal" note
   *  is drawn when a burst starts; the flag keeps the burst from noting every line). */
  terminalBurst: boolean;
  /**
   * A message of OUR OWN went out and the driver has not reacted yet — the window the status
   * ladder fills: "Preparando…" while `ready` is still false (cold driver booting/resuming),
   * "Pensando…" once it is (the turn is in the engine, no token yet). Any event of the MAIN agent —
   * a delta, a tool, the result — clears it and the plain "Trabalhando…"/nothing takes over; a
   * subagent's events do not (the main has not reacted to OUR message yet). Set only by
   * the view's own send (`appendUserRow` with `awaiting`), never by replay or external messages:
   * the ladder narrates OUR send, not someone else's.
   */
  awaiting: boolean;
  /**
   * Every skill and command this card's session can run, as the driver reported it — the "/" menu
   * of the composer. Empty until the catalogue lands (a driver still booting, or an older runner
   * that does not report one): the field then behaves exactly as it did before, and a "/" typed by
   * hand still reaches the CLI.
   */
  commands: SlashCommandInfo[];
  /**
   * THIS view asked the driver to stop (the composer's button, or stepping into editing a message
   * mid-turn) and the aborted turn has not reported back yet.
   *
   * Why the state has to remember it: the SDK closes an interrupted turn with a `result` carrying
   * `is_error` and NO text, which the chat used to draw as a red bubble reading literally "error"
   * (the production screenshot: the answer cut mid-sentence, and a mute red "error" under it). A
   * stop the person ASKED for is not a failure — the back's note already narrates the cut — so
   * that result draws nothing at all. Cleared by the first `result` (or by `ready`, which means a
   * fresh driver: whatever we interrupted is long gone).
   */
  interruptRequested: boolean;
  /**
   * A `message_edited` was folded and its new version has not arrived yet: the NEXT user row is that
   * version and gets the "editada" badge (replay and another socket's edit both send the marker
   * first, then the message).
   */
  revisionPending?: boolean;
  /**
   * The PLAN of each workflow this session started, by `meta.name` — the description and the phases
   * declared in the script. It comes from the tool CALL (the whole script is in the `input`), and the
   * progress comes from the back minutes later, by name: the two sides meet here. Kept in the state,
   * and not on the row, because the call happens before any progress row exists.
   */
  workflowMeta: Record<string, { description?: string; phases?: Array<{ title: string; detail?: string }> }>;
  /**
   * THE BACKGROUND TASKS alive in the CLI (a Bash with `run_in_background`, a subagent, a
   * monitor). The turn that starts them closes at once — the "Trabalhando…" goes out on `result` — and
   * they keep going for minutes: without this the chat went silent and it looked like Claude had
   * stopped (production, 2026-10-07). It is not a conversation row: it is state, shown in a strip
   * above the input while something is alive — the "1 background task" of Claude Code's footer.
   */
  backgroundTasks: BackgroundTask[];
  /**
   * THE STATE OF EACH SUBAGENT keyed by the call that started it (`agent_task`): status, counters and
   * the sentence of what it is doing now. It is what the fleet and the tray draw.
   */
  agentTasks: Record<string, AgentTask>;
  /**
   * THE PLAN LIMIT WARNING per window (`five_hour`, `seven_day`, …), the latest one the CLI emitted —
   * the "You've used 91% of your session limit" of the terminal's footer. State, not conversation: it
   * becomes the colored strip next to the "está digitando" (see lib/planUsage.ts).
   */
  rateLimits: Record<string, RateLimitInfo>;
  /**
   * HOW MUCH OF THE CONTEXT WINDOW the conversation takes up, the latest reading (the `/context`).
   * State, not conversation: it becomes the colored meter in the bottom right corner of the log (see
   * lib/contextUsage.ts).
   */
  contextUsage: ContextUsageInfo | null;
  /** Monotonic counter for rows the driver did not name. */
  seq: number;
}

export const INITIAL_SDK_STATE: SdkChatState = {
  rows: [],
  workflowMeta: {},
  backgroundTasks: [],
  agentTasks: {},
  rateLimits: {},
  contextUsage: null,
  ready: false,
  turnActive: false,
  terminalBurst: false,
  awaiting: false,
  commands: [],
  interruptRequested: false,
  seq: 0,
};

/** The note row a terminal burst opens with (the view translates it). */
export const TERMINAL_ACTIVITY_NOTE = "terminal-activity";

/** Notes the BACK writes when a turn is cut short — codes, translated by the view. Must match
 *  `back/src/services/sdk/protocol.ts` (`NOTE_TURN_INTERRUPTED*`). */
export const TURN_INTERRUPTED_NOTE = "turn-interrupted";
export const TURN_INTERRUPTED_EDIT_NOTE = "turn-interrupted-edit";
/** The note the back leaves where a `/clear` wiped the conversation. Must match the back's
 *  `NOTE_CONVERSATION_CLEARED` (back/src/services/sdk/protocol.ts). */
export const CONVERSATION_CLEARED_NOTE = "conversation-cleared";

/**
 * Sentinels the reducer puts on an error row when the wire carried NO words of its own. The view
 * turns them into a sentence in the reader's language (see `errorText` below) — the fix
 * for the mute "error" bubble: every error in this chat says what happened and what to do.
 */
export const SDK_ERROR_TURN_FAILED = "sdk-error:turn-failed";
export const SDK_ERROR_NO_DETAIL = "sdk-error:no-detail";

/** Why the question ended unanswered, with the name of who stopped the turn. PURE. */
export function cancelledText(cancel: QuestionCancel | undefined, t: Translate): string {
  const how = cancel?.how ?? "stop";
  if (!cancel?.by) return t(`sdk.questionCancelled.${how}.anon`);
  return t(`sdk.questionCancelled.${how}`, { name: peerDisplayName(cancel.by) });
}

/**
 * A note row's words. Some notes travel as CODES (the back writes them, the reader may be reading
 * in either language); anything else is already a sentence and passes through. PURE.
 */
export function noteText(text: string, t: Translate): string {
  if (text === TERMINAL_ACTIVITY_NOTE) return t("sdk.terminalActivity");
  if (text === TURN_INTERRUPTED_EDIT_NOTE) return t("sdk.noteInterruptedEdit");
  if (text === TURN_INTERRUPTED_NOTE) return t("sdk.noteInterrupted");
  if (text === CONVERSATION_CLEARED_NOTE) return t("sdk.noteConversationCleared");
  return text;
}

/**
 * WHAT WENT WRONG, IN WORDS. This chat once showed a red bubble reading literally "error" — the
 * turn's failure had no text of its own and the raw value was drawn as-is. Nothing reaches the
 * reader as jargon or as an empty word any more: the known refusals and the reducer's sentinels
 * (above) become a sentence that says what happened AND what to do. Anything already
 * written as a sentence by the driver passes through untouched. PURE.
 */
export function errorText(text: string, t: Translate): string {
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

/** Mark that WE asked for the stop (see `interruptRequested`). PURE. */
export function markInterruptRequested(state: SdkChatState): SdkChatState {
  return state.interruptRequested ? state : { ...state, interruptRequested: true };
}

/**
 * Marks which side of the card is talking. A terminal-mirrored event OPENS a burst: one system
 * note ("atividade no terminal") so the reader knows the conversation moved to the Terminal tab;
 * a driver event closes it. PURE.
 */
function markSource(state: SdkChatState, viaTerminal: boolean): SdkChatState {
  if (!viaTerminal) return state.terminalBurst ? { ...state, terminalBurst: false } : state;
  if (state.terminalBurst) return state;
  const { id, seq } = nextId(state, "note");
  return {
    ...state,
    seq,
    terminalBurst: true,
    rows: [...settleStreaming(state.rows), { kind: "note", id, text: TERMINAL_ACTIVITY_NOTE }],
  };
}

/**
 * Whether an event may light the "Trabalhando…" spinner: only a LIVE driver event (after `ready`).
 * Replay arrives before `ready` and carries no turn ends, so it used to leave the spinner ON with
 * nothing running — the "Trabalhando… pendurado" of the production incident. Terminal-mirrored
 * events are the terminal's work, told by the burst note instead. PURE.
 */
function nextTurnActive(state: SdkChatState, viaTerminal: boolean): boolean {
  return state.turnActive || (state.ready && !viaTerminal);
}

/** How much of a tool input is worth one compact line. */
const SUMMARY_MAX = 120;

/** One line that says what a tool call is about: the command, the file, the pattern… PURE. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = [o.command, o.file_path, o.pattern, o.url, o.description, o.prompt].find(
    (v) => typeof v === "string" && v.trim() !== "",
  ) as string | undefined;
  if (!pick) return "";
  const flat = normalizeMessage(pick);
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/**
 * THE HEADLINE OF A TOOL CALL — what the CLI shows in the terminal, ported to the chat.
 *
 * In the TUI a tool call reads as two lines: WHAT it is doing ("Measuring PDV module size",
 * `Read(registry.ts)`, `Skill(code-review)`) and, indented under it, the detail — the command it
 * ran, the path it opened, or "running in the background" for work that was handed to an agent.
 * The chat used to show `Bash` plus a truncated blob of the input, which is the same information
 * with the meaning taken out: the name of the tool is the least interesting part of the line.
 *
 * `background` is the third thing the TUI says and the chat could not: a Skill or a Task does not
 * finish on this line — it goes off and keeps running while the turn continues, which is exactly
 * when someone stares at the screen wondering whether anything is happening.
 *
 * PURE and i18n-free: it returns the title, the detail and the flag; the view translates the
 * background line.
 */
export interface ToolHeadline {
  /** The line that says what is going on. Never empty. */
  title: string;
  /** The indented second line: the command, the full path, the query. Absent = nothing to add. */
  detail?: string;
  /** The call was handed to an agent and keeps running (Skill, Task, Workflow). */
  background?: boolean;
}

/** Trimmed string field, or "". PURE. */
function field(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v.trim() : "";
}

/** One line, collapsed and capped. PURE. */
function line(value: string, max = SUMMARY_MAX): string {
  const flat = normalizeMessage(value);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The last path segment — what names a file in a headline. PURE. */
function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** What a workflow's script DECLARES about itself: the `meta` block at the top. */
export interface WorkflowScriptMeta {
  name: string;
  description?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

/**
 * A JS string literal, single or double quotes, with escapes — TWO capture groups. Backticks are
 * left out on purpose: the `meta` is, by the harness's contract, a pure literal (no interpolation).
 */
const LITERAL = "(?:'((?:[^'\\\\]|\\\\.)*)'|\"((?:[^\"\\\\]|\\\\.)*)\")";

/** The content of whichever of the two groups matched, with the most common escapes undone. PURE. */
function literal(match: RegExpMatchArray | null | undefined, first: number): string | undefined {
  if (!match) return undefined;
  const raw = match[first] ?? match[first + 1];
  if (raw === undefined) return undefined;
  return raw.replace(/\\(['"\\])/g, "$1").replace(/\\n/g, " ").trim();
}

/**
 * Reads the `meta` of the workflow's script — the PLAN the model declared when it started the fleet:
 * name, description and phases. The script arrives whole in the tool call's `input`, and the `meta`
 * is, by the harness's contract, a pure literal at its top: nothing is evaluated here, only read.
 *
 * Tolerant by design: a script without `meta` (or with a `meta` this reading does not understand)
 * returns what could be understood and the screen draws the rest — a panel without the phases is
 * still infinitely better than the mute screen that existed before it. PURE.
 */
export function parseWorkflowScriptMeta(script: unknown): WorkflowScriptMeta | null {
  const text = typeof script === "string" ? script.slice(0, 20_000) : "";
  const start = text.indexOf("export const meta");
  if (start < 0) return null;
  const block = text.slice(start, start + 8_000);
  const name = literal(block.match(new RegExp("\\bname:\\s*" + LITERAL)), 1);
  if (!name) return null;
  const description = literal(block.match(new RegExp("\\bdescription:\\s*" + LITERAL)), 1);
  const phases: Array<{ title: string; detail?: string }> = [];
  const phasesAt = block.indexOf("phases:");
  if (phasesAt >= 0) {
    const closes = block.indexOf("]", phasesAt);
    const list = block.slice(phasesAt, closes < 0 ? undefined : closes + 1);
    const entry = new RegExp("\\btitle:\\s*" + LITERAL + "(?:\\s*,\\s*detail:\\s*" + LITERAL + ")?", "g");
    for (const match of list.matchAll(entry)) {
      const title = literal(match, 1);
      if (!title) continue;
      const detail = literal(match, 3);
      phases.push({ title, ...(detail ? { detail } : {}) });
    }
  }
  return { name, ...(description ? { description } : {}), ...(phases.length ? { phases } : {}) };
}

/**
 * A run's phases: those of the back's SNAPSHOT (read from the script on the runner — the only source
 * when the tab opened after the launch) rule the order, with the detail from the call's plan when the
 * title matches. An old back does not send `phases`: the call's plan applies, as before. PURE.
 */
function workflowPhases(
  fromBack: unknown,
  fromCall: Array<{ title: string; detail?: string }> | undefined,
): Array<{ title: string; detail?: string }> {
  const titles = Array.isArray(fromBack) ? fromBack.filter((t): t is string => typeof t === "string" && t !== "") : [];
  if (titles.length === 0) return fromCall ?? [];
  return titles.map((title) => {
    const detail = fromCall?.find((p) => p.title === title)?.detail;
    return detail ? { title, detail } : { title };
  });
}

/**
 * What a subagent returned, readable. Nearly every workflow `agent()` comes back with a `schema`, so
 * the log keeps an OBJECT — and raw on screen that is a line of JSON cut in the middle. It becomes
 * `key: value`, one per line, which is how a person would read it. Plain text passes intact, and a
 * JSON this reading does not understand comes back exactly as it came: better raw than hidden. PURE.
 */
export function formatAgentResult(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // cut at 400 characters by the probe, for example
  }
  const one = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(one).filter(Boolean).join(" · ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  if (Array.isArray(parsed)) return parsed.map(one).filter(Boolean).join("\n");
  if (!parsed || typeof parsed !== "object") return text;
  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${one(value)}`)
    .join("\n");
}

/** One item of a `TodoWrite` call — the agent's own task list. */
export interface SdkTodo {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

/** The `todos` of a TodoWrite input, normalised; null when it is not a list. PURE. */
export function parseTodos(raw: unknown): SdkTodo[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      content: typeof item.content === "string" ? item.content.trim() : "",
      activeForm: typeof item.activeForm === "string" ? item.activeForm.trim() : "",
      status: item.status === "completed" || item.status === "in_progress" ? item.status : "pending",
    }));
}

export function toolHeadline(name: string, input: unknown): ToolHeadline {
  const tool = String(name ?? "").trim() || "?";
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const file = field(o, "file_path") || field(o, "path") || field(o, "notebook_path");
  switch (tool) {
    case "Bash":
    case "BashOutput":
      // The description is the agent's OWN headline for the command ("Measuring PDV module size")
      // — the best line on the screen, and the one the chat was throwing away.
      return {
        title: field(o, "description") || tool,
        ...(field(o, "command") ? { detail: line(`$ ${field(o, "command")}`) } : {}),
      };
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        title: file ? `${tool}(${basename(file)})` : tool,
        ...(file && basename(file) !== file ? { detail: line(file) } : {}),
      };
    case "Glob":
    case "Grep": {
      const pattern = field(o, "pattern");
      return {
        title: pattern ? `${tool}(${line(pattern, 60)})` : tool,
        ...(file ? { detail: line(file) } : {}),
      };
    }
    case "WebFetch": {
      const url = field(o, "url");
      let host = url;
      try {
        host = new URL(url).host || url;
      } catch {
        /* not a URL we can parse: the raw value is the best label there is */
      }
      return { title: url ? `Fetch(${host})` : tool, ...(url ? { detail: line(url) } : {}) };
    }
    case "WebSearch": {
      const query = field(o, "query");
      return { title: query ? `Search(${line(query, 60)})` : tool };
    }
    case "TodoWrite": {
      const todos = parseTodos(o.todos);
      if (!todos) return { title: tool };
      const done = todos.filter((todo) => todo.status === "completed").length;
      const current = todos.find((todo) => todo.status === "in_progress");
      const doing = current ? current.activeForm || current.content : "";
      return {
        title: translate("sdk.todosTitle", { done, total: todos.length }),
        ...(doing ? { detail: line(doing) } : {}),
      };
    }
    // `Agent` is the current name of the subagent tool in Claude Code; `Task`, the old one.
    case "Task":
    case "Agent": {
      const agent = field(o, "subagent_type");
      const what = field(o, "description") || agent;
      return {
        title: what ? `${tool}(${line(what, 60)})` : tool,
        ...(agent && agent !== what ? { detail: line(agent) } : {}),
        background: true,
      };
    }
    case "Skill": {
      const skill = field(o, "skill") || field(o, "name") || field(o, "command");
      return {
        title: skill ? `Skill(${line(skill, 60)})` : tool,
        ...(field(o, "args") ? { detail: line(field(o, "args")) } : {}),
        background: true,
      };
    }
    case "Workflow": {
      // The real input is `{script}`: name and description live in the script's `meta`.
      const meta = parseWorkflowScriptMeta(o.script);
      const what = meta?.name || field(o, "name") || field(o, "title") || field(o, "description");
      const about = meta?.description
        ?? (meta?.phases?.length ? translate("sdk.workflowPhases", { n: meta.phases.length }) : "");
      return {
        title: what ? `Workflow(${line(what, 60)})` : tool,
        ...(about ? { detail: line(about) } : {}),
        background: true,
      };
    }
    default: {
      const summary = toolSummary(input);
      return { title: tool, ...(summary ? { detail: summary } : {}) };
    }
  }
}

/**
 * Elapsed time the way the CLI writes it: `4s`, `1m 24s`. Not the composer's recording clock
 * (`0:42`, TerminalComposer) — a different dial, hence a different name. PURE.
 */
export function formatTurnElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The tools whose input IS a file being written: the provisional row names the file. */
const WRITING_TOOLS = new Set(["Write"]);
const EDITING_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

/**
 * WHAT THE TOOL IS DOING NOW, while there is something live to say — or null.
 *
 * Two windows have something live to say: the model WRITING a tool's input (a 400-line Write is
 * tens of seconds of tokens before the `tool_use` exists) and a tool RUNNING for a long time. In the
 * first the row is provisional (`pending`) and this says which file and how much of it: "Escrevendo
 * sdkChat.ts… 12 KB". In the second it says what runs and for how long: "Rodando: npm test… 42s".
 * A settled row with no clock has nothing live to say. PURE.
 */
export function toolLiveLabel(row: SdkRow): string | null {
  if (row.kind !== "tool") return null;
  if (row.pending) {
    const file = row.filePath ? basename(row.filePath) : translate("sdk.toolLive.aFile");
    const label = WRITING_TOOLS.has(row.name)
      ? translate("sdk.toolLive.writing", { file })
      : EDITING_TOOLS.has(row.name)
        ? translate("sdk.toolLive.editing", { file })
        : translate("sdk.toolLive.preparing", { tool: row.name });
    const bytes = row.inputBytes ?? 0;
    return bytes > 0 ? `${label} ${translate("sdk.toolLive.kb", { n: Math.max(1, Math.round(bytes / 1024)) })}` : label;
  }
  if (typeof row.elapsedSeconds !== "number") return null;
  const o = (row.input && typeof row.input === "object" ? row.input : {}) as Record<string, unknown>;
  const what = row.name === "Bash"
    ? field(o, "description") || line(field(o, "command"), 60) || row.name
    : toolHeadline(row.name, row.input).title;
  return `${translate("sdk.toolLive.running", { what })} ${formatTurnElapsed(row.elapsedSeconds)}`;
}

/**
 * WHAT THE TURN IS DOING RIGHT NOW — the line the sticky bar shows while work runs.
 *
 * Read backwards from the end of the conversation and stop at the message that started the turn:
 * the newest tool call, the reasoning stream, or the answer already being written. Anything older
 * than the last user message belongs to a turn that is over and is never reported as live. Returns
 * null when there is nothing to name (the turn just started), and the caller falls back to the
 * plain "Trabalhando…". PURE.
 */
export interface SdkActivity {
  kind: "tool" | "thinking" | "answering";
  /** Already human: a tool headline, or empty for thinking/answering (the view names those). */
  label: string;
  /** The row to jump to when the bar is clicked. */
  rowId: string;
  /** The activity is an agent/skill running in the background. */
  background?: boolean;
}

export function currentActivity(state: SdkChatState): SdkActivity | null {
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i] as SdkRow;
    // A message ABSORBED into the running turn did not open it: the work before it is still the
    // turn's, and stopping here hid a 9-minute test run behind the canned "ainda trabalhando".
    if (row.kind === "user" && row.absorbed === true) continue;
    if (row.kind === "user") return null; // the turn's own message: nothing after it to report
    const subagent = subagentActivity(state.rows, row);
    if (subagent !== null) return { kind: "tool", label: subagent, rowId: row.id };
    if (row.kind === "tool") {
      const headline = toolHeadline(row.name, row.input);
      return {
        kind: "tool",
        label: toolLiveLabel(row) ?? headline.title,
        rowId: row.id,
        ...(headline.background ? { background: true } : {}),
      };
    }
    // A stream still open IS the activity; one that has settled is the turn's OUTPUT, and anything
    // older than it is older still — so the walk stops there and the bar falls back to
    // "Trabalhando…" rather than naming a thought that is already finished.
    if (row.kind === "thinking") return row.streaming ? { kind: "thinking", label: "", rowId: row.id } : null;
    if (row.kind === "assistant") return row.streaming ? { kind: "answering", label: "", rowId: row.id } : null;
  }
  return null;
}

/**
 * The question of a `/btw` — or null when the message is not one. The command is the WHOLE message
 * starting with it, as in the terminal; `/btw` with no question goes on as a regular message. Only the
 * composer asks this: from there on the /btw is a frame and a row of its own. PURE.
 */
export function btwQuestion(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim());
  const question = match?.[1]?.trim();
  return question ? question : null;
}

/**
 * THE FINISHED ANSWERS — the ones that get "copiar" and "ouvir" underneath, like in ChatGPT.
 *
 * One per round: the main agent's last utterance (subagents do not count) before the person's next
 * message. Earlier rounds are already over; the last one only counts when `settled` — nothing
 * running, neither a turn nor a background task. While the AI works, the answer may still change. PURE.
 */
export function finishedAnswerIds(rows: readonly SdkRow[], settled: boolean): Set<string> {
  const out = new Set<string>();
  let last: string | null = null;
  for (const row of rows) {
    if (row.kind === "user") {
      if (last) out.add(last);
      last = null;
    } else if (row.kind === "assistant" && !row.parent && !row.streaming && row.text.trim() !== "") {
      last = row.id;
    }
  }
  if (settled && last) out.add(last);
  return out;
}

/**
 * The turn has ROOM for one more message — the BREATHER in which the queue moves.
 *
 * The queue used to wait for the turn to CLOSE, and a fifteen-minute turn held a "para, tá errado"
 * for fifteen minutes. So the breather became the CLOSED BLOCK: delivered there, the message enters
 * the running turn through streaming input (the `turn_absorbed`) instead of becoming an interruption
 * of the reasoning in progress.
 *
 * WHAT THIS RULE CANNOT BE is "nothing running" (production, 13/10/2026: "passo uma tarefa e vejo
 * que ela demora um pouco"). Reading "tool in progress" as "wait" brought back nearly all of the old
 * wait, because the tool is where the turn spends its time and the newest row of a working turn is
 * almost always a tool: measured on the transcript of a real session of this panel, from a tool call
 * to the next closed block is 11s at the median, 31s at p90 and 71s at worst — with the wire up and
 * the CLI ready to receive. Worse: a turn that ENDS on a tool row (interrupted in the middle of one,
 * a `result` with no final text) left the queue stuck with nothing running and nobody to draw the
 * next row — frozen until the person sent something else.
 *
 * So a breather is the absence of a HALF-FINISHED SENTENCE, not the absence of work — read in the
 * same order the activity bar uses (see `currentActivity`): text or reasoning still streaming, no;
 * "Preparando…" — our last message has not even been read yet —, no. Closed block, yes; and tool in
 * progress ALSO yes, because a message delivered during it has the same fate it would have at the
 * closed block: the CLI queues it and the model reads it on the next step.
 *
 * And a freshly delivered message does NOT open the next breather: it is the newest row and the
 * turn is still up, so the next one only moves when the model REACTS (its row). Without this the
 * whole queue would go out at once in the same instant, which is the opposite of "uma por vez, e as
 * outras continuam suas".
 *
 * THE KNOWN LIMIT of this rhythm: it counts ROWS, not model steps. A step that drew several rows at
 * once (text + two parallel tools in the SAME message) would open one breather per row and let
 * several from the queue go up together. It is documented instead of defended because (a) the
 * protocol has no step-start mark to read, and (b) in the 1,677 assistant steps of this runner's
 * transcripts, ALL of them carry a single block — the CLI writes one message per block. And the
 * worst case is benign: the messages all reach the model, which is the destination they already had;
 * what is lost is the chance to edit the ones behind. PURE.
 */
export function turnHasRoomForMore(state: SdkChatState): boolean {
  if (state.awaiting) return false;
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i] as SdkRow;
    // The last thing said is ours: either there is no turn (the queue moves as it always did), or it
    // has just been delivered and the model has not reacted yet — the breather was already its own.
    if (row.kind === "user") return !state.turnActive;
    // Tool: work in progress, not a sentence in progress — and this is where the turn spends its time.
    if (row.kind === "tool") return true;
    if (row.kind === "thinking" || row.kind === "assistant") return !row.streaming;
  }
  return true; // empty conversation: nothing in progress to get in the way
}

/**
 * WHAT THE MODEL IS SAYING NOW — its own words, so the indicator does not speak for it.
 *
 * The indicator used to say only verb + clock + a tail picked from a table based on the elapsed
 * time ("ferramenta demorada, ainda rodando"). Being the same sentence for any tool and any
 * reasoning, it said nothing — and the real material was right there: the description the agent
 * ITSELF wrote for the command (`toolHeadline`, which already extracts it) and the reasoning it is
 * writing at this very moment.
 *
 * What comes out here is the LAST line of what is in progress, because that is what is changing —
 * the start of a ten-line reasoning is history, the end is news. An already CLOSED block is not
 * activity: it became the turn's output, and announcing it would be announcing something already
 * drawn right above. In that case it returns `null`, and the canned sentence goes back to being what
 * it always should have been: the fallback for when there is nothing to say. PURE.
 */
export function liveActivityDetail(state: SdkChatState): string | null {
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i] as SdkRow;
    if (row.kind === "user" && row.absorbed === true) continue; // it entered the turn, it did not open it
    if (row.kind === "user") return null; // the turn's message: nothing after it to report
    const subagent = subagentActivity(state.rows, row);
    if (subagent !== null) return subagent;
    if (row.kind === "tool") return toolLiveLabel(row) ?? lastLine(toolHeadline(row.name, row.input).title);
    if (row.kind === "thinking" || row.kind === "assistant") {
      return row.streaming ? lastLine(row.text) : null;
    }
  }
  return null;
}

/**
 * Who the subagent started by the `parentId` call is: its type (`Explore`), or the description, or
 * the tool's name — whatever there is. PURE.
 */
export function subagentName(rows: readonly SdkRow[], parentId: string): string {
  const parent = rows.find((row) => row.kind === "tool" && row.id === parentId);
  return parent && parent.kind === "tool" ? subagentLabel(parent.name, parent.input) : "";
}

/** A subagent's name by the call that started it: type, description or the tool's name. PURE. */
export function subagentLabel(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return field(o, "subagent_type") || field(o, "description") || tool;
}

/** What a subagent row is doing, in one line: the tool's headline, or the last
 *  line of what it said. Empty becomes null. PURE. */
export function subagentAction(row: SdkRow): string | null {
  if (row.kind === "tool") return lastLine(toolHeadline(row.name, row.input).title);
  if (row.kind === "assistant") return lastLine(row.text);
  return null;
}

/**
 * The activity bar when the last thing belongs to a SUBAGENT: "Subagente Explore: Read(x.ts)",
 * attributed to it and not to the main agent. Null when the row is not a subagent's. PURE.
 */
function subagentActivity(rows: readonly SdkRow[], row: SdkRow): string | null {
  if ((row.kind !== "tool" && row.kind !== "assistant") || !row.parent) return null;
  const action = subagentAction(row);
  if (action === null) return null;
  return translate("sdk.subagentRunning", { type: subagentName(rows, row.parent) || "?", action });
}

/** The last non-empty line of a text in progress, collapsed to single spaces. Empty becomes null. PURE. */
function lastLine(text: string): string | null {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = normalizeMessage(lines[i] as string);
    if (line !== "") return line;
  }
  return null;
}

function nextId(state: SdkChatState, prefix: string): { id: string; seq: number } {
  const seq = state.seq + 1;
  return { id: `${prefix}:${seq}`, seq };
}

/** The last row, when it is an assistant row still streaming. */
function streamingRow(rows: SdkRow[]): { kind: "assistant"; id: string; text: string; streaming: boolean } | null {
  const last = rows[rows.length - 1];
  return last && last.kind === "assistant" && last.streaming ? last : null;
}

/**
 * The REASONING row still open (the last one, if it is one). Kept apart from `streamingRow` on
 * purpose: thought and answer are two distinct streams, and one never writes into the other —
 * otherwise the answer's first token would end up at the end of the reasoning. PURE.
 */
function streamingThinkingRow(rows: SdkRow[]): { kind: "thinking"; id: string; text: string; streaming: boolean } | null {
  const last = rows[rows.length - 1];
  return last && last.kind === "thinking" && last.streaming ? last : null;
}

/**
 * Append an error row — or COLLAPSE it into the previous one when it says the same thing.
 *
 * The reconnect loop makes this the common case, not the corner: with the global flag off (or the
 * driver down) every attempt is refused with the identical message, and each refusal used to add
 * one more banner — a validation session collected ~14 copies of "the SDK driver is off". One
 * banner with a counter says the same thing without burying the conversation. PURE.
 */
function appendErrorRow(state: SdkChatState, rows: SdkRow[], text: string): SdkChatState {
  const last = rows[rows.length - 1];
  if (last && last.kind === "error" && last.text === text) {
    return { ...state, rows: [...rows.slice(0, -1), { ...last, count: (last.count ?? 1) + 1 }] };
  }
  const { id, seq } = nextId(state, "e");
  return { ...state, seq, rows: [...rows, { kind: "error", id, text }] };
}

/**
 * A SUBAGENT row comes in without touching the main agent's speech: it is drawn under the parent's
 * card, and closing the row the main agent is writing would turn its consolidated block into a
 * SECOND row (the same care as `workflow_progress`). So the open row is still the last one.
 * The turn and the wait also belong to the main agent: a background subagent does not reopen the
 * turn after the `result`, nor mark as answered a send that is still waiting for the main agent. PURE.
 */
function appendSubagentRow(state: SdkChatState, build: (id: string) => SdkRow, preferredId?: string): SdkChatState {
  const marked = markSource(state, false);
  const { id, seq } = nextId(marked, "a");
  const row = build(preferredId ?? id);
  return { ...marked, seq, rows: withSideRow(marked.rows, row) };
}

/** Where the PROVISIONAL tool row with this id sits (see `pending`), or -1. PURE. */
function provisionalToolAt(rows: readonly SdkRow[], id: string | undefined): number {
  return id ? rows.findIndex((row) => row.kind === "tool" && row.pending === true && row.id === id) : -1;
}

/**
 * The text/thinking row a `tool_use_start` closed: the one right before the trailing provisional
 * tool rows, or -1. The consolidated block of that row may land AFTER the start (the CLI's order
 * between the block's `assistant` message and the next block's opening is not ours to pick) — and
 * it belongs on that same row, not on a second bubble with the same words. PURE.
 */
function blockClosedByToolStart(rows: readonly SdkRow[], kind: "assistant" | "thinking"): number {
  let i = rows.length - 1;
  while (i >= 0 && rows[i]!.kind === "tool" && (rows[i] as { pending?: boolean }).pending === true) i -= 1;
  if (i === rows.length - 1 || i < 0) return -1;
  const row = rows[i]!;
  if (row.kind !== kind || (row.kind === "assistant" && row.parent)) return -1;
  return i;
}

/** The rows with `row` in place of index `at` — every other row keeps its reference (the memo). PURE. */
function replaceRowAt(rows: readonly SdkRow[], at: number, row: SdkRow): SdkRow[] {
  return [...rows.slice(0, at), row, ...rows.slice(at + 1)];
}

/**
 * Drop the provisional tool rows a turn left behind. The `tool_use` that would have replaced them
 * never comes once the turn is over (interrupted mid-input, the CLI died): kept, they would spin
 * forever — and the conversation never had that call, so a replay would not draw it either. PURE.
 */
/**
 * The main agent's turn ENDED: an action of its own that was born live and got no result (interrupted,
 * the CLI died) is no longer running — without this the icon spun forever. The subagent ones stay:
 * a background subagent works after the turn's `result`. PURE.
 */
function settleLiveTools(rows: SdkRow[]): SdkRow[] {
  if (!rows.some((r) => r.kind === "tool" && r.live === true && !r.result && !r.parent)) return rows;
  return rows.map((r) => (r.kind === "tool" && r.live === true && !r.result && !r.parent ? { ...r, live: false } : r));
}

function dropProvisionalTools(rows: SdkRow[]): SdkRow[] {
  return rows.some((row) => row.kind === "tool" && row.pending === true)
    ? rows.filter((row) => !(row.kind === "tool" && row.pending === true))
    : rows;
}

/** Close any live streaming row (a tool call or the turn's end interrupts the text block). */
function settleStreaming(rows: SdkRow[]): SdkRow[] {
  const live = streamingRow(rows) ?? streamingThinkingRow(rows);
  if (!live) return rows;
  return [...rows.slice(0, -1), { ...live, streaming: false }];
}

/**
 * Folds ONE driver event into the chat state. PURE — returns the same state object when the event
 * changes nothing, so React can skip the render.
 */
export function applySdkEvent(state: SdkChatState, event: SdkEvent): SdkChatState {
  const viaTerminal = event.source === "terminal";
  switch (event.type) {
    case "user": {
      // A replayed message (live sends of one's own are drawn by `appendUserRow` when the socket
      // accepts the frame) — or a LIVE external one: another card's agent talking to this card,
      // or a message the terminal mirror lifted from the TUI.
      if (!event.text) return state;
      const marked = markSource(state, viaTerminal);
      const { revisionPending, ...rest } = marked;
      return appendUserRow({ ...rest, rows: settleStreaming(marked.rows) }, event.text, event.from, {
        at: typeof event.at === "number" ? event.at : undefined,
        revision: revisionPending === true,
      });
    }
    case "catalog": {
      // The session's "/" menu. Pure STATE, not a row: it never touches the conversation, and it
      // REPLACES what was there (a refreshed catalogue is the whole truth, not an addition).
      if (!Array.isArray(event.commands)) return state;
      return { ...state, commands: event.commands };
    }
    case "background_tasks": {
      // LEVEL signal: the whole set, to REPLACE. It does not light the turn's spinner — the
      // task is not a turn, and the turn that started it may already be over.
      if (!Array.isArray(event.tasks)) return state;
      // Normalised here too (socket boundary): the strip reads `description` without checking, and a
      // missing field brought down the whole chat tree.
      const tasks: BackgroundTask[] = event.tasks
        .filter((t) => typeof t === "object" && t !== null && typeof t.id === "string")
        .map((t) => ({
          id: t.id,
          type: typeof t.type === "string" ? t.type : "",
          description: typeof t.description === "string" ? t.description : "",
          ...(typeof t.toolUseId === "string" && t.toolUseId ? { toolUseId: t.toolUseId } : {}),
        }));
      if (tasks.length === 0 && state.backgroundTasks.length === 0) return state;
      return { ...state, backgroundTasks: tasks };
    }
    case "tool_result": {
      // An action's result: settles its row (main agent or subagent), in place. A row that
      // is not on screen (outside the replay window) has nowhere to settle — nothing to do.
      if (!event.id || !event.toolResult || typeof event.toolResult !== "object") return state;
      const at = state.rows.findIndex((r) => r.kind === "tool" && r.id === event.id);
      const row = state.rows[at];
      if (!row || row.kind !== "tool") return state;
      return { ...state, rows: replaceRowAt(state.rows, at, { ...row, result: event.toolResult }) };
    }
    case "agent_task": {
      // State, not conversation: replaces the same subagent's.
      if (!event.toolUseId || !event.taskId) return state;
      const status = event.status === "completed" || event.status === "failed" || event.status === "stopped" ? event.status : "running";
      const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const task: AgentTask = {
        toolUseId: event.toolUseId,
        taskId: event.taskId,
        status,
        ...(typeof event.description === "string" ? { description: event.description } : {}),
        ...(typeof event.subagentType === "string" ? { subagentType: event.subagentType } : {}),
        ...(num(event.toolUses) !== undefined ? { toolUses: num(event.toolUses) } : {}),
        ...(num(event.tokens) !== undefined ? { tokens: num(event.tokens) } : {}),
        ...(num(event.durationMs) !== undefined ? { durationMs: num(event.durationMs) } : {}),
        ...(typeof event.lastTool === "string" ? { lastTool: event.lastTool } : {}),
        ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
        ...(num(event.startedAt) !== undefined ? { startedAt: num(event.startedAt) } : {}),
        ...(num(event.receivedAt) !== undefined ? { receivedAt: num(event.receivedAt) } : {}),
        ...(num(event.quietMs) !== undefined ? { quietMs: num(event.quietMs) } : {}),
      };
      return { ...state, agentTasks: { ...state.agentTasks, [task.toolUseId]: task } };
    }
    case "rate_limit": {
      // One window at a time, REPLACING its previous reading. Normalised at the boundary: a
      // malformed frame paints no strip at all.
      const status = event.status;
      if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return state;
      if (typeof event.window !== "string" || !event.window) return state;
      const info: RateLimitInfo = {
        status,
        window: event.window,
        ...(typeof event.utilization === "number" && Number.isFinite(event.utilization) ? { utilization: event.utilization } : {}),
        ...(typeof event.resetsAt === "number" && Number.isFinite(event.resetsAt) ? { resetsAt: event.resetsAt } : {}),
      };
      return { ...state, rateLimits: { ...state.rateLimits, [info.window]: info } };
    }
    case "context_usage": {
      // Replaces the previous reading. A malformed one does not erase the one that holds.
      const info = parseContextUsage(event);
      return info ? { ...state, contextUsage: info } : state;
    }
    case "conversation_reset": {
      // /clear: the model started from scratch in a new session. The screen forgets the old conversation
      // the way Claude Code does — otherwise the /clear seemed to have done nothing. What stays is what
      // belongs to the card's SESSION and not to the conversation: the "/" menu, the background tasks
      // still alive, the turn. The trigger filter is the same as the back's (today every reset arrives as
      // "clear" — the CLI does not say the cause), and the cut is at the LAST "/clear": what was sent
      // after it (the CLI's queue) belongs to the new conversation and stays.
      if (event.trigger !== undefined && event.trigger !== "clear") return state;
      let from = -1;
      state.rows.forEach((row, i) => {
        if (row.kind === "user" && row.text.trim() === "/clear") from = i;
      });
      return {
        ...state,
        rows: from === -1 ? [] : state.rows.slice(from),
        sessionId: undefined,
        workflowMeta: {},
        terminalBurst: false,
        awaiting: false,
        // The erased conversation no longer takes up anything; the new session's reading comes at the end of the turn.
        contextUsage: null,
      };
    }
    case "local_output": {
      // `/cost` and friends: answered by the CLI itself, outside any turn. Its own row, so it is
      // never mistaken for something Claude said.
      if (!event.text) return state;
      const { id, seq } = nextId(state, "cmd");
      return {
        ...state,
        seq,
        awaiting: false,
        rows: [...settleStreaming(state.rows), { kind: "command_output", id, text: event.text }],
      };
    }
    case "compaction":
      return applyCompaction(state, event);
    case "btw_answer": {
      // Does not touch `awaiting` nor `turnActive`: the side question is not the turn, and the turn
      // that was running keeps running. This tab's question already has a row (pending); another
      // tab's, or the replay's, gets one now.
      if (typeof event.id !== "string" || typeof event.question !== "string" || (!event.text && !event.error)) return state;
      const outcome = event.text ? { text: event.text, error: undefined } : { error: event.error };
      const at = state.rows.findIndex((row) => row.kind === "btw" && row.btwId === event.id);
      if (at < 0) return pushBtwRow(state, { btwId: event.id, question: event.question, ...outcome });
      const rows = [...state.rows];
      rows[at] = { ...(rows[at] as Extract<SdkRow, { kind: "btw" }>), ...outcome };
      return { ...state, rows };
    }
    case "voice_turn": {
      // A spoken turn, from the replay or announced live (this tab's own included, once the server
      // saved it). Upserted by `vid`: the replay after a reconnect and the live echo never double it.
      if (!event.vid || (event.role !== "user" && event.role !== "assistant") || !event.text) return state;
      const at = state.rows.findIndex((row) => row.kind === "voice" && row.vid === event.vid);
      const row: SdkRow = {
        kind: "voice",
        id: at >= 0 ? state.rows[at]!.id : `voice-${event.vid}`,
        vid: event.vid,
        role: event.role,
        text: event.text,
        at: typeof event.at === "number" ? event.at : undefined,
        from: event.from,
      };
      if (at >= 0) {
        const rows = [...state.rows];
        rows[at] = row;
        return { ...state, rows };
      }
      // The agent may be mid-answer (someone typed during the call): its streaming row must stay
      // LAST — deltas and the consolidated text only ever write to the last row. The spoken turn
      // goes in right above what is still being written.
      let insertAt = state.rows.length;
      while (insertAt > 0) {
        const prev = state.rows[insertAt - 1]!;
        if ((prev.kind === "assistant" || prev.kind === "thinking") && prev.streaming) insertAt--;
        else break;
      }
      return { ...state, rows: [...state.rows.slice(0, insertAt), row, ...state.rows.slice(insertAt)] };
    }
    case "system_note": {
      // The PANEL talking (a deploy interrupted a turn, the boot resumed it): one muted centered
      // line, never a bubble — it is about the conversation, not part of it.
      if (!event.text) return state;
      const { id, seq } = nextId(state, "note");
      return { ...state, seq, rows: [...settleStreaming(state.rows), { kind: "note", id, text: event.text }] };
    }
    case "ready": {
      // The frame carries the manager's REAL turn state. `turnActive: true` = a turn is in flight
      // in the card's live driver — the reattach mid-turn (Terminal↔Chat, reload) must light the
      // spinner even though this view saw no live event yet (reattach mid-turn). Absent/false =
      // nothing is running, whatever the replayed tail looked like (a turn cut mid-tool must not
      // leave the spinner on forever).
      const next: SdkChatState = {
        ...state,
        ready: true,
        turnActive: event.turnActive === true,
        // A (re)connect: whatever this view interrupted belongs to a turn that is already over —
        // the flag must not outlive it and swallow a later, REAL error result.
        interruptRequested: false,
        // A new driver does not have the previous one's tasks; on a reconnect the back resends the
        // current set right behind this `ready` (see `attachSocket`). Zeroing here is what prevents a
        // "rodando em segundo plano" strip hanging around after the process running it died.
        backgroundTasks: [],
        // Same for the limit warning: the back resends the current one behind the `ready`; a new driver
        // (a switched account, included) does not inherit the previous account's warning.
        rateLimits: {},
        // Same for the context meter: the back resends the session's latest reading behind the `ready`.
        contextUsage: null,
        rows: event.turnActive === true ? settleStreaming(state.rows) : settleLiveTools(dropProvisionalTools(settleStreaming(state.rows))),
      };
      // The resumed session is state, not conversation: no "Retomando a sessão…" row in the log.
      if (event.resume) next.sessionId = event.resume;
      return next;
    }
    case "user_ack":
      // The back has it on disk — the browser may finally forget its own copy (the view's caller
      // drops it from the outbox).
      return event.cid ? settleUserRow(state, event.cid, "sent") : state;
    case "user_nack":
      // The history does NOT have it: the back refused it (the card's driver had died — a
      // hibernate, a crash), or the driver took it but the write to disk failed. Either way an F5
      // would lose it: say so, keep the words, offer the resend (same `cid`: to the driver that took
      // it, that only retries the write — see the back's `chargeReceipt`).
      return event.cid ? settleUserRow(state, event.cid, "undelivered") : state;
    case "session":
      if (!event.sessionId || event.sessionId === state.sessionId) return state;
      return { ...state, sessionId: event.sessionId };
    case "assistant_delta": {
      if (!event.text) return state;
      const base = markSource(state, false); // deltas are always the driver talking — closes a burst
      const live = streamingRow(base.rows);
      if (live) {
        const rows = [...base.rows.slice(0, -1), { ...live, text: live.text + event.text }];
        return { ...base, rows, turnActive: nextTurnActive(base, false), awaiting: false };
      }
      const { id, seq } = nextId(base, "a");
      return {
        ...base,
        seq,
        turnActive: nextTurnActive(base, false),
        awaiting: false,
        // `settleStreaming` and not a raw append: what may be open here is the
        // REASONING row (the model thought and now answers), and leaving it "pensando" forever is the
        // pulse that never stops. An open answer row would already have been used above.
        rows: [...settleStreaming(base.rows), { kind: "assistant", id, text: event.text, streaming: true }],
      };
    }
    /**
     * The live REASONING. It lands on its own row, never on the assistant's: they are two streams
     * (the model thinks, then answers) and mixing them would glue the answer's first token to the end
     * of the thought. A reasoning delta CLOSES an answer that was still open — if the
     * model went back to thinking, that paragraph is over.
     */
    case "thinking_delta": {
      if (!event.text) return state;
      const base = markSource(state, false); // reasoning is always the driver talking
      const live = streamingThinkingRow(base.rows);
      if (live) {
        const rows = [...base.rows.slice(0, -1), { ...live, text: live.text + event.text }];
        return { ...base, rows, turnActive: nextTurnActive(base, false), awaiting: false };
      }
      const { id, seq } = nextId(base, "t");
      return {
        ...base,
        seq,
        turnActive: nextTurnActive(base, false),
        awaiting: false,
        rows: [...settleStreaming(base.rows), { kind: "thinking", id, text: event.text, streaming: true }],
      };
    }
    /** The consolidated block: same words, now settled — it replaces the deltas that built it. */
    case "thinking": {
      const text = event.text ?? "";
      const live = streamingThinkingRow(state.rows);
      if (live) {
        const rows = [...state.rows.slice(0, -1), { ...live, text, streaming: false }];
        return { ...state, rows, turnActive: nextTurnActive(state, viaTerminal), awaiting: false };
      }
      const closed = viaTerminal ? -1 : blockClosedByToolStart(state.rows, "thinking");
      const closedRow = state.rows[closed];
      if (closedRow && closedRow.kind === "thinking") {
        if (text === "" || closedRow.text === text) return state;
        return { ...state, rows: replaceRowAt(state.rows, closed, { ...closedRow, text }) };
      }
      if (text === "") return state;
      const marked = markSource(state, viaTerminal);
      const { id, seq } = nextId(marked, "t");
      return {
        ...marked,
        seq,
        turnActive: nextTurnActive(marked, viaTerminal),
        awaiting: false,
        rows: [...settleStreaming(marked.rows), { kind: "thinking", id, text, streaming: false }],
      };
    }
    case "assistant_text": {
      const text = event.text ?? "";
      if (event.parentToolUseId) {
        if (text === "") return state;
        const parent = event.parentToolUseId;
        return appendSubagentRow(state, (id) => ({ kind: "assistant", id, text, streaming: false, parent }));
      }
      const live = streamingRow(state.rows);
      if (live && !viaTerminal) {
        // The consolidated block REPLACES the deltas that built it — same words, now settled.
        const rows = [...state.rows.slice(0, -1), { ...live, text, streaming: false }];
        return { ...state, rows, turnActive: nextTurnActive(state, viaTerminal), awaiting: false };
      }
      const closed = viaTerminal ? -1 : blockClosedByToolStart(state.rows, "assistant");
      const closedRow = state.rows[closed];
      if (closedRow && closedRow.kind === "assistant") {
        if (text === "" || closedRow.text === text) return state;
        return { ...state, rows: replaceRowAt(state.rows, closed, { ...closedRow, text }) };
      }
      if (text === "") return state;
      const marked = markSource(state, viaTerminal);
      const { id, seq } = nextId(marked, "a");
      return {
        ...marked,
        seq,
        turnActive: nextTurnActive(marked, viaTerminal),
        awaiting: false,
        rows: [...settleStreaming(marked.rows), { kind: "assistant", id, text, streaming: false }],
      };
    }
    case "tool_use": {
      if (event.parentToolUseId) {
        const parent = event.parentToolUseId;
        return appendSubagentRow(state, (id) => ({
          kind: "tool", id, name: event.name ?? "?", summary: toolSummary(event.input), input: event.input, parent,
          ...(state.ready && !viaTerminal ? { live: true } : {}),
        }), event.id);
      }
      const marked = markSource(state, viaTerminal);
      const { id, seq } = nextId(marked, "t");
      const rows = settleStreaming(marked.rows);
      // The Workflow call carries the PLAN (the script's `meta`). The progress comes from the back much
      // later, only with the run's name — this is where the plan is kept so it can be found. It also
      // holds on replay: an F5 in the middle of the fleet rebuilds the phases from this same row.
      const meta = event.name === "Workflow" ? parseWorkflowScriptMeta((event.input as { script?: unknown })?.script) : null;
      const workflowMeta = meta
        ? { ...marked.workflowMeta, [meta.name]: { description: meta.description, phases: meta.phases } }
        : marked.workflowMeta;
      const row: SdkRow = {
        kind: "tool", id: event.id ?? id, name: event.name ?? "?", summary: toolSummary(event.input), input: event.input,
        ...(marked.ready && !viaTerminal ? { live: true } : {}),
      };
      // The full input of the call that is already on screen as PROVISIONAL: the same row, in the same
      // place — a single card, which now knows what it does (the Edit/Write diff shows up here).
      const provisional = provisionalToolAt(rows, event.id);
      return {
        ...marked,
        seq,
        workflowMeta,
        turnActive: nextTurnActive(marked, viaTerminal),
        awaiting: false,
        rows: provisional >= 0 ? replaceRowAt(rows, provisional, row) : [...rows, row],
      };
    }
    case "tool_use_start": {
      // The model OPENED the call and is still writing the input (tens of seconds on a big Write). The
      // row is born provisional and the complete `tool_use` replaces it. Main agent only: the driver
      // does not relay the subagent stream, and a repeated frame does not open a second row.
      if (!event.id || event.parentToolUseId || state.rows.some((row) => row.kind === "tool" && row.id === event.id)) return state;
      const marked = markSource(state, false);
      return {
        ...marked,
        turnActive: nextTurnActive(marked, false),
        awaiting: false,
        rows: [...settleStreaming(marked.rows), { kind: "tool", id: event.id, name: event.name ?? "?", summary: "", pending: true }],
      };
    }
    case "tool_input_progress": {
      // Only the provisional row: after the complete `tool_use`, the input's size is no longer news.
      const at = provisionalToolAt(state.rows, event.id);
      const row = state.rows[at];
      if (!row || row.kind !== "tool" || typeof event.bytes !== "number") return state;
      const filePath = event.filePath || row.filePath;
      if (row.inputBytes === event.bytes && row.filePath === filePath) return state;
      return { ...state, rows: replaceRowAt(state.rows, at, { ...row, inputBytes: event.bytes, ...(filePath ? { filePath } : {}) }) };
    }
    case "tool_progress": {
      const at = event.id ? state.rows.findIndex((r) => r.kind === "tool" && r.id === event.id) : -1;
      const row = state.rows[at];
      if (!row || row.kind !== "tool" || typeof event.elapsedSeconds !== "number" || row.elapsedSeconds === event.elapsedSeconds) return state;
      return { ...state, rows: replaceRowAt(state.rows, at, { ...row, elapsedSeconds: event.elapsedSeconds }) };
    }
    case "workflow_progress": {
      // The back reading the fleet's log (services/sdk/workflow.ts). Does NOT touch `turnActive`: the
      // turn that started the workflow is already over — that is exactly why this row exists.
      // A run has ONE row: the new snapshot replaces the previous one, in the place it already was.
      const runId = event.runId;
      if (!runId) return state;
      const name = event.name ?? "";
      const metas = Object.keys(state.workflowMeta);
      // By name; and when the back could not read it (script deleted, odd name) but this
      // session started only ONE workflow, it is that one — better the right plan than a panel with no plan.
      const meta = state.workflowMeta[name] ?? (metas.length === 1 ? state.workflowMeta[metas[0]!] : undefined);
      const agents = Array.isArray(event.agents) ? event.agents : [];
      const phases = workflowPhases(event.phases, meta?.phases);
      const row: SdkRow = {
        kind: "workflow",
        id: `wf:${runId}`,
        runId,
        name,
        ...(meta?.description ? { description: meta.description } : {}),
        ...(phases.length ? { phases } : {}),
        ...(typeof event.startedAt === "number" && event.startedAt > 0 ? { startedAt: event.startedAt } : {}),
        agents,
        total: typeof event.total === "number" ? event.total : agents.length,
        done: typeof event.done === "number" ? event.done : agents.filter((a) => a.status === "done").length,
        at: typeof event.at === "number" ? event.at : 0,
        finished: event.finished === true,
        ...(WORKFLOW_OUTCOMES.has(event.outcome) ? { outcome: event.outcome } : {}),
      };
      const at = state.rows.findIndex((r) => r.kind === "workflow" && r.runId === runId);
      if (at >= 0) return { ...state, rows: [...state.rows.slice(0, at), row, ...state.rows.slice(at + 1)] };
      // The fleet arrives outside the turn, and may land ON TOP of a streaming answer. Closing
      // that row here (the `settleStreaming` of all the others) would turn the consolidated block that
      // comes right after into a SECOND row: the same sentence twice, with the panel in between. So
      // the open row is still the last one — the panel goes in right before it.
      return { ...state, rows: withSideRow(state.rows, row) };
    }
    case "permission_request": {
      if (!event.id) return state;
      const rows = settleStreaming(state.rows);
      return {
        ...state,
        turnActive: nextTurnActive(state, viaTerminal),
        awaiting: false,
        rows: [
          ...rows,
          {
            kind: "permission",
            id: event.id,
            tool: event.tool ?? "?",
            summary: toolSummary(event.input),
            reason: event.reason,
            outcome: "pending",
          },
        ],
      };
    }
    case "permission": {
      // Only the escalated ones carry an id; the auto-allowed bulk is noise the chat does not draw.
      if (!event.id) return state;
      const outcome: PermissionOutcome =
        event.decision === "allow" ? "allowed" : event.timedOut ? "timeout" : "denied";
      return decidePermission(state, event.id, outcome);
    }
    case "user_question": {
      if (!event.id || !Array.isArray(event.questions) || event.questions.length === 0) return state;
      const rows = settleStreaming(state.rows);
      return {
        ...state,
        turnActive: nextTurnActive(state, viaTerminal),
        awaiting: false,
        rows: [
          ...rows,
          { kind: "question", id: event.id, questions: event.questions, outcome: "pending" },
        ],
      };
    }
    case "question_result": {
      if (!event.id) return state;
      const cancel = event.cancelledHow || event.cancelledBy
        ? { ...(event.cancelledBy ? { by: event.cancelledBy } : {}), ...(event.cancelledHow ? { how: event.cancelledHow } : {}) }
        : undefined;
      return answerQuestion(state, event.id, event.answers, event.superseded === true, cancel);
    }
    case "turn_absorbed": {
      // The driver's confirmation that the LAST send folded into the turn already running
      // (streaming input): the newest unmarked user row is recorded as absorbed — no label is
      // drawn, the mark is what keeps this fold idempotent. Live-only — never replayed (by replay
      // time the turn is history).
      const next = markUserAbsorbed(state);
      if (next === state && !state.awaiting) return state;
      return { ...next, turnActive: nextTurnActive(next, false), awaiting: false };
    }
    case "rewound": {
      // The conversation was taken back to before the edited message: what the model forgot, the
      // screen forgets too. A `false` here is the driver saying it could NOT rewind (see
      // `rewindAndSend`), and then nothing is dropped — the supersede it sent instead means every
      // row on screen is still part of the conversation.
      if (event.ok !== true) return state;
      return dropRewoundRows(state, event.originalText, event.text, event.first === true);
    }
    case "message_edited": {
      // The user superseded a message he sent: the LAST user row with those words is drawn dimmed
      // with the "editada" badge (the new version follows as its own row). Matching is by
      // normalized text — the history has no row ids, and the same rule folds live and replay.
      if (!event.originalText) return state;
      const marked = markUserEdited(state, event.originalText, { first: event.first === true });
      return marked === state ? state : { ...marked, revisionPending: true };
    }
    case "result": {
      const next: SdkChatState = {
        ...state,
        turnActive: false,
        awaiting: false,
        interruptRequested: false,
        rows: settleCompaction(settleLiveTools(dropProvisionalTools(settleStreaming(state.rows)))),
      };
      if (event.sessionId) next.sessionId = event.sessionId;
      if (!event.isError) return next;
      // THE MUTE BUBBLE. An interrupted turn used to come back as `is_error` with an empty
      // `result`, and this line rendered it as the string "error" — a red balloon saying nothing,
      // right under an answer chopped mid-sentence (the reported case: editing a message mid-turn).
      // The DRIVER now de-arms `isError` for an aborted turn (`wasAborted`), which is the honest
      // place for it: it survives an F5 and a second tab, which `interruptRequested` cannot. This
      // flag stays as the second lock (an older CLI reports no `terminal_reason`), and a real
      // failure still gets a sentence instead of the word "error".
      if (state.interruptRequested) return next;
      const detail = (event.result ?? "").trim();
      if (detail !== "") return appendErrorRow(next, next.rows, detail);
      return appendErrorRow(next, next.rows, event.subtype ? `${SDK_ERROR_TURN_FAILED}|${event.subtype}` : SDK_ERROR_TURN_FAILED);
    }
    case "error": {
      const text = (event.message ?? "").trim();
      return appendErrorRow(
        { ...state, turnActive: false, awaiting: false },
        dropProvisionalTools(settleStreaming(state.rows)),
        text !== "" ? text : SDK_ERROR_NO_DETAIL,
      );
    }
    case "parse_error": {
      const raw = (event.raw ?? "").trim();
      return appendErrorRow(state, state.rows, raw !== "" ? raw : SDK_ERROR_NO_DETAIL);
    }
    default:
      return state;
  }
}

/** Append a user message: one's own send (no `from`), or a replayed/external one with provenance.
 *  `opts.awaiting` — a LIVE send of one's own: starts the status ladder ("Preparando…"/"Pensando…")
 *  until the driver's first reaction. Replay and external messages never pass it. PURE. */
export function appendUserRow(
  state: SdkChatState,
  text: string,
  from?: MessageOrigin,
  opts?: { awaiting?: boolean; cid?: string; state?: "sending" | "sent" | "undelivered"; at?: number; revision?: boolean },
): SdkChatState {
  const { id, seq } = nextId(state, "u");
  const row: SdkRow = { kind: "user", id, text, state: opts?.state ?? "sent", cid: opts?.cid, from, at: opts?.at };
  if (opts?.revision === true) row.revision = true;
  return {
    ...state,
    seq,
    awaiting: opts?.awaiting === true ? true : state.awaiting,
    rows: [...state.rows, row],
  };
}

/**
 * A /btw row goes in BEFORE the turn's text still streaming (like a subagent's): the delta flow
 * only writes into the LAST row, and a side row at the end split the answer into two bubbles,
 * the first stuck at "escrevendo" forever. PURE.
 */
function withSideRow(rows: SdkRow[], row: SdkRow): SdkRow[] {
  const last = rows[rows.length - 1];
  const stillWriting = last && (last.kind === "assistant" || last.kind === "thinking") && last.streaming;
  return stillWriting ? [...rows.slice(0, -1), row, last] : [...rows, row];
}

type CompactionRow = Extract<SdkRow, { kind: "compaction" }>;

/** The compaction still running, if any — the LAST one (only one exists at a time). */
function runningCompactionAt(rows: SdkRow[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.kind === "compaction" && row.status === "running") return i;
  }
  return -1;
}

/**
 * The `compaction` event: `started` opens the bar (just one — the repeated start of whoever
 * reconnects does not open another); `done`/`failed` close the open bar, or draw the divider on its
 * own (the replay, which only has the outcome). PURE.
 */
function applyCompaction(state: SdkChatState, event: SdkEvent): SdkChatState {
  const at = runningCompactionAt(state.rows);
  if (event.phase === "started") {
    if (at >= 0) return state;
    const { id, seq } = nextId(state, "compact");
    const row: CompactionRow = {
      kind: "compaction", id, status: "running",
      ...(typeof event.startedAt === "number" ? { startedAt: event.startedAt } : {}),
      ...(event.trigger === "manual" || event.trigger === "auto" ? { trigger: event.trigger } : {}),
    };
    return { ...state, seq, rows: withSideRow(state.rows, row) };
  }
  if (event.phase !== "done" && event.phase !== "failed") return state;
  const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const outcome: Partial<CompactionRow> = { status: event.phase };
  if (event.trigger === "manual" || event.trigger === "auto") outcome.trigger = event.trigger;
  if (count(event.preTokens) !== undefined) outcome.preTokens = count(event.preTokens);
  if (count(event.postTokens) !== undefined) outcome.postTokens = count(event.postTokens);
  if (count(event.durationMs) !== undefined) outcome.durationMs = count(event.durationMs);
  if (event.phase === "failed" && event.error) outcome.error = event.error;
  const next = { ...state, contextUsage: compactedUsage(state.contextUsage, outcome) };
  if (at >= 0) {
    const rows = [...state.rows];
    rows[at] = { ...(rows[at] as CompactionRow), ...outcome };
    return { ...next, rows };
  }
  const { id, seq } = nextId(state, "compact");
  return { ...next, seq, rows: withSideRow(state.rows, { kind: "compaction", id, status: event.phase, ...outcome }) };
}

/**
 * The meter after the compaction: the CLI says how much is left (`postTokens`), and the meter drops
 * AT ONCE — the real reading only comes at the end of the turn, and until then it would show the old
 * conversation. With no previous reading there is no window to divide by: it stays as it is. PURE.
 */
function compactedUsage(usage: ContextUsageInfo | null, outcome: Partial<CompactionRow>): ContextUsageInfo | null {
  if (!usage || outcome.status !== "done" || outcome.postTokens === undefined || usage.maxTokens <= 0) return usage;
  const percent = Math.min(100, Math.round((outcome.postTokens / usage.maxTokens) * 100));
  return { ...usage, usedTokens: outcome.postTokens, percent };
}

/** The turn closed: a bar still open does not run forever (the old driver does not close it). PURE. */
function settleCompaction(rows: SdkRow[]): SdkRow[] {
  const at = runningCompactionAt(rows);
  if (at < 0) return rows;
  const next = [...rows];
  next[at] = { ...(next[at] as CompactionRow), status: "failed" };
  return next;
}

type BtwRow = Extract<SdkRow, { kind: "btw" }>;

function pushBtwRow(state: SdkChatState, fields: Omit<BtwRow, "kind" | "id">): SdkChatState {
  const { id, seq } = nextId(state, "btw");
  return { ...state, seq, rows: withSideRow(state.rows, { kind: "btw", id, ...fields }) };
}

/** The question of a /btw from this tab, pending until the answer (`btw_answer`) fills it in. PURE. */
export function appendBtwRow(state: SdkChatState, btwId: string, question: string, askedAt: number): SdkChatState {
  return pushBtwRow(state, { btwId, question, askedAt });
}

/** A question from THIS tab with neither an answer nor an error yet. PURE. */
function isPendingBtw(row: SdkRow): row is BtwRow & { askedAt: number } {
  return row.kind === "btw" && row.askedAt !== undefined && row.text === undefined && row.error === undefined;
}

/**
 * The deadline of a side question on the SCREEN. The driver answers ONE at a time (up to 3 queued) and
 * each has 3 min — the deadline covers the whole queue plus some slack. Past it with no answer, the
 * driver that was answering it died (deploy, hibernation) and nobody is going to answer anymore.
 */
export const BTW_EXPIRE_MS = 10 * 60_000;

/** This tab's questions that passed the deadline become errors. Nothing expired = the SAME state. PURE. */
export function expireBtwRows(state: SdkChatState, now: number): SdkChatState {
  const stale = (row: SdkRow): boolean => isPendingBtw(row) && now - row.askedAt >= BTW_EXPIRE_MS;
  if (!state.rows.some(stale)) return state;
  return { ...state, rows: state.rows.map((row) => (stale(row) ? { ...row, error: translate("sdk.btwExpired") } : row)) };
}

/**
 * Settle one own send by its RECEIPT: delivered (the back saved it) or undelivered (it refused, or
 * the receipt never came). Unknown cid = nothing to settle — a receipt for a row this view no
 * longer holds (a reconnect wiped it) is not an error. PURE.
 */
export function settleUserRow(
  state: SdkChatState,
  cid: string,
  next: "sending" | "sent" | "undelivered",
): SdkChatState {
  let changed = false;
  const rows = state.rows.map((row) => {
    if (row.kind !== "user" || row.cid !== cid || row.state === next) return row;
    changed = true;
    return { ...row, state: next };
  });
  if (!changed) return state;
  // An undelivered message is not work in progress: the ladder must stop claiming the agent is on it.
  const stuck = next === "undelivered";
  return { ...state, rows, awaiting: stuck ? false : state.awaiting };
}

/** Forget one own send entirely (the person clicked "Descartar"). PURE. */
export function dropUserRow(state: SdkChatState, cid: string): SdkChatState {
  const rows = state.rows.filter((row) => !(row.kind === "user" && row.cid === cid));
  return rows.length === state.rows.length ? state : { ...state, rows };
}

/**
 * The `cid`s THIS screen already has drawn — the sends with an owner, which the reconciliation does not judge.
 *
 * Reconciling is about what was left over from BEFORE: messages from a previous browser or connection,
 * whose bubbles the (re)connect erased and whose fate only the replay knows. A send made ON THIS
 * connection already has its own bubble and clock (the watchdog) — and the replay cannot contain it,
 * because the server sends `ready` on attach and only afterwards answers the frames that were buffered
 * during setup. Without this boundary, it was exactly the in-flight message that the reconciliation
 * deemed lost: a SECOND bubble, marked "não entregue" (production, 2026-09-28). Rows coming from the
 * replay have no `cid` — they are the ones the text comparison exists to match. PURE.
 */
export function liveUserCids(rows: readonly SdkRow[]): Set<string> {
  const cids = new Set<string>();
  for (const row of rows) if (row.kind === "user" && row.cid) cids.add(row.cid);
  return cids;
}

/**
 * The messages the SERVER has (replayed/acked own sends), with when it recorded them — what marks
 * a send and reconciles the outbox (lib/sdkOutbox.ts `sendMark`/`reconcileOutbox`). PURE.
 *
 * `viewer` (who is looking) leaves OTHER people's messages out: they reach this screen live now,
 * and the same words from someone else never prove that one's own send arrived — nor are they an
 * anchor for one's next send (a peer's line drawn after one's own bubble may be older on the
 * server). Unattributed rows stay: one's own live sends carry no `from`. Unknown viewer: all count.
 */
export function deliveredUserTexts(rows: readonly SdkRow[], viewer?: string): ServerText[] {
  return rows.filter((r): r is Extract<SdkRow, { kind: "user" }> =>
    r.kind === "user" && r.state === "sent" && (viewer === undefined || !r.from || r.from.name === viewer))
    .map((r) => ({ text: r.text, at: r.at }));
}

/** Mark the LAST not-yet-edited user row whose words match as superseded ("editada"). PURE. */
export function markUserEdited(state: SdkChatState, originalText: string, opts: { first?: boolean } = {}): SdkChatState {
  const target = normalizeMessage(originalText);
  if (target === "") return state;
  // `first`: the edit was of the conversation's first message — the FIRST row with those words.
  const n = state.rows.length;
  for (let k = 0; k < n; k += 1) {
    const i = opts.first ? k : n - 1 - k;
    const row = state.rows[i]!;
    if (row.kind !== "user" || row.edited === true || normalizeMessage(row.text) !== target) continue;
    const rows = [...state.rows.slice(0, i), { ...row, edited: true }, ...state.rows.slice(i + 1)];
    return { ...state, rows };
  }
  return state;
}

/** Is `rowId` the conversation's FIRST user row — nothing a person said comes before it? PURE. */
export function isFirstUserRow(rows: readonly SdkRow[], rowId: string): boolean {
  const first = rows.find((row) => row.kind === "user");
  return first !== undefined && first.id === rowId;
}

/**
 * Drop the rows a REWIND erased: the edited message and everything the model answered to it.
 *
 * What survives is what the model still has — everything before the edited message — plus the
 * edit's own new message, which is the LAST user row and was appended after the marker. Cutting
 * "from the edited row to the last user row" is what keeps this correct even if a frame lands in
 * between: anything after that new message is newer than the rewind and is not ours to remove —
 * with ONE exception, the note that narrated the cut turn (below), which is newer only because the
 * driver is slower than the keyboard.
 *
 * The note that NARRATED the stop goes with them, and only here does it look like an exception.
 * On screen it lands AFTER the new bubble — the bubble is drawn the instant the person presses
 * Enter, while the note still has to come back from the driver — so the cut would leave "a
 * resposta acima ficou pela metade" standing under a corrected message with a COMPLETE answer
 * above it, telling the reader something that is no longer true. The log agrees that it must go,
 * by both of its routes: when the note was written BEFORE the edit's marker the main cut swallows
 * it, and when it landed after (the grace path — the screen gave up waiting for the turn to close,
 * so the marker went first) `dropOrphanInterruptNotes` takes it there. The filter is over the
 * whole tail on purpose: `rewound` is emitted before the new turn's first frame, so nothing in
 * that tail can narrate a stop other than the one just undone.
 *
 * Total and conservative: no row marked `edited`, or an order that cannot be (the edited row at or
 * after the new message), and the state comes back untouched. A screen with a stale row is a
 * cosmetic bug; a screen missing rows the model still has is a lie about the conversation.
 *
 * `originalText` (the driver says which message it rewound) picks the edited row BY ITS WORDS: an
 * edit of an older message must not stop at a row further down that an earlier supersede already
 * marked "editada" — that row is gone for the model too. Without it, the newest edited row. PURE.
 */
export function dropRewoundRows(state: SdkChatState, originalText?: string, newText?: string, first: boolean = false): SdkChatState {
  const target = originalText === undefined ? "" : normalizeMessage(originalText);
  let editedAt = -1;
  let lastUserAt = -1;
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i]!;
    if (row.kind !== "user") continue;
    if (lastUserAt === -1) lastUserAt = i;
    if (row.edited === true && (target === "" || normalizeMessage(row.text) === target)) {
      editedAt = i;
      // `first` (the conversation's first message was edited): keep walking up to the FIRST copy —
      // the newer ones with the same words are re-sends, and they go with the cut.
      if (!first) break;
    }
  }
  // `editedAt >= lastUserAt` is the whole identity case: the edited row IS the newest message, so
  // there is nothing between them to drop. Past it the cut always removes at least one row.
  if (editedAt === -1 || lastUserAt === -1 || editedAt >= lastUserAt) return state;
  // `newText` (the back says which row is the edit's new message) moves the end of the cut there:
  // with another person on the card, their message can land after it, before this confirmation —
  // and the "last user row" would then be THEIRS, erasing the correction. The FIRST match after the
  // edited row: an earlier identical line only keeps more rows, never fewer.
  const key = newText === undefined ? "" : normalizeMessage(newText);
  let keepFrom = lastUserAt;
  if (key !== "") {
    // With `first` the LAST match: the copies in between are the re-sends being cut, and the new
    // words may well be the same as theirs.
    const isNew = (row: SdkRow, i: number): boolean => i > editedAt && row.kind === "user" && normalizeMessage(row.text) === key;
    const found = first ? state.rows.findLastIndex(isNew) : state.rows.findIndex(isNew);
    if (found !== -1) keepFrom = found;
  }
  const tail = state.rows.slice(keepFrom).filter((row) => !narratesTheCutTurn(row));
  return { ...state, rows: [...state.rows.slice(0, editedAt), ...tail] };
}

/** Is this row the note that explained the stop the rewind just erased? PURE. */
function narratesTheCutTurn(row: SdkRow): boolean {
  return row.kind === "note" && (row.text === TURN_INTERRUPTED_NOTE || row.text === TURN_INTERRUPTED_EDIT_NOTE);
}

/** Mark the LAST not-yet-absorbed user row as folded into the running turn (no label; the mark is
 * what makes a repeated `turn_absorbed` a no-op). PURE. */
export function markUserAbsorbed(state: SdkChatState): SdkChatState {
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i]!;
    if (row.kind !== "user") continue;
    if (row.absorbed === true) return state; // the newest user row is already marked — nothing newer to mark
    const rows = [...state.rows.slice(0, i), { ...row, absorbed: true }, ...state.rows.slice(i + 1)];
    return { ...state, rows };
  }
  return state;
}

/** Settle a permission card's outcome (a click, or the driver's echo — idempotent). PURE. */
export function decidePermission(state: SdkChatState, id: string, outcome: PermissionOutcome): SdkChatState {
  let changed = false;
  const rows = state.rows.map((row) => {
    if (row.kind !== "permission" || row.id !== id || row.outcome === outcome) return row;
    // The first decision wins on screen: a driver echo may confirm it, never flip it back to pending.
    if (row.outcome !== "pending" && outcome === "pending") return row;
    changed = true;
    return { ...row, outcome };
  });
  return changed ? { ...state, rows } : state;
}

/** Settle a question card (a click, the driver's echo, or a replayed result — idempotent). PURE. */
export function answerQuestion(
  state: SdkChatState,
  id: string,
  answers?: SdkQuestionAnswer[],
  superseded: boolean = false,
  cancel?: QuestionCancel,
): SdkChatState {
  const outcome: QuestionOutcome = answers && answers.length > 0
    ? "answered"
    : superseded ? "superseded" : cancel ? "cancelled" : "unanswered";
  let changed = false;
  const rows = state.rows.map((row) => {
    if (row.kind !== "question" || row.id !== id) return row;
    // The first settlement wins on screen: an echo may confirm it, never flip it back to pending.
    if (row.outcome !== "pending") return row;
    changed = true;
    return { ...row, outcome, answers, ...(outcome === "cancelled" ? { cancel } : {}) };
  });
  return changed ? { ...state, rows } : state;
}

/* --------------------------------------------------------------- folding */

/** A run of consecutive tool rows folds into one block, like the transcript chat does. */
export type SdkRenderRow =
  | { kind: "row"; id: string; row: SdkRow }
  | { kind: "tools"; id: string; rows: SdkRow[] }
  /** SUBAGENTS started in sequence: a fleet, each on its own row (never folded into "N ações"). */
  | { kind: "agents"; id: string; rows: SdkRow[] };

/** The tools that start a subagent: `Agent` (current name in Claude Code) and `Task` (the old one). */
function isAgentCall(row: SdkRow): boolean {
  return row.kind === "tool" && !row.pending && (row.name === "Agent" || row.name === "Task");
}

export const SDK_TOOL_FOLD_MIN = 3;

/**
 * Fold consecutive tool rows (>= min) into one block; everything else passes through. PURE.
 * A tool row that carries a diff (an Edit/Write with its text) is never folded: the change is
 * what the reader wants to see, so it breaks the run and stays on screen as its own row. Neither
 * is a provisional one (`pending`): it is what is happening now, not a step already taken.
 */
export function groupSdkRows(rows: readonly SdkRow[], min: number = SDK_TOOL_FOLD_MIN): SdkRenderRow[] {
  const out: SdkRenderRow[] = [];
  let run: SdkRow[] = [];
  let fleet: SdkRow[] = [];
  const flushFleet = (): void => {
    if (fleet.length > 0) out.push({ kind: "agents", id: fleet[0]!.id, rows: fleet });
    fleet = [];
  };
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length >= Math.max(2, min)) out.push({ kind: "tools", id: run[0]!.id, rows: run });
    else for (const row of run) out.push({ kind: "row", id: row.id, row });
    run = [];
  };
  for (const row of rows) {
    if (isAgentCall(row)) {
      flush();
      fleet.push(row);
      continue;
    }
    flushFleet();
    if (row.kind === "tool" && !row.pending && !hasToolDiff(row.name, row.input)) {
      run.push(row);
      continue;
    }
    flush();
    out.push({ kind: "row", id: row.id, row });
  }
  flush();
  flushFleet();
  return out;
}

/**
 * The thread as drawn during (and right after) a voice call: the saved rows, plus the call's turns
 * the server has not echoed back yet — the one being spoken, the one being saved — appended where
 * they are happening, at the end. A turn leaves this overlay the moment its saved copy arrives (same
 * `vid`), so it never shows twice. Returns `rows` itself when there is nothing to add. PURE.
 */
export function mergeLiveVoiceTurns(
  rows: SdkRow[],
  turns: ReadonlyArray<LocalVoiceTurn>,
  self?: MessageOrigin,
): SdkRow[] {
  if (turns.length === 0) return rows;
  const saved = new Set<string>();
  for (const row of rows) if (row.kind === "voice") saved.add(row.vid);
  const extra: SdkRow[] = [];
  for (const turn of turns) {
    if (saved.has(turn.vid) || !turn.text.trim()) continue;
    extra.push({
      kind: "voice",
      id: `voice-${turn.vid}`,
      vid: turn.vid,
      role: turn.role,
      text: turn.text,
      at: turn.at,
      from: self,
      live: !turn.final,
      save: turn.save,
    });
  }
  return extra.length === 0 ? rows : [...rows, ...extra];
}
