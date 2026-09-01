// vibehub SDK DRIVER — runs INSIDE the runner (a Node process in the card's worktree, the way the
// tmux TUI runs there today). It drives ONE card's Claude session through the Agent SDK's `query()`
// instead of send-keys, speaking a tiny structured protocol:
//
//   stdout: newline-delimited JSON events   (assistant text / tool_use / session / permission / result)
//   stdin : newline-delimited JSON control  ({"type":"user","text":"..."} to send a message)
//
// Generalised from the proven spike (`spikes/sdk-poc/run-poc2.mjs`, see FINDINGS.md). The protocol
// and the permission gate MIRROR `back/src/services/sdk/protocol.ts` — keep them in step.
//
// Auth: CLAUDE_CODE_OAUTH_TOKEN is exported by the spawn command (read from the card profile's
// .oauth-token, exactly like the TUI's sessionCommand), so `query()` boots already logged in.
//
// Permission model: `--permission-gate` picks the mode (mirror of `sdkGateAction` in protocol.ts).
//   - "same-as-terminal": the native chat mirrors the Terminal tab — the runner's own Claude
//     settings decide, no vibehub gate on top; the hook only emits observability events.
//   - "ask-sensitive" (the fallback when the flag is absent/unknown): permissionMode
//     "bypassPermissions" auto-allows the bulk; the PreToolUse hook ESCALATES the SENSITIVE set
//     (rm -rf / force-push / deploy / secret reads) to the chat — it emits a `permission_request`
//     and AWAITS the human's `permission_decision` on stdin, denying after PERMISSION_TIMEOUT_MS.
// The runner's settings.json allowlist is NOT relied upon for the gate (the PoC found bare-name
// allow entries SHADOW the callback) — the driver's own hook fires regardless.
//
// Tools: the SDK is told to load the SAME configuration the TUI session sees — settingSources
// user+project+local (the profile's managed MCPs: vibehub, navegador, the registered ones; the
// worktree's .mcp.json; the runner settings' status hooks) and the claude_code system prompt preset
// (the brain CLAUDE.md at the profile root + the repo's own CLAUDE.md). The `navegador` MCP's
// stored config references ${PW_CDP_ENDPOINT}, which the spawn command exports per card — so the
// native chat drives the card's OWN Chromium, the one the user watches on the noVNC canvas.
//
// AUTH IS THE OAUTH TOKEN, PERIOD (project rule): the spawn command exports
// CLAUDE_CODE_OAUTH_TOKEN from the card profile and UNSETS ANTHROPIC_API_KEY; the delete below is
// the second lock on the same door, in case the driver is ever spawned by another path. An API key
// in the environment would silently bill the API instead of the Max subscription.

import { createInterface } from "node:readline";

delete process.env.ANTHROPIC_API_KEY;

/* --------------------------------------------------------------- argv */

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const CWD = argOf("--cwd") || process.cwd();
const INITIAL_RESUME = argOf("--resume"); // a stored session_id to continue on the first message
const MODEL = argOf("--model");
// Mirror of `parseGateMode` in protocol.ts: anything unrecognised falls back to the STRICTER mode.
const GATE_MODE = argOf("--permission-gate") === "same-as-terminal" ? "same-as-terminal" : "ask-sensitive";

/* ------------------------------------------------------------- output */

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

/* --------------------------------------------- permission gate (mirror) */
// Keep in step with SENSITIVE_BASH_PATTERNS / SENSITIVE_TOOLS in protocol.ts.

const SENSITIVE_BASH_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+push\b.*\+/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\b(kubectl|helm|docker|systemctl|serverless|sls|vercel|netlify|fly|flyctl|heroku)\b.*\b(deploy|apply|rollout|up|delete|destroy|down|prune)\b/i,
  /\bnpm\s+publish\b/i,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  /(^|[^\w])(cat|less|head|tail|grep|printenv|env)\b[^\n]*(\.env|id_rsa|id_ed25519|credentials|secret|\.oauth-token|\.vibehub-token)/i,
];
const SENSITIVE_TOOLS = ["KillShell"];

function classifySensitivity(toolName, input) {
  if (SENSITIVE_TOOLS.includes(toolName)) return true;
  const command = input && typeof input === "object" && typeof input.command === "string" ? input.command : "";
  if (command === "") return false;
  return SENSITIVE_BASH_PATTERNS.some((re) => re.test(command));
}

