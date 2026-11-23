# SDK driver — the native chat

The Chat tab of every card runs the card's Claude session through the **Claude Agent SDK**
(`query()`), not through `send-keys` into the terminal UI (TUI). A small Node process, the
**driver**, runs inside the runner, in the card's worktree, and talks to the back over NDJSON on
stdin/stdout; the back relays it to the browser over a websocket. The Terminal tab is untouched:
both tabs are views of the same conversation (see "Terminal and native chat").

## Settings

All three live in `back/src/services/settings/settings.ts` and are install-wide (owner only):

| Setting | Default | Effect |
|---|---|---|
| `sdkDriver` | `true` | On: the Chat tab of every card is the native chat. Off: every card falls back to the classic transcript chat and `GET /api/cards/:id/sdk` answers an error frame and closes. The front learns the value from `GET /api/features` (`sdkChat`), readable by any signed-in user. UI: Settings → "Native chat (install default)". |
| `sdkPermissionMode` | `"same-as-terminal"` | The driver's permission gate (see "Permissions"). Travels to the driver as `--permission-gate`. |
| `sdkAutoResume` | `true` | Whether a turn killed by a panel restart or a driver crash is resumed automatically (see "Resume after a restart"). |

The card field `card.sdkChat` (an old per-card opt-in) is still accepted by the board's patch
validation, but nothing reads it: the front decides only by `/api/features`.

## The pieces

| File | Role |
|---|---|
| `back/src/services/sdk/sdk-driver.mjs` | The driver process. Runs in the runner; one streaming `query()` per stream, `bypassPermissions` plus its own `PreToolUse` hook, NDJSON events on stdout, controls on stdin. Copied into `dist` by `back/scripts/build-assets.mjs` (tsc ignores `.mjs`). |
| `back/src/services/sdk/protocol.ts` | The canonical contract: event and control types, `parseDriverLine`, `encodeControl`, `parseSdkClientFrame` and the other browser-frame parsers, the permission classifier and the permission/question ledgers. The driver embeds mirror copies of the classifier, the gate and the ledgers (an `.mjs` cannot import the compiled back); `protocol.ts` is the tested source. |
| `back/src/services/sdk/driver.ts` | Installs the driver and the SDK into the runner and builds the spawn command. |
| `back/src/services/sdk/manager.ts` | Owns the card's single driver: multiplexes every websocket of the card, persists history and the resume id, counts turns, handles idle stop, death reports, API retries and effort switches. |
| `back/src/routes/cardSdk.ts` | The websocket `GET /api/cards/:id/sdk` (`requireCardWork`): per-connection work (frame buffering, replay, mirror reference, author) and then `attachSocket` onto the card's driver. |
| `back/src/services/sdk/history.ts` | The card's chat log, `<dataDir>/sdk-history/<cardId>.ndjson`. |
| `back/src/services/sdk/inflight.ts`, `resume.ts` | Durable "turn in flight" markers and the boot sweep that resumes them. |
| `back/src/services/sdk/mirror.ts`, `transcript.ts` | Terminal → chat mirror and the replay merge with the CLI transcript. |
| `front/src/features/board/components/SdkChatView.tsx`, `front/src/features/board/lib/sdkChat.ts` | The chat view and its pure reducer/rules. |

## Driver lifecycle

### Provisioning

On connect, when the card has no live driver, `installCardSdkDriver()` plants `sdk-driver.mjs`
in `/root/.vibehub-sdk/` (atomic `mktemp` + `mv`) and runs `buildEnsureSdkScript`, which installs
`@anthropic-ai/claude-agent-sdk@<SDK_PACKAGE_VERSION>` there only when the `.sdk-version` marker
disagrees. The first connect pays one `npm install`; later ones are a marker check. Upgrading the
SDK means changing `SDK_PACKAGE_VERSION` in `driver.ts` (currently `0.3.300`). The runner container
is never recreated.

Before spawning, the route also rebuilds a missing worktree (`restoreMissingWorkspace`, for a card
whose agent removed its own folder) and reapplies the card's git identity.

### The spawn command

`buildSdkDriverCommandLine` produces `docker exec -i <runner> bash -c '<env>; exec node
sdk-driver.mjs --cwd <worktree> [--resume <id>] [--model …] [--effort …] [--permission-gate …]'`,
run through the host executor's pipe transport (no tty, so long NDJSON lines are not cut or
echoed). The environment it sets:

- `unset ANTHROPIC_API_KEY`, `IS_SANDBOX=1`, `NODE_PATH` at the driver's own `node_modules`, the
  auto-compact and test-worker exports;
- the sign-in (see "Authentication") and `CLAUDE_CONFIG_DIR` for a non-default account; transcripts
  are carried over from the previous profile after an account switch, so `--resume` finds them;
- the card's environment, the same the TUI session has: `PW_CDP_ENDPOINT` (the `navegador` MCP
  drives this card's own Chromium), `VIBEHUB_CARD_ID` and `VIBEHUB_STATUS_URL` (the status hooks
  report the right card), the card's git identity variables and its temp dir.

Every value placed in the line is validated (paths, card id, session id, URLs) and shell-quoted.

