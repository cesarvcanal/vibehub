/**
 * SDK DRIVER PROTOCOL — the pure contract shared by the driver process (runs in the runner) and the
 * back service that bridges it. The driver writes NEWLINE-DELIMITED JSON on stdout; the back parses
 * each line into a `DriverEvent` and relays it to the front over the `/api/cards/:id/sdk` websocket.
 *
 * Nothing here has side effects — it is types, a line parser, and the permission classifier. The
 * driver embeds a COPY of `classifySensitivity`/`sdkPermissionDecision` (an .mjs cannot import from
 * the compiled back), so this file is the CANONICAL spec and the unit-tested source of truth; keep
 * `sdk-driver.mjs`'s inline copy in step with it.
 */

/* ------------------------------------------------------------------ events */

/** A block of assistant text (consolidated, from an `assistant` message). */
export interface AssistantTextEvent { type: "assistant_text"; text: string }
/** A live text delta (only when the driver runs with partial messages on). */
export interface AssistantDeltaEvent { type: "assistant_delta"; text: string }
/**
 * O RACIOCÍNIO do modelo (bloco `thinking` consolidado) e o seu delta ao vivo.
 *
 * Por que existe: enquanto o agente trabalha, a tela só mostrava um spinner com "Trabalhando…" —
 * podia ser meio segundo ou dez minutos, e quem esperava não tinha como saber se ele estava no
 * caminho certo. O raciocínio é a única coisa que o modelo produz ANTES da resposta, então é ele
 * que transforma a espera em acompanhamento.
 *
 * NÃO é persistido no histórico (veja `replayableHistoryEvent`): é orientação do momento, como o
 * `turn_absorbed`. O que fica em disco é a conversa — mensagem, ferramenta, resposta.
 */
export interface ThinkingEvent { type: "thinking"; text: string }
export interface ThinkingDeltaEvent { type: "thinking_delta"; text: string }
/** A tool call the agent is about to run (or ran). */
export interface ToolUseEvent { type: "tool_use"; id: string; name: string; input: unknown }
/** The session id — emitted as soon as the driver learns it, and again on the result. */
export interface SessionEvent { type: "session"; sessionId: string }
/** A permission decision the driver's PreToolUse gate made (observability + the escalation's outcome). */
export interface PermissionEvent {
  type: "permission";
  tool: string;
  decision: "allow" | "deny";
  sensitive: boolean;
  reason?: string;
  /** Present when the decision answers a `permission_request` (the same id), so the front can pair them. */
  id?: string;
  /** True when the deny happened because nobody answered within the timeout. */
  timedOut?: boolean;
}
/**
 * A SENSITIVE tool call is waiting for the human: the driver pauses the agent (the PreToolUse hook
 * awaits) until a `permission_decision` control with this `id` arrives on stdin — or the timeout
 * (PERMISSION_TIMEOUT_MS) denies it. The front renders this as the "Permitir / Negar" card.
 */
export interface PermissionRequestEvent {
  type: "permission_request";
  id: string;
  tool: string;
  input?: unknown;
  reason?: string;
}
/* ------------------------------------------------------- user questions */

/** One selectable option of a question (mirror of AskUserQuestion's option shape). */
export interface UserQuestionOption { label: string; description?: string }
/** One question the agent asked, with its selectable options. */
export interface UserQuestionItem {
  question: string;
  /** Short chip-like title ("Auth", "Deploy"…). */
  header?: string;
  options: UserQuestionOption[];
  /** True = the person may pick several options. */
  multiSelect?: boolean;
}
/**
 * The agent called AskUserQuestion: instead of executing, the driver pauses the turn and asks the
 * HUMAN — the front renders this as a question card with clickable options (plus a free-text
 * "other answer" field). Answered by a `question_answer` control with the same `id`, or the
 * timeout (QUESTION_TIMEOUT_MS) reports "no answer" to the model.
 */