/* --------------------------------------- permission broker (mirror of createPermissionBroker) */
// Keep in step with `createPermissionBroker` / PERMISSION_TIMEOUT_MS in protocol.ts.

const PERMISSION_TIMEOUT_MS = 5 * 60_000;
const pendingPermissions = new Map();

function waitPermission(id, timeoutMs = PERMISSION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(id);
      resolve({ allow: false, timedOut: true });
    }, timeoutMs);
    pendingPermissions.set(id, (result) => {
      clearTimeout(timer);
      pendingPermissions.delete(id);
      resolve(result);
    });
  });
}

function resolvePermission(id, allow) {
  const deliver = pendingPermissions.get(id);
  if (!deliver) return false;
  deliver({ allow, timedOut: false });
  return true;
}

let permissionSeq = 0;

/* --------------------------------------- question broker (mirror of createQuestionBroker) */
// Keep in step with `createQuestionBroker` / QUESTION_TIMEOUT_MS / `buildAskUserAnswers` in
// protocol.ts. AskUserQuestion is SPECIAL: the SDK routes it through `canUseTool` in EVERY
// permission mode (bypassPermissions included) — it is a question to the human, not a permission.
// The driver turns it into a `user_question` frame the chat renders as clickable options, waits
// for the `question_answer` control on stdin, and answers the model through `updatedInput`.

const QUESTION_TIMEOUT_MS = 30 * 60_000;
const pendingQuestions = new Map();

function waitQuestion(id, timeoutMs = QUESTION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(id);
      resolve({ answers: null, timedOut: true });
    }, timeoutMs);
    pendingQuestions.set(id, (result) => {
      clearTimeout(timer);
      pendingQuestions.delete(id);
      resolve(result);
    });
  });
}

function resolveQuestion(id, answers) {
  const deliver = pendingQuestions.get(id);
  if (!deliver) return false;
  deliver({ answers, timedOut: false });
  return true;
}

