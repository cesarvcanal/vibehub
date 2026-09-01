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
// AUTH IS THE OAUTH TOKEN, PERIOD (ordem do César): the spawn command exports
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

let lastSessionId = INITIAL_RESUME; // resume target for the NEXT turn
let busy = false;
const queue = [];

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
  };
  if (MODEL) opts.model = MODEL;
  return opts;
}

let currentQuery = null; // the live query() iterator, so an interrupt can reach it mid-turn

async function runTurn(text) {
  const options = baseOptions();
  if (lastSessionId) options.resume = lastSessionId;
  let closed = false; // did this turn emit its own end (a result, or an error)?
  try {
    currentQuery = query({ prompt: text, options });
    for await (const msg of currentQuery) {
      if (msg.type === "system" && msg.session_id) {
        lastSessionId = msg.session_id;
        emit({ type: "session", sessionId: msg.session_id });
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
        if (msg.session_id) lastSessionId = msg.session_id;
        closed = true;
        emit({ type: "result", subtype: msg.subtype, isError: !!msg.is_error,
          sessionId: msg.session_id, result: msg.result, permissionDenials: msg.permission_denials });
      }
    }
  } catch (err) {
    emit({ type: "error", message: err && err.message ? err.message : String(err) });
  } finally {
    // A turn can END without a result: `interrupt()` just stops the iterator, a stalled query can
    // be torn down mid-stream, and an SDK error only produces the `error` event above. The front's
    // "Trabalhando…" only clears on a result/error/ready — a turn that ends silently left it
    // spinning FOREVER (the César incident) — and the backend MANAGER counts turns by their
    // `result` events to know when the driver is idle. Every turn now closes itself with a result,
    // whatever ended it.
    if (!closed) emit({ type: "result", subtype: "aborted", isError: false, sessionId: lastSessionId });
    currentQuery = null;
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const text = queue.shift();
    await runTurn(text);
  }
  busy = false;
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
    queue.push(control.text);
    void pump();
    return;
  }
  if (control && control.type === "permission_decision" && typeof control.id === "string") {
    if (!resolvePermission(control.id, control.allow === true)) {
      emit({ type: "error", message: `no pending permission request with id ${control.id}` });
    }
    return;
  }
  if (control && control.type === "interrupt") {
    // Abandon anything still queued (the interrupt means "stop what you are doing"), deny anything
    // still waiting for a click (the turn it belongs to is being killed), then interrupt the SDK.
    queue.length = 0;
    for (const id of [...pendingPermissions.keys()]) resolvePermission(id, false);
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