export interface UserQuestionEvent {
  type: "user_question";
  id: string;
  questions: UserQuestionItem[];
}
/** One question's answer: the chosen option labels (free text arrives as one more string). */
export interface UserQuestionAnswer { selected: string[] }
/** How a `user_question` ended — pairs by `id`, so a replayed card can settle. */
export interface QuestionResultEvent {
  type: "question_result";
  id: string;
  answers?: UserQuestionAnswer[];
  /** True when nobody answered within the timeout (the model was told "no answer"). */
  timedOut?: boolean;
  /** A pessoa respondeu POR MENSAGEM em vez de clicar: o cartão foi substituído pelo que ela disse. */
  superseded?: boolean;
}

/**
 * A user send arrived while a turn was ALREADY running: with streaming input the driver pushed it
 * into the live stream and the CLI folds it into the running turn (the model absorbs it at its
 * next step) — it will NOT produce its own `result`. The manager takes back that send's +1 on its
 * turn count; the front labels the bubble ("entrou no turno em andamento") so the message never
 * looks lost. Live-only feedback: it is not replayed (by the time of a replay the turn is history).
 */
export interface TurnAbsorbedEvent { type: "turn_absorbed" }

/** End of a turn. */
export interface ResultEvent {
  type: "result";
  subtype?: string;
  isError: boolean;
  sessionId?: string;
  result?: string;
  permissionDenials?: unknown[];
}
/**
 * ONE invocable command of the card's session — a SKILL, a plugin command, a project command in
 * `.claude/commands/`, or one of Claude Code's own. The CLI already knows all of them (it is what
 * `/` lists in the TUI); the driver merely forwards the list so the chat can offer the same menu.
 */
export interface SlashCommandInfo {
  /** Without the leading slash, as the CLI reports it (`code-review`, `plugin:command`). */
  name: string;
  description?: string;
  /** What comes after the name (`[low|medium|high] [<pr#>]`) — shown as a hint, never sent. */
  argumentHint?: string;
  /** Alternate names that resolve to the same command (`/review` → `/code-review`). */
  aliases?: string[];
  /**
   * WHERE the command comes from, so the menu can group it. `skill` = an Agent Skill (the CLI's
   * init lists them by name), `plugin` = provided by an installed plugin, `command` = everything
   * else (Claude Code's own and the repo's `.claude/commands/`).
   */
  source: "skill" | "plugin" | "command";
}

/**
 * The session's command CATALOGUE, emitted when the driver learns it (the CLI's `init`) and again
 * whenever it changes (`commands_changed` — a skill discovered mid-session). It is STATE, not
 * conversation: never written to the history, always re-sent to a socket that attaches later.
 */
export interface CatalogEvent { type: "catalog"; commands: SlashCommandInfo[] }
/**
 * Output of a LOCAL slash command (`/cost`, `/usage`): the CLI answers it itself, without a model
 * turn. Without this the chat swallowed the answer and the command looked like it did nothing.
 */
export interface LocalOutputEvent { type: "local_output"; text: string }
/** The driver is up and ready to accept the first user message. The back stamps `turnActive` on
 *  every `ready` it sends (real or synthesized on reattach) with the manager's live turn count, so
 *  a view mounting mid-turn knows work is running (reattach mid-turn: Terminal↔Chat during a turn
 *  remounted the view and the "Trabalhando…" spinner never lit). */
export interface ReadyEvent { type: "ready"; resume?: string; turnActive?: boolean }
/** The driver hit an error (SDK threw, auth missing, etc.). */
export interface DriverErrorEvent { type: "error"; message: string }
/** A line that was NOT valid JSON, or an unknown event — surfaced rather than swallowed. */
export interface ParseErrorEvent { type: "parse_error"; raw: string }

export type DriverEvent =
  | AssistantTextEvent
  | AssistantDeltaEvent
  | ThinkingEvent
  | ThinkingDeltaEvent
  | ToolUseEvent
  | SessionEvent
  | PermissionEvent
  | PermissionRequestEvent
  | UserQuestionEvent
  | QuestionResultEvent
  | TurnAbsorbedEvent
  | CatalogEvent
  | LocalOutputEvent
  | ResultEvent
  | ReadyEvent
  | DriverErrorEvent
  | ParseErrorEvent;

