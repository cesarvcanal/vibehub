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

// Mirror de `supersedeAll` / QUESTION_SUPERSEDED_MESSAGE em protocol.ts.
//
// A pessoa não clicou: ela ESCREVEU. Enquanto um cartão de pergunta está de pé, o turno está parado
// dentro do `canUseTool` — a mensagem nova entra na fila do CLI e fica lá, sem ninguém para lê-la,
// até o timeout de 30 minutos. Era o "mando a mensagem e não acontece nada, fica preso nessa tela".
// Falar é responder: a mensagem libera o cartão e passa a valer no lugar dele.
function supersedePendingQuestions() {
  const waiting = pendingQuestions.size;
  for (const deliver of [...pendingQuestions.values()]) {
    deliver({ answers: null, timedOut: false, superseded: true });
  }
  pendingQuestions.clear();
  return waiting;
}

const QUESTION_SUPERSEDED_MESSAGE =
  "The user did not pick any of the options: they answered by sending a message in the chat instead. " +
  "That message is in this conversation — read it and follow it. It SUPERSEDES this question, " +
  "so do not ask it again unless their message leaves you genuinely unable to proceed.";

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
  const { answers, timedOut, superseded } = await waitQuestion(id);
  if (!answers) {
    emit({ type: "question_result", id, timedOut: !!timedOut, superseded: !!superseded });
    return { behavior: "deny", message: timedOut
      ? "The user did not answer the question within 30 minutes. Continue with your best judgment and note the open question."
      : superseded
        ? QUESTION_SUPERSEDED_MESSAGE
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
    // O RACIOCÍNIO, ao vivo. `display: "summarized"` não é opcional: nos modelos atuais o padrão é
    // "omitted", e aí os blocos de thinking CHEGAM VAZIOS — o driver encaminharia string vazia e a
    // tela continuaria só com o spinner. Adaptive deixa o modelo decidir quando (e quanto) pensar.
    thinking: { type: "adaptive", display: "summarized" },
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

/* ------------------------------------------- the command catalogue (the chat's "/") */
// What the TUI shows when you press "/": every skill, plugin command, project command and built-in
// this session can run. The CLI already resolved all of it — `init` names the skills, the plugins
// and the terminal-only commands, and `supportedCommands()` adds each one's description and
// argument hint. The driver forwards it RAW; the back normalises and caps it (protocol.ts
// `normalizeSlashCommands`) before any of it reaches a browser.

let lastInit = null; // the newest `init` — where the skill/plugin/terminal-only lists come from
let catalogAnnounced = false; // the catalogue was asked for once; `commands_changed` refreshes it

/** A mid-session change (a skill discovered as the agent walks into a subdirectory). */
function emitCatalogChanged(commands) {
  if (!Array.isArray(commands)) return;
  emit({
    type: "catalog",
    commands,
    skills: lastInit?.skills,
    plugins: lastInit?.plugins,
    hidden: lastInit?.terminal_slash_commands,
  });
}

/** Emit the catalogue for an `init` message. Never throws: a chat without a menu still works. */
async function emitCatalogFrom(init, queryHandle) {
  try {
    const commands = await queryHandle.supportedCommands();
    emit({
      type: "catalog",
      commands,
      skills: init?.skills,
      plugins: init?.plugins,
      hidden: init?.terminal_slash_commands,
    });
  } catch (err) {
    // The list is a convenience, not the conversation — say it in stderr, and let the NEXT init
    // try again (a catalogue that failed once must not leave the chat without a menu forever).
    catalogAnnounced = false;
    process.stderr.write(`catalog unavailable: ${err && err.message ? err.message : String(err)}\n`);
  }
}

/**
 * O MENU "/" ANTES DA PRIMEIRA MENSAGEM (produção, 26/09/2026: card novo, digitar "/code-re" não
 * oferecia nada). O catálogo só chegava pelo `init`, e o `init` só existe quando um turno começa —
 * ou seja, num card recém-aberto o menu ficava vazio justamente na hora em que a pessoa quer
 * escolher um comando.
 *
 * O CLI responde `supportedCommands()` sem nenhum turno (verificado contra o SDK 0.3.246 antes
 * desta linha existir), então o driver sobe uma consulta DESCARTÁVEL só para perguntar isso e a
 * encerra em seguida. Três cuidados:
 *
 *  - `VIBEHUB_STATUS_URL` vai VAZIO: os hooks de status do runner disparam no SessionStart desta
 *    consulta, e um card sem turno nenhum não pode sair mandando status pro painel;
 *  - nada de `resume`: é uma sessão jogada fora, e resumir a conversa real aqui seria carregá-la
 *    por nada;
 *  - `catalogAnnounced` fica FALSO: este catálogo é provisório (sem as listas do `init`, todo
 *    comando aparece como "comando"), e o primeiro `init` de verdade o substitui com os rótulos
 *    certos — skill, plugin, e os comandos que só fazem sentido num terminal, escondidos.
 */
let warmChannel = null;
async function warmCatalog() {
  if (catalogAnnounced || channel || warmChannel) return;
  const ch = makeChannel();
  warmChannel = ch;
  try {
    const options = baseOptions();
    options.env = { ...process.env, VIBEHUB_STATUS_URL: "" };
    const handle = query({ prompt: ch, options });
    // A consulta só ganha vida sendo iterada — e nada do que ela diz interessa: o único objetivo é
    // ter um CLI de pé para responder a pergunta abaixo.
    void (async () => { try { for await (const _ of handle) { /* descartado */ } } catch { /* idem */ } })();
    const commands = await handle.supportedCommands();
    // Um turno de verdade começou no meio disso: o `init` dele traz o catálogo completo, e este
    // aqui — sem rótulos — não tem por que passar na frente.
    if (!catalogAnnounced && !channel && Array.isArray(commands)) emit({ type: "catalog", commands });
  } catch (err) {
    process.stderr.write(`warm catalog unavailable: ${err && err.message ? err.message : String(err)}\n`);
  } finally {
    ch.end(); // fecha a corrente de entrada: sem mais mensagens, o CLI descartável sai sozinho
    warmChannel = null;
  }
}

let currentQuery = null; // the live query() iterator, so an interrupt can reach it mid-turn
let channel = null; // feeds the live query's prompt stream (null = no stream running)
let turnActive = false; // a turn is running, or a message is already fed and about to start one
let announcedSessionId = null; // last session id emitted as a `session` event (dedupe)

/* ------------------------------------------------- rewind (editar = voltar no tempo) */
// Editing a message REWINDS the conversation: the session resumes at the point right before that
// message and everything after it — the half answer, the tools it ran, the message itself — stops
// existing for the model. That is what `resumeSessionAt` does (verified against the SDK before
// this was written: forking at the kept turn's ASSISTANT uuid brings the old answer back, forking
// at the `result` uuid is rejected with `error_during_execution`).
//
// Two things have to be true for a rewind, and when either is not, the driver falls back to the
// SUPERSEDE it always did (a new turn saying "disregard that, this stands") rather than guess:
//
//  - there must BE a point to go back to (an assistant message and a session id);
//  - nothing may have been ABSORBED into the running turn since then. This is the one that would
//    lose data: vibehub lets a second message join a turn already in flight, and a rewind past
//    that point would discard it with no trace and no bubble. The SDK's own `resumeDropsTurn`
//    guard exists for exactly this case; the driver cannot use it (it never sees the prompt uuid
//    of its own sends), so it refuses the rewind instead.

/** The last assistant message's uuid — the only chain entry the CLI accepts as a fork point. */
let lastAssistantUuid = null;
/** Where a rewind of the LAST user message would land: the fork point captured when it was sent. */
let forkPoint = null;
/** A send joined the turn in flight since `forkPoint` — rewinding past it would drop that message. */
let absorbedSinceFork = false;
/** Set for ONE stream: the chain entry that stream must resume at (and truncate after). */
let pendingResumeAt = null;

/**
 * MAY this edit rewind? The whole safety of the feature is these three lines, so they are a pure
 * function of the three pieces of state that decide it — testable without a session, a CLI or a
 * clock (see driver.test.ts, which runs this very function).
 *
 *  - no session id: there is no conversation on disk to resume, so there is nothing to go back to;
 *  - no fork point: nothing has been answered yet, so the message being edited is the first thing
 *    in the session and a "rewind" would be a resume of nothing;
 *  - absorbed: a message joined the turn in flight AFTER the one being edited. Rewinding past it
 *    would discard it with no bubble, no history row and no way to get it back — and it is a
 *    message a PERSON wrote. Refusing here is the difference between a feature and a data loss.
 *
 * PURE, TOTAL.
 */
function rewindDecision(sessionId, fork, absorbed) {
  if (!sessionId || !fork) return { rewind: false, reason: "no-fork-point" };
  if (absorbed) return { rewind: false, reason: "absorbed" };
  return { rewind: true };
}

async function runStream() {
  const options = baseOptions();
  if (lastSessionId) options.resume = lastSessionId;
  if (pendingResumeAt && lastSessionId) {
    // The rewind itself: resume this session only up to that entry. Consumed here — one stream,
    // one truncation; the streams after it continue normally from the new tip.
    options.resumeSessionAt = pendingResumeAt;
  }
  pendingResumeAt = null;
  const myChannel = channel;
  try {
    currentQuery = query({ prompt: myChannel, options });
    for await (const msg of currentQuery) {
      if (msg.type === "system") {
        if (msg.session_id) {
          // Streaming mode delivers MANY system messages per turn (init, hooks…), all carrying the
          // session id — announce it only when it actually changes, not once per hook.
          if (msg.session_id !== announcedSessionId) {
            announcedSessionId = msg.session_id;
            emit({ type: "session", sessionId: msg.session_id });
          }
          lastSessionId = msg.session_id;
        }
        if (msg.subtype === "init") {
          // `init` repeats on EVERY turn; the catalogue is asked for once (a control round-trip per
          // turn would buy nothing) and refreshed by `commands_changed` when it actually moves.
          lastInit = msg;
          if (!catalogAnnounced) {
            catalogAnnounced = true;
            void emitCatalogFrom(msg, currentQuery);
          }
        } else if (msg.subtype === "commands_changed") {
          emitCatalogChanged(msg.commands);
        } else if (msg.subtype === "local_command_output" && typeof msg.content === "string") {
          // A command the CLI answers itself (/cost, /usage): no turn, no assistant message — the
          // answer exists ONLY here, and swallowing it makes the command look broken.
          if (msg.content.trim() !== "") emit({ type: "local_output", text: msg.content });
        }
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          emit({ type: "assistant_delta", text: ev.delta.text });
        } else if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "thinking_delta") {
          // O campo é `thinking`, não `text` (ThinkingDelta da Messages API).
          if (ev.delta.thinking) emit({ type: "thinking_delta", text: ev.delta.thinking });
        }
      } else if (msg.type === "assistant") {
        // The fork point a later rewind will use. Recorded for EVERY assistant message, so the
        // point is always the tip of the last completed answer.
        if (msg.uuid) lastAssistantUuid = msg.uuid;
        for (const block of msg.message.content) {
          if (block.type === "text") emit({ type: "assistant_text", text: block.text });
          // `redacted_thinking` não entra aqui de propósito: ele não carrega texto legível (só o
          // payload cifrado), então não há o que mostrar — emitir uma linha vazia seria pior que
          // nada. Um bloco vazio também é descartado: o spinner já diz que há trabalho em curso.
          else if (block.type === "thinking") { if (block.thinking) emit({ type: "thinking", text: block.thinking }); }
          else if (block.type === "tool_use") emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      } else if (msg.type === "result") {
        // In streaming input mode the CLI emits ONE result per turn and keeps running — the
        // stream stays open for the next message. Absorbed sends never produce their own result.
        if (msg.session_id) lastSessionId = msg.session_id;
        turnActive = false;
        void clearUltra(); // the keyword was for THIS turn
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
    // The next stream is a NEW CLI process: whatever we pinned in this one's flag layer died with
    // it, so there is nothing left to give back.
    ultraRaised = null;
  }
}

/* --------------------------------- the reserved words (ultrathink / ultracode) */
// Claude Code treats both as KEYWORDS, not as text: `ultrathink` asks for deeper reasoning on the
// turn it appears in, `ultracode` opts that turn into multi-agent orchestration (the Workflow
// tool). The CLI does that part itself — the driver hands it the text verbatim, keywords included.
//
// What the CLI does NOT do is raise the REASONING LEVEL, and that is what the panel promises when
// it paints the word in the composer. So the driver pins the flag-settings layer to `max` effort
// for the turn the keyword arrived in and clears it again when that turn ends. Flag settings are
// session-scoped and never written to any settings file, so nothing here outlives the driver.
//
// The detection mirrors `front/src/features/board/lib/ultraWords.ts` — the SAME rules, because the
// word only gets painted up there when it will be acted on down here. Keep the two in step.

const ULTRA_CLOSERS = { "`": "`", '"': '"', "<": ">", "{": "}", "[": "]", "(": ")", "'": "'" };
const ULTRA_WORDISH = /[\p{L}\p{N}_]/u;

/** The spans of `text` inside a quote, a bracket or a tag — a keyword in there is being quoted. */
function ultraQuotedSpans(text) {
  const spans = [];
  const wordish = (c) => !!c && ULTRA_WORDISH.test(c);
  let opener = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (opener) {
      if (opener === "[" && c === "[") { from = i; continue; }
      if (c !== ULTRA_CLOSERS[opener]) continue;
      if (opener === "'" && wordish(text[i + 1])) continue;
      spans.push({ start: from, end: i + 1 });
      opener = null;
    } else if (
      (c === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1])) ||
      (c === "'" && !wordish(text[i - 1])) ||
      (c !== "<" && c !== "'" && c in ULTRA_CLOSERS)
    ) {
      opener = c;
      from = i;
    }
  }
  return spans;
}