### Query options

`baseOptions()` in the driver:

- `permissionMode: "bypassPermissions"` with a `PreToolUse` hook (the gate) and `canUseTool` (which
  receives `AskUserQuestion` in every permission mode);
- `settingSources: ["user", "project", "local"]` and `systemPrompt: { type: "preset", preset:
  "claude_code" }`: the same MCPs, settings, hooks and `CLAUDE.md` files the TUI session loads;
- `includePartialMessages: true` (live deltas), `thinking: { type: "adaptive", display:
  "summarized" }` (on current models the default display is `omitted`, and thinking blocks arrive
  with empty text), `agentProgressSummaries: true` (a per-subagent "what it is doing now" line);
- `model` and `effort` when the card pins them. No `allowedTools`.

### One driver per card

`ensureDriverSession` keeps at most one driver per card, owned by the back, not by a connection.
A reconnect or a second tab attaches to the live process and receives a synthesized `ready` (with
the newest resume id and `turnActive`). Closing a tab only detaches its socket: the turn keeps
running and the manager keeps writing the history, the resume id and the mirror's dedupe keys.

The driver ends when:

- the card's session is killed (`onCardSessionKill`: pause, hibernate, restart, delete, model or
  account change);
- it is idle: no socket and no turn in flight for `DRIVER_IDLE_MS` (15 min). A live background
  task holds an unwatched driver for at most `BACKGROUND_HOLD_MAX_MS` (3 h);
- its stdin closes (`rl.on("close") → exit 0`), which is also how it exits when the back stops.

The runner reaper never selects a process whose command line carries the driver path. A card with
a connected chat or a turn running is vetoed from hibernation (`isCardChatInUse`), and a chat
message stamps `humanActiveAt`, which the idle sweep counts as activity.

An exit nobody asked for becomes a `warn` log with the exit code, the stderr tail
(`STDERR_TAIL_MAX`) and the turns in flight, plus an `error` frame in the chat. If a turn was in
flight, the crash resume picks it up (see below). A late `close` from a stopped driver never clears
state that a successor driver already owns.

The route buffers every frame that arrives during its setup (seconds of `await`) and feeds them to
the manager after the attach, in order. If the socket closed during the setup, the route acquires
nothing (no mirror, no driver, no slot in `session.sockets`).

## Turns: streaming input

The driver keeps one long-lived `query()` whose `prompt` is an async iterable fed by an internal
channel. A message that arrives while a turn runs is pushed into the live stream, and the CLI folds
it into the running turn. Verified live on SDK 0.3.246 and again on 0.3.300: a message pushed
during a running turn produced a single `result` whose answer already honoured it.

- **`turn_absorbed`**: the driver emits it after pushing a message into a running turn. That send
  will not produce its own `result`, so the manager takes back its +1 on `activeTurns` (floor 1).
- **Closing a turn**: a turn that ends without a `result` (interrupt, stream death) is closed with
  `result { subtype: "aborted" }`, so the manager's count always returns to zero. An interrupted
  turn (`terminal_reason` `aborted_streaming`/`aborted_tools`) reports `isError: false`. The CLI's
  internal diagnostics (`[ede_diagnostic]`) are stripped from error text; a stream the driver
  tears down itself is not reported as an error.
- **Autonomous turns**: the CLI also opens turns on its own (a background task finished, a
  `ScheduleWakeup` fired). The manager detects them (main-agent output with no turn open) and
  `isTurnInFlight` (`activeTurns > 0 || autonomousTurn`) is the single rule used by `ready`, the
  idle stop and the board status.
- **Known race**: the driver decides "absorbed" from its own `turnActive` at push time. If the
  CLI's `result` was already in transit, the CLI runs the message as a new turn and one extra
  `result` arrives; the manager's floor at zero absorbs it, and the worst symptom is the spinner
  going off between the two results.
- **Session id**: `session` is emitted when the id changes; the manager persists it on the card
  (`resumeSessionId`). A new stream resumes `lastSessionId`. On connect, the route resumes the
  newest transcript in the card's worktree, whichever tab wrote it (`resumeTargetFor`).

## The wire protocol

`protocol.ts` defines four directions. Everything below matches it field by field.

### Driver → back (stdout)

`parseDriverLine` accepts exactly these `type` values (`DRIVER_EVENT_TYPES`); anything else, or a
line that is not JSON, becomes `parse_error`.

