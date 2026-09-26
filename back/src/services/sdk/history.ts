import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import type { DriverEvent } from "./protocol.js";
import type { MessageOrigin } from "../chat/provenance.js";
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

/**
 * What the log stores: driver events, plus the user's own messages (they come from stdin, not
 * stdout). `from` is the message's PROVENANCE — who put it into this card: another person's chat
 * send, or another card's agent (`vibehub_send_to_terminal`). Absent on the card owner's own
 * messages and on everything written before this field existed; the replay carries it verbatim, so
 * the native chat's attribution is exact, never matched.
 */
export type HistoryEvent = (
  | DriverEvent
  | {
      type: "user";
      text: string;
      /**
       * On an EDITED message's new version: the text as it went to the driver's stdin (the
       * supersede wrapper, see protocol.ts `buildSupersedeText`). `text` stays the CLEAN version —
       * what the screen draws — while `sent` is what the transcript will carry, so the replay
       * dedupe (`replayDedupeKey`) matches the transcript line instead of drawing it twice.
       */
      sent?: string;
    }
  /** The user edited a sent message: the row whose text matches `originalText` is drawn "editada". */
  | { type: "message_edited"; originalText: string }
  | { type: "system_note"; text: string }
) & {
  at?: number;
  from?: MessageOrigin;
  /** The event was MIRRORED from the card's terminal (TUI) transcript, not spoken by the driver. */
  source?: "terminal";
  /** The transcript event id a mirrored event came from — the exact dedupe key on replay. */
  tid?: string;
};

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
    // The panel's own voice in the conversation ("o turno foi interrompido por uma atualização…"):
    // written by the backend, never by the driver — and worth re-drawing on every replay.
    case "system_note":
    case "user_question":
    case "question_result":
    // The edit marker: without it a replay would draw the superseded message as if it still stood.
    case "message_edited":
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

/**
 * Rewrite a card's log to match a conversation that was REWOUND.
 *
 * When an edit rewinds the session (`resumeSessionAt`), the model loses the original message, the
 * half answer it was writing and every tool that ran in between. The log has to lose them too:
 * otherwise a reload replays a conversation the model does not have, and the screen and the model
 * disagree about what was said — which is the bug the rewind existed to fix, wearing a different
 * hat.
 *
 * What is cut is exactly the middle: from the ORIGINAL message (inclusive) to the `message_edited`
 * marker (inclusive). Everything before survives untouched — it is the kept turn — and everything
 * after survives too, because that is the edit's own new message, already written by the time the
 * driver reports back.
 *
 * Conservative on purpose: if either end is missing (a compaction already dropped the original, a
 * marker that never landed) NOTHING is rewritten. A log with a stale row is a cosmetic problem; a
 * log missing rows it should have kept is a lost conversation.
 *
 * Returns how many events were dropped — 0 meaning "left alone".
 */
export function rewindHistory(cardId: string, originalText: string): Promise<number> {
  let dropped = 0;
  return appendHistoryBarrier(cardId, async () => {
    const file = historyFile(cardId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return; // no log yet: nothing to rewind
    }
    const events: HistoryEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as HistoryEvent;
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") events.push(parsed);
      } catch { /* a torn line from a crash mid-append: keep the rest */ }
    }
    // The LAST occurrence of each end, because the same words can be said twice in a conversation
    // and it is the most recent pair that was just edited.
    let start = -1;
    let mark = -1;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i] as HistoryEvent;
      if (e.type === "user" && e.text === originalText) start = i;
      if (e.type === "message_edited" && e.originalText === originalText) mark = i;
    }
    // One end missing, or an order that cannot be, and nothing is rewritten. Past this line the
    // cut always removes at least the original and the marker — there is no zero-length case left.
    if (start === -1 || mark === -1 || mark < start) return;
    const kept = [...events.slice(0, start), ...events.slice(mark + 1)];
    dropped = events.length - kept.length;
    await writeFile(file, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), "utf8");
  }).then(() => dropped);
}

/* -------------------------------------------------------- external events */

/**
 * Events that enter a card's conversation from OUTSIDE its own websocket — today, an agent's
 * `vibehub_send_to_terminal`. The bridge records driver/browser traffic itself, so this bus exists
 * for the one case it cannot see: the text was typed into the card's terminal by the backend, and a
 * native chat that happens to be open should draw it NOW, not on the next reconnect.
 */
const externalBus = new EventEmitter();
externalBus.setMaxListeners(0); // one listener per open native chat — not a leak, a fan-out

/** Appends an external message to the card's log AND announces it to any open native chat. */
export function publishExternalMessage(cardId: string, event: HistoryEvent): Promise<void> {
  const done = appendHistory(cardId, event);
  externalBus.emit(cardId, event);
  return done;
}

/** Subscribe to a card's external messages. Returns the unsubscribe. */
export function onExternalMessage(cardId: string, listener: (event: HistoryEvent) => void): () => void {
  externalBus.on(cardId, listener);
  return () => externalBus.off(cardId, listener);
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

/**
 * DELETES a card's log — the card itself is being erased, and its conversation goes with it.
 *
 * Chained like an append (a delete must not race a line being written) and best-effort: no file is
 * the desired end state, so "already gone" is success. The in-memory chain entry is dropped with
 * it, so nothing keeps the card alive in this module.
 */
export async function removeHistory(cardId: string): Promise<void> {
  // The barrier swallows what `work` throws (a compaction failure is not worth an exception on the
  // hot path); a PURGE has to be able to say it failed, so the error is carried out by hand.
  let failure: Error | undefined;
  await appendHistoryBarrier(cardId, async () => {
    try {
      await rm(historyFile(cardId), { force: true });
    } catch (err) {
      failure = err as Error;
    }
  });
  if (failure) throw failure;
}
