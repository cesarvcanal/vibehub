// SDK PoC harness v2 — the canUseTool proof done right, plus selective-gate-under-bypass.
//
// v1 taught us: bare `allowedTools` entries AND permissionMode 'bypassPermissions' both
// auto-approve a tool BEFORE canUseTool is consulted (SDK emits CLAUDE_SDK_CAN_USE_TOOL_SHADOWED).
// So to make the callback the real arbiter we must NOT pre-allowlist the gated tools.
//
// Scenario D: default permission mode, NO allowedTools => every tool_use hits canUseTool.
//             Allow Write+Read, DENY the `rm` Bash call. Prove the agent OBEYS (file survives).
// Scenario E: bypassPermissions (auto-allow) + a PreToolUse HOOK that denies `rm`.
//             Proves you can still SELECTIVELY gate one tool while auto-allowing the rest.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";

const WORK = "/tmp/poc-work2";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const out = {};

// ---------- Scenario D: canUseTool is the arbiter ----------
console.log("\n===== SCENARIO D: canUseTool arbiter (default mode, no allowlist) =====");
const permCalls = [];
const policy = async (toolName, input) => {
  const cmd = typeof input?.command === "string" ? input.command : "";
  const deny = toolName === "Bash" && /\brm\b/.test(cmd);
  const decision = deny
    ? { behavior: "deny", message: "PoC policy: rm blocked (this is the chat 'Deny' button)." }
    : { behavior: "allow", updatedInput: input };
  permCalls.push({ toolName, cmd: cmd || undefined, decision: decision.behavior });
  console.log(`  [canUseTool] ${toolName} -> ${decision.behavior}${cmd ? ` cmd=${cmd}` : ""}`);
  return decision;
};

let dText = "";
for await (const msg of query({
  prompt:
    `Do these in ${WORK}, one tool per step, do not ask me anything:\n` +
    `1) Write tool: create ${WORK}/hello.txt containing exactly HELLO_FROM_SDK\n` +
    `2) Read tool: read it back\n` +
    `3) Bash tool: run exactly \`rm ${WORK}/hello.txt\`\n` +
    `Finish with one line: did step 3 succeed or was it blocked?`,
  options: { cwd: WORK, canUseTool: policy /* NO allowedTools => callback decides all */ },
})) {
  if (msg.type === "assistant")
    for (const b of msg.message.content) {
      if (b.type === "tool_use") console.log(`  [tool_use] ${b.name} ${JSON.stringify(b.input).slice(0,120)}`);
      if (b.type === "text") dText += b.text;
    }
  if (msg.type === "result") out.D = { subtype: msg.subtype, result: msg.result, permission_denials: msg.permission_denials, session_id: msg.session_id };
}
out.D = { ...out.D, permCalls, fileSurvived: existsSync(`${WORK}/hello.txt`), finalText: dText.trim() };
console.log(`  -> fileSurvived=${out.D.fileSurvived}  denials=${JSON.stringify(out.D.permission_denials)}`);

// ---------- Scenario E: bypass + PreToolUse hook selective gate ----------
console.log("\n===== SCENARIO E: bypassPermissions + PreToolUse hook denies rm only =====");
const hookHits = [];
const preToolUse = async (input) => {
  const name = input.tool_name;
  const cmd = input.tool_input?.command ?? "";
  const block = name === "Bash" && /\brm\b/.test(cmd);
  hookHits.push({ name, cmd: cmd || undefined, block });
  console.log(`  [PreToolUse hook] ${name} ${cmd ? `cmd=${cmd} ` : ""}-> ${block ? "DENY" : "allow"}`);
  if (block)
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "PoC hook: rm blocked under bypass." } };
  return {};
};

for await (const msg of query({
  prompt:
    `In ${WORK}, do one tool per step, no questions:\n` +
    `1) Write tool: create ${WORK}/keep.txt containing KEEP_ME\n` +
    `2) Bash tool: run exactly \`rm ${WORK}/keep.txt\`\n` +
    `Finish with one line: did the rm succeed or was it blocked?`,
  options: {
    cwd: WORK,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
  },
})) {
  if (msg.type === "assistant")
    for (const b of msg.message.content) if (b.type === "tool_use") console.log(`  [tool_use] ${b.name} ${JSON.stringify(b.input).slice(0,120)}`);
  if (msg.type === "result") out.E = { subtype: msg.subtype, result: msg.result, permission_denials: msg.permission_denials };
}
out.E = { ...out.E, hookHits, keepSurvived: existsSync(`${WORK}/keep.txt`) };
console.log(`  -> keepSurvived=${out.E.keepSurvived}  hookHits=${hookHits.length}`);

writeFileSync(`${WORK}/poc2-summary.json`, JSON.stringify(out, null, 2));
console.log("\n===== SUMMARY v2 =====\n" + JSON.stringify(out, null, 2));