/** The event `type` values the driver is allowed to emit (parse_error is synthesised by the back). */
const DRIVER_EVENT_TYPES = new Set([
  "assistant_text",
  "assistant_delta",
  "thinking",
  "thinking_delta",
  "tool_use",
  "session",
  "permission",
  "permission_request",
  "user_question",
  "question_result",
  "turn_absorbed",
  "catalog",
  "local_output",
  "result",
  "ready",
  "error",
]);

/**
 * Parse ONE stdout line from the driver into a `DriverEvent`. A blank line yields null (skip it); a
 * line that is not valid JSON, or whose `type` the back does not recognise, becomes a
 * `parse_error` so nothing is silently dropped. PURE.
 */
export function parseDriverLine(line: string): DriverEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: "parse_error", raw: trimmed };
  }
  if (typeof parsed !== "object" || parsed === null) return { type: "parse_error", raw: trimmed };
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !DRIVER_EVENT_TYPES.has(type)) return { type: "parse_error", raw: trimmed };
  return parsed as DriverEvent;
}

/* ------------------------------------------------------- control (stdin) */

/**
 * A message the front sends TO the driver over stdin (one JSON object per line).
 *
 * `cid` is the browser's DELIVERY RECEIPT id (see `ClientFrameOutcome` in ./manager.ts): it never
 * reaches the driver — `encodeControl` strips it — and exists only so the back can answer
 * "gravei esta mensagem" (`user_ack`) or "não peguei" (`user_nack`). Without it a send into a
 * half-open socket looked identical to a delivered one, and the message vanished on the next F5.
 */
export interface UserControl { type: "user"; text: string; cid?: string }
export interface InterruptControl { type: "interrupt" }
/** The human's answer to a `permission_request` — `id` pairs it with the awaiting call. */
export interface PermissionDecisionControl { type: "permission_decision"; id: string; allow: boolean }
/** The human's answer to a `user_question` — one entry per question, in order. */
export interface QuestionAnswerControl { type: "question_answer"; id: string; answers: UserQuestionAnswer[] }
/**
 * The user EDITED a message he already sent — a SUPERSEDE, not a rewrite of the past: the model
 * has read the original, so the edit reaches it as a new user turn wrapped by `buildSupersedeText`
 * (the manager does the wrapping — the driver only ever sees a normal `user` control). `original`
 * is the message being replaced (how the front marks it "editada"), `text` the version that now
 * stands. Provenance stays the USER's: it is his speech, corrected.
 */
export interface EditUserControl { type: "edit_user"; original: string; text: string; cid?: string }
export type DriverControl =
  | UserControl
  | InterruptControl
  | PermissionDecisionControl
  | QuestionAnswerControl
  | EditUserControl;

/**
 * The supersede wrapper an EDITED message wears on its way to the MODEL. The original was already
 * read — pretending it never existed would be lying to the context — so the edit says exactly what
 * happened: disregard that version, this one stands. Kept in pt-BR deliberately: it is the user's
 * own speech act, and this panel's users speak pt-BR to their agents. PURE.
 */
export function buildSupersedeText(original: string, text: string): string {
  return (
    `[correção do usuário — desconsidere a mensagem anterior:\n` +
    `«${original}»\n` +
    `e considere esta versão no lugar:]\n\n` +
    text
  );
}

/**
 * Serialise a control message as one stdin line (with the trailing newline). The browser's `cid`
 * is a back↔front receipt id and is STRIPPED here — the driver's protocol knows nothing about it
 * and an unknown field must never travel into the model's input. PURE.
 */
export function encodeControl(control: DriverControl): string {
  const { cid: _cid, ...forDriver } = control as DriverControl & { cid?: string };
  return JSON.stringify(forDriver) + "\n";
}

/** The receipt id the browser stamped on a frame, when it stamped one. PURE. */
export function frameCid(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const cid = (raw as { cid?: unknown }).cid;
  return typeof cid === "string" && cid !== "" && cid.length <= 64 ? cid : undefined;
}