// Mirror of `normalizeUserQuestions` in protocol.ts.
function normalizeUserQuestions(input) {
  if (!input || typeof input !== "object") return null;
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.question !== "string" || entry.question.trim() === "") return null;
    const options = [];
    if (Array.isArray(entry.options)) {
      for (const opt of entry.options) {
        if (!opt || typeof opt !== "object" || typeof opt.label !== "string" || opt.label.trim() === "") continue;
        options.push({ label: opt.label, ...(typeof opt.description === "string" ? { description: opt.description } : {}) });
      }
    }
    questions.push({
      question: entry.question,
      ...(typeof entry.header === "string" && entry.header.trim() !== "" ? { header: entry.header } : {}),
      options,
      ...(entry.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

// Mirror of `buildAskUserAnswers` in protocol.ts.
function buildAskUserAnswers(questions, answers) {
  const map = {};
  questions.forEach((q, i) => {
    const selected = (answers[i] && Array.isArray(answers[i].selected) ? answers[i].selected : []).filter(
      (s) => typeof s === "string" && s.trim() !== "",
    );
    if (selected.length === 0) return;
    map[q.question] = q.multiSelect ? selected : (selected.length === 1 ? selected[0] : selected.join(", "));
  });
  return map;
}

let questionSeq = 0;

// canUseTool — the SDK invokes it for AskUserQuestion in every mode. Everything else that reaches
// it (rare under bypassPermissions) is allowed unchanged: the PreToolUse gate above is the gate.
async function canUseTool(toolName, input) {
  if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
  const questions = normalizeUserQuestions(input);
  if (!questions) {
    // Not question-shaped: refuse rather than draw an empty card — the model rephrases.
    return { behavior: "deny", message: "vibehub SDK driver: malformed AskUserQuestion input." };
  }
  const id = `q_${++questionSeq}_${Date.now()}`;
  emit({ type: "user_question", id, questions });
  const { answers, timedOut } = await waitQuestion(id);
  if (!answers) {
    emit({ type: "question_result", id, timedOut: !!timedOut });
    return { behavior: "deny", message: timedOut
      ? "The user did not answer the question within 30 minutes. Continue with your best judgment and note the open question."
      : "The question was cancelled (the turn was interrupted)." };
  }
  emit({ type: "question_result", id, answers });
  return { behavior: "allow", updatedInput: { questions: input.questions, answers: buildAskUserAnswers(questions, answers) } };
}

// PreToolUse hook — mirror of `sdkGateAction` in protocol.ts. "same-as-terminal": everything is
// allowed (the Terminal tab's behaviour), only observability events are emitted. "ask-sensitive":
// auto-allow the bulk; a SENSITIVE call becomes a `permission_request` in the chat and the agent's
// loop WAITS here for the human's `permission_decision` (or the timeout's deny).
async function preToolUse(input) {
  const name = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const sensitive = classifySensitivity(name, toolInput);
  if (GATE_MODE === "same-as-terminal") {
    emit({ type: "permission", tool: name, decision: "allow", sensitive });
    return {};
  }
  if (sensitive) {
    const id = `perm_${++permissionSeq}_${Date.now()}`;
    emit({ type: "permission_request", id, tool: name, input: toolInput,
      reason: "vibehub SDK driver: sensitive action (rm -rf / force-push / deploy / secret-reads) — waiting for Permitir/Negar in the chat." });
    const { allow, timedOut } = await waitPermission(id);
    emit({ type: "permission", id, tool: name, decision: allow ? "allow" : "deny", sensitive: true, timedOut,
      reason: allow ? "allowed by the human in the chat"
        : timedOut ? "denied: nobody answered the permission request in time"
        : "denied by the human in the chat" });
    if (allow) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: timedOut
        ? "Blocked by vibehub SDK driver: the permission request timed out with no answer."
        : "Blocked by vibehub SDK driver: the human denied this action in the chat." } };
  }
  emit({ type: "permission", tool: name, decision: "allow", sensitive: false });
  return {};
}

/* --------------------------------------------------------------- SDK */

let query;
try {
  ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
} catch (err) {
  emit({ type: "error", message: "could not load @anthropic-ai/claude-agent-sdk in the runner: " + (err && err.message ? err.message : String(err)) });
  process.exit(1);
}

let lastSessionId = INITIAL_RESUME; // resume target for the NEXT stream

/* ----------------------------------------------- streaming input (2026-09-01) */
// ONE long-lived query() fed by an async channel of user messages, instead of one query() per
// turn. The payoff is the TUI's own queue behaviour ("encavalar"): a message sent WHILE a turn is
// running is pushed into the live stream and the CLI FOLDS it into the running turn — the model
// absorbs it at its next step. Verified live on SDK 0.3.246: a message pushed mid-turn produced
// ONE result whose final answer already honoured it (see docs/sdk-driver.md).

function makeChannel() {
  const buf = [];
  let notify = null;
  let done = false;
  return {
    push(m) {
      buf.push(m);
      if (notify) { const n = notify; notify = null; n(); }
    },
    end() {
      done = true;
      if (notify) { const n = notify; notify = null; n(); }
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buf.length) yield buf.shift();
        if (done) return;
        await new Promise((resolve) => { notify = resolve; });
      }
    },
  };
}

