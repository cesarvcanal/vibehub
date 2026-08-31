import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import type { DriverEvent } from "./protocol.js";
import { logger } from "../../utils/logger.js";

/**
 * SDK CHAT HISTORY — the per-card event log that makes the native chat's conversation SURVIVE.
 *
 * The `--resume` session id preserves the conversation FOR THE MODEL, but the UI used to hold its
 * rows only in React state: switching to the terminal tab and back, reopening the card, or a page
 * reload remounted the view and the whole conversation vanished from the screen (the production
 * bug on the "teste chat nativo sdk" card — the message was delivered, the transcript proves it,
 * and the screen forgot it anyway). This is the same promise the OLD chat already keeps via the
 * tmux transcript: what was said is on disk, and every connect REPLAYS it.
 *
 * One NDJSON file per card under `<dataDir>/sdk-history/`, append-only on the hot path. Only the
 * events worth re-drawing are kept (see `replayableHistoryEvent`): the consolidated text, never the
 * deltas; the request AND the decision of a permission, so a replayed card shows its outcome.
 */

/** Where the logs live, under the data dir (survives container restarts like board.json does). */
export const SDK_HISTORY_DIR = "sdk-history";

/** How many events one connect replays. Enough for several long turns without a mega-frame burst. */
export const HISTORY_REPLAY_LIMIT = 500;

/** Compaction threshold: when a file holds this many times the replay limit, it is rewritten. */
export const HISTORY_COMPACT_FACTOR = 4;

/** What the log stores: driver events, plus the user's own messages (they come from stdin, not stdout). */
export type HistoryEvent = (DriverEvent | { type: "user"; text: string }) & { at?: number };

/**
 * Card ids are UUIDs minted by the registry. The id also names a file on disk, so anything that is
 * not plainly id-shaped is refused rather than resolved — no path from a URL ever touches the fs.
 */
const CARD_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

function historyFile(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id for sdk history: '${cardId}'`);
  return dataPath(SDK_HISTORY_DIR, `${cardId}.ndjson`);
}

/**
 * Which events are worth writing down and replaying. Deltas are not (the consolidated
 * `assistant_text` replaces them), and neither is the connection's own chatter (ready/session) nor
 * transient errors — a replayed "driver exited" from last week would just be a lie. `permission`
 * only when it carries the id that pairs it with a request, so the replay can settle the card. PURE.
 */
export function replayableHistoryEvent(event: HistoryEvent): boolean {
  switch (event.type) {
    case "user":
    case "assistant_text":
    case "tool_use":
    case "permission_request":
      return true;
    case "permission":
      return typeof (event as { id?: unknown }).id === "string";
    default:
      return false;
  }
}

/**
 * Appends are SERIALIZED per card: the bridge fires them without awaiting (an event stream must not
 * block on the disk), and two interleaved appendFile calls could still interleave their lines.
 */
const chains = new Map<string, Promise<void>>();

/** Append one event to a card's log. Fire-and-forget safe: never throws, never blocks the stream. */
export function appendHistory(cardId: string, event: HistoryEvent): Promise<void> {
  const prev = chains.get(cardId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const file = historyFile(cardId);
      await mkdir(join(file, ".."), { recursive: true });
      await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
    })
    .catch((err: unknown) => {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not append sdk chat history");
    })
    .finally(() => {
      if (chains.get(cardId) === next) chains.delete(cardId);
    });
  chains.set(cardId, next);
  return next;
}

/**
 * The last `limit` replayable events of a card, oldest first — what a fresh connect sends to the
 * browser before the driver says `ready`. Reading is also when the file is COMPACTED: a log that
 * has grown past several times the replay window is rewritten to just that window, so the hot
 * append path never pays for a rewrite. Never throws — no file simply means no history yet.
 */
export async function readHistory(cardId: string, limit: number = HISTORY_REPLAY_LIMIT): Promise<HistoryEvent[]> {
  let raw: string;
  const file = historyFile(cardId);
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const events: HistoryEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as HistoryEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") events.push(parsed);
    } catch {
      // a torn last line from a crash mid-append: skip it, keep the rest
    }
  }
  const tail = events.slice(-limit);
  if (events.length > limit * HISTORY_COMPACT_FACTOR) {
    // Chained like an append so a compaction never races one; best-effort like everything here.
    await appendHistoryBarrier(cardId, async () => {
      await writeFile(file, tail.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    });
  }
  return tail;
}

/** Runs `work` inside the card's append chain (compaction must not interleave with an append). */
function appendHistoryBarrier(cardId: string, work: () => Promise<void>): Promise<void> {
  const prev = chains.get(cardId) ?? Promise.resolve();
  const next = prev
    .then(work)
    .catch((err: unknown) => {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not compact sdk chat history");
    })
    .finally(() => {
      if (chains.get(cardId) === next) chains.delete(cardId);
    });
  chains.set(cardId, next);
  return next;
}