/** Interpret a browser frame as a driver control message. A bare string = a user message. PURE. */
export function parseSdkClientFrame(raw: string): DriverControl | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; text?: unknown; id?: unknown; allow?: unknown };
      if (parsed.type === "interrupt") return { type: "interrupt" };
      if (parsed.type === "user" && typeof parsed.text === "string") return { type: "user", text: parsed.text, cid: frameCid(parsed) };
      if (parsed.type === "permission_decision" && typeof parsed.id === "string" && typeof parsed.allow === "boolean") {
        return { type: "permission_decision", id: parsed.id, allow: parsed.allow };
      }
      if (parsed.type === "question_answer" && typeof parsed.id === "string") {
        const answers = parseQuestionAnswers((parsed as { answers?: unknown }).answers);
        if (answers) return { type: "question_answer", id: parsed.id, answers };
      }
      if (
        parsed.type === "edit_user" &&
        typeof (parsed as { original?: unknown }).original === "string" &&
        typeof parsed.text === "string" &&
        parsed.text.trim() !== ""
      ) {
        return { type: "edit_user", original: (parsed as { original: string }).original, text: parsed.text, cid: frameCid(parsed) };
      }
      return null;
    } catch {
      // not JSON — fall through and treat as a bare user message
    }
  }
  return { type: "user", text: raw };
}

/* ------------------------------------------------------ permission gate */

/**
 * The SENSITIVE set — actions this increment REFUSES to auto-run because a mistake is destructive or
 * exfiltrating. Matched against a Bash command string (the only tool whose payload is a shell line).
 *
 * Increment 2: each of these ESCALATES to a "Permitir / Negar" card in the chat — the driver's
 * PreToolUse hook emits a `permission_request` and AWAITS the human's `permission_decision` (see
 * `createPermissionBroker`); the timeout denies. The bulk of tools auto-allow (bypass sandbox) —
 * the maintainer chose to allow everything and ask only for the sensitive set.
 */
export const SENSITIVE_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i, // rm -r / rm -f / rm -rf (recursive or forced delete)
  /\bgit\s+push\b.*(--force|-f\b)/i, // force-push (history rewrite)
  /\bgit\s+push\b.*\+/i, // git push origin +branch (forced refspec)
  /\bgit\s+reset\s+--hard\b/i, // discards work
  /\b(kubectl|helm|docker|systemctl|serverless|sls|vercel|netlify|fly|flyctl|heroku)\b.*\b(deploy|apply|rollout|up|delete|destroy|down|prune)\b/i,
  /\bnpm\s+publish\b/i,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, // curl | sh (remote code exec)
  /(^|[^\w])(cat|less|head|tail|grep|printenv|env)\b[^\n]*(\.env|id_rsa|id_ed25519|credentials|secret|\.oauth-token|\.vibehub-token)/i,
] as const;

/** Tools whose raw name is sensitive regardless of input (destructive/deploy-shaped, no shell line). */
export const SENSITIVE_TOOLS: readonly string[] = ["KillShell"] as const;

/**
 * Is this tool call in the SENSITIVE set? Reads `input.command` for Bash-like tools. PURE.
 */
export function classifySensitivity(toolName: string, input: unknown): boolean {
  if (SENSITIVE_TOOLS.includes(toolName)) return true;
  const command =
    input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
      ? (input as { command: string }).command
      : "";
  if (command === "") return false;
  return SENSITIVE_BASH_PATTERNS.some((re) => re.test(command));
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  sensitive: boolean;
  reason?: string;
}

/**
 * The gate the driver's PreToolUse hook applies under `bypassPermissions`. Increment 1 policy:
 * auto-allow the bulk, DENY the sensitive set (rm -rf / push --force / deploy / secret reads). PURE.
 *
 * Returns `sensitive` alongside the behaviour so the driver can emit a `permission` event even for
 * the allowed calls if it ever wants to — and so increment 2 can turn the `deny` into an escalation
 * without re-deriving the classification.
 */
export function sdkPermissionDecision(toolName: string, input: unknown): PermissionDecision {
  const sensitive = classifySensitivity(toolName, input);
  if (sensitive) {
    return {
      behavior: "deny",
      sensitive: true,
      reason: `vibehub SDK driver blocked a sensitive action (${toolName}). Increment 1 denies rm -rf / force-push / deploy / secret-reads pending the chat permission button.`,
    };
  }
  return { behavior: "allow", sensitive: false };
}

