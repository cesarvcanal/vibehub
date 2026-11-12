/**
 * THE DRAFT OF EACH QUESTION CARD — what the person already ticked and wrote in an AskUserQuestion
 * they have not answered yet — kept in localStorage, per card and per question.
 *
 * Why on disk: every (re)connect clears the screen and the replay redraws the card, which unmounts
 * and remounts (production, 2026-10-07, the first version: a module map, which was enough for that).
 * But a deploy also RELOADS the tab — the new version triggers the F5 by itself (lib/versionCheck.ts) —
 * and the module map dies with it: four ticked questions turned into a blank card (production,
 * 2026-11-03). localStorage is what an F5 does not erase, like the composer's draft and the outbox.
 *
 * The key is card + question: the id comes from the driver (`q_<n>_<ms>`) and two cards can generate
 * the same one.
 *
 * Also kept AFTER the click on "Responder": the screen's "respondida" is optimistic, and if the wire
 * drops along with the driver before the confirmation, the replay redraws the pending card — with what
 * was already ticked. That is why nobody erases on answer: what goes away is the old
 * (`QUESTION_DRAFT_TTL_MS`) and the excess (`QUESTION_DRAFTS_MAX`, oldest first), on every write.
 *
 * Never throws: blocked localStorage (private mode, quota) only takes away the durability — the tab's
 * memory holds the draft while it stays open.
 */

import { isEmptyDraft, type QuestionDraft } from "@/features/board/lib/peerQuestionDraft";

const STORAGE_KEY = "vibehub.questionDrafts";

/** How many cards the disk keeps, at most. */
export const QUESTION_DRAFTS_MAX = 50;

/** After this the draft goes away: the question closed long ago (the card's deadline is 30 min). */
export const QUESTION_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredQuestionDraft {
  picked: string[][];
  other: string[];
  /** When the person made the change (epoch ms) — the pruning order, and what decides against the server's version. */
  at: number;
}

/** The tab's memory: it counts first, and it is what is left when localStorage is blocked. */
const memory = new Map<string, StoredQuestionDraft>();

function keyOf(cardId: string, questionId: string): string {
  return `${cardId}:${questionId}`;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;

/** An entry from disk, checked — localStorage is untrusted input. PURE. */
function parseEntry(value: unknown): StoredQuestionDraft | null {
  if (!value || typeof value !== "object") return null;
  const { picked, other, at } = value as { picked?: unknown; other?: unknown; at?: unknown };
  if (!Array.isArray(picked) || typeof at !== "number") return null;
  const pickedLists = picked.map(strings);
  const otherList = strings(other);
  if (pickedLists.some((p) => p === null) || otherList === null) return null;
  return { picked: pickedLists as string[][], other: otherList, at };
}

function readStored(): Record<string, StoredQuestionDraft> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, StoredQuestionDraft> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = parseEntry(value);
      if (entry) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStored(drafts: Record<string, StoredQuestionDraft>): void {
  try {
    if (Object.keys(drafts).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* the tab's memory still holds the draft */
  }
}

/** Without the old and without the excess — the most recent stay. PURE. */
export function pruneQuestionDrafts<T extends { at: number }>(drafts: Record<string, T>, now: number): Record<string, T> {
  const kept = Object.entries(drafts)
    .filter(([, d]) => now - d.at <= QUESTION_DRAFT_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, QUESTION_DRAFTS_MAX);
  return Object.fromEntries(kept);
}

/** This card's draft, with the time of the last change: the tab's, or the disk's (after an F5), or nothing. */
export function readQuestionDraft(cardId: string, questionId: string): (QuestionDraft & { at: number }) | undefined {
  const key = keyOf(cardId, questionId);
  const live = memory.get(key);
  if (live) return live;
  return readStored()[key];
}

/**
 * Saves the current draft. `draft.at` is WHEN the person changed it (absent = now): rewriting the same
 * content does not make it younger — otherwise an old draft would pass for a new one against the server. Empty =
 * the person unticked and erased everything: the entry goes away.
 */
export function writeQuestionDraft(cardId: string, questionId: string, draft: QuestionDraft, now: number = Date.now()): void {
  const key = keyOf(cardId, questionId);
  const stored = readStored();
  if (isEmptyDraft(draft)) {
    memory.delete(key);
    if (!(key in stored)) return;
    delete stored[key];
  } else {
    const entry: StoredQuestionDraft = { picked: draft.picked, other: draft.other, at: draft.at ?? now };
    memory.set(key, entry);
    stored[key] = entry;
  }
  writeStored(pruneQuestionDrafts(stored, now));
}

/** Test hook: forgets the tab's memory — exactly what an F5 erases (localStorage stays). */
export function forgetQuestionDraftMemoryForTesting(): void {
  memory.clear();
}
