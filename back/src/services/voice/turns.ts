import { publishExternalMessageReported, readHistory, type HistoryEvent } from "../sdk/history.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { VoiceLiveError } from "./live.js";

/**
 * VOICE IN THE CHAT — the spoken turns of a call held inside a card's chat land in the SAME log as
 * the typed conversation (`sdk-history/<card>.ndjson`), as `voice_turn` events. The call ends, the
 * conversation stays: a reload, another tab or another person opening the card replays them in
 * place, between the typed messages they were said among.
 *
 * GPT-Live's transcript arrives as fragments with no turn id; the BROWSER settles them into whole
 * turns and names each one (`vid`). Saving is IDEMPOTENT on that id: a retry after a dropped
 * response, or the same turn flushed twice (hang-up racing the debounce), is written once.
 */

/** One request carries at most this many turns — a flush after a long call, not a bulk import. */
export const TURNS_MAX = 40;
/** A spoken turn longer than this is not a turn (or not speech): refused, not truncated silently. */
export const TURN_TEXT_MAX = 8_000;
const VID_RE = /^[A-Za-z0-9_-]{6,80}$/;

export interface VoiceTurnInput {
  vid: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

/** The request body as turns, or a 400. Whitespace-only turns are dropped, not refused. PURE. */
export function parseVoiceTurns(body: unknown, now: number = Date.now()): VoiceTurnInput[] {
  const raw = (body as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(raw) || raw.length === 0) throw new VoiceLiveError(400, "turns are required");
  if (raw.length > TURNS_MAX) throw new VoiceLiveError(400, `at most ${TURNS_MAX} turns per request`);
  const turns: VoiceTurnInput[] = [];
  for (const item of raw) {
    const t = item as { vid?: unknown; role?: unknown; text?: unknown; at?: unknown };
    if (typeof t.vid !== "string" || !VID_RE.test(t.vid)) throw new VoiceLiveError(400, "invalid turn id");
    if (t.role !== "user" && t.role !== "assistant") throw new VoiceLiveError(400, "invalid turn role");
    if (typeof t.text !== "string") throw new VoiceLiveError(400, "turn text is required");
    if (t.text.length > TURN_TEXT_MAX) throw new VoiceLiveError(400, "turn text is too long");
    const text = t.text.trim();
    if (!text) continue;
    // The browser's clock orders the turn; a wild value (skewed clock, forged body) is clamped to
    // the server's "now" so it cannot sort itself years away from the conversation.
    const at = typeof t.at === "number" && Number.isFinite(t.at) && Math.abs(t.at - now) < 86_400_000 ? t.at : now;
    turns.push({ vid: t.vid, role: t.role, text, at });
  }
  return turns;
}

/** Turn ids already in each card's log. Loaded from the log once per card, then kept current. */
const known = new Map<string, Set<string>>();
const loading = new Map<string, Promise<Set<string>>>();

async function knownVids(cardId: string): Promise<Set<string>> {
  const cached = known.get(cardId);
  if (cached) return cached;
  let pending = loading.get(cardId);
  if (!pending) {
    // The WHOLE log, not the replay window: a retry arriving after a long conversation must still
    // find its turn (and a limit this high never triggers the read's compaction).
    pending = readHistory(cardId, Number.MAX_SAFE_INTEGER).then((events) => {
      const set = new Set<string>();
      for (const e of events) if (e.type === "voice_turn") set.add(e.vid);
      known.set(cardId, set);
      loading.delete(cardId);
      return set;
    });
    loading.set(cardId, pending);
  }
  return pending;
}

export function resetVoiceTurns(): void {
  known.clear();
  loading.clear();
}

/**
 * Writes the turns not yet in the card's log and announces them to every open chat of the card
 * (the sender's own included — it reconciles by `vid`). Returns which ids were written now and which
 * were already there. The id is claimed BEFORE the write, so two concurrent saves of one turn write
 * it once.
 */
export async function saveVoiceTurns(
  cardId: string,
  turns: VoiceTurnInput[],
  from?: MessageOrigin,
): Promise<{ saved: string[]; duplicate: string[] }> {
  const vids = await knownVids(cardId);
  const saved: string[] = [];
  const duplicate: string[] = [];
  const writes: Promise<void>[] = [];
  let failed = false;
  for (const turn of turns) {
    if (vids.has(turn.vid)) {
      duplicate.push(turn.vid);
      continue;
    }
    vids.add(turn.vid);
    saved.push(turn.vid);
    const event: HistoryEvent = { type: "voice_turn", vid: turn.vid, role: turn.role, text: turn.text, at: turn.at, ...(from ? { from } : {}) };
    writes.push(
      publishExternalMessageReported(cardId, event).then((ok) => {
        if (ok) return;
        // Not on disk: release the id, so the browser's retry writes it instead of being told
        // "duplicate" about a turn nobody kept.
        vids.delete(turn.vid);
        failed = true;
      }),
    );
  }
  await Promise.all(writes);
  if (failed) throw new VoiceLiveError(503, "could not save the voice turns — try again");
  return { saved, duplicate };
}
