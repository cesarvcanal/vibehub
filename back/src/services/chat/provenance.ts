import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

/**
 * MESSAGE PROVENANCE — who put a message into a card's conversation.
 *
 * Everything that enters a card arrives the same way (typed at the prompt), so the transcript
 * records every incoming message as "the user said". That is correct for delivery and WRONG for
 * reading: a maestro's instruction, another person's message and the owner's own words all look
 * identical. This log is the missing attribution — recorded at the moment of the send, when the
 * sender is still known.
 *
 *  - **Native chat**: provenance rides ON the history event itself (`from` on the ndjson line) —
 *    exact, no matching needed. This file is not involved.
 *  - **Old chat (transcript reader)**: the transcript carries no sender, so the send is logged HERE
 *    (one ndjson per card) keyed by the message's normalized text + timestamp, and the chat route
 *    matches transcript user-events back to it. BEST-EFFORT by construction: the match is by
 *    collapsed text and nearest timestamp, so two IDENTICAL texts sent close together by different
 *    senders can swap labels, and a message Claude re-words (it never does today) would not match.
 *    Attribution can be missing; it is never invented for a text that was not recorded.
 */

/** Who a message came from. `owner`/`user` = a person (by username); `agent` = another card's AI;
 *  `system` = the panel itself (e.g. the boot-resume's continuation turn — never a person's words). */
export interface MessageOrigin {
  kind: "owner" | "user" | "agent" | "system";
  /** The username, or the sender card's title. Empty = unknown (the front shows a generic label). */
  name: string;
  /** For `agent`: the card the message came from — what the chat links back to. */
  sourceCardId?: string;
  /** For `agent`: that card's project, so the front can build the `?project&card` link. */
  sourceProjectId?: string;
}

/** One recorded send. `key` is the normalized text; `at` is when the send happened (epoch ms). */
export interface ProvenanceEntry {
  at: number;
  key: string;
  origin: MessageOrigin;
}

/** Where the per-card logs live, under the data dir. */
export const PROVENANCE_DIR = "provenance";

/** How many entries are kept in memory (and consulted for matching) per card. */
export const PROVENANCE_CACHE_MAX = 200;

/**
 * How far apart the send and the transcript echo may be and still match (ms). Claude Code writes
 * the user line when the turn STARTS, which can lag the send by however long the previous turn ran
 * — so this is generous. An event with no timestamp matches the newest entry for its text.
 */
export const PROVENANCE_MATCH_WINDOW_MS = 30 * 60_000;

/** Same id rule as the sdk history: the card id names a file, so only id-shaped values touch the fs. */
const CARD_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

function provenanceFile(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id for provenance: '${cardId}'`);
  return dataPath(PROVENANCE_DIR, `${cardId}.ndjson`);
}

/** The matching key: whitespace collapsed, exactly like the front's `normalizeMessage`. PURE. */
export function normalizeProvenanceKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** In-memory tail per card: what the sync matcher consults. Loaded lazily, appended on record. */
const cache = new Map<string, ProvenanceEntry[]>();
/** Cards whose file has been loaded into the cache (so a restart still sees older sends). */
const primed = new Set<string>();
/** Append serialization per card, so two sends never interleave their ndjson lines. */
const chains = new Map<string, Promise<void>>();

function pushCached(cardId: string, entry: ProvenanceEntry): void {
  const entries = cache.get(cardId) ?? [];
  entries.push(entry);
  if (entries.length > PROVENANCE_CACHE_MAX) entries.splice(0, entries.length - PROVENANCE_CACHE_MAX);
  cache.set(cardId, entries);
}

function parseEntry(line: string): ProvenanceEntry | null {
  try {
    const parsed = JSON.parse(line) as ProvenanceEntry;
    if (
      parsed && typeof parsed === "object" &&
      typeof parsed.at === "number" && typeof parsed.key === "string" &&
      parsed.origin && typeof parsed.origin === "object" && typeof parsed.origin.name === "string"
    ) {
      return parsed;
    }
  } catch {
    /* a torn last line from a crash mid-append */
  }
  return null;
}

/**
 * Loads a card's log into the cache (once). Called before a chat stream starts matching, so a
 * backend restart does not forget who sent what. Never throws — no file means no history.
 */
export async function primeProvenance(cardId: string): Promise<void> {
  if (primed.has(cardId)) return;
  const file = provenanceFile(cardId); // validates the id BEFORE anything is swallowed below
  primed.add(cardId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return;
  }
  const fromDisk: ProvenanceEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (entry) fromDisk.push(entry);
  }
  // Entries recorded while the read was in flight stay AFTER the disk tail (they are newer).
  const live = cache.get(cardId) ?? [];
  const merged = [...fromDisk, ...live].slice(-PROVENANCE_CACHE_MAX);
  cache.set(cardId, merged);
}

/**
 * Records who sent one message into a card. Fire-and-forget safe: the cache is updated
 * synchronously (a stream running in this process can match immediately), the file append is
 * serialized and never throws — losing a provenance line degrades a label, not a message.
 */
export function recordOrigin(cardId: string, text: string, origin: MessageOrigin, at: number = Date.now()): Promise<void> {
  const entry: ProvenanceEntry = { at, key: normalizeProvenanceKey(text), origin };
  if (entry.key === "") return Promise.resolve();
  pushCached(cardId, entry);
  const prev = chains.get(cardId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const file = provenanceFile(cardId);
      await mkdir(join(file, ".."), { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    })
    .catch((err: unknown) => {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not append message provenance");
    })
    .finally(() => {
      if (chains.get(cardId) === next) chains.delete(cardId);
    });
  chains.set(cardId, next);
  return next;
}

/**
 * Picks the entry a transcript event belongs to: same normalized text, nearest timestamp within the
 * window. An event with no timestamp (`at` = 0) takes the newest entry for that text. PURE.
 */
export function pickOrigin(
  entries: readonly ProvenanceEntry[],
  text: string,
  at: number,
  windowMs: number = PROVENANCE_MATCH_WINDOW_MS,
): MessageOrigin | undefined {
  const key = normalizeProvenanceKey(text);
  if (key === "") return undefined;
  let best: ProvenanceEntry | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (entry.key !== key) continue;
    if (!(at > 0)) {
      best = entry; // no event timestamp: the newest recorded send for this text wins
      continue;
    }
    const delta = Math.abs(entry.at - at);
    if (delta <= windowMs && delta <= bestDelta) {
      best = entry;
      bestDelta = delta;
    }
  }
  return best?.origin;
}

/** Sync matcher over the primed cache — what the chat stream calls per user event. */
export function matchOrigin(cardId: string, text: string, at: number): MessageOrigin | undefined {
  return pickOrigin(cache.get(cardId) ?? [], text, at);
}

/** Test hook: forget everything cached (the files on disk are untouched). */
export function resetProvenanceCache(): void {
  cache.clear();
  primed.clear();
}
