import { spawn, type ChildProcess } from "node:child_process";
import { chatSource, parseChatEvents } from "../chat/chat.js";
import { matchOrigin, primeProvenance } from "../chat/provenance.js";
import { publishExternalMessage } from "./history.js";
import { chatEventToHistory, dedupeLookupKeys, dedupeNoteKeys } from "./transcript.js";
import type { HistoryEvent } from "./history.js";
import type { DriverEvent } from "./protocol.js";
import { logger } from "../../utils/logger.js";
import { createLineReader } from "../../utils/lineReader.js";
import { dropOldest } from "./insertionOrder.js";

/**
 * TRANSCRIPT MIRROR — what keeps the NATIVE chat honest while the conversation happens in the TUI.
 *
 * The native chat's socket hears the SDK driver's stdout and nothing else. The moment the person
 * switches to the Terminal tab and types at the prompt (a real incident: the chat felt slow, the user
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

/**
 * `driverKeys` is RECEIVED, not created: it belongs to the card (see `driverKeysFor`), not to this
 * mirror. A mirror is born on the first connect and dies on the last disconnect, but what the driver
 * has already been told to say has still been said — with or without someone watching.
 */
export function createMirrorState(
  cutoffAt: number,
  seenIds: Iterable<string> = [],
  driverKeys: Set<string> = new Set(),
): MirrorState {
  return { cutoffAt, seen: new Set(seenIds), driverKeys };
}

/** Records what the driver said (stdout event) or was told (a user send) into the dedupe set. PURE-ish. */
export function noteDriverEvent(state: MirrorState, event: DriverEvent | { type: "user"; text: string }): void {
  noteDriverKeys(state.driverKeys, event);
}

/** The same registration, on the raw Set — it is what the card keeps between one mirror and the next. PURE-ish. */
function noteDriverKeys(keys: Set<string>, event: DriverEvent | { type: "user"; text: string }): void {
  for (const key of dedupeNoteKeys(event as { type: HistoryEvent["type"]; text?: string; id?: string })) {
    keys.delete(key); // re-adding moves it to the newest slot
    keys.add(key);
  }
  dropOldest(keys, MIRROR_DEDUPE_MAX);
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
    dropOldest(state.seen, MIRROR_DEDUPE_MAX);
    const converted = chatEventToHistory(event);
    if (!converted) continue;
    // The driver already said this on stdout — including the case where Claude Code rewrote a slash
    // command on its way into the transcript (see dedupeLookupKeys).
    const keys = dedupeLookupKeys(converted as { type: HistoryEvent["type"]; text?: string; id?: string });
    if (keys.some((k) => state.driverKeys.has(k))) continue;
    const mirrored: HistoryEvent = { ...converted, source: "terminal" };
    if (mirrored.type === "user" && !mirrored.from) {
      const from = matchOrigin(cardId, mirrored.text, mirrored.at ?? 0);
      if (from) mirrored.from = from;
    }
    // CONVERSATION THE CHAT DID NOT PRODUCE: it entered the transcript through another CLI process (the
    // Terminal tab). Whoever keeps a stream open needs to know — see `onOutsideTurn`. The notice goes out
    // from here, and not from whoever reads the follow's stdout, because it is HERE that one decides the line is new,
    // external and from a person: the reader only passes on what this function has already judged.
    if (mirrored.type === "user") noteOutsideTurn(cardId);
    out.push(mirrored);
  }
  return out;
}

/* ---------------------------------------------------------------- runtime */

interface CardMirror {
  refs: number;
  state: MirrorState;
  /** The live follow process — null before it starts, after it dies, and after the last release. */
  child: ChildProcess | null;
  /** A follow is being spawned right now (its setup awaits): a concurrent acquire must not spawn a second. */
  starting: boolean;
}

const mirrors = new Map<string, CardMirror>();