```jsonc
{ "type": "ready", "resume"?: "<sessionId>", "turnActive"?: bool }   // turnActive is stamped by the back
{ "type": "session", "sessionId": "<uuid>" }
{ "type": "assistant_delta", "text": "…" }
{ "type": "assistant_text", "text": "…", "parentToolUseId"?: "toolu_…" }
{ "type": "thinking_delta", "text": "…" }
{ "type": "thinking", "text": "…" }
{ "type": "tool_use_start", "id": "toolu_…", "name": "Write" }
{ "type": "tool_input_progress", "id": "toolu_…", "bytes": n, "filePath"?: "…" }
{ "type": "tool_use", "id": "toolu_…", "name": "Write", "input": { … }, "parentToolUseId"?: "…" }
{ "type": "tool_progress", "id": "toolu_…", "elapsedSeconds": n }
{ "type": "tool_result", "id": "toolu_…", "isError"?: bool, "text"?: "…", "textLength"?: n, "structured"?: …, "outputLines"?: n, "parentToolUseId"?: "…" } // raw, capped
{ "type": "task_started" | "task_progress" | "task_notification", "taskId": "…", "toolUseId"?: "…", "description"?: "…", "subagentType"?: "…", "taskType"?: "…", "status"?: "…", "toolUses"?: …, "tokens"?: …, "durationMs"?: …, "lastTool"?: "…", "summary"?: "…" }
{ "type": "permission", "tool": "Bash", "decision": "allow"|"deny", "sensitive": bool, "reason"?: "…", "id"?: "…", "timedOut"?: bool }
{ "type": "permission_request", "id": "…", "tool": "Bash", "input"?: …, "reason"?: "…" }
{ "type": "user_question", "id": "…", "questions": [ { "question": "…", "header"?: "…", "options": [ { "label": "…", "description"?: "…" } ], "multiSelect"?: bool } ] }
{ "type": "question_result", "id": "…", "answers"?: [ { "selected": ["…"] } ], "timedOut"?: bool, "superseded"?: bool, "sent"?: "…", "cancelledBy"?: "…", "cancelledHow"?: "stop"|"send_now"|"edit" }
{ "type": "turn_absorbed" }
{ "type": "rewound", "ok": bool, "uuid"?: "…", "reason"?: "no-fork-point"|"absorbed"|"not-delivered", "originalText"?: "…", "text"?: "…", "first"?: bool }
{ "type": "catalog", "commands": [ { "name": "…", "description"?: "…", "argumentHint"?: "…", "aliases"?: ["…"], "source": "skill"|"plugin"|"command" } ] }
{ "type": "effort_default", "effort": "…" }
{ "type": "effort_ack", "id": "…", "effort"?: "…", "error"?: "…" }
{ "type": "keyword_effort_replaced" }
{ "type": "local_output", "text": "…" }
{ "type": "btw_answer", "id": "…", "question": "…", "text"?: "…", "error"?: "…" }
{ "type": "compaction", "phase": "started"|"done"|"failed", "trigger"?: "manual"|"auto", "preTokens"?: n, "postTokens"?: n, "durationMs"?: n, "error"?: "…", "startedAt"?: ms }
{ "type": "background_tasks", "tasks": [ { "id": "…", "type": "…", "description": "…", "toolUseId"?: "…" } ] }
{ "type": "rate_limit", "status": "allowed"|"allowed_warning"|"rejected", "window": "…", "utilization"?: n, "resetsAt"?: ms }
{ "type": "login_failed" }
{ "type": "usage_limited", "rateLimit"?: … }
{ "type": "context_usage", "usedTokens": n, "maxTokens": n, "percent": n, "model"?: "…" }
{ "type": "conversation_reset", "trigger"?: "…" }
{ "type": "result", "isError": bool, "subtype"?: "…", "sessionId"?: "…", "result"?: "…", "permissionDenials"?: [ … ] }
{ "type": "error", "message": "…" }
```

Notes:

- `rewound.text` and `rewound.first` are stamped by the back before relaying; the driver sends
  `ok`, `uuid`, `reason` and `originalText`.
- `rate_limit` and `context_usage` are normalised by the back (`rateLimit.ts`, `contextUsage.ts`:
  percentage 0..100, epoch in ms, whole tokens).
- `compaction.startedAt` is set by the back on `started`.

### Events the back synthesises (also in `protocol.ts`)

```jsonc
{ "type": "parse_error", "raw": "<the bad line>" }
{ "type": "workflow_progress", "runId": "…", "name": "…", "total": n, "done": n, "agents": [ … ], "at": ms, "finished": bool, "outcome"?: … } // = WorkflowRun (workflowProbe.ts)
{ "type": "workflow_feed", "runId": "…", "agentId": "…", "items": [ … ], "error"?: "invalid-id"|"no-session"|"probe-failed" } // only to the socket that asked
{ "type": "login_restored" }                                                // first turn that works after login_failed
```

### Back → driver (stdin, `DriverControl`)

`encodeControl` strips the browser's `cid` before writing.

```jsonc
{ "type": "user", "text": "…", "now"?: true, "keepQuestions"?: true }  // keepQuestions: back only
{ "type": "btw", "id": "…", "question": "…" }
{ "type": "set_effort", "id": "…", "effort": "<level>" | null }        // back only
{ "type": "interrupt", "reason"?: "edit" }
{ "type": "permission_decision", "id": "…", "allow": bool }
{ "type": "question_answer", "id": "…", "answers": [ { "selected": ["…"] } ], "forModel"?: [ … ] } // forModel: back only
{ "type": "edit_user", "original": "…", "text": "…", "fallback"?: "…", "first"?: bool }  // fallback: back only
{ "type": "reanchor" }                                                  // back only
```

### Browser → back (websocket)

