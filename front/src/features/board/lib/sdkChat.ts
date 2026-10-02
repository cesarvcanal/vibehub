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

import { parseOrigin, type MessageOrigin } from "@/features/board/lib/chat";
import type { SlashCommandInfo } from "@/features/board/lib/slashMenu";

/* ----------------------------------------------------------------- events */

/** One frame from the SDK socket — the driver's event contract, verbatim (`user` only on replay
 *  and for external sends: another card's agent, another person's message). */
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
    | "permission"
    | "permission_request"
    | "user_question"
    | "question_result"
    | "message_edited"
    | "turn_absorbed"
    | "rewound"
    | "catalog"
    | "local_output"
    | "result"
    | "workflow_progress"
    | "user_ack"
    | "user_nack"
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
  /** On `workflow_progress` (synthesised by the BACK, see back/src/services/sdk/workflow.ts): the
   *  live snapshot of a Workflow's fleet of subagents. `name` carries the script's name. */
  runId?: string;
  agents?: Array<{ id: string; label: string; status: "running" | "done"; result?: string }>;
  /** A contagem do diário INTEIRO — a lista de `agents` tem teto, ela não. */
  total?: number;
  done?: number;
  at?: number;
  finished?: boolean;
  message?: string;
  raw?: string;
  /** Message provenance on `user` events — who sent it (see lib/chat.ts `MessageOrigin`). */
  from?: MessageOrigin;
  /** "terminal" = the event was MIRRORED from the card's TUI transcript, not spoken by the driver. */
  source?: string;
  /** On `catalog`: every skill/command this session can run — what the composer's "/" offers. */
  commands?: SlashCommandInfo[];
  /** On `user_question`: the questions with their selectable options. */
  questions?: SdkQuestion[];
  /** On `question_result`: what the person picked (absent when it timed out / was cancelled). */
  answers?: SdkQuestionAnswer[];
  /**
   * On `question_result`: a pessoa respondeu POR MENSAGEM em vez de clicar numa opção. Não é o
   * mesmo que "sem resposta" — ela respondeu, só não pelo cartão —, e a linha precisa dizer isso.
   */
  superseded?: boolean;
  /** On `message_edited`: the superseded message's text — the row it greys out. */
  originalText?: string;
  /**
   * On `rewound`: the edit REWOUND the conversation (the model no longer has the original, the
   * half answer, or the tools between them) and the screen has to drop those rows too. `false`
   * means the driver fell back to a supersede and everything on screen still stands.
   */
  ok?: boolean;
  /**
   * On `user_ack`/`user_nack`: the RECEIPT id of the send being answered (see lib/sdkOutbox.ts).
   * `user_ack` = the back has the message on disk; `user_nack` = it refused it and nobody has it
   * but this browser.
   */
  cid?: string;
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

/* ------------------------------------------------------------------- rows */

/** What one permission card is showing: still waiting, or how it ended. */
export type PermissionOutcome = "pending" | "allowed" | "denied" | "timeout";

/**
 * What one question card is showing: still waiting, answered, given up (timeout/cancel) — ou
 * SUBSTITUÍDO: a pessoa não clicou em opção nenhuma, escreveu no chat, e o que ela escreveu passou
 * a valer. "unanswered" seria mentira nesse caso: ela respondeu, só não pelo cartão.
 */
export type QuestionOutcome = "pending" | "answered" | "unanswered" | "superseded";