/** Is this keyword being USED in `text`? Case-insensitive; a path, a flag or a quote does not count. */
function hasUltraKeyword(text, keyword) {
  const source = String(text ?? "");
  if (source.startsWith("/")) return false; // a slash command, not a sentence
  const spans = ultraQuotedSpans(source);
  const wordish = (c) => !!c && ULTRA_WORDISH.test(c);
  for (const m of source.matchAll(new RegExp(`\\b${keyword}\\b`, "gi"))) {
    if (m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (spans.some((s) => start >= s.start && start < s.end)) continue;
    const before = source[start - 1];
    const after = source[end];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
    if (after === "." && wordish(source[end + 1])) continue;
    return true;
  }
  return false;
}

/** What this message asks for, if anything. */
function ultraKeywords(text) {
  const ultrathink = hasUltraKeyword(text, "ultrathink");
  const ultracode = hasUltraKeyword(text, "ultracode");
  return { ultrathink, ultracode, any: ultrathink || ultracode };
}

/**
 * The keys WE pinned in the flag layer, so the give-back clears exactly those and nothing else.
 * `null` while we have pinned nothing. It matters that this is a record and not a boolean: an
 * `ultrathink` turn must not switch off an `ultracode` the session already had.
 */
let ultraRaised = null;

/** How long the first message of a fresh stream waits for the CLI to boot before going anyway. */
const ULTRA_INIT_TIMEOUT_MS = 10_000;

/**
 * Raise the effort for the turn about to start. Best effort in the literal sense: every step is
 * optional and a failure at any of them must NEVER cost the message — an older CLI without
 * `applyFlagSettings`, an account whose plan caps effort below `max`, a session with dynamic
 * workflows switched off (which is what refuses `ultracode`) all fall through to the next weaker
 * attempt and finally to sending the message exactly as it would have gone anyway.
 */
async function raiseUltra(kinds, waitForInit) {
  const handle = currentQuery;
  if (!handle || typeof handle.applyFlagSettings !== "function") return;
  if (waitForInit && typeof handle.initializationResult === "function") {
    // A stream that has only just been created has no CLI behind it yet, and a control request
    // written into nothing is lost. This is the handshake that says the CLI is listening.
    try {
      await Promise.race([
        handle.initializationResult(),
        new Promise((resolve) => setTimeout(resolve, ULTRA_INIT_TIMEOUT_MS)),
      ]);
    } catch { /* boot failed on its own terms; the message still goes */ }
  }
  if (currentQuery !== handle) return; // the stream died while we waited
  // Strongest first. `ultracode` is xhigh PLUS standing workflow orchestration, which is exactly
  // what the keyword means; where the session cannot have it, plain `max` effort still answers
  // "o nível de raciocínio máximo".
  const attempts = kinds.ultracode
    ? [{ effortLevel: "max", ultracode: true }, { effortLevel: "max" }, { effortLevel: "xhigh" }]
    : [{ effortLevel: "max" }, { effortLevel: "xhigh" }];
  for (const settings of attempts) {
    try {
      await handle.applyFlagSettings(settings);
      ultraRaised = settings;
      return;
    } catch { /* try the next, weaker one */ }
  }
}

/** Give the effort back at the end of the turn: the keyword was for THAT turn, not for the session. */
async function clearUltra() {
  const raised = ultraRaised;
  if (!raised) return;
  ultraRaised = null;
  const handle = currentQuery;
  if (!handle || typeof handle.applyFlagSettings !== "function") return;
  try {
    // `null` clears the key from the flag layer, so whatever the user's own settings say takes
    // over again — this restores a level, it does not impose one. Only the keys this driver
    // actually set are cleared: an `ultrathink` turn never touches `ultracode`.
    const give = {};
    for (const key of Object.keys(raised)) give[key] = null;
    await handle.applyFlagSettings(give);
  } catch { /* the stream is gone, and a dead stream has no effort to give back */ }
}

function sendUser(text) {
  const ultra = ultraKeywords(text);
  const fresh = !channel;
  if (fresh) {
    // A consulta descartável do catálogo (se ainda estiver de pé) não tem mais razão de existir —
    // e deixá-la viva gastaria um CLI inteiro ao lado do que vai responder de verdade.
    if (warmChannel) warmChannel.end();
    channel = makeChannel();
    void runStream();
  }
  const myChannel = channel;
  const absorbed = turnActive;
  turnActive = true;
  // Where a rewind of THIS message would land, captured now: the tip of the last finished answer.
  // A message that JOINS a turn already running shares that turn's fork point, and arms the guard
  // — from here on a rewind would take it down with the message being edited.
  if (absorbed) absorbedSinceFork = true;
  else { forkPoint = lastAssistantUuid; absorbedSinceFork = false; }
  if (!ultra.any) {
    myChannel.push(userMessage(text));
  } else if (!fresh) {
    // A live CLI: the control frame is written before the push below, so the effort is already
    // pinned by the time the message reaches the model.
    void raiseUltra(ultra, false);
    myChannel.push(userMessage(text));
  } else {
    // The FIRST message of a fresh stream has to wait for the CLI to exist. The push moves into
    // the continuation — `finally`, so no failure up there can ever swallow the message.
    void (async () => {
      try {
        await raiseUltra(ultra, true);
      } finally {
        myChannel.push(userMessage(text));
      }
    })();
  }
  // Tell the SURVIVING side what happened to this send: absorbed = it folds into the turn already
  // running (or coalesces with a queued one) and will NOT produce its own result — the manager
  // takes back this send's +1 on its turn count, and the front labels the bubble ("entrou no
  // turno em andamento"). Emitted AFTER the push so a result racing past can never precede it.
  if (absorbed) emit({ type: "turn_absorbed" });
}

/**
 * Stops the live stream so the next one can resume somewhere else. Interrupts a running turn,
 * closes the prompt channel and waits for `runStream` to let go of the query — without that wait
 * the new stream would race the old one onto the same session.
 */
async function endStream() {
  const dying = currentQuery;
  const ch = channel;
  if (!dying) return;
  try {
    if (typeof dying.interrupt === "function") await dying.interrupt();
  } catch { /* a turn that was not running cannot be interrupted, and that is fine */ }
  if (ch) ch.end();
  for (let i = 0; i < 120 && currentQuery === dying; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (channel === ch) channel = null;
}

/**
 * EDIT = REWIND. Takes the conversation back to just before the message being edited and sends the
 * corrected one in its place, so the model never saw the original — the behaviour of every chat
 * the user has ever used.
 *
 * `fallback` is the same edit written as a SUPERSEDE (the manager builds it): the text used when a
 * rewind is not safe, which keeps this operation total — an edit ALWAYS reaches the model, as one
 * or as the other. The `rewound` event says which happened, because the screen has to agree with
 * the model about what is still in the conversation.
 */
async function rewindAndSend(text, fallback) {
  const decision = rewindDecision(lastSessionId, forkPoint, absorbedSinceFork);
  if (!decision.rewind) {
    emit({ type: "rewound", ok: false, reason: decision.reason });
    sendUser(typeof fallback === "string" && fallback !== "" ? fallback : text);
    return;
  }
  const at = forkPoint;
  try {
    await endStream();
  } catch {
    // Tearing the old stream down failed — but the edit is a MESSAGE, and a message that does not
    // arrive is the worst outcome available. Give up on the rewind, keep the words.
    emit({ type: "rewound", ok: false, reason: "no-fork-point" });
    sendUser(typeof fallback === "string" && fallback !== "" ? fallback : text);
    return;
  }
  pendingResumeAt = at;
  // The rewind erases what came after this point, so nothing is absorbed into it any more and the
  // next answer becomes the new fork point.
  forkPoint = null;
  absorbedSinceFork = false;
  lastAssistantUuid = at;
  emit({ type: "rewound", ok: true, uuid: at });
  sendUser(text);
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
    // ORDEM IMPORTA: a mensagem entra na corrente ANTES de o cartão ser liberado. Liberar primeiro
    // solta o turno, que pode seguir e responder à pergunta sem nunca ter visto a mensagem nova —
    // exatamente o contrário do que a pessoa pediu ao escrever.
    sendUser(control.text);
    supersedePendingQuestions();
    return;
  }
  if (control && control.type === "edit_user" && typeof control.text === "string") {
    // Same ORDER as a plain user message: the message is on its way before the pending question
    // cards are released, so a turn parked on a question never answers without having read it.
    void rewindAndSend(control.text, control.fallback);
    supersedePendingQuestions();
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

// O menu "/" não espera a primeira mensagem: assim que o driver está de pé, ele pergunta ao CLI
// quais comandos esta sessão tem. Nunca bloqueia o boot — falhou, o chat segue sem menu até o
// primeiro `init`, que é exatamente o comportamento antigo.
void warmCatalog();