`parseSdkClientFrame` turns a frame into a control. It accepts `user { text, cid?, now? }`,
`interrupt { reason?: "edit" }` (any other reason degrades to a plain stop),
`permission_decision { id, allow }`, `question_answer { id, answers }`, `btw { id, question }`
(question capped at `BTW_QUESTION_MAX`), `edit_user { original, text, cid?, first? }`, and a
**bare string**, which is a user message. A JSON object of an unrecognised shape is ignored.

Four more frames are parsed separately and never reach the driver or the history:

```jsonc
{ "type": "typing", "active": bool }                                          // parseTypingFrame
{ "type": "question_draft", "id": "…", "picked": [["…"]], "other": ["…"], "at"?: ms } // parseQuestionDraftFrame
{ "type": "workflow_feed", "runId": "…", "agentId": "…" }                      // parseWorkflowFeedFrame
{ "type": "detail", "req": "tool"|"agent"|"changes"|"file", "id"?: "…", "path"?: "…", "nonce"?: "…" } // parseDetailFrame
```

### Back → browser

Driver events are relayed as they are, with these exceptions in `manager.ts`: `effort_default`,
`effort_ack` and `usage_limited` are consumed by the manager; raw `tool_result` is replaced by its
summary `{ type: "tool_result", id, parentToolUseId?, toolResult }` (`toolResult.ts`); the three
`task_*` frames are merged into one state per call, `agent_task { toolUseId, taskId, status, … }`.

Frames only the back produces (typed in `manager.ts`, `history.ts` and `toolResult.ts`, not in
`protocol.ts`): `user_ack { cid }`, `user_nack { cid, reason: "driver-gone"|"history-write-failed" }`,
`system_note { text, at }`, `user { text, at, from? }` and `message_edited { originalText, first?, at }`
(relayed from another tab, and in the replay), `peer_typing { name, active }`,
`peer_question_draft { id, name, picked, other }`, `voice_turn` (replay), and the answer to a
`detail` request `{ type: "detail", req, id?, path?, nonce?, data?, error? }`.

Session state (`catalog`, `background_tasks`, `rate_limit`, `context_usage`, `login_failed`, the
running compaction, subagent states, the latest `workflow_progress`) is never written to the history;
the manager re-sends it to every socket that attaches.

## History and replay

`history.ts` appends to `<dataDir>/sdk-history/<cardId>.ndjson` only what is worth re-drawing
(`replayableHistoryEvent`): `user`, `assistant_text`, `tool_use` (long input texts capped),
`permission_request`, `permission` with an `id`, `user_question`, `question_result`,
`system_note`, `message_edited`, `voice_turn`, `btw_answer` with text, `compaction` `done`/`failed`,
the main agent's `tool_result` summary and a finished `agent_task`. Deltas, thinking, tool progress,
`turn_absorbed`, `rewound` and errors are live-only.

Each connect replays up to `HISTORY_REPLAY_LIMIT` (500) events, merged with the card's newest CLI
transcript (`mergeTranscriptReplay`): conversation held in the Terminal tab with no chat open
enters the timeline, and what the driver already said is deduplicated by tool-use id, transcript
event id (`tid`) and normalised text. The file is compacted past `HISTORY_COMPACT_FACTOR` × the
replay limit or `HISTORY_COMPACT_SIZE` characters. The harness filler `[Request interrupted by
user]` + `No response requested.` is dropped on every path that reads transcripts.

A `/clear` (`conversation_reset`) opens a new CLI session; the back clears the card's log, writes the
`conversation-cleared` note and the front clears the screen. The driver forgets its fork points.

## Sending a message

### Delivery receipt

Each send carries a `cid`. The browser keeps the message in `localStorage` (`sdkOutbox.ts`) before
writing to the socket and removes it only on `user_ack`, which the back sends **after** the line is
appended to the history. With the driver gone the back refuses (`user_nack` `driver-gone`, nothing
written, no turn counted); a failed append answers `user_nack` `history-write-failed`.

- No receipt within `OUTBOX_ACK_TIMEOUT_MS` (12 s), counted from the `ready` of the current
  connection (`answerableSince`), marks the bubble "not delivered" with Resend/Discard and drops
  the socket. Each message is judged once (`undelivered`).
- On reconnect, `reconcileOutbox` compares the outbox with the replay by text, anchored on the
  server timestamp the screen knew at send time (`sendMark`: `since`, `seenBefore`); messages that
  already have a bubble on this connection (`liveUserCids`) are not judged. If the conversation
  moved further than the replay window between the send and the reconnect, a delivered message
  comes back "not delivered" (Resend is safe, see next item).
- Resend repeats the same `cid`. The manager remembers the last `ACCEPTED_CIDS_MAX` (256) receipts
  and answers a known `cid` without touching the driver; a stored `history-write-failed` retries
  the append (`chargeReceipt`).
- The reconnect backoff (400 ms → 15 s) resets on `ready`, not on the websocket handshake.

### The queue and "Send now"

