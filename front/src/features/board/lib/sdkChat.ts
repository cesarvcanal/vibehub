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

/* ----------------------------------------------------------------- events */

/** One frame from the SDK socket — the driver's event contract, verbatim (`user` only on replay
 *  and for external sends: another card's agent, another person's message). */
export interface SdkEvent {
  type:
    | "user"
    | "ready"
    | "session"
    | "assistant_delta"
    | "assistant_text"
    | "tool_use"
    | "permission"
    | "permission_request"
    | "result"
    | "error"
    | "parse_error";
  text?: string;
  sessionId?: string;
  resume?: string;
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
}

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

export type SdkRow =
  /** A message the person sent. `sent` = it reached the driver's stdin (the socket was open).
   *  `from` = provenance on replayed/external messages: another card's agent, another person. */
  | { kind: "user"; id: string; text: string; state: "sent"; from?: MessageOrigin }
  /** Claude talking. `streaming` while deltas are still landing on it. */
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  /** One tool call, compact: the name plus a one-line summary of its input. */
  | { kind: "tool"; id: string; name: string; summary: string; input?: unknown }
  /** The "Permitir / Negar" card — a sensitive call waiting on the human (or how it ended). */
  | { kind: "permission"; id: string; tool: string; summary: string; reason?: string; outcome: PermissionOutcome }
  /** Something went wrong and saying so beats swallowing it. `count` > 1 = the SAME error again
      (a reconnect loop against a refused socket) — one banner that counts, not a stack of copies. */
  | { kind: "error"; id: string; text: string; count?: number }
  /** A quiet note (resumed session, turn ended with an error result…). */
  | { kind: "note"; id: string; text: string };

export interface SdkChatState {
  rows: SdkRow[];
  /** The conversation's resume key, as soon as the driver reports it. */
  sessionId?: string;
  /** The driver said `ready` — messages can go. */
  ready: boolean;
  /** A turn is running (something arrived since the last `result`). */
  turnActive: boolean;
  /** Monotonic counter for rows the driver did not name. */
  seq: number;
}

export const INITIAL_SDK_STATE: SdkChatState = { rows: [], ready: false, turnActive: false, seq: 0 };

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
  const live = streamingRow(rows);
  if (!live) return rows;
  return [...rows.slice(0, -1), { ...live, streaming: false }];
}

/**
 * Folds ONE driver event into the chat state. PURE — returns the same state object when the event
 * changes nothing, so React can skip the render.
 */
export function applySdkEvent(state: SdkChatState, event: SdkEvent): SdkChatState {
  switch (event.type) {
    case "user": {
      // A replayed message (live sends of one's own are drawn by `appendUserRow` when the socket
      // accepts the frame) — or a LIVE external one: another card's agent talking to this card.
      if (!event.text) return state;
      return appendUserRow({ ...state, rows: settleStreaming(state.rows) }, event.text, event.from);
    }
    case "ready": {
      // A fresh driver process: nothing is running in it yet, whatever the replayed tail looked
      // like (a turn cut mid-tool must not leave the spinner on forever).
      const next: SdkChatState = { ...state, ready: true, turnActive: false, rows: settleStreaming(state.rows) };
      if (event.resume) {
        next.sessionId = event.resume;
        const { id, seq } = nextId(state, "note");
        next.seq = seq;
        next.rows = [...next.rows, { kind: "note", id, text: `resume:${event.resume}` }];
      }
      return next;
    }
    case "session":
      if (!event.sessionId || event.sessionId === state.sessionId) return state;
      return { ...state, sessionId: event.sessionId };
    case "assistant_delta": {
      if (!event.text) return state;
      const live = streamingRow(state.rows);
      if (live) {
        const rows = [...state.rows.slice(0, -1), { ...live, text: live.text + event.text }];
        return { ...state, rows, turnActive: true };
      }
      const { id, seq } = nextId(state, "a");
      return {
        ...state,
        seq,
        turnActive: true,
        rows: [...state.rows, { kind: "assistant", id, text: event.text, streaming: true }],
      };
    }
    case "assistant_text": {
      const text = event.text ?? "";
      const live = streamingRow(state.rows);
      if (live) {
        // The consolidated block REPLACES the deltas that built it — same words, now settled.
        const rows = [...state.rows.slice(0, -1), { ...live, text, streaming: false }];
        return { ...state, rows, turnActive: true };
      }
      if (text === "") return state;
      const { id, seq } = nextId(state, "a");
      return {
        ...state,
        seq,
        turnActive: true,
        rows: [...state.rows, { kind: "assistant", id, text, streaming: false }],
      };
    }
    case "tool_use": {
      const { id, seq } = nextId(state, "t");
      const rows = settleStreaming(state.rows);
      return {
        ...state,
        seq,
        turnActive: true,
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
        turnActive: true,
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
    case "result": {
      const next: SdkChatState = { ...state, turnActive: false, rows: settleStreaming(state.rows) };
      if (event.sessionId) next.sessionId = event.sessionId;
      if (event.isError) return appendErrorRow(next, next.rows, event.result || "error");
      return next;
    }
    case "error":
      return appendErrorRow({ ...state, turnActive: false }, settleStreaming(state.rows), event.message ?? "error");
    case "parse_error":
      return appendErrorRow(state, state.rows, event.raw ?? "parse error");
    default:
      return state;
  }
}

/** Append a user message: one's own send (no `from`), or a replayed/external one with provenance. PURE. */
export function appendUserRow(state: SdkChatState, text: string, from?: MessageOrigin): SdkChatState {
  const { id, seq } = nextId(state, "u");
  return { ...state, seq, rows: [...state.rows, { kind: "user", id, text, state: "sent", from }] };
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
