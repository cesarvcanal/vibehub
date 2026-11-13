import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { CARD_ID_RE, UUID_RE } from "../board/cardId.js";

/**
 * IN-FLIGHT TURN MARKERS — the durable record that a card's SDK driver has a turn RUNNING.
 *
 * The incident this closes (2x in production, 2026-08-31): a panel deploy restarts app-vibehub;
 * the SDK driver is a child of the back (docker exec) and dies with it — and a turn in flight simply
 * vanished, with no warning, because the very side that would warn (the back) was dying. The card
 * went silent.
 *
 * The manager writes ONE marker file per card (`<dataDir>/sdk-inflight/<cardId>.json`) when a user
 * turn enters the driver's stdin and removes it when the driver's `result` closes the last turn in
 * flight — so the marker's very EXISTENCE at boot means "a turn was interrupted by the restart".
 * The boot sweep (see ./resume.ts) turns those orphans into a visible system line in the card's
 * history and (once, never in a loop) an automatic resume.
 *
 * `attempts` + `progressed` are the loop-guard: 0 = a normal user turn; >=1 = this turn IS already
 * an automatic resume — it earns another one only if it made progress, up to MAX_AUTO_RESUMES
 * resumes that die soon after progressing (see nextResumeAttempt in ./resume.ts).
 *
 * `owner` + the HEARTBEAT: the tech.multi deploy is BLUE/GREEN — the new container comes up and turns
 * healthy with the old one STILL running, running the turn. "There is a marker at boot" stopped
 * meaning "the turn died": the new one's sweep resumed a live turn, two CLIs spoke in the same
 * session and the old back's mirror recorded the resume prompt as terminal conversation — the
 * duplicated system message (production, 2026-10-08). Each process signs the markers it writes and
 * touches a heartbeat file (`sdk-inflight/owners/<owner>`) while it lives; a marker is only orphaned
 * when its owner stops beating — blue/green kills the old one with SIGKILL — or drops the heartbeat
 * on a SIGTERM (`releaseInflightOwnerSync`, from a `docker stop`/restart).
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
  /** Automatic resumes already spent on this chain of turns (0 = a person's own turn). */
  attempts: number;
  /**
   * The resumed turn PRODUCED something (text or a tool call) before it died. It is what tells a
   * deploy that happened to land mid-work (resume again) from a resume that dies on arrival — the
   * loop the guard exists for (see ./resume.ts).
   */
  progressed?: boolean;
  /** The back process that wrote the marker. Absent = written by a version with no owner. */
  owner?: string;
  /**
   * BACKGROUND WORK alive when the marker was written: the CLI's tasks (Bash with
   * run_in_background, subagent, monitor) and a scheduled wakeup (ScheduleWakeup). They die with the
   * driver on a deploy, and the turn that was waiting for them never comes — without this the card
   * stopped silently in the middle of the delivery (production, 2026-10-19). `idle` = no turn was
   * running, only the background; `since` = since when the background has been alive (the cap that
   * separates a deploy wait from `npm run dev`).
   */
  background?: InflightBackground;
}

export interface InflightBackground {
  tasks: string[];
  since: number;
  idle: boolean;
}

/** The identity of THIS back process — born at boot, it signs the markers it writes. */
export const INFLIGHT_OWNER = randomUUID();

/** How often the live process touches its heartbeat. */
const OWNER_HEARTBEAT_MS = 3_000;

/**
 * A heartbeat older than this belongs to a process that died without letting go — the NORMAL case of
 * blue/green, which removes the old container with `docker rm -f` (SIGKILL, no SIGTERM). It is how
 * long the resume waits after the switch: short enough for the person, long enough that an event
 * loop pause is not mistaken for death.
 */
export const OWNER_STALE_MS = 12_000;

/** Only an id that looks like a UUID (`UUID_RE`) becomes a path: whoever calls `ownerFile` with an outside one checks it first. */
function ownerFile(owner: string): string {
  return dataPath(SDK_INFLIGHT_DIR, "owners", owner);
}

