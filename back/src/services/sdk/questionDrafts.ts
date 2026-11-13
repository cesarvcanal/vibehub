import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { CARD_ID_RE } from "../board/cardId.js";

/**
 * WHAT EACH PERSON HAS ALREADY TICKED on an open question card, ON DISK — per card, question and name.
 *
 * The incident (production, 2026-11-03): four questions ticked, a deploy, everything blank. The manager
 * kept the drafts only in memory (for whoever opens the card in the middle of another person's answer) and
 * the deploy restarts the back. Here they survive the deploy, the closed tab and the switch of device — what
 * I ticked, what the others ticked — until the question closes (`forgetQuestionDrafts`).
 *
 * A card's writes are CHAINED and COALESCED: a draft arrives every ~150 ms while
 * someone types, and only the last state matters — at most one write in flight and one queued, always the
 * newest. The read waits for the card's queue: the successor driver must not read a stale file.
 */

export const SDK_QUESTION_DRAFTS_DIR = "sdk-question-drafts";

export interface StoredQuestionDraft {
  picked: string[][];
  other: string[];
  /** When the person made the change (their browser's clock) — the newest wins. */
  at?: number;
}

/** `question id → name → draft`. */
export type CardQuestionDrafts = Map<string, Map<string, StoredQuestionDraft>>;

function draftsFile(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id for question drafts: '${cardId}'`);
  return dataPath(SDK_QUESTION_DRAFTS_DIR, `${cardId}.json`);
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;

/** A draft from disk, checked. PURE. */
function parseDraft(value: unknown): StoredQuestionDraft | null {
  if (!value || typeof value !== "object") return null;
  const { picked, other, at } = value as { picked?: unknown; other?: unknown; at?: unknown };
  if (!Array.isArray(picked)) return null;
  const pickedLists = picked.map(strings);
  const otherList = strings(other);
  if (pickedLists.some((p) => p === null) || otherList === null) return null;
  return { picked: pickedLists as string[][], other: otherList, ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}) };
}

/** The file's content, or null when there is nothing to keep. PURE. */
export function serializeQuestionDrafts(drafts: CardQuestionDrafts): string | null {
  const out: Record<string, Record<string, StoredQuestionDraft>> = {};
  for (const [id, byName] of drafts) {
    if (byName.size === 0) continue;
    out[id] = Object.fromEntries(byName);
  }
  return Object.keys(out).length === 0 ? null : JSON.stringify(out);
}

/** The file's text, checked — what does not match is ignored, never throws. PURE. */
export function parseQuestionDrafts(raw: string): CardQuestionDrafts {
  const drafts: CardQuestionDrafts = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drafts;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return drafts;
  for (const [id, byName] of Object.entries(parsed)) {
    if (!byName || typeof byName !== "object" || Array.isArray(byName)) continue;
    const names = new Map<string, StoredQuestionDraft>();
    for (const [name, value] of Object.entries(byName)) {
      const draft = parseDraft(value);
      if (draft && name !== "") names.set(name, draft);
    }
    if (names.size > 0) drafts.set(id, names);
  }
  return drafts;
}

/** Per card: the write in flight and the next content (null = delete the file). */
const writing = new Map<string, Promise<void>>();
const nextContent = new Map<string, string | null>();

async function writeNow(cardId: string, content: string | null): Promise<void> {
  try {
    const file = draftsFile(cardId);
    if (content === null) {
      await rm(file, { force: true });
      return;
    }
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content, "utf8");
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not write the question drafts");
  }
}

/** Writes the current state of the card's drafts. Never throws; the promise resolves when it is on disk. */
export function saveQuestionDrafts(cardId: string, drafts: CardQuestionDrafts): Promise<void> {
  nextContent.set(cardId, serializeQuestionDrafts(drafts));
  const running = writing.get(cardId);
  if (running) return running;
  const loop = (async () => {
    while (nextContent.has(cardId)) {
      const content = nextContent.get(cardId)!;
      nextContent.delete(cardId);
      await writeNow(cardId, content);
    }
    writing.delete(cardId);
  })();
  writing.set(cardId, loop);
  return loop;
}

/** The card's stored drafts (empty when there are none, or when the file cannot be read). Never throws. */
export async function loadQuestionDrafts(cardId: string): Promise<CardQuestionDrafts> {
  await writing.get(cardId);
  try {
    return parseQuestionDrafts(await readFile(draftsFile(cardId), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not read the question drafts");
    }
    return new Map();
  }
}

/** Resolves when the card's pending writes are on disk. */
export function questionDraftsSettled(cardId: string): Promise<void> {
  return writing.get(cardId) ?? Promise.resolve();
}

/** The card was deleted: its drafts too. Never throws. */
export async function removeQuestionDrafts(cardId: string): Promise<void> {
  nextContent.set(cardId, null);
  await (writing.get(cardId) ?? saveQuestionDrafts(cardId, new Map()));
}
