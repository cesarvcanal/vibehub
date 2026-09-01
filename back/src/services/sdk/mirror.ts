import { spawn, type ChildProcess } from "node:child_process";
import { chatSource, parseChatEvents } from "../chat/chat.js";
import { matchOrigin, primeProvenance } from "../chat/provenance.js";
import { publishExternalMessage } from "./history.js";
import { chatEventToHistory, replayDedupeKey } from "./transcript.js";
import type { HistoryEvent } from "./history.js";
import type { DriverEvent } from "./protocol.js";
import { logger } from "../../utils/logger.js";

/**
 * TRANSCRIPT MIRROR — what keeps the NATIVE chat honest while the conversation happens in the TUI.
 *
 * The native chat's socket hears the SDK driver's stdout and nothing else. The moment the person
 * switches to the Terminal tab and types at the prompt (the César incident: the chat felt slow, he
 * went to the terminal, and the native chat never showed that conversation), everything moves to
 * the transcript — a file the native view never read. This mirror is the missing tail: while at
 * least one native chat is connected to a card, ONE follow process per card (the same
 * `buildFollowCommand` loop the legacy chat runs, reaper marker included) tails the card's newest
 * transcript, converts the NEW lines into history events and hands them to
 * `publishExternalMessage` — which appends them to the sdk history (so they survive a reconnect)
 * and fans them out to every open native chat (so they are on screen NOW).
 *
 * WHAT IS FILTERED, and why (see `mirrorNewEvents`):
 *  - the follow loop starts by re-printing the tail: everything at or before the mirror's cutoff
 *    is already on screen via the connect replay — only strictly newer events pass;
 *  - `tail -F` can re-print lines when the newest file changes: each transcript event id passes
 *    exactly once (`seen`);
 *  - the DRIVER's own turns are also written to the transcript (the SDK logs its session in the
 *    same directory): everything the driver already said on stdout would come around again through
 *    the file, so the route reports every driver event and user send into `noteDriverEvent`, and
 *    the mirror drops transcript events matching those keys (tool-use id — exact; kind+text for
 *    the rest).
 *
 * The mirror is REFCOUNTED per card: the first native chat connect starts it, the last disconnect
 * stops it (stdin.end() first — the follow loop's parent-liveness check — then kill, exactly like
 * the legacy chat route tears its follower down).
 */

/** How many recently seen transcript ids / driver keys are kept for dedupe. */
export const MIRROR_DEDUPE_MAX = 800;

/** The pure dedupe state of one card's mirror. */
export interface MirrorState {
  /** Events at or before this instant replayed already (the connect replay covered them). */
  cutoffAt: number;
  /** Transcript event ids already mirrored (or replayed) — each passes exactly once. */
  seen: Set<string>;
  /** Dedupe keys of what the driver already emitted on stdout (tool ids, kind+text). */
  driverKeys: Set<string>;
}

export function createMirrorState(cutoffAt: number, seenIds: Iterable<string> = []): MirrorState {
  return { cutoffAt, seen: new Set(seenIds), driverKeys: new Set() };
}

/** Sets have insertion order: dropping the oldest entries is how the dedupe memory stays bounded. */
function capSet(set: Set<string>, max: number = MIRROR_DEDUPE_MAX): void {
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

/** Records what the driver said (stdout event) or was told (a user send) into the dedupe set. PURE-ish. */
export function noteDriverEvent(state: MirrorState, event: DriverEvent | { type: "user"; text: string }): void {
  const key = replayDedupeKey(event as { type: HistoryEvent["type"]; text?: string; id?: string });
  if (!key) return;
  state.driverKeys.delete(key); // re-adding moves it to the newest slot
  state.driverKeys.add(key);
  capSet(state.driverKeys);
}

/**
 * Filters one chunk of transcript events down to what the native chat has NOT seen yet, converted
 * to history events stamped `source:"terminal"` (plus the sender, when the provenance log knows
 * it). Mutates the state's dedupe sets; emits in transcript order.
 */
export function mirrorNewEvents(state: MirrorState, jsonl: string, cardId: string): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const event of parseChatEvents(jsonl)) {
    if (!(event.at > state.cutoffAt)) continue;
    if (state.seen.has(event.id)) continue;
    state.seen.add(event.id);
    capSet(state.seen);
    const converted = chatEventToHistory(event);
    if (!converted) continue;
    const key = replayDedupeKey(converted as { type: HistoryEvent["type"]; text?: string; id?: string });
    if (key && state.driverKeys.has(key)) continue; // the driver already said this on stdout
    const mirrored: HistoryEvent = { ...converted, source: "terminal" };
    if (mirrored.type === "user" && !mirrored.from) {
      const from = matchOrigin(cardId, mirrored.text, mirrored.at ?? 0);
      if (from) mirrored.from = from;
    }
    out.push(mirrored);
  }
  return out;
}

