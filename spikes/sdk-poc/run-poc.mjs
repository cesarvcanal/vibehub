// SDK PoC harness for vibehub — throwaway spike. See FINDINGS.md.
//
// Proves whether an Agent SDK session can replace the tmux/send-keys TUI:
//  (1) structured streaming (assistant text deltas + tool_use),
//  (2) canUseTool as a programmatic allow/deny callback that the agent honors,
//  (3) resume by session id,
//  (4) a real file edit + command,
//  (5) bypassPermissions => canUseTool is NOT called (auto-allow),
//  and it captures the REAL event shapes it observes.
//
// Run INSIDE the vibehub-runner with CLAUDE_CODE_OAUTH_TOKEN exported.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";

const WORK = "/tmp/poc-work";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const log = [];
const rec = (scenario, kind, data) => log.push({ scenario, kind, t: Date.now(), ...data });
const seenEventTypes = new Set();
const seenPartialTypes = new Set();

// Compact view of what the chat UI would render from a message stream.
function observe(scenario, msg) {
  seenEventTypes.add(msg.type);
  if (msg.type === "stream_event") {
    const ev = msg.event;
    seenPartialTypes.add(ev?.type + (ev?.delta?.type ? `:${ev.delta.type}` : ""));
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      process.stdout.write(ev.delta.text);
    }
    rec(scenario, "stream_event", { evType: ev?.type, deltaType: ev?.delta?.type });
  } else if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "tool_use") {
        rec(scenario, "tool_use", { id: block.id, name: block.name, input: block.input });
        console.log(`\n  [assistant tool_use] ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
      } else if (block.type === "text") {
        rec(scenario, "assistant_text", { text: block.text });
      }
    }
  } else if (msg.type === "result") {
    rec(scenario, "result", {
      subtype: msg.subtype, is_error: msg.is_error,
      session_id: msg.session_id, result: msg.result,
      num_turns: msg.num_turns, permission_denials: msg.permission_denials,
    });
  } else if (msg.type === "system") {
    rec(scenario, "system", { subtype: msg.subtype, session_id: msg.session_id, model: msg.model });
  }
}

// -------- canUseTool policy: allow Write/Read, allow safe Bash, DENY rm --------
const permCalls = [];
const policy = async (toolName, input) => {
  const cmd = typeof input?.command === "string" ? input.command : "";
  const deny = toolName === "Bash" && /\brm\b/.test(cmd);
  const decision = deny
    ? { behavior: "deny", message: "PoC policy: rm is blocked by the chat button." }
    : { behavior: "allow", updatedInput: input };
  permCalls.push({ toolName, cmd: cmd || undefined, decision: decision.behavior });
  console.log(`\n  [canUseTool] ${toolName} -> ${decision.behavior}${cmd ? `  cmd=${cmd}` : ""}`);
  return decision;
};

async function drain(scenario, q) {
  let sessionId = null;
  for await (const msg of q) {
    observe(scenario, msg);
    if (msg.type === "system" && msg.session_id) sessionId = msg.session_id;
    if (msg.type === "result" && msg.session_id) sessionId = msg.session_id;
  }
  return sessionId;
}

const results = {};

// ===== Scenario A: streaming + canUseTool allow/deny + real task =====
console.log("\n\n===== SCENARIO A: stream + canUseTool (allow Write/Read, deny rm) + real task =====");
const promptA =
  `Do exactly these steps in ${WORK}, one tool at a time, no questions:\n` +
  `1) Use the Write tool to create ${WORK}/hello.txt with the exact content HELLO_FROM_SDK\n` +
  `2) Use the Read tool to read ${WORK}/hello.txt back\n` +
  `3) Use the Bash tool to run: rm ${WORK}/hello.txt\n` +
  `Then tell me in one line whether step 3 succeeded or was blocked.`;

const sessionA = await drain("A", query({
  prompt: promptA,
  options: {
    cwd: WORK,
    includePartialMessages: true,
    canUseTool: policy,
    allowedTools: ["Write", "Read", "Bash"],
    // default permission mode: canUseTool is the arbiter
  },
}));
results.A = {
  sessionId: sessionA,
  permCalls,
  fileStillExists: existsSync(`${WORK}/hello.txt`),
};
console.log(`\n  -> sessionId=${sessionA}  file_still_exists=${results.A.fileStillExists}`);

// ===== Scenario B: RESUME the same session by id =====
console.log("\n\n===== SCENARIO B: resume session " + sessionA + " =====");
let bText = "";
for await (const msg of query({
  prompt: "Without using any tool, tell me: what exact content did you write into hello.txt earlier, and what was the file's name?",
  options: { resume: sessionA, includePartialMessages: false, cwd: WORK, canUseTool: policy },
})) {
  observe("B", msg);
  if (msg.type === "assistant") for (const b of msg.message.content) if (b.type === "text") bText += b.text;
  if (msg.type === "result") results.B = { sessionId: msg.session_id, result: msg.result };
}
results.B = results.B || {};
results.B.remembered = /HELLO_FROM_SDK/.test(bText) && /hello\.txt/.test(bText);
console.log(`\n  -> resumed sessionId=${results.B.sessionId}  remembered_context=${results.B.remembered}`);

// ===== Scenario C: bypassPermissions -> canUseTool NOT called =====
console.log("\n\n===== SCENARIO C: bypassPermissions (auto-allow) — does canUseTool fire? =====");
const bypassCalls = [];
const bypassPolicy = async (toolName, input) => {
  bypassCalls.push({ toolName });
  return { behavior: "allow", updatedInput: input };
};
const sessionC = await drain("C", query({
  prompt: `Use the Write tool to create ${WORK}/bypass.txt with content BYPASS_OK. Then say done.`,
  options: {
    cwd: WORK,
    includePartialMessages: true,
    canUseTool: bypassPolicy,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: ["Write", "Bash", "Read"],
  },
}));
results.C = {
  sessionId: sessionC,
  canUseToolCalls: bypassCalls.length,
  bypassFileExists: existsSync(`${WORK}/bypass.txt`),
};
console.log(`\n  -> canUseTool fired ${bypassCalls.length} time(s); bypass.txt exists=${results.C.bypassFileExists}`);

// ===== summary =====
const summary = {
  sdk: "@anthropic-ai/claude-agent-sdk",
  observedTopLevelMessageTypes: [...seenEventTypes].sort(),
  observedStreamEventTypes: [...seenPartialTypes].sort(),
  scenarioA: results.A,
  scenarioB: results.B,
  scenarioC: results.C,
};
writeFileSync(`${WORK}/poc-events.json`, JSON.stringify(log, null, 2));
writeFileSync(`${WORK}/poc-summary.json`, JSON.stringify(summary, null, 2));
console.log("\n\n===== SUMMARY =====");
console.log(JSON.stringify(summary, null, 2));