/**
 * A CARD's dedupe memory — what its driver has already said, or has already been told to say.
 *
 * It lives here, and not inside the mirror, because the two lifetimes are different: the mirror starts on the
 * first connected chat and ends on the last one that closes, while the driver speaks from boot. The resume
 * sweep (`resumeInterruptedTurns`, right after `listen`) injects a turn when no
 * browser has connected yet — and with the memory tied to the mirror that key was thrown away, the mirror
 * was born blind, and the line the CLI wrote in the transcript came back as if it were new conversation: the
 * deploy's system message showed up TWICE (production, 2026-09-28).
 */
const driverKeysByCard = new Map<string, Set<string>>();

/** The card's memory, created the first time someone has something to remember. */
export function driverKeysFor(cardId: string): Set<string> {
  const known = driverKeysByCard.get(cardId);
  if (known) return known;
  const keys = new Set<string>();
  driverKeysByCard.set(cardId, keys);
  return keys;
}

/**
 * THE CONVERSATION MOVED OUTSIDE THE CHAT — whoever needs to know subscribes here.
 *
 * The mirror is the only one that sees it: it reads the transcript and recognises what the driver has already said, so
 * that what is left came from ANOTHER CLI process (the Terminal tab, talking to the SAME session).
 * The chat's driver keeps the conversation in memory while the stream is open; without this notice its
 * next message continues from a stale point and leaves the terminal's turn orphaned — and an orphaned
 * message has no point to go back to, so editing it did not rewind (see `staleView` in sdk-driver.mjs).
 *
 * The direction is mirror → manager, never the other way: `manager.ts` already imports this module, and an
 * import back would close a cycle.
 */
const outsideListeners = new Map<string, Set<() => void>>();

/** Warns that the card had conversation coming from outside the chat. Never lets a listener knock down the mirror. */
function noteOutsideTurn(cardId: string): void {
  for (const listener of outsideListeners.get(cardId) ?? []) {
    try { listener(); } catch { /* a broken listener does not stop the mirror */ }
  }
}

/** Listens to the conversation that comes in from outside on this card. Returns the cancellation. */
export function onOutsideTurn(cardId: string, listener: () => void): () => void {
  const set = outsideListeners.get(cardId) ?? new Set<() => void>();
  outsideListeners.set(cardId, set);
  set.add(listener);
  return () => {
    const live = outsideListeners.get(cardId);
    if (!live) return;
    live.delete(listener);
    if (live.size === 0) outsideListeners.delete(cardId);
  };
}

/**
 * The card is over (driver closed, card deleted): its memory goes with it.
 *
 * EMPTIED, not swapped: a live mirror adopted this SAME Set when it was born (`createMirrorState`) and
 * keeps reading from it. Swapping the Set in the map left the mirror with the dead driver's memory, while
 * the successor wrote into a new Set nobody read — and each of the successor's lines came back through the transcript
 * as if it were the terminal's, a duplicated bubble. The entry only leaves the map with no mirror using it.
 */
export function forgetDriverKeys(cardId: string): void {
  driverKeysByCard.get(cardId)?.clear();
  if (!mirrors.has(cardId)) driverKeysByCard.delete(cardId);
}

/** Reports a driver event/user send of a card into its dedupe memory — whether there is a mirror or not. */
export function noteDriverEventFor(cardId: string, event: DriverEvent | { type: "user"; text: string }): void {
  noteDriverKeys(driverKeysFor(cardId), event);
}

/**
 * Stops EVERY mirror of this process — a deploy's SIGTERM. On blue/green the NEW process resumes the
 * turn as soon as this one lets go of the card, and the resume prompt it injects is unknown to THIS one's dedupe
 * memory: a mirror that stayed alive until the exit would record it as terminal conversation (the
 * duplicated system message, production 2026-10-08). On a SIGTERM (`docker stop`, restart), therefore,
 * the mirrors stop BEFORE the heartbeat is released (see `handOffSdkOnShutdown`).
 */
export function stopAllMirrors(): void {
  for (const mirror of mirrors.values()) stopChild(mirror);
  mirrors.clear();
}