/* ---------------------------------------------------------------- runtime */

interface CardMirror {
  refs: number;
  state: MirrorState;
  child: ChildProcess | null;
}

const mirrors = new Map<string, CardMirror>();

/** Reports a driver event/user send of a card into its live mirror's dedupe (no-op with no mirror). */
export function noteDriverEventFor(cardId: string, event: DriverEvent | { type: "user"; text: string }): void {
  const mirror = mirrors.get(cardId);
  if (mirror) noteDriverEvent(mirror.state, event);
}

/** Test hook: forget every live mirror (children are killed). */
export function resetMirrors(): void {
  for (const mirror of mirrors.values()) stopChild(mirror);
  mirrors.clear();
}

function stopChild(mirror: CardMirror): void {
  const child = mirror.child;
  mirror.child = null;
  if (!child) return;
  // stdin FIRST: the follow loop inside the runner watches its stdin for EOF (its parent-liveness
  // check) — this reaches across the docker exec even when killing the local client would not.
  try { child.stdin?.end(); } catch { /* already gone */ }
  try { child.kill(); } catch { /* already gone */ }
}

export interface AcquireMirrorOpts {
  /** Events at or before this instant are the connect replay's business, not the mirror's. */
  cutoffAt?: number;
  /** Transcript ids the connect replay already drew — pre-seeds the dedupe on the FIRST acquire. */
  seenIds?: Iterable<string>;
}

/**
 * Starts (or joins) the card's transcript mirror. Returns the release; the LAST release stops the
 * follow process. Never throws — a card whose mirror cannot start still has its driver socket, and
 * the failure is logged rather than taking the chat down.
 */
export async function acquireTranscriptMirror(cardId: string, opts: AcquireMirrorOpts = {}): Promise<() => void> {
  const existing = mirrors.get(cardId);
  if (existing) {
    existing.refs += 1;
    return () => release(cardId);
  }
  const mirror: CardMirror = { refs: 1, state: createMirrorState(opts.cutoffAt ?? Date.now(), opts.seenIds), child: null };
  mirrors.set(cardId, mirror);
  try {
    await primeProvenance(cardId).catch(() => undefined);
    const source = await chatSource(cardId);
    const child = spawn(source.command.file, source.command.args, { stdio: ["pipe", "pipe", "ignore"] });
    mirror.child = child;
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      const batch = lines.join("\n");
      if (batch.trim() === "") return;
      for (const event of mirrorNewEvents(mirror.state, batch, cardId)) {
        void publishExternalMessage(cardId, event);
      }
    });
    child.on("close", () => {
      // The follow died on its own (runner restart, reaper): live mirroring stops until the next
      // connect; the replay merge covers whatever happened in between.
      if (mirrors.get(cardId) === mirror) mirror.child = null;
    });
    logger.debug({ card: cardId }, "sdk transcript mirror attached");
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not start the sdk transcript mirror");
  }
  return () => release(cardId);
}

function release(cardId: string): void {
  const mirror = mirrors.get(cardId);
  if (!mirror) return;
  mirror.refs -= 1;
  if (mirror.refs > 0) return;
  mirrors.delete(cardId);
  stopChild(mirror);
  logger.debug({ card: cardId }, "sdk transcript mirror released");
}