export type SdkRow =
  /** A message the person sent. `sent` = it reached the driver's stdin (the socket was open).
   *  `from` = provenance on replayed/external messages: another card's agent, another person.
   *  `edited` = a later version SUPERSEDED this one (drawn dimmed, with the "editada" badge).
   *  `absorbed` = it arrived mid-turn and the driver folded it into the RUNNING turn (streaming
   *  input). Bookkeeping only — the bubble is NOT labelled: quem está na conversa vê a mensagem
   *  entrar no turno em andamento na própria tela, e a etiqueta só repetia isso por escrito. */
  /** `state`: "sending" = no receipt yet (the socket took the frame, the back has not confirmed);
   *  "sent" = the back gravou (a `user_ack`, or a replay — the only proofs an F5 respects);
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
      absorbed?: boolean;
    }
  /** Claude talking. `streaming` while deltas are still landing on it. */
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  /**
   * O RACIOCÍNIO do modelo, enquanto ele pensa. Mesma mecânica de streaming da linha do assistente
   * (`streaming` enquanto os deltas caem), mas desenhada em segundo plano: é contexto de espera, não
   * a resposta. Existe porque um turno longo mostrava só "Trabalhando…" e quem esperava não fazia
   * ideia do que estava acontecendo. Vive na sessão: não é gravado no histórico nem replayado.
   */
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  /** One tool call, compact: the name plus a one-line summary of its input. */
  | { kind: "tool"; id: string; name: string; summary: string; input?: unknown }
  /** The "Permitir / Negar" card — a sensitive call waiting on the human (or how it ended). */
  | { kind: "permission"; id: string; tool: string; summary: string; reason?: string; outcome: PermissionOutcome }
  /** The agent's question with clickable options — waiting on the human, or how it was answered. */
  | { kind: "question"; id: string; questions: SdkQuestion[]; outcome: QuestionOutcome; answers?: SdkQuestionAnswer[] }
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
   * A FROTA DE UM WORKFLOW, ao vivo — a linha que faltava.
   *
   * A tool `Workflow` devolve na hora e trabalha em segundo plano: o turno acabava, o chat ficava
   * mudo por minutos e quem estava do outro lado lia aquilo como "ele terminou" (produção,
   * 2026-10-02). Esta linha é o instantâneo que o back lê do diário da rodada: quantos subagentes
   * já responderam, quais ainda correm, o que cada um devolveu. `phases` é o plano declarado no
   * script (`meta.phases`), que chega pela chamada da tool. Vive só na sessão — como o raciocínio,
   * não é conversa gravada; quem reabre a aba recebe o último quadro do back.
   */
  | {
      kind: "workflow";
      id: string;
      runId: string;
      name: string;
      description?: string;
      phases?: Array<{ title: string; detail?: string }>;
      agents: Array<{ id: string; label: string; status: "running" | "done"; result?: string }>;
      /** Quantos subagentes a rodada tem e quantos já responderam, contados no diário inteiro. */
      total: number;
      done: number;
      at: number;
      finished: boolean;
    };

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
   * "Pensando…" once it is (the turn is in the engine, no token yet). Any driver event — a delta,
   * a tool, the result — clears it and the plain "Trabalhando…"/nothing takes over. Set only by
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
   * O PLANO de cada workflow que esta sessão disparou, por `meta.name` — a descrição e as fases
   * declaradas no script. Vem da CHAMADA da tool (o script inteiro está no `input`), e o progresso
   * vem do back minutos depois, pelo nome: os dois lados se encontram aqui. Guardado no estado, e
   * não na linha, porque a chamada acontece antes de existir linha de progresso alguma.
   */
  workflowMeta: Record<string, { description?: string; phases?: Array<{ title: string; detail?: string }> }>;
  /** Monotonic counter for rows the driver did not name. */
  seq: number;
}