function markerFile(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id for sdk inflight marker: '${cardId}'`);
  return dataPath(SDK_INFLIGHT_DIR, `${cardId}.json`);
}

/** Trim a message to the preview the marker stores. PURE. */
export function inflightPreview(text: string): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > INFLIGHT_PREVIEW_MAX ? `${flat.slice(0, INFLIGHT_PREVIEW_MAX - 1)}…` : flat;
}

/**
 * One card's marker operations, IN THE ORDER they were asked for. Callers fire-and-forget (`void`),
 * and a write's mkdir+writeFile can otherwise land AFTER a later rm — a finished turn's marker
 * resurrected, and the next boot resuming work that was already done.
 */
const markerQueues = new Map<string, Promise<void>>();
function inOrder(cardId: string, op: () => Promise<void>): Promise<void> {
  const next = (markerQueues.get(cardId) ?? Promise.resolve()).then(op);
  markerQueues.set(cardId, next);
  void next.then(() => { if (markerQueues.get(cardId) === next) markerQueues.delete(cardId); });
  return next;
}

/** Write (or overwrite) a card's marker. Never throws — the send must not fail on a disk hiccup. */
export function writeInflightMarker(cardId: string, marker: InflightMarker): Promise<void> {
  return inOrder(cardId, () => writeMarkerNow(cardId, marker));
}

async function writeMarkerNow(cardId: string, marker: InflightMarker): Promise<void> {
  try {
    const file = markerFile(cardId);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify({ ...marker, owner: INFLIGHT_OWNER }), "utf8");
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not write the sdk inflight marker");
  }
}

/** Remove a card's marker (the turn closed, or the sweep consumed it). Idempotent, never throws. */
export function clearInflightMarker(cardId: string): Promise<void> {
  return inOrder(cardId, () => clearMarkerNow(cardId));
}

async function clearMarkerNow(cardId: string): Promise<void> {
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
    owner: typeof m.owner === "string" && m.owner !== "" ? m.owner : undefined,
    ...(m.progressed === true ? { progressed: true } : {}),
    ...(parseBackground(m.background) ?? {}),
  };
}

/** A marker's background block, or nothing when it does not have the expected shape. PURE. */
function parseBackground(raw: unknown): { background: InflightBackground } | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<InflightBackground>;
  if (!Array.isArray(b.tasks) || typeof b.since !== "number" || !Number.isFinite(b.since)) return null;
  const tasks = b.tasks.filter((t): t is string => typeof t === "string" && t !== "");
  if (tasks.length === 0) return null;
  return { background: { tasks, since: b.since, idle: b.idle === true } };
}

/** A heartbeat of THIS process. Never throws: with no heartbeat, the worst case is the old behaviour. */
export async function touchInflightOwner(): Promise<void> {
  try {
    const file = ownerFile(INFLIGHT_OWNER);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, String(Date.now()), "utf8");
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "could not touch the sdk inflight owner heartbeat");
  }
}

/** Beats right away and every `OWNER_HEARTBEAT_MS`, without holding the process up. Returns the shutdown. */
export function startInflightOwnerHeartbeat(): () => void {
  void touchInflightOwner();
  const timer = setInterval(() => { void touchInflightOwner(); }, OWNER_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * The owner's goodbye: the heartbeat goes away, and a deploy's new process starts seeing this one's markers
 * as orphans. SYNCHRONOUS on purpose — it runs inside the SIGTERM, which gives seconds, not promises.
 */
export function releaseInflightOwnerSync(): void {
  try { rmSync(ownerFile(INFLIGHT_OWNER), { force: true }); } catch { /* best-effort by design */ }
}

/** Collects the heartbeats of dead processes — each blue/green deploy leaves one (SIGKILL does not let go). */
export async function pruneStaleInflightOwners(): Promise<void> {
  let owners: string[];
  try {
    owners = await readdir(dataPath(SDK_INFLIGHT_DIR, "owners"));
  } catch {
    return; // no directory, nothing to collect
  }
  for (const owner of owners) {
    if (owner === INFLIGHT_OWNER || !UUID_RE.test(owner)) continue;
    if (await isInflightOwnerAlive(owner)) continue;
    await rm(ownerFile(owner), { force: true }).catch(() => undefined);
  }
}

/** Is the process that signed a marker still alive? Missing or stale heartbeat = no. */
export async function isInflightOwnerAlive(owner: string): Promise<boolean> {
  if (!UUID_RE.test(owner)) return false;
  try {
    const { mtimeMs } = await stat(ownerFile(owner));
    return Date.now() - mtimeMs < OWNER_STALE_MS;
  } catch {
    return false;
  }
}
