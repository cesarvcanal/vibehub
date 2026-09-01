import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

/**
 * IN-FLIGHT TURN MARKERS — the durable record that a card's SDK driver has a turn RUNNING.
 *
 * The incident this closes (2x em produção, 2026-08-31): a deploy do painel reinicia o app-vibehub;
 * o driver SDK é filho do back (docker exec) e morre junto — e um turno em voo simplesmente sumia,
 * sem aviso, porque o próprio lado que avisaria (o back) estava morrendo. O card ficava mudo.
 *
 * The manager writes ONE marker file per card (`<dataDir>/sdk-inflight/<cardId>.json`) when a user
 * turn enters the driver's stdin and removes it when the driver's `result` closes the last turn in
 * flight — so the marker's very EXISTENCE at boot means "a turn was interrupted by the restart".
 * The boot sweep (see ./resume.ts) turns those orphans into a visible system line in the card's
 * history and (once, never in a loop) an automatic resume.
 *
 * `attempts` is the loop-guard: 0 = a normal user turn; >=1 = this turn IS already an automatic
 * resume — a second death does not resume again, it says so and stops.
 */

/** Where the markers live, under the data dir (same durability story as sdk-history). */
export const SDK_INFLIGHT_DIR = "sdk-inflight";

/** How much of the user's message the marker keeps — context for logs/notes, not a transcript. */
export const INFLIGHT_PREVIEW_MAX = 200;

export interface InflightMarker {
  /** When the (first) turn now in flight entered the driver's stdin (epoch ms). */
  startedAt: number;
  /** Head of the LAST user message sent — what the interrupted work was about. */
  preview?: string;
  /** Automatic resumes already spent on this turn. >=1 blocks another one (no loops). */
  attempts: number;
}

/** Same id rule as sdk-history: the card id names a file, so only id-shaped values touch the fs. */
const CARD_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

function markerFile(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id for sdk inflight marker: '${cardId}'`);
  return dataPath(SDK_INFLIGHT_DIR, `${cardId}.json`);
}

/** Trim a message to the preview the marker stores. PURE. */
export function inflightPreview(text: string): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > INFLIGHT_PREVIEW_MAX ? `${flat.slice(0, INFLIGHT_PREVIEW_MAX - 1)}…` : flat;
}

/** Write (or overwrite) a card's marker. Never throws — the send must not fail on a disk hiccup. */
export async function writeInflightMarker(cardId: string, marker: InflightMarker): Promise<void> {
  try {
    const file = markerFile(cardId);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(marker), "utf8");
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not write the sdk inflight marker");
  }
}

/** Remove a card's marker (the turn closed, or the sweep consumed it). Idempotent, never throws. */
export async function clearInflightMarker(cardId: string): Promise<void> {
  try {
    await rm(markerFile(cardId), { force: true });
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not clear the sdk inflight marker");
  }
}

/** Read one card's marker, or null. Malformed content reads as null (and is cleaned up by the sweep). */
export async function readInflightMarker(cardId: string): Promise<InflightMarker | null> {
  let raw: string;
  try {
    raw = await readFile(markerFile(cardId), "utf8");
  } catch {
    return null;
  }
  return parseMarker(raw);
}

/** Every marker on disk — the boot sweep's input. A missing dir is simply "no orphans". */
export async function listInflightMarkers(): Promise<Array<{ cardId: string; marker: InflightMarker }>> {
  let names: string[];
  try {
    names = await readdir(dataPath(SDK_INFLIGHT_DIR));
  } catch {
    return [];
  }
  const out: Array<{ cardId: string; marker: InflightMarker }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const cardId = name.slice(0, -".json".length);
    if (!CARD_ID_RE.test(cardId)) continue;
    const marker = await readInflightMarker(cardId);
    if (marker) out.push({ cardId, marker });
    else await clearInflightMarker(cardId); // torn/foreign file: not a turn, just leftover bytes
  }
  return out;
}

/** Parse one marker file's content. Anything not marker-shaped is null. PURE. */
export function parseMarker(raw: string): InflightMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Partial<InflightMarker>;
  if (typeof m.startedAt !== "number" || !Number.isFinite(m.startedAt)) return null;
  const attempts = typeof m.attempts === "number" && Number.isInteger(m.attempts) && m.attempts >= 0 ? m.attempts : 0;
  return {
    startedAt: m.startedAt,
    preview: typeof m.preview === "string" ? m.preview : undefined,
    attempts,
  };
}