/* -------------------------------------------------------- gate modes */

/**
 * How the driver's PreToolUse gate behaves — the `sdkPermissionMode` install setting, carried to the
 * driver as `--permission-gate`:
 *
 * - `"same-as-terminal"` — the native chat mirrors the permission behaviour the Terminal tab of the
 *   same card already has (the runner's own Claude settings decide; no extra vibehub gate on top).
 *   The hook only emits observability `permission` events. One card, two views, one permission
 *   story — the install owner's product decision (2026-08-31).
 * - `"ask-sensitive"` — the SENSITIVE set escalates to Permitir/Negar buttons in the chat and the
 *   agent waits for the click. Kept for less-trusted chats (shared members).
 */
export type SdkPermissionGateMode = "same-as-terminal" | "ask-sensitive";

/** Parse the `--permission-gate` argv value. Anything unrecognised falls back to the STRICTER mode. PURE. */
export function parseGateMode(raw: unknown): SdkPermissionGateMode {
  return raw === "same-as-terminal" ? "same-as-terminal" : "ask-sensitive";
}

/**
 * What the PreToolUse hook should DO with one tool call under a gate mode. PURE — the driver embeds
 * a mirror copy (see the file header); keep `sdk-driver.mjs` in step.
 */
export function sdkGateAction(
  mode: SdkPermissionGateMode,
  toolName: string,
  input: unknown,
): { action: "allow" | "escalate"; sensitive: boolean } {
  const sensitive = classifySensitivity(toolName, input);
  if (mode === "same-as-terminal") return { action: "allow", sensitive };
  return { action: sensitive ? "escalate" : "allow", sensitive };
}

/* ------------------------------------------------- permission escalation */

/**
 * How long a `permission_request` waits for the human before it is DENIED. Five minutes: long
 * enough to grab the phone and answer, short enough that a forgotten card does not hold the
 * agent's loop hostage forever (the PreToolUse hook AWAITS this).
 */
export const PERMISSION_TIMEOUT_MS = 5 * 60_000;

export interface PermissionWaitResult {
  allow: boolean;
  /** True when nobody answered in time (the deny was the clock's, not the human's). */
  timedOut: boolean;
}

export interface PermissionBroker {
  /** Await the human's decision for `id`. Resolves with a deny when the timeout fires first. */
  wait(id: string): Promise<PermissionWaitResult>;
  /** Deliver a decision. Returns false when nothing was waiting under that id (late click, typo). */
  resolve(id: string, allow: boolean): boolean;
  /** How many requests are still waiting (observability + tests). */
  pendingCount(): number;
}

/**
 * The pending-permission ledger the driver keeps between "emitted a permission_request" and "the
 * stdin brought a permission_decision". PURE apart from the injected clock (`setTimeout`), which is
 * what makes the timeout testable. The driver embeds a MIRROR copy (see the file header) — keep
 * them in step.
 */
export function createPermissionBroker(timeoutMs: number = PERMISSION_TIMEOUT_MS): PermissionBroker {
  const pending = new Map<string, (result: PermissionWaitResult) => void>();
  return {
    wait(id: string): Promise<PermissionWaitResult> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ allow: false, timedOut: true });
        }, timeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(result);
        });
      });
    },
    resolve(id: string, allow: boolean): boolean {
      const deliver = pending.get(id);
      if (!deliver) return false;
      deliver({ allow, timedOut: false });
      return true;
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

/* --------------------------------------------------------- user questions */

/**
 * How long a `user_question` waits for the human before the model is told "no answer". Generous
 * (30 minutes): a question is a fork in the work, worth waiting for — but a forgotten card must
 * not hold the agent's loop hostage forever (the canUseTool callback AWAITS this).
 */
export const QUESTION_TIMEOUT_MS = 30 * 60_000;

/**
 * O que o MODELO lê quando a pessoa respondeu por mensagem em vez de clicar numa opção.
 *
 * Precisa dizer três coisas, senão o agente reabre a mesma pergunta em seguida e o incômodo volta:
 * que não houve escolha, que existe uma mensagem nova, e que ela manda. PURE.
 */
export const QUESTION_SUPERSEDED_MESSAGE =
  "The user did not pick any of the options: they answered by sending a message in the chat instead. " +
  "That message is in this conversation — read it and follow it. It SUPERSEDES this question, " +
  "so do not ask it again unless their message leaves you genuinely unable to proceed.";

/** Parse the `answers` payload of a `question_answer` frame. Null when it is not answer-shaped. PURE. */
export function parseQuestionAnswers(raw: unknown): UserQuestionAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  const answers: UserQuestionAnswer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const selected = (entry as { selected?: unknown }).selected;
    if (!Array.isArray(selected) || selected.some((s) => typeof s !== "string")) return null;
    answers.push({ selected: selected as string[] });
  }
  return answers;
}