A message written while a turn runs waits in a queue above the field (`SdkQueueTray`, capped at
`max-h-[28vh]`, each item at `max-h-24`), editable and persisted. With the socket down, the send
also goes to the queue. The queue is released at the turn's next "breathing point"
(`turnHasRoomForMore` in `lib/sdkChat.ts`): not while text or reasoning is streaming or the session
is preparing; yes after a closed block or **while a tool runs**. A message just delivered does not
open the next breathing point, so the queue goes out one at a time. The exception: with a
`user_question` pending, a message goes immediately, because only a message releases the turn.

Evidence for releasing during tools: in a real session transcript, the time from a tool call to the
next closed block was 11 s median, 31 s p90 and 71 s worst case.

Each queued message has a **Send now** action (`sdk-queued-send-now`), which sends `user` with
`now: true`. The CLI reads a pushed message only when the running tool returns (observed: 51 s
blind behind a 60 s `Bash`). So with a main-agent tool in flight the driver (`sendUserNow`)
denies pending permissions, abandons pending questions, interrupts, waits up to
`SEND_NOW_TIMEOUT_MS` (10 s) for the turn to close and sends the message as a new turn. With no
tool running it folds into the turn like any other send.

### Interrupt

The stop button sends `interrupt`. The driver denies pending permissions, abandons pending
questions and calls `query().interrupt()`. The manager writes a `system_note`
(`turn-interrupted` or, with `reason: "edit"`, `turn-interrupted-edit`) after the interrupted
turn's `result`; the front translates the code. A stop with no turn running writes no note.

## Editing a message

The pencil on a sent bubble (or Esc on an empty field, for the last one) opens the edit. Clicking
the pencil does **not** stop the turn: the agent keeps working until the correction is sent.

1. **Send.** With a turn running, the front sends `interrupt { reason: "edit" }` and holds the edit
   until the turn reports its end (grace `EDIT_INTERRUPT_GRACE_MS`, 15 s). Then it sends
   `edit_user { original, text, cid, first? }`. `first: true` means the edited bubble is the first
   message on screen (words alone cannot tell which copy of a repeated message was clicked).
2. **Back.** `dispatchClientFrame` writes `edit_user` to the driver with `fallback` = the same
   edit wrapped by `buildSupersedeText` ("disregard the previous message … consider this version"),
   queues the edit in `session.rewinds`, and appends `message_edited` plus the new `user` line
   (`text` clean, `sent` the wrapped words, used as the transcript dedupe key).
3. **Driver** (`rewindAndSend`, serialized behind any rewind in flight) decides, before tearing
   anything down:
   - **Rewind** (`rewound { ok: true }`). The fork point comes first from the session transcript on
     disk (`forkPointFromTranscript`: walks the live branch by `parentUuid`, finds the newest prompt
     with the original words and the first `assistant` above it), which works for any message and
     after a driver restart. `first` skips the search and starts a new session. If the disk has no
     answer, the in-memory point is used only when the edited message is the last one sent
     (`rewindDecision`). The driver closes the stream and the next one resumes with
     `resumeSessionAt` at that point; everything after it leaves the model's context. The model
     reads the clean text.
   - **Not delivered** (`rewound { ok: false, reason: "not-delivered" }`). The transcript's live
     branch was read to its root and the original is not there (its turn died before the CLI wrote
     it): the clean text goes as a normal turn, nothing is cut.
   - **Supersede** (`rewound { ok: false, reason }`), the fallback: `no-fork-point` (nothing to go
     back to, or the teardown failed) or `absorbed` (a message joined the turn after the edited one;
     rewinding would silently discard it). The wrapped text goes as a new turn on the live stream.
   The disk answers "not found" on a `compact_boundary`, a missing parent, or when the same words
   appear later as an absorbed message (`queued_command` attachment).
4. **Agreement.** On `ok: true` the manager pairs the answer with the oldest queued edit, cuts the
   log (`rewindHistory`, also dropping an orphaned interrupt note), drops the stale `sent`, records
   the clean text in the mirror's dedupe memory, stamps `text`/`first` and relays `rewound`; the
   screen cuts the same rows (`dropRewoundRows`). An `ok: true` with no queued edit is not relayed.
   On `ok: false` nothing is cut and the wrapped text stays the dedupe key.

Invariant covered by tests: an edit always reaches the model, as a rewind, a clean turn or a
supersede. Evidence from the SDK: resuming at the kept turn's `assistant` uuid works and keeps the
session id; resuming at a `result` uuid is rejected with `error_during_execution`.

Known gap: editing the first message opens a new session; if the driver dies before that session
writes its first transcript entry, the next spawn resumes the old session.

The classic transcript chat has no edit.

## Permissions

`sdkGateAction(mode, tool, input)` (`protocol.ts`, mirrored in the driver) decides what the
`PreToolUse` hook does:

- **`same-as-terminal`** (default): allow everything, emitting `permission` events for
  observability only. The chat behaves like the card's Terminal tab, which runs under the runner's
  own settings with no vibehub gate on top.
