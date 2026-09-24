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
    | "catalog"
    | "local_output"
    | "result"
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
   *  input) — drawn with the "entrou no turno em andamento" label so it never looks lost. */
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
  | { kind: "command_output"; id: string; text: string };

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
  /** Monotonic counter for rows the driver did not name. */
  seq: number;
}

export const INITIAL_SDK_STATE: SdkChatState = {
  rows: [],
  ready: false,
  turnActive: false,
  terminalBurst: false,
  awaiting: false,
  commands: [],
  seq: 0,
};

/** The note row a terminal burst opens with (the view translates it). */
export const TERMINAL_ACTIVITY_NOTE = "terminal-activity";

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
      return {
        ...marked,
        seq,
        turnActive: nextTurnActive(marked, viaTerminal),
        awaiting: false,
        rows: [
          ...rows,
          { kind: "tool", id: event.id ?? id, name: event.name ?? "?", summary: toolSummary(event.input), input: event.input },
        ],
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
      // (streaming input): the newest not-yet-labelled user row gets the "entrou no turno em
      // andamento" tag. Live-only — never replayed (by replay time the turn is history).
      const next = markUserAbsorbed(state);
      if (next === state && !state.awaiting) return state;
      return { ...next, turnActive: nextTurnActive(next, false), awaiting: false };
    }
    case "message_edited": {
      // The user superseded a message he sent: the LAST user row with those words is drawn dimmed
      // with the "editada" badge (the new version follows as its own row). Matching is by
      // normalized text — the history has no row ids, and the same rule folds live and replay.
      if (!event.originalText) return state;
      return markUserEdited(state, event.originalText);
    }
    case "result": {
      const next: SdkChatState = { ...state, turnActive: false, awaiting: false, rows: settleStreaming(state.rows) };
      if (event.sessionId) next.sessionId = event.sessionId;
      if (event.isError) return appendErrorRow(next, next.rows, event.result || "error");
      return next;
    }
    case "error":
      return appendErrorRow({ ...state, turnActive: false, awaiting: false }, settleStreaming(state.rows), event.message ?? "error");
    case "parse_error":
      return appendErrorRow(state, state.rows, event.raw ?? "parse error");
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

/** Mark the LAST not-yet-absorbed user row as folded into the running turn. PURE. */
export function markUserAbsorbed(state: SdkChatState): SdkChatState {
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i]!;
    if (row.kind !== "user") continue;
    if (row.absorbed === true) return state; // the newest user row is already labelled — nothing newer to label
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
