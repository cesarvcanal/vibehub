import { clampDetail, parseChatEvents, type ChatEventKind } from "../chat/chat.js";
import {
  normalizeUserQuestions, PERMISSION_TIMEOUT_MS, QUESTION_TIMEOUT_MS, type UserQuestionItem,
} from "../sdk/protocol.js";
import type { HistoryEvent } from "../sdk/history.js";

/**
 * FEED — what someone driving a card from OUTSIDE the board (ChatGPT, often by voice) needs in order
 * to follow it without looking at it: is the card waiting on a decision, what has it been doing, what
 * did it say. The board shows all of this on screen; an assistant on the other end of the MCP only
 * gets what a tool returns, and `vibehub_read_terminal` alone (the answers' text) hid the two things
 * that matter most mid-task — a question card waiting for the user, and the work in between answers.
 *
 * Two sources, because a card's conversation can live in either:
 *  - the card's SDK HISTORY (the native chat's log on the back's disk): the question and permission
 *    cards with their exact state (answered, superseded, timed out);
 *  - the card's Claude TRANSCRIPT (the runner's `.jsonl`): every message and tool call, whichever
 *    process wrote it — the native chat's driver and the terminal's Claude log to the same place.
 *
 * Everything in this file is PURE.
 */

/** Longest message text an activity event carries — a card must not flood the assistant's context. */
export const ACTIVITY_TEXT_MAX = 2000;

/** The question a card is waiting on. `source` says where it can be answered from. */
export interface PendingQuestion {
  /** The question card's id (chat) or the AskUserQuestion tool call's id (terminal). */
  id: string;
  /**
   * `chat` = the native chat's question card: a MESSAGE answers it (the driver supersedes the card).
   * `terminal` = a menu in the terminal: only the board can answer it.
   */
  source: "chat" | "terminal";
  askedAt: number;
  questions: UserQuestionItem[];
}

/** A sensitive tool waiting for "Permitir / Negar" on the board. */
export interface PendingPermission {
  id: string;
  tool: string;
  reason?: string;
  askedAt: number;
}

/** One line of what a card did: a message, a tool call (one-line summary) or an answer. */
export interface ActivityEvent {
  at: number;
  kind: ChatEventKind;
  text: string;
  tool?: string;
}

/**
 * The newest question card nobody answered: no `question_result` for its id, nobody spoke after it
 * (a message answers it — the driver supersedes the card), and still inside the driver's own
 * timeout (past it the model was told "no answer" and moved on, even if the result line was lost).
 */
export function pendingQuestionFromHistory(events: readonly HistoryEvent[], now: number = Date.now()): PendingQuestion | null {
  const settled = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user") return null;
    if (e.type === "question_result") settled.add(e.id);
    else if (e.type === "user_question" && !settled.has(e.id)) {
      const askedAt = e.at ?? 0;
      if (askedAt && now - askedAt > QUESTION_TIMEOUT_MS) return null;
      return { id: e.id, source: "chat", askedAt, questions: e.questions };
    }
  }
  return null;
}

/** The newest permission request with no decision paired to it, inside the driver's timeout. */
export function pendingPermissionFromHistory(events: readonly HistoryEvent[], now: number = Date.now()): PendingPermission | null {
  const decided = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "permission" && e.id) decided.add(e.id);
    else if (e.type === "permission_request" && !decided.has(e.id)) {
      const askedAt = e.at ?? 0;
      if (askedAt && now - askedAt > PERMISSION_TIMEOUT_MS) return null;
      return { id: e.id, tool: e.tool, ...(e.reason ? { reason: e.reason } : {}), askedAt };
    }
  }
  return null;
}

/** Transcript lines as objects; torn and malformed lines are skipped (`tail` cuts the first one). */
function transcriptObjects(jsonl: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of jsonl.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s.startsWith("{")) continue;
    try {
      const obj = JSON.parse(s) as unknown;
      if (obj && typeof obj === "object") out.push(obj as Record<string, unknown>);
    } catch { /* torn line */ }
  }
  return out;
}

function contentBlocks(obj: Record<string, unknown>): Record<string, unknown>[] {
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object") : [];
}

/** Does this line carry something said — text from the person or from the agent? */
function saysSomething(obj: Record<string, unknown>): boolean {
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim() !== "";
  return contentBlocks(obj).some((b) => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
}

/**
 * The terminal's question menu: the newest AskUserQuestion call that has no tool result and after
 * which nothing was said. A call the conversation moved past (interrupted, never answered) is not
 * pending — the agent is no longer waiting on it.
 */
export function pendingQuestionFromTranscript(jsonl: string): PendingQuestion | null {
  const objs = transcriptObjects(jsonl);
  const answered = new Set<string>();
  for (let i = objs.length - 1; i >= 0; i--) {
    const obj = objs[i]!;
    if (obj.isSidechain === true) continue;
    const blocks = contentBlocks(obj);
    for (const b of blocks) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") answered.add(b.tool_use_id);
    }
    if (obj.type === "assistant") {
      const ask = [...blocks].reverse().find((b) => b.type === "tool_use" && b.name === "AskUserQuestion");
      if (ask) {
        const id = typeof ask.id === "string" ? ask.id : "";
        if (!id || answered.has(id)) return null;
        const questions = normalizeUserQuestions(ask.input);
        if (!questions) return null;
        return { id, source: "terminal", askedAt: Date.parse(String(obj.timestamp ?? "")) || 0, questions };
      }
    }
    if (saysSomething(obj)) return null;
  }
  return null;
}

/** Clamps a message without collapsing its line breaks (an answer's structure is worth keeping). */
function clampText(text: string, max = ACTIVITY_TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * What the card did, oldest first: the person's messages, each tool call as one line (what it
 * touched — never its raw output), and the agent's answers. `since` keeps only events strictly
 * after it (for polling); `limit` keeps the newest.
 */
export function activityFromTranscript(jsonl: string, opts: { since?: number; limit?: number } = {}): ActivityEvent[] {
  const since = opts.since ?? Number.NEGATIVE_INFINITY;
  const events = parseChatEvents(jsonl)
    .filter((e) => e.at > since)
    .map((e): ActivityEvent => ({
      at: e.at,
      kind: e.kind,
      text: e.kind === "tool" ? clampDetail(e.text) : clampText(e.text),
      ...(e.tool ? { tool: e.tool } : {}),
    }));
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : events.length;
  return events.slice(-limit);
}