- **`ask-sensitive`** (also the driver's fallback when `--permission-gate` is missing or unknown):
  the sensitive set (`classifySensitivity`: `rm -r/-f`, force push, `git reset --hard`,
  deploy-shaped commands, `npm publish`, `curl | sh`, reads of secret files, the `KillShell` tool)
  escalates. The hook emits `permission_request` and awaits `permission_decision`; no answer within
  `PERMISSION_TIMEOUT_MS` (5 min) denies. The driver then emits `permission { id, decision,
  sensitive: true, timedOut? }`.

The gate is the hook, not `canUseTool`. An allow rule in settings or `allowedTools` makes the SDK
skip `canUseTool` for that tool (it warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, which the driver
silences because `canUseTool` only serves questions here). vibehub writes no allow rules:
`runnerSettingsJson` sets only `permissions.defaultMode: "bypassPermissions"`, and the driver passes
no `allowedTools`. A repository's own committed `.claude/settings.json` may still carry allow
rules; that is the project's choice.

## Questions (AskUserQuestion)

The SDK routes `AskUserQuestion` through `canUseTool` in every permission mode. The driver
normalises the input (`normalizeUserQuestions`), emits `user_question` and awaits
`question_answer`; the answer returns to the model as `updatedInput` (`buildAskUserAnswers`) and the
driver emits `question_result`. No answer within `QUESTION_TIMEOUT_MS` (30 min): the model is told
nobody answered.

- **Answering by message.** A user message releases every pending question with
  `superseded: true`; the model reads `QUESTION_SUPERSEDED_MESSAGE`. The message is pushed before
  the question is released, so the turn never continues without having read it.
- **Stopped turn.** An interrupt, a "Send now" or an edit abandons pending questions; the manager
  stamps `cancelledBy`/`cancelledHow` on the `question_result`.
- **Orphan questions.** The driver's ledger is in memory. If the driver died with a card open, the
  replay still shows it pending; the manager knows which questions the current driver asked
  (`ownQuestions`) and sends an answer to an orphan as a user message (`buildOrphanAnswerText`).
- **Several people.** Draft choices are relayed as `peer_question_draft`. When an answer meets
  other people's drafts, the model receives all of them (`forModel`, `mergePeerAnswers`); an answer
  arriving after the card closed goes as a message (`buildLateAnswerText`, `keepQuestions: true`).
- The front keeps what was ticked per question id in `lib/questionDraftStore.ts`, which survives
  the remount a reconnect causes.

## Terminal and native chat

A card is one conversation shown in two tabs.

- **Terminal → chat (mirror).** While a chat is connected, the back follows the card's transcript
  (`mirror.ts`) and turns new lines into frames: a message typed in the TUI appears as a user
  bubble, preceded by the `terminal-activity` note. Mirrored events go to the history with
  `source: "terminal"` and `tid`.
- **Chat → terminal.** The driver writes the same transcript directory. The TUI does not draw the
  driver's turns live, but its next resume continues from the newest transcript.
- **Re-anchoring.** When the mirror sees the conversation move outside the chat, the manager sends
  `reanchor`; the driver marks its stream stale and, on the next send (never during one of its own
  turns), closes it so the new stream resumes at the transcript's real end.

## Resume after a restart

### Panel restart (deploy)

The driver is a child of the back and dies with it.

- **Marker.** When a turn starts, the manager writes `<dataDir>/sdk-inflight/<cardId>.json`
  (`startedAt`, `preview`, `attempts`, `owner`, later `progressed`, `background`). It is removed when
  the last turn closes and on a deliberate stop (pause, hibernate, delete). Marker operations are
  serialized per card.
- **Background work counts.** The marker also covers autonomous turns, live background tasks and
  a pending `ScheduleWakeup`; the continuation text lists what died. Background work alone that has
  been idle longer than `BACKGROUND_HOLD_MAX_MS` only gets a note.
- **SIGTERM.** `handOffSdkOnShutdown()` stops the mirrors, ends each driver's stdin and keeps the
  markers.
- **Blue/green.** Each process signs its markers (`owner`) and touches a heartbeat every 3 s. The
  boot sweep (`resume.ts`) resumes a marker only when its owner stopped beating for
  `OWNER_STALE_MS` (12 s) or released the heartbeat on SIGTERM; if the old process finishes the turn
  meanwhile, the marker disappears and nothing is resumed.
- **Resume.** The card gets a `system_note`; with `sdkAutoResume` on, the driver is spawned with
  `--resume` and receives `RESUME_CONTINUATION_TEXT` as a normal user turn with `system`
  provenance. A turn parked on a question card is not resumed: the note asks the person to answer it.
  A resumed turn that closes without the agent advancing gets one re-engage
  (`RESUME_REENGAGE_TEXT`, after `RESUME_CONFIRM_MS`, 45 s) and then `NOTE_RESUME_STALLED`.
- **No loop.** A resumed turn is resumed again only if it advanced (`progressed`) and fewer than
  `MAX_AUTO_RESUMES` (5) consecutive resumes happened; one that advanced and stayed up for
  `SETTLED_RESUME_MS` (2 min) restarts the count. A person's message resets the chain.

### Driver crash

A driver that dies with work in flight while the back stays up is resumed by the same logic with
crash wording (`CRASH_TEXTS`), after `CRASH_RESUME_DELAY_MS` (10 s).

### Transient API failure

When the CLI gives up and closes a turn with a transient API error (`isTransientApiFailure`:
5xx, overloaded, network and DNS errors), the manager posts a note and, after
`API_RETRY_DELAYS_MS` (30 s, 2 min, 5 min), injects `API_RETRY_TEXT` as a system turn. 4xx
(credentials, invalid request, plan limit) is left to the person. The wait counts as a turn in
flight; a person's message cancels it; a turn that ends without error resets the count; after the
last delay `NOTE_API_RETRY_EXHAUSTED` is posted. End-to-end check:
`scripts/e2e-mcp-wake/run.sh apiretry`.

## Authentication

The driver signs in with the card profile's Claude subscription credentials, never with an API key:

- The spawn command exports `CLAUDE_CODE_OAUTH_TOKEN` from the profile's `.oauth-token` through
  `oauthTokenGuard` (`accounts/profiles.ts`, shared with the TUI) unless a `.credentials.json`
  newer than the token and carrying a refresh token (a `/login`) exists; then the CLI uses that
  login. The newest sign-in wins, because inside Claude Code the variable outranks
  `.credentials.json`.
- `ANTHROPIC_API_KEY` is unset in the spawn line and deleted again by the driver at boot. An
  inherited API key would take precedence over the subscription token and bill the API.
- The driver re-applies the same rule itself (`decideAuth`/`applyAuth`) before every stream, and
  before every send (`reauthIfChanged`) compares the profile's sign-in with the one the open CLI was
  born with. If it changed, the stream is closed and the message opens a new CLI on the new sign-in,
  resuming the same session. Not with a turn in flight, and not with background tasks running
  unless the current CLI's login already failed.
- `login_failed` (the CLI answered `authentication_failed`) is session state shown in the chat until
  a turn works again (`login_restored`).

## Reasoning level (effort)

### The card's level, switched live

Changing the level in the card's pill with a driver up never restarts the session. The back writes
`set_effort { id, effort }`; the driver applies it with `applyFlagSettings({ effortLevel })`, mid-turn
included. Measured on the real CLI (SDK 0.3.300): later calls of the same turn carry the new level;
the call being generated at that instant finishes on the old one.

- `effort: null` (back to the account default) is also live. `effortLevel: null` alone falls to the
  **model's** default and skips the account settings (measured: settings `high` → flag `xhigh` →
  `null` gave `medium`), so the driver reads `getSettings().effective.effortLevel` and reapplies it
  (`restoreAccountEffort`).
