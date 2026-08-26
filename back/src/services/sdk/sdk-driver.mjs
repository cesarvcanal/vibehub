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
// Permission model (increment 1): permissionMode "bypassPermissions" auto-allows the bulk; a
// PreToolUse hook DENIES a small SENSITIVE set (rm -rf / force-push / deploy / secret reads). The
// runner's own settings.json allowlist is NOT relied upon (the PoC found bare-name allow entries
// SHADOW the callback) — the driver passes its own hook, which fires regardless.

import { createInterface } from "node:readline";

/* --------------------------------------------------------------- argv */

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const CWD = argOf("--cwd") || process.cwd();
const INITIAL_RESUME = argOf("--resume"); // a stored session_id to continue on the first message
const MODEL = argOf("--model");

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

// PreToolUse hook: auto-allow the bulk, deny the sensitive set. Emits a `permission` event either
// way so the front (increment 2) can render it and, later, escalate the deny to a button.
async function preToolUse(input) {
  const name = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const sensitive = classifySensitivity(name, toolInput);
  if (sensitive) {
    emit({ type: "permission", tool: name, decision: "deny", sensitive: true,
      reason: "vibehub SDK driver blocked a sensitive action (increment 1 denies rm -rf / force-push / deploy / secret-reads pending the chat permission button)." });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: "Blocked by vibehub SDK driver (sensitive action, pending permission UI)." } };
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
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
  };
  if (MODEL) opts.model = MODEL;
  return opts;
}

async function runTurn(text) {
  const options = baseOptions();
  if (lastSessionId) options.resume = lastSessionId;
  try {
    for await (const msg of query({ prompt: text, options })) {
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
        emit({ type: "result", subtype: msg.subtype, isError: !!msg.is_error,
          sessionId: msg.session_id, result: msg.result, permissionDenials: msg.permission_denials });
      }
    }
  } catch (err) {
    emit({ type: "error", message: err && err.message ? err.message : String(err) });
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
  }
  // interrupt / other control types: reserved for increment 2.
});
rl.on("close", () => process.exit(0));

emit({ type: "ready", resume: INITIAL_RESUME });