/* ------------------------------------------------------- command catalogue */

/** A slash command name as the CLI reports it: `code-review`, `plugin:command`. */
const COMMAND_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
/** Descriptions are skill frontmatter — some run to hundreds of words. The menu shows a line. */
export const COMMAND_DESCRIPTION_MAX = 300;
/** A session with more commands than this is a bug, not a menu: the catalogue is capped. */
export const COMMAND_CATALOGUE_MAX = 400;

/** Trim, collapse newlines, cap. Empty becomes undefined (the menu simply shows no description). */
function commandText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Turn what the CLI reports into the catalogue the chat may render: unknown-shaped entries and
 * names that are not command names are DROPPED (this list ends up in a browser and is clicked to
 * build a message), descriptions are flattened to one line, and the whole thing is capped.
 *
 * `skills` and `plugins` are the CLI's own init lists; they only decide the `source` LABEL the
 * menu groups by. `hidden` is `terminal_slash_commands` — commands whose UX is bound to a real
 * terminal (`/doctor`, `/color`); offering them in a web chat is offering something that cannot
 * work. PURE.
 */
export function normalizeSlashCommands(
  raw: unknown,
  opts: { skills?: unknown; plugins?: unknown; hidden?: unknown } = {},
): SlashCommandInfo[] {
  if (!Array.isArray(raw)) return [];
  const names = (value: unknown): Set<string> =>
    new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const skills = names(opts.skills);
  const hidden = names(opts.hidden);
  const plugins = names(
    Array.isArray(opts.plugins)
      ? opts.plugins.map((p) => (p && typeof p === "object" ? (p as { name?: unknown }).name : p))
      : opts.plugins,
  );
  const out: SlashCommandInfo[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || !COMMAND_NAME_RE.test(name)) continue;
    if (hidden.has(name) || seen.has(name)) continue;
    seen.add(name);
    const rawAliases = (entry as { aliases?: unknown }).aliases;
    const aliases = Array.isArray(rawAliases)
      ? rawAliases.filter((a): a is string => typeof a === "string" && COMMAND_NAME_RE.test(a))
      : [];
    const source: SlashCommandInfo["source"] = skills.has(name)
      ? "skill"
      : plugins.has(name.split(":")[0] ?? "")
        ? "plugin"
        : "command";
    out.push({
      name,
      source,
      ...(commandText((entry as { description?: unknown }).description, COMMAND_DESCRIPTION_MAX)
        ? { description: commandText((entry as { description?: unknown }).description, COMMAND_DESCRIPTION_MAX) }
        : {}),
      ...(commandText((entry as { argumentHint?: unknown }).argumentHint, 80)
        ? { argumentHint: commandText((entry as { argumentHint?: unknown }).argumentHint, 80) }
        : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
    });
    if (out.length >= COMMAND_CATALOGUE_MAX) break;
  }
  return out;
}

/**
 * Normalize the AskUserQuestion tool input into the wire's `questions` — refusing anything that is
 * not question-shaped (the driver falls back to letting the SDK handle a malformed call). PURE.
 */