- Every `set_effort` is answered with `effort_ack`: `effort` is what the session says the next call
  uses (`getSettings().applied.effort`), `error` means not applied. A switch that has not started
  writing within `EFFORT_SWITCH_START_DEADLINE_MS` (12 s) is refused and never writes later; each
  step has `EFFORT_STEP_TIMEOUT_MS` (4 s). Both can be overridden by
  `VIBEHUB_EFFORT_SWITCH_START_DEADLINE_MS` and `VIBEHUB_EFFORT_STEP_TIMEOUT_MS` (tests only).
- The back waits `EFFORT_ACK_TIMEOUT_MS` (25 s). Refused, timed out or no driver: it falls back to
  restarting the session now if the card is idle, or when it becomes idle (`restartPendingAt`).
  Outcomes are audited as `sdk.effort.applied` / `refused` / `timeout`.
- **One writer.** The keyword raise, the end-of-turn give-back, the pill switch and the `/btw` read
  go through one queue (`inEffortQueue`); each write claims the level (`claimEffortWrite`) so a
  late step never overwrites a newer write.
- **Before the first reply.** At boot the driver's throwaway catalog query, started without the
  card's `--effort`, reads the level an unpinned session uses and emits `effort_default`; the
  manager keeps it as session state for `GET /api/cards/:id/session`.

### `ultrathink` and `ultracode`

The CLI reacts to both words in the text itself (deeper reasoning for the turn; Workflow
orchestration for `ultracode`). It does not raise the effort level, so the driver does: it detects
the word with the same rules the front uses to paint it (`ultraCommandNameEnd` in the driver,
`commandNameEnd` in `front/src/features/board/lib/ultraWords.ts`; the first token of a slash command
is a name, the rest is prose; quoted spans, paths and flags do not count) and applies, strongest
first, `{ effortLevel: "max", ultracode: true }` (for `ultracode`), `{ effortLevel: "max" }`,
`{ effortLevel: "xhigh" }`. The message is pushed in a `finally`, so a failed raise never costs it,
and the first message of a new stream waits for `initializationResult()` (bounded) first.

At the turn's `result` the driver gives the level back: the card's pinned level when there is one
(clearing the flag does not restore `--effort`: measured on SDK 0.3.300, `--effort low` → flag
`max` → flag `null` left `medium`), otherwise the account level. A pill switch during a keyword
turn wins: the driver emits `keyword_effort_replaced` (only for the newest keyword message) and the
activity bar drops its "high effort" label.

### `/btw`

`/btw <question>` asks a side question without touching the running turn. The composer sends
`btw { id, question }`; the driver answers from a separate query that forks the session
(`resume` + `forkSession`, no tools, `maxTurns: 1`, `persistSession: false`, timeout 3 min) and
emits `btw_answer`. The prompt includes the main session's current level and its live background
tasks. The manager adds `/btw` to the catalog (`withBtwCommand`).