/** Test hook: forget every live mirror (children are killed) and every card's dedupe memory. */
export function resetMirrors(): void {
  stopAllMirrors();
  driverKeysByCard.clear();
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
  /**
   * Transcript ids the connect replay already drew — pre-seeds the dedupe on the FIRST acquire, and
   * again when a later acquire has to restart a follow that died (that tab's replay drew them too).
   */
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
    // A follow that died on its own (runner restart, reaper) left the mirror ALIVE but deaf: while
    // any older tab held a ref, every new connect joined a mirror that mirrored nothing, and live
    // mirroring never came back. A connect is the moment to start it again — unless one is already
    // starting (two tabs connecting together still get ONE follow).
    if (!existing.child && !existing.starting) {
      for (const id of opts.seenIds ?? []) existing.state.seen.add(id);
      dropOldest(existing.state.seen, MIRROR_DEDUPE_MAX);
      await startFollow(cardId, existing);
    }
    return () => release(cardId, existing);
  }
  // The mirror ADOPTS the card's memory: what the driver had already been told to say before someone opened
  // this screen (the boot sweep's turn, for example) stays recognisable when it comes back through the file.
  const mirror: CardMirror = {
    refs: 1,
    state: createMirrorState(opts.cutoffAt ?? Date.now(), opts.seenIds, driverKeysFor(cardId)),
    child: null,
    starting: false,
  };
  mirrors.set(cardId, mirror);
  await startFollow(cardId, mirror);
  return () => release(cardId, mirror);
}

/** Spawns the mirror's follow process and wires its stdout into the conversation. Never throws. */
async function startFollow(cardId: string, mirror: CardMirror): Promise<void> {
  mirror.starting = true;
  try {
    await primeProvenance(cardId).catch(() => undefined);
    const source = await chatSource(cardId);
    // Stopped while it was coming up (the last release, or the shutdown): a follow born now would have no owner.
    if (mirrors.get(cardId) !== mirror) return;
    const child = spawn(source.command.file, source.command.args, { stdio: ["pipe", "pipe", "ignore"] });
    mirror.child = child;
    const readLines = createLineReader();
    child.stdout?.on("data", (chunk: Buffer) => {
      // Mirror stopped (last release, shutdown): what the follow still dumps from its buffer has no owner.
      if (mirrors.get(cardId) !== mirror) return;
      const batch = readLines(chunk).join("\n");
      if (batch.trim() === "") return;
      for (const event of mirrorNewEvents(mirror.state, batch, cardId)) {
        void publishExternalMessage(cardId, event);
      }
    });
    // The follow died on its own (runner restart, reaper, a spawn that failed): the mirror forgets
    // it, and the next acquire starts a fresh one; the replay merge covers whatever happened between.
    const forgetChild = (): void => {
      if (mirrors.get(cardId) === mirror && mirror.child === child) mirror.child = null;
    };
    child.on("close", forgetChild);
    // A spawn that fails asynchronously (EAGAIN, EMFILE) arrives as 'error' — and an 'error' with no
    // listener is rethrown by Node as an uncaught exception that takes the whole back down. Same for
    // the EPIPE `stopChild`'s `stdin.end()` can raise on a follow that is already gone.
    child.on("error", (err) => {
      logger.warn({ card: cardId, detail: err.message }, "sdk transcript mirror follow failed");
      forgetChild();
    });
    child.stdin?.on("error", () => { /* the follow is gone; `close`/`error` above already tell it */ });
    logger.debug({ card: cardId }, "sdk transcript mirror attached");
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not start the sdk transcript mirror");
  } finally {
    mirror.starting = false;
  }
}

/** Releases ONE ref of the mirror the tab took — an already stopped mirror has nothing to release. */
function release(cardId: string, mirror: CardMirror): void {
  if (mirrors.get(cardId) !== mirror) return;
  mirror.refs -= 1;
  if (mirror.refs > 0) return;
  mirrors.delete(cardId);
  stopChild(mirror);
  logger.debug({ card: cardId }, "sdk transcript mirror released");
}