export function normalizeUserQuestions(input: unknown): UserQuestionItem[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: UserQuestionItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const q = entry as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof q.question !== "string" || q.question.trim() === "") return null;
    const options: UserQuestionOption[] = [];
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (!opt || typeof opt !== "object") continue;
        const o = opt as { label?: unknown; description?: unknown };
        if (typeof o.label !== "string" || o.label.trim() === "") continue;
        options.push({ label: o.label, ...(typeof o.description === "string" ? { description: o.description } : {}) });
      }
    }
    questions.push({
      question: q.question,
      ...(typeof q.header === "string" && q.header.trim() !== "" ? { header: q.header } : {}),
      options,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

/**
 * Build the `answers` map the SDK's canUseTool response wants: question text → chosen label(s)
 * (one string for a single choice, an array for multiSelect; free text is just one more string).
 * Answers pair with questions BY INDEX; a question left without an answer is omitted. PURE — the
 * driver embeds a mirror copy (see the file header); keep `sdk-driver.mjs` in step.
 */
export function buildAskUserAnswers(
  questions: readonly UserQuestionItem[],
  answers: readonly UserQuestionAnswer[],
): Record<string, string | string[]> {
  const map: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const selected = answers[i]?.selected.filter((s) => s.trim() !== "") ?? [];
    if (selected.length === 0) return;
    map[q.question] = q.multiSelect ? selected : (selected.length === 1 ? selected[0]! : selected.join(", "));
  });
  return map;
}

export interface QuestionWaitResult {
  /** Null when nobody answered in time. */
  answers: UserQuestionAnswer[] | null;
  timedOut: boolean;
  /**
   * A pessoa NÃO clicou em nada: ela escreveu no chat, e o que ela escreveu vale mais que o cartão.
   *
   * O bug que isto fecha (produção, 2026-09-17): o agente propunha um plano com opções, a pessoa
   * não gostava do plano e mandava uma mensagem redirecionando — e não acontecia NADA. O turno
   * estava parado dentro do `canUseTool` esperando um clique, a mensagem ficava na fila do CLI sem
   * ninguém para lê-la, e a tela ficava presa até o timeout de 30 MINUTOS. Falar é responder.
   */
  superseded?: boolean;
}

export interface QuestionBroker {
  /** Await the human's answers for `id`. Resolves with `timedOut` when the clock fires first. */
  wait(id: string): Promise<QuestionWaitResult>;
  /** Deliver answers. Returns false when nothing was waiting under that id (late click, typo). */
  resolve(id: string, answers: UserQuestionAnswer[]): boolean;
  /** Resolve everything still pending as unanswered (an interrupt kills the turn they belong to). */
  abandonAll(): void;
  /**
   * Libera o que espera clique porque a PESSOA FALOU: a mensagem dela substitui o cartão. Devolve
   * quantos cartões foram liberados (0 = não havia nenhum, o caminho comum de toda mensagem).
   */
  supersedeAll(): number;
  /** How many questions are still waiting (observability + tests). */
  pendingCount(): number;
}

/**
 * The pending-question ledger the driver keeps between "emitted a user_question" and "the stdin
 * brought a question_answer" — the same shape as `createPermissionBroker`, with answers instead of
 * a boolean. The driver embeds a MIRROR copy (see the file header) — keep them in step.
 */
export function createQuestionBroker(timeoutMs: number = QUESTION_TIMEOUT_MS): QuestionBroker {
  const pending = new Map<string, (result: QuestionWaitResult) => void>();
  return {
    wait(id: string): Promise<QuestionWaitResult> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ answers: null, timedOut: true });
        }, timeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(result);
        });
      });
    },
    resolve(id: string, answers: UserQuestionAnswer[]): boolean {
      const deliver = pending.get(id);
      if (!deliver) return false;
      deliver({ answers, timedOut: false });
      return true;
    },
    abandonAll(): void {
      for (const deliver of [...pending.values()]) deliver({ answers: null, timedOut: false });
      pending.clear();
    },
    supersedeAll(): number {
      const waiting = pending.size;
      for (const deliver of [...pending.values()]) deliver({ answers: null, timedOut: false, superseded: true });
      pending.clear();
      return waiting;
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}