## The "/" menu

At boot the driver runs a throwaway query (`warmCatalog`) and, on each stream's `init`, asks
`supportedCommands()` once per process; `commands_changed` refreshes it. It emits one raw `catalog`;
the back normalises it (`normalizeSlashCommands`: valid names only, one-line descriptions, a cap,
`source` from the init's skill and plugin lists, terminal-only commands removed), keeps it as
session state, persists it per card (`<dataDir>/sdk-catalog/`, never an empty list) and serves the
remembered list to a socket that connects before the driver announces. The front's rules are in
`lib/slashMenu.ts`; the menu exists while the whole draft is one word starting with `/`. A slash
command is sent as a normal user message; a local command (`/cost`, `/usage`) answers with
`local_output`.

## What the screen shows

- **Reasoning**: `thinking_delta` live, `thinking` consolidated, in its own row, open while
  thinking and collapsed after. `redacted_thinking` is ignored. Not stored.
- **Tool generation**: `tool_use_start`, `tool_input_progress` (throttled) and `tool_progress`, main
  agent only, so a long `Write` shows progress before its `tool_use` exists.
- **Tool results**: the driver forwards a capped result (text up to 4 KB, lines counted before the
  cut); the back's summary ("7 lines", "+3 −1", "error: …") is what the browser and the history get.
- **Subagents**: `agent_task` per call; consecutive subagent calls render as a fleet. Subagent
  stream deltas are never emitted.
- **Detail on demand**: a `detail` request is answered only to the asking tab, one `docker exec` at
  a time. `detail.ts` reads the transcript (a tool call's input, output and preceding reasoning; a
  subagent's timeline) and `maestro/changes.ts` reads the worktree's git (changed files, a file's
  diff against the merge base). Nothing new is stored.
- **Workflow fleet**: the `Workflow` tool returns at once; the back watches its journal on disk
  (`workflow.ts`) and pushes `workflow_progress`; `workflow_feed` answers one agent's recent steps.
- **Activity bar** (`SdkActivityBar`, sticky): what is running now (`currentActivity`,
  `liveActivityDetail`, `toolHeadline`), elapsed time (`useTurnClock`) and the keyword effort.
  Before the first event of a send, an inline indicator shows "Preparing…" (driver not ready) or
  "Thinking…" (turn in the engine).
- **Compaction**: `compaction` `started` opens a row with a bar; `done`/`failed` close it with
  tokens before and after, or the reason.
- **Context and plan limits**: `context_usage` (read at the end of each turn) and `rate_limit`.

## Several people on one card

- **Authorship.** The route resolves the socket's author once; each message carries it (`from`).
  The front reconnects the socket on a real account switch (`identity.epoch`,
  `lib/viewerIdentity.ts`); queued messages of another account move to the outbox as "not
  delivered", without Resend.
- **Relay.** An accepted message (or edit) is relayed to the card's other tabs as `user` (preceded by
  `message_edited`), never back to the sender, never twice for the same `cid`. A tab still setting up
  receives what it missed after attaching (`missedDuringSetup`).
- **Typing.** The front sends `typing` at most every `TYPING_SEND_EVERY_MS` (2.5 s) and "stopped"
  after `TYPING_IDLE_MS` (3 s) idle (`lib/peerTyping.ts`). The back relays `peer_typing` to the
  other sockets, at most one "typing" per socket per `TYPING_RELAY_MIN_MS` (1 s). The front expires
  a name after `PEER_TYPING_TTL_MS` (6 s) and hides its own name.

## Limitations

- **Typing indicator per name.** The back tracks typing per socket and the front per name: the same
  person typing in two tabs and closing one hides the indicator for up to 2.5 s.
- **Absorbed-turn race.** See "Turns": an extra `result` can briefly turn the spinner off.
- **First-message edit.** See "Editing a message".
- **Outbox window.** A conversation that moves further than the replay window between a send and the
  reconnect makes a delivered message come back "not delivered".
- **Effort keyword lag.** With the effort queue busy, a keyword's raise can land after the turn has
  started; the level holds from that moment.
- **Mid-turn level switch.** The call already being generated finishes on the old level.

## Manual check

1. Settings → "Native chat (install default)" on (the default).
2. Open any card's Chat tab. The first connect on a runner may take longer: it installs the SDK.
3. Send "create hello.txt with HELLO and read it back". Expected: streamed answer, tool rows
   (Write, Read) with result summaries, end of turn.
4. Send a second message while a turn runs: it waits in the queue and enters at the next breathing
   point; "Send now" interrupts a running tool and sends it as a new turn.
5. Edit a sent message: the rows below it disappear and the model answers the new version.
6. With `sdkPermissionMode` set to `ask-sensitive`, ask for `rm -rf .`: a permission card with
   Allow/Deny appears; no answer denies after 5 minutes.
7. Reload the page mid-turn: the turn continues and the replay shows what the screen missed.
8. Turn `sdkDriver` off: every card shows the classic chat.