function userMessage(text) {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

function baseOptions() {
  const opts = {
    cwd: CWD,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // The SAME configuration the card's TUI session loads, so the native chat has the same tools:
    // "user" brings the profile's managed MCPs (vibehub — whose MCP instructions ARE the maestro
    // persona —, navegador over ${PW_CDP_ENDPOINT}, and every registered one) plus the runner
    // settings (status hooks, session persistence); "project"/"local" bring the worktree's own
    // .mcp.json and settings, honoured without a prompt by the runner's enableAllProjectMcpServers.
    // Explicit rather than the SDK default so a future default flip cannot silently strip the tools.
    settingSources: ["user", "project", "local"],
    // The TUI's system prompt (Claude Code's own), which is also what loads CLAUDE.md — the brain
    // at the profile root and the repo's. Without it the driver ran on the bare SDK prompt.
    systemPrompt: { type: "preset", preset: "claude_code" },
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    // AskUserQuestion always lands here (every permission mode) — the chat's question card.
    canUseTool,
  };
  if (MODEL) opts.model = MODEL;
  return opts;
}

let currentQuery = null; // the live query() iterator, so an interrupt can reach it mid-turn
let channel = null; // feeds the live query's prompt stream (null = no stream running)
let turnActive = false; // a turn is running, or a message is already fed and about to start one
let announcedSessionId = null; // last session id emitted as a `session` event (dedupe)

async function runStream() {
  const options = baseOptions();
  if (lastSessionId) options.resume = lastSessionId;
  const myChannel = channel;
  try {
    currentQuery = query({ prompt: myChannel, options });
    for await (const msg of currentQuery) {
      if (msg.type === "system" && msg.session_id) {
        // Streaming mode delivers MANY system messages per turn (init, hooks…), all carrying the
        // session id — announce it only when it actually changes, not once per hook.
        if (msg.session_id !== announcedSessionId) {
          announcedSessionId = msg.session_id;
          emit({ type: "session", sessionId: msg.session_id });
        }
        lastSessionId = msg.session_id;
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          emit({ type: "assistant_delta", text: ev.delta.text });
        }
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") emit({ type: "assistant_text", text: block.text });
          else if (block.type === "tool_use") emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      } else if (msg.type === "result") {
        // In streaming input mode the CLI emits ONE result per turn and keeps running — the
        // stream stays open for the next message. Absorbed sends never produce their own result.
        if (msg.session_id) lastSessionId = msg.session_id;
        turnActive = false;
        emit({ type: "result", subtype: msg.subtype, isError: !!msg.is_error,
          sessionId: msg.session_id, result: msg.result, permissionDenials: msg.permission_denials });
      }
    }
  } catch (err) {
    emit({ type: "error", message: err && err.message ? err.message : String(err) });
  } finally {
    // The STREAM died (an SDK error, a teardown mid-stream — never a normal turn end, which keeps
    // the stream open). A turn can therefore END without a result, and the front's "Trabalhando…"
    // only clears on a result/error/ready — a turn that ended silently left it spinning FOREVER (a
    // real incident) — while the backend MANAGER counts turns by their `result` events to know
    // when the driver is idle. Whatever killed the stream, an open turn closes itself here; the
    // NEXT user message starts a fresh stream that resumes the same session (lastSessionId).
    if (turnActive) {
      turnActive = false;
      emit({ type: "result", subtype: "aborted", isError: false, sessionId: lastSessionId });
    }
    if (channel === myChannel) channel = null;
    currentQuery = null;
  }
}

function sendUser(text) {
  if (!channel) {
    channel = makeChannel();
    void runStream();
  }
  const absorbed = turnActive;
  turnActive = true;
  channel.push(userMessage(text));
  // Tell the SURVIVING side what happened to this send: absorbed = it folds into the turn already
  // running (or coalesces with a queued one) and will NOT produce its own result — the manager
  // takes back this send's +1 on its turn count, and the front labels the bubble ("entrou no
  // turno em andamento"). Emitted AFTER the push so a result racing past can never precede it.
  if (absorbed) emit({ type: "turn_absorbed" });
}

/* ------------------------------------------------------------- stdin */

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let control;
  try {
    control = JSON.parse(trimmed);
  } catch {
    emit({ type: "error", message: "driver received a non-JSON control line" });
    return;
  }
  if (control && control.type === "user" && typeof control.text === "string") {
    sendUser(control.text);
    return;
  }
  if (control && control.type === "permission_decision" && typeof control.id === "string") {
    if (!resolvePermission(control.id, control.allow === true)) {
      emit({ type: "error", message: `no pending permission request with id ${control.id}` });
    }
    return;
  }
  if (control && control.type === "question_answer" && typeof control.id === "string" && Array.isArray(control.answers)) {
    if (!resolveQuestion(control.id, control.answers)) {
      emit({ type: "error", message: `no pending question with id ${control.id}` });
    }
    return;
  }
  if (control && control.type === "interrupt") {
    // Deny anything still waiting for a click (the turn it belongs to is being killed), then
    // interrupt the SDK. With streaming input every send is already IN the CLI (no driver-side
    // queue): the interrupt aborts the running turn; a send still queued CLI-side (pushed in the
    // last instant, not yet folded in) can survive it and run as its own turn — its result is one
    // more `result` frame, which the manager's floor-at-zero accounting absorbs.
    for (const id of [...pendingPermissions.keys()]) resolvePermission(id, false);
    for (const id of [...pendingQuestions.keys()]) resolveQuestion(id, null);
    if (currentQuery && typeof currentQuery.interrupt === "function") {
      currentQuery.interrupt().catch((err) => {
        emit({ type: "error", message: "interrupt failed: " + (err && err.message ? err.message : String(err)) });
      });
    }
    return;
  }
});
rl.on("close", () => process.exit(0));

emit({ type: "ready", resume: INITIAL_RESUME });