export const INITIAL_SDK_STATE: SdkChatState = {
  rows: [],
  workflowMeta: {},
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

/**
 * Sentinels the reducer puts on an error row when the wire carried NO words of its own. The view
 * turns them into a sentence in the reader's language (see `errorText` in SdkChatView) — the fix
 * for the mute "error" bubble: every error in this chat says what happened and what to do.
 */
export const SDK_ERROR_TURN_FAILED = "sdk-error:turn-failed";
export const SDK_ERROR_NO_DETAIL = "sdk-error:no-detail";

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
  const flat = pick.replace(/\s+/g, " ").trim();
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
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The last path segment — what names a file in a headline. PURE. */
function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** O que o script de um workflow DECLARA sobre si mesmo: o bloco `meta` do topo. */
export interface WorkflowScriptMeta {
  name: string;
  description?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

/**
 * Uma string literal de JS, aspas simples ou duplas, com escapes — DOIS grupos de captura. Crases
 * não entram de propósito: o `meta` é, por contrato do harness, um literal puro (sem interpolação).
 */
const LITERAL = "(?:'((?:[^'\\\\]|\\\\.)*)'|\"((?:[^\"\\\\]|\\\\.)*)\")";

/** O conteúdo do primeiro dos dois grupos que casou, com os escapes mais comuns desfeitos. PURE. */
function literal(match: RegExpMatchArray | null | undefined, first: number): string | undefined {
  if (!match) return undefined;
  const raw = match[first] ?? match[first + 1];
  if (raw === undefined) return undefined;
  return raw.replace(/\\(['"\\])/g, "$1").replace(/\\n/g, " ").trim();
}

/**
 * Lê o `meta` do script do workflow — o PLANO que o modelo declarou ao disparar a frota: nome,
 * descrição e fases. O script chega inteiro no `input` da chamada da tool, e o `meta` é, por
 * contrato do harness, um literal puro no topo dele: nada é avaliado aqui, só lido.
 *
 * Tolerante por desenho: um script sem `meta` (ou com um `meta` que esta leitura não entende)
 * devolve o que deu para entender e a tela desenha o resto — um painel sem as fases ainda é
 * infinitamente melhor do que a tela muda que existia antes dele. PURE.
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
 * O que um subagente devolveu, legível. Quase todo `agent()` de workflow volta com `schema`, então o
 * diário guarda um OBJETO — e cru na tela isso é uma linha de JSON cortada no meio. Vira
 * `chave: valor`, uma por linha, que é como a pessoa leria. Texto puro passa intacto, e um JSON que
 * esta leitura não entende volta exatamente como veio: melhor cru do que escondido. PURE.
 */
export function formatAgentResult(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // cortado em 400 caracteres pela sonda, por exemplo
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
    case "TodoWrite":
      return { title: tool };
    case "Task": {
      const agent = field(o, "subagent_type");
      const what = field(o, "description") || agent;
      return {
        title: what ? `Task(${line(what, 60)})` : tool,
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
      const what = field(o, "name") || field(o, "title") || field(o, "description");
      return { title: what ? `Workflow(${line(what, 60)})` : tool, background: true };
    }
    default: {
      const summary = toolSummary(input);
      return { title: tool, ...(summary ? { detail: summary } : {}) };
    }
  }
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
    if (row.kind === "user") return null; // the turn's own message: nothing after it to report
    if (row.kind === "tool") {
      const headline = toolHeadline(row.name, row.input);
      return {
        kind: "tool",
        label: headline.title,
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
 * O turno tem ESPAÇO para mais uma mensagem — o RESPIRO em que a fila anda.
 *
 * A fila esperava o turno FECHAR, e um turno de quinze minutos segurava por quinze minutos um
 * "para, tá errado". Só que um turno não é um bloco maciço: entre uma ferramenta e a próxima o
 * modelo FECHA um bloco de resposta, e é esse instante que o Cursor e o Claude Code usam para puxar
 * o que está esperando. Entregue aí, a mensagem entra no turno em andamento pelo streaming input
 * (o `turn_absorbed`) em vez de virar uma interrupção do raciocínio em curso.
 *
 * Respiro é a AUSÊNCIA de algo em curso, lida na mesma ordem que a barra de atividade usa para
 * dizer o que está acontecendo (ver `currentActivity`): ferramenta rodando, não; texto ou
 * raciocínio ainda escorrendo, não; "Preparando…" — o turno nem começou —, não. Bloco fechado, sim.
 *
 * E uma mensagem recém-entregue NÃO abre o respiro seguinte: o `turn_absorbed` derruba o
 * `awaiting`, e sem esta regra a fila inteira sairia de uma vez no mesmo instante, que é o oposto
 * de "uma por vez, e as outras continuam suas". PURE.
 */
export function turnHasRoomForMore(state: SdkChatState): boolean {
  if (state.awaiting) return false;
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i] as SdkRow;
    // A última coisa dita é nossa: ou não há turno (a fila anda como sempre andou), ou ela acabou
    // de ser entregue e o modelo ainda não reagiu — o respiro já foi dela.
    if (row.kind === "user") return !state.turnActive;
    if (row.kind === "tool") return false;
    if (row.kind === "thinking" || row.kind === "assistant") return !row.streaming;
  }
  return true; // conversa vazia: não há nada em curso para atrapalhar
}

/**
 * O QUE O MODELO ESTÁ DIZENDO AGORA — a palavra dele, para o indicador não falar por ele.
 *
 * O indicador dizia só verbo + relógio + uma cauda escolhida por tabela a partir do tempo
 * decorrido ("ferramenta demorada, ainda rodando"). Sendo a mesma frase em qualquer ferramenta e em
 * qualquer raciocínio, ela não informava nada — e o material de verdade estava ali do lado: a
 * descrição que o PRÓPRIO agente escreveu para o comando (`toolHeadline`, que já a extrai) e o
 * raciocínio que ele está escrevendo neste instante.
 *
 * Aqui sai a ÚLTIMA linha do que está em curso, porque é ela que está mudando — o começo de um
 * raciocínio de dez linhas é história, o fim é notícia. Um bloco já FECHADO não é atividade: virou
 * a saída do turno, e anunciá-lo seria anunciar algo que já está desenhado logo acima. Nesse caso
 * devolve `null`, e a frase enlatada volta a ser o que sempre deveria ter sido: o fallback de
 * quando não há nada a dizer. PURE.
 */
export function liveActivityDetail(state: SdkChatState): string | null {
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i] as SdkRow;
    if (row.kind === "user") return null; // a mensagem do turno: nada depois dela para relatar
    if (row.kind === "tool") return lastLine(toolHeadline(row.name, row.input).title);
    if (row.kind === "thinking" || row.kind === "assistant") {
      return row.streaming ? lastLine(row.text) : null;
    }
  }
  return null;
}

/** A última linha não vazia de um texto em curso, dobrada em espaço simples. Vazio vira null. PURE. */
function lastLine(text: string): string | null {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] as string).replace(/\s+/g, " ").trim();
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
 * A linha de RACIOCÍNIO ainda aberta (a última, se for uma). Separada de `streamingRow` de
 * propósito: pensamento e resposta são duas correntes distintas, e uma nunca escreve na outra —
 * senão o primeiro token da resposta iria parar no fim do raciocínio. PURE.
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
      return appendUserRow({ ...marked, rows: settleStreaming(marked.rows) }, event.text, event.from);
    }
    case "catalog": {
      // The session's "/" menu. Pure STATE, not a row: it never touches the conversation, and it
      // REPLACES what was there (a refreshed catalogue is the whole truth, not an addition).
      if (!Array.isArray(event.commands)) return state;
      return { ...state, commands: event.commands };
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
        rows: settleStreaming(state.rows),
      };
      if (event.resume) {
        next.sessionId = event.resume;
        const { id, seq } = nextId(state, "note");
        next.seq = seq;
        next.rows = [...next.rows, { kind: "note", id, text: `resume:${event.resume}` }];
      }
      return next;
    }
    case "user_ack":
      // The back has it on disk — the browser may finally forget its own copy (the view's caller
      // drops it from the outbox).
      return event.cid ? settleUserRow(state, event.cid, "sent") : state;
    case "user_nack":
      // The back REFUSED it (the card's driver had died — a hibernate, a crash). Nothing was
      // written anywhere: say so, keep the words, offer the resend.
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
        // `settleStreaming` e não um append cru: o que pode estar aberto aqui é a linha de
        // RACIOCÍNIO (o modelo pensou e agora responde), e deixá-la "pensando" para sempre é a
        // pulsação que nunca para. Uma linha de resposta aberta já teria sido usada acima.
        rows: [...settleStreaming(base.rows), { kind: "assistant", id, text: event.text, streaming: true }],
      };
    }
    /**
     * O RACIOCÍNIO ao vivo. Cai na sua própria linha, nunca na do assistente: são duas correntes
     * (o modelo pensa, depois responde) e misturá-las colaria o primeiro token da resposta no fim
     * do pensamento. Um delta de raciocínio FECHA uma resposta que ainda estivesse aberta — se o
     * modelo voltou a pensar, aquele parágrafo acabou.
     */
    case "thinking_delta": {
      if (!event.text) return state;
      const base = markSource(state, false); // raciocínio é sempre o driver falando
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
    /** O bloco consolidado: mesmas palavras, agora fechadas — substitui os deltas que o montaram. */
    case "thinking": {
      const text = event.text ?? "";
      const live = streamingThinkingRow(state.rows);
      if (live) {
        const rows = [...state.rows.slice(0, -1), { ...live, text, streaming: false }];
        return { ...state, rows, turnActive: nextTurnActive(state, viaTerminal), awaiting: false };
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
      const live = streamingRow(state.rows);
      if (live && !viaTerminal) {
        // The consolidated block REPLACES the deltas that built it — same words, now settled.
        const rows = [...state.rows.slice(0, -1), { ...live, text, streaming: false }];
        return { ...state, rows, turnActive: nextTurnActive(state, viaTerminal), awaiting: false };
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
      const marked = markSource(state, viaTerminal);
      const { id, seq } = nextId(marked, "t");
      const rows = settleStreaming(marked.rows);
      // A chamada do Workflow carrega o PLANO (o `meta` do script). O progresso vem do back muito
      // depois, só com o nome da rodada — é aqui que o plano fica guardado para encontrá-lo. Vale
      // também no replay: um F5 no meio da frota reconstrói as fases a partir desta mesma linha.
      const meta = event.name === "Workflow" ? parseWorkflowScriptMeta((event.input as { script?: unknown })?.script) : null;
      const workflowMeta = meta
        ? { ...marked.workflowMeta, [meta.name]: { description: meta.description, phases: meta.phases } }
        : marked.workflowMeta;
      return {
        ...marked,
        seq,
        workflowMeta,
        turnActive: nextTurnActive(marked, viaTerminal),
        awaiting: false,
        rows: [
          ...rows,
          { kind: "tool", id: event.id ?? id, name: event.name ?? "?", summary: toolSummary(event.input), input: event.input },
        ],
      };
    }
    case "workflow_progress": {
      // O back lendo o diário da frota (services/sdk/workflow.ts). NÃO mexe em `turnActive`: o
      // turno que disparou o workflow já acabou — é exatamente por isso que esta linha existe.
      // Uma rodada tem UMA linha: o quadro novo substitui o anterior, no lugar onde ele já estava.
      const runId = event.runId;
      if (!runId) return state;
      const name = event.name ?? "";
      const metas = Object.keys(state.workflowMeta);
      // Pelo nome; e quando o back não conseguiu lê-lo (script apagado, nome estranho) mas esta
      // sessão só disparou UM workflow, é esse — melhor o plano certo do que painel sem plano.
      const meta = state.workflowMeta[name] ?? (metas.length === 1 ? state.workflowMeta[metas[0]!] : undefined);
      const agents = Array.isArray(event.agents) ? event.agents : [];
      const row: SdkRow = {
        kind: "workflow",
        id: `wf:${runId}`,
        runId,
        name,
        ...(meta?.description ? { description: meta.description } : {}),
        ...(meta?.phases?.length ? { phases: meta.phases } : {}),
        agents,
        total: typeof event.total === "number" ? event.total : agents.length,
        done: typeof event.done === "number" ? event.done : agents.filter((a) => a.status === "done").length,
        at: typeof event.at === "number" ? event.at : 0,
        finished: event.finished === true,
      };
      const at = state.rows.findIndex((r) => r.kind === "workflow" && r.runId === runId);
      if (at >= 0) return { ...state, rows: [...state.rows.slice(0, at), row, ...state.rows.slice(at + 1)] };
      // A frota chega por fora do turno, e pode cair EM CIMA de uma resposta em streaming. Fechar
      // essa linha aqui (o `settleStreaming` de todas as outras) faria o bloco consolidado que vem
      // logo depois virar uma SEGUNDA linha: a mesma frase duas vezes, com o painel no meio. Então
      // a linha aberta continua sendo a última — o painel entra logo antes dela.
      const last = state.rows[state.rows.length - 1];
      const stillWriting = last && (last.kind === "assistant" || last.kind === "thinking") && last.streaming;
      return {
        ...state,
        rows: stillWriting ? [...state.rows.slice(0, -1), row, last] : [...state.rows, row],
      };
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
      return answerQuestion(state, event.id, event.answers, event.superseded === true);
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
      return dropRewoundRows(state);
    }
    case "message_edited": {
      // The user superseded a message he sent: the LAST user row with those words is drawn dimmed
      // with the "editada" badge (the new version follows as its own row). Matching is by
      // normalized text — the history has no row ids, and the same rule folds live and replay.
      if (!event.originalText) return state;
      return markUserEdited(state, event.originalText);
    }
    case "result": {
      const next: SdkChatState = {
        ...state,
        turnActive: false,
        awaiting: false,
        interruptRequested: false,
        rows: settleStreaming(state.rows),
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
        settleStreaming(state.rows),
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
  opts?: { awaiting?: boolean; cid?: string; state?: "sending" | "sent" | "undelivered" },
): SdkChatState {
  const { id, seq } = nextId(state, "u");
  return {
    ...state,
    seq,
    awaiting: opts?.awaiting === true ? true : state.awaiting,
    rows: [...state.rows, { kind: "user", id, text, state: opts?.state ?? "sent", cid: opts?.cid, from }],
  };
}

/**
 * Settle one own send by its RECEIPT: delivered (the back gravou) or undelivered (it refused, or
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
 * Os `cid` que ESTA tela já tem desenhados — os envios com dono, que a reconciliação não julga.
 *
 * Reconciliar é sobre o que sobrou de ANTES: mensagens de um navegador ou de uma conexão anterior,
 * cujas bolhas o (re)connect apagou e cujo destino só o replay conhece. Um envio feito NESTA
 * conexão já tem bolha e relógio próprio (o watchdog) — e o replay não pode contê-lo, porque o
 * servidor manda `ready` no attach e só depois responde os frames que ficaram bufferados durante o
 * setup. Sem esta fronteira, era exatamente a mensagem em voo que a reconciliação dava por perdida:
 * uma SEGUNDA bolha, marcada "não entregue" (produção, 2026-09-28). Linhas vindas do replay não
 * têm `cid` — são elas que a comparação por texto existe para casar. PURE.
 */
export function liveUserCids(rows: readonly SdkRow[]): Set<string> {
  const cids = new Set<string>();
  for (const row of rows) if (row.kind === "user" && row.cid) cids.add(row.cid);
  return cids;
}

/** The texts of the messages the SERVER has (replayed/acked own sends) — what reconciles the outbox. PURE. */
export function deliveredUserTexts(rows: readonly SdkRow[]): string[] {
  return rows.filter((r): r is Extract<SdkRow, { kind: "user" }> => r.kind === "user" && r.state === "sent")
    .map((r) => r.text);
}

/** Whitespace-insensitive text identity — the same folding the back's dedupe key uses. */
function normalizeMessageText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Mark the LAST not-yet-edited user row whose words match as superseded ("editada"). PURE. */
export function markUserEdited(state: SdkChatState, originalText: string): SdkChatState {
  const target = normalizeMessageText(originalText);
  if (target === "") return state;
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i]!;
    if (row.kind !== "user" || row.edited === true || normalizeMessageText(row.text) !== target) continue;
    const rows = [...state.rows.slice(0, i), { ...row, edited: true }, ...state.rows.slice(i + 1)];
    return { ...state, rows };
  }
  return state;
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
 * cosmetic bug; a screen missing rows the model still has is a lie about the conversation. PURE.
 */
export function dropRewoundRows(state: SdkChatState): SdkChatState {
  let editedAt = -1;
  let lastUserAt = -1;
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i]!;
    if (row.kind !== "user") continue;
    if (lastUserAt === -1) lastUserAt = i;
    if (row.edited === true) { editedAt = i; break; }
  }
  // `editedAt >= lastUserAt` is the whole identity case: the edited row IS the newest message, so
  // there is nothing between them to drop. Past it the cut always removes at least one row.
  if (editedAt === -1 || lastUserAt === -1 || editedAt >= lastUserAt) return state;
  const tail = state.rows.slice(lastUserAt).filter((row) => !narratesTheCutTurn(row));
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
): SdkChatState {
  const outcome: QuestionOutcome = answers && answers.length > 0
    ? "answered"
    : superseded ? "superseded" : "unanswered";
  let changed = false;
  const rows = state.rows.map((row) => {
    if (row.kind !== "question" || row.id !== id) return row;
    // The first settlement wins on screen: an echo may confirm it, never flip it back to pending.
    if (row.outcome !== "pending") return row;
    changed = true;
    return { ...row, outcome, answers };
  });
  return changed ? { ...state, rows } : state;
}

/* --------------------------------------------------------------- folding */

/** A run of consecutive tool rows folds into one block, like the transcript chat does. */
export type SdkRenderRow = { kind: "row"; id: string; row: SdkRow } | { kind: "tools"; id: string; rows: SdkRow[] };

export const SDK_TOOL_FOLD_MIN = 3;

/** Fold consecutive tool rows (>= min) into one block; everything else passes through. PURE. */
export function groupSdkRows(rows: readonly SdkRow[], min: number = SDK_TOOL_FOLD_MIN): SdkRenderRow[] {
  const out: SdkRenderRow[] = [];
  let run: SdkRow[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length >= Math.max(2, min)) out.push({ kind: "tools", id: run[0]!.id, rows: run });
    else for (const row of run) out.push({ kind: "row", id: row.id, row });
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "tool") {
      run.push(row);
      continue;
    }
    flush();
    out.push({ kind: "row", id: row.id, row });
  }
  flush();
  return out;
}
