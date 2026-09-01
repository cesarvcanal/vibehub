import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebSocket } from "ws";
import * as registry from "../board/registry.js";
import { onCardSessionKill } from "../board/workspace.js";
import { appendHistory, replayableHistoryEvent } from "./history.js";
import { clearInflightMarker, inflightPreview, writeInflightMarker } from "./inflight.js";
import { noteDriverEventFor } from "./mirror.js";
import { isHarnessFiller } from "../chat/chat.js";
import { parseDriverLine, parseSdkClientFrame, encodeControl, type DriverEvent } from "./protocol.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { logger } from "../../utils/logger.js";

/**
 * SDK DRIVER MANAGER — ONE driver process per card, owned by the BACKEND, not by a websocket.
 *
 * The bug this closes (the reload-mid-turn bug): the driver used to be spawned per
 * CONNECTION and torn down in the socket's close handler — the user sent a message on the native
 * chat, hit Cmd+Shift+R, the socket died and killed the driver MID-TURN. The answer never reached
 * the transcript, and the reconnect's fresh driver resumed the session without continuing the
 * pending turn: the message was silently swallowed.
 *
 * The manager decouples the turn from the page:
 *  - `ensureDriverSession` spawns AT MOST one driver per card and hands every later connect the
 *    same live process (two tabs of one card multiplex one driver — never two);
 *  - the manager itself listens to the driver's stdout: history persistence, mirror dedupe keys
 *    and resume-id persistence all live HERE, the side that survives — a turn keeps flowing into
 *    `sdk-history` with zero pages open;
 *  - `attachSocket` fans events out to every connected socket and funnels controls (user message,
 *    interrupt, permission decision) into the one stdin; a socket closing merely detaches it;
 *  - end of life: `stopCardDriver` (wired into `killCardSession` via `onCardSessionKill`, so
 *    pause/hibernate/restart/delete/model-switch all end the driver), plus an IDLE timer — a
 *    driver with no sockets AND no running turn for `DRIVER_IDLE_MS` shuts down on its own (the
 *    persisted resume id brings the conversation back on the next connect).
 *
 * The runner reaper never touches a live driver: the driver is not a `claude`/watcher process, its
 * SDK subprocesses hang off it (never ppid 1 while it lives), and `reapCandidates` additionally
 * refuses anything carrying the driver's path (see services/reaper/reaper.ts).
 */

/** No sockets AND no running turn for this long ⇒ the driver shuts down (resume covers the rest). */
export const DRIVER_IDLE_MS = 15 * 60_000;

/** Websocket keepalive — same cadence as the terminal socket (proxies drop idle websockets). */
const KEEPALIVE_MS = 25_000;

export interface DriverSession {
  cardId: string;
  /** Log label (the card's worktree slug). */
  label: string;
  child: ChildProcessWithoutNullStreams;
  sockets: Set<WebSocket>;
  /** The driver said `ready` — a socket attaching after this gets a synthesized one. */
  ready: boolean;
  /** Latest session id the driver reported — the resume key (also persisted on the card). */
  lastSessionId?: string;
  /** Turns in flight or queued in the driver: +1 per user send, -1 per result. */
  activeTurns: number;
  idleTimer: NodeJS.Timeout | null;
  buffer: string;
  /** Rolling tail of the driver's stderr — what a post-mortem has to say (see STDERR_TAIL_MAX). */
  stderrTail: string;
  /** The session was stopped or its child closed — a new ensure must spawn anew. */
  closed: boolean;
}

/** How much stderr the post-mortem keeps. Enough for a stack trace, bounded against a chatty child. */
export const STDERR_TAIL_MAX = 2000;

const sessions = new Map<string, DriverSession>();

/* ------------------------------------------------------------- test seams */

type DriverSpawner = (file: string, args: string[]) => ChildProcessWithoutNullStreams;

const realSpawner: DriverSpawner = (file, args) =>
  spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

let spawner: DriverSpawner = realSpawner;

/** Test hook: replace (or with null, restore) how the driver child is spawned. */
export function setDriverSpawnerForTesting(fn: DriverSpawner | null): void {
  spawner = fn ?? realSpawner;
}

/** Test hook: stop and forget every live driver session. */
export function resetSdkSessionsForTesting(): void {
  for (const cardId of [...sessions.keys()]) stopCardDriver(cardId);
  sessions.clear();
}

/** Whether a card has a LIVE driver right now. */
export function hasDriverSession(cardId: string): boolean {
  const session = sessions.get(cardId);
  return !!session && !session.closed;
}

/* ---------------------------------------------------------------- helpers */

/** ws sockets expose the raw TCP socket as `_socket`; flushing small frames beats batching them. */
function disableNagle(socket: WebSocket): void {
  const raw = (socket as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })._socket;
  try { raw?.setNoDelay?.(true); } catch { /* the socket is already closing */ }
}

function broadcast(session: DriverSession, event: object): void {
  const frame = JSON.stringify(event);
  for (const socket of session.sockets) {
    try { socket.send(frame); } catch { /* that socket is going away; its close handler detaches it */ }
  }
}

function clearIdleTimer(session: DriverSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

/**
 * Arm the idle stop when NOTHING holds the driver: no page connected and no turn in flight. The
 * check runs again when the timer fires — a turn or a socket that showed up in between wins.
 */
function maybeScheduleIdleStop(session: DriverSession): void {
  if (session.closed || session.sockets.size > 0 || session.activeTurns > 0) return;
  if (session.idleTimer) return;
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (session.closed || session.sockets.size > 0 || session.activeTurns > 0) return;
    logger.info({ card: session.label, audit: true, action: "sdk.driver.idle" }, "sdk driver idle — shutting it down (resume id persisted)");
    stopCardDriver(session.cardId);
  }, DRIVER_IDLE_MS);
  session.idleTimer.unref?.();
}

/** One driver event, seen by the SURVIVING side: persist, remember, fan out. */
function handleDriverEvent(session: DriverSession, event: DriverEvent): void {
  // The harness's canned close-out for a turn that died mid-flight ("No response requested.") can
  // also arrive LIVE, as the resumed session's first assistant message. It is filler, not an
  // answer — shown, it reads as Claude dismissing the person's message (the production symptom).
  if (event.type === "assistant_text" && typeof (event as { text?: unknown }).text === "string"
    && isHarnessFiller("assistant", (event as { text: string }).text)) return;
  if (event.type === "ready") {
    session.ready = true;
    // Stamp the manager's live turn count on the frame: a message may already be queued on the
    // fresh driver's stdin (sent before it booted) — the front's spinner must know it.
    event = { ...event, turnActive: session.activeTurns > 0 };
  }
  if ((event.type === "session" || event.type === "result") && event.sessionId && event.sessionId !== session.lastSessionId) {
    session.lastSessionId = event.sessionId;
    // Persist the resume key on the card (board.json) so the NEXT driver spawn — after an idle
    // stop, a pause, a backend restart — continues this very conversation (`--resume`).
    void registry.updateCard(session.cardId, { resumeSessionId: event.sessionId }).catch((err: unknown) => {
      logger.warn({ card: session.label, detail: (err as Error).message }, "could not persist the sdk session id");
    });
  }
  if (event.type === "result") {
    session.activeTurns = Math.max(0, session.activeTurns - 1);
    // The last turn in flight CLOSED: the durable "turn in flight" marker comes off. A deploy that
    // lands after this point interrupts nothing — no marker, no boot-resume (see ./inflight.ts).
    if (session.activeTurns === 0) void clearInflightMarker(session.cardId);
    maybeScheduleIdleStop(session);
  }
  broadcast(session, event);
  // History + mirror dedupe are MANAGER duties, not socket duties: they must keep happening while
  // no page is open — that is the whole point of the detach.
  noteDriverEventFor(session.cardId, event);
  if (replayableHistoryEvent(event)) void appendHistory(session.cardId, { ...event, at: Date.now() });
}

/* ------------------------------------------------------------------- API */

export interface EnsureDriverOpts {
  cardId: string;
  /** Log label (the card's worktree slug). */
  label: string;
  /** The spawn command (built by the route via `sdkDriverCommand` + `resumeTargetFor`). */
  command: { file: string; args: string[] };
}

/**
 * The card's ONE driver: returns the live session, or spawns it. Spawning is synchronous, so two
 * simultaneous connects cannot race a second driver into existence.
 */
export function ensureDriverSession(opts: EnsureDriverOpts): DriverSession {
  const existing = sessions.get(opts.cardId);
  if (existing && !existing.closed) return existing;

  const child = spawner(opts.command.file, opts.command.args);
  const session: DriverSession = {
    cardId: opts.cardId,
    label: opts.label,
    child,
    sockets: new Set(),
    ready: false,
    activeTurns: 0,
    idleTimer: null,
    buffer: "",
    stderrTail: "",
    closed: false,
  };
  sessions.set(opts.cardId, session);
  logger.info({ card: opts.label }, "sdk driver spawned (card-owned, survives the page)");

  child.stdout.on("data", (chunk: Buffer) => {
    session.buffer += chunk.toString();
    let nl: number;
    while ((nl = session.buffer.indexOf("\n")) >= 0) {
      const line = session.buffer.slice(0, nl);
      session.buffer = session.buffer.slice(nl + 1);
      const event = parseDriverLine(line);
      if (event) handleDriverEvent(session, event);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    // KEEP the tail, don't just debug-log it: in the original incident the driver died with its
    // stderr invisible (debug level) and its exit frame sent to an already-closed socket — a fully
    // SILENT death. The tail is the post-mortem the exit handler below reports.
    session.stderrTail = (session.stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX);
    logger.debug({ card: opts.label, stderr: chunk.toString().slice(0, 500) }, "sdk driver stderr");
  });
  child.on("error", (err) => {
    logger.warn({ card: opts.label, detail: err.message }, "sdk driver process error");
    broadcast(session, { type: "error", message: `driver process error: ${err.message}` });
  });
  child.on("close", (code) => {
    // The driver died (idle stop, killCardSession, a crash): tell whoever is watching and close
    // their sockets — the front's reconnect loop spawns the successor on its next connect.
    const deliberate = session.closed; // stopCardDriver stamped it BEFORE killing
    clearIdleTimer(session);
    session.closed = true;
    if (sessions.get(opts.cardId) === session) sessions.delete(opts.cardId);
    const stderrNote = session.stderrTail.trim() === "" ? "" : ` — stderr: ${session.stderrTail.trim().slice(-400)}`;
    broadcast(session, { type: "error", message: `driver exited (code ${code ?? "?"})${stderrNote}` });
    for (const socket of session.sockets) {
      try { socket.close(); } catch { /* already closed */ }
    }
    session.sockets.clear();
    // A death nobody asked for is NEVER silent: warn with the exit code, the stderr tail and
    // whether a turn was running — the log line that was missing from the incident.
    if (deliberate && (code === 0 || code === null)) {
      logger.debug({ card: opts.label, code }, "sdk driver exited");
    } else {
      logger.warn(
        {
          audit: true,
          action: "sdk.driver.exit",
          card: opts.label,
          code,
          deliberate,
          turnsInFlight: session.activeTurns,
          stderr: session.stderrTail.trim().slice(-STDERR_TAIL_MAX) || undefined,
        },
        "sdk driver exited unexpectedly",
      );
    }
  });
  return session;
}

/**
 * ONE client frame (raw text from a websocket — live or buffered while the route was still setting
 * the connection up) funneled into the card's driver. A user message is a TURN: it goes to the
 * driver's stdin AS a user message (never converted, never wrapped), the turn count and the durable
 * in-flight marker (see ./inflight.ts) both move, and the history gets the line with its sender.
 */
export function handleClientFrame(session: DriverSession, raw: string, origin?: MessageOrigin): void {
  const control = parseSdkClientFrame(raw);
  if (!control) return;
  try { session.child.stdin.write(encodeControl(control)); } catch { /* driver gone; close will fire */ }
  if (control.type === "user") {
    session.activeTurns += 1;
    clearIdleTimer(session);
    noteDriverEventFor(session.cardId, control);
    void appendHistory(session.cardId, { type: "user", text: control.text, at: Date.now(), from: origin });
    // The durable "turn in flight" record: if a deploy kills the back (and this driver with it)
    // before the result arrives, the boot sweep finds this marker and the turn is not silently
    // lost. attempts: 0 — a person's own turn always earns one automatic resume.
    void writeInflightMarker(session.cardId, { startedAt: Date.now(), preview: inflightPreview(control.text), attempts: 0 });
  } else if (control.type === "interrupt") {
    // The driver drops its QUEUE on interrupt — only the running turn will still produce a
    // result. Forgetting the queued ones here keeps an abandoned queue from pinning the driver
    // past the idle stop forever.
    session.activeTurns = Math.min(session.activeTurns, 1);
  }
}

/**
 * A turn injected by the BACKEND itself (the boot-resume after a deploy killed a turn in flight):
 * same stdin path and same turn accounting as a person's message — the driver receives a NORMAL
 * user turn — but the history line carries system provenance (it must never read as the person's
 * own words) and the in-flight marker carries the attempt count that stops a resume loop.
 */
export function injectSystemTurn(session: DriverSession, text: string, origin: MessageOrigin, attempts: number): void {
  try { session.child.stdin.write(encodeControl({ type: "user", text })); } catch { /* driver gone; close will fire */ }
  session.activeTurns += 1;
  clearIdleTimer(session);
  noteDriverEventFor(session.cardId, { type: "user", text });
  void appendHistory(session.cardId, { type: "user", text, at: Date.now(), from: origin });
  void writeInflightMarker(session.cardId, { startedAt: Date.now(), preview: inflightPreview(text), attempts });
}

/**
 * Attach one websocket to the card's live driver: events fan out to it, its controls funnel in.
 * `origin` is who types on THIS socket — stamped on the messages it persists. Detaching (socket
 * close/error) never touches the driver; it only arms the idle stop when nothing else holds it.
 */
export function attachSocket(session: DriverSession, socket: WebSocket, origin?: MessageOrigin): void {
  disableNagle(socket);
  clearIdleTimer(session);
  session.sockets.add(socket);

  // The reconnect case: the driver said `ready` long ago (it only says it at boot). Without a
  // synthesized one the fresh page would never enable its composer. `turnActive` carries the
  // manager's REAL state: a view remounting mid-turn (Terminal↔Chat, reload)
  // reset its own turn flag and nothing re-lit the "Trabalhando…" spinner until much later.
  if (session.ready) {
    try {
      socket.send(JSON.stringify({ type: "ready", resume: session.lastSessionId, turnActive: session.activeTurns > 0 }));
    } catch { /* going away */ }
  }

  const keepalive = setInterval(() => {
    try { socket.ping?.(); } catch { /* the close handler cleans up */ }
  }, KEEPALIVE_MS);

  socket.on("message", (raw: Buffer) => {
    handleClientFrame(session, raw.toString(), origin);
  });

  const detach = (): void => {
    clearInterval(keepalive);
    session.sockets.delete(socket);
    if (session.sockets.size === 0) maybeScheduleIdleStop(session);
  };
  socket.on("close", detach);
  socket.on("error", detach);
}

/**
 * Stop a card's driver NOW (pause, hibernate, restart, delete, model/account switch, idle).
 * stdin first — EOF is the driver's own exit signal (`rl.on("close") → exit 0`), and it reaches
 * across the docker exec — then kill the local client. Best-effort and idempotent.
 */
export function stopCardDriver(cardId: string): void {
  const session = sessions.get(cardId);
  if (!session) return;
  sessions.delete(cardId);
  clearIdleTimer(session);
  session.closed = true;
  try { session.child.stdin.end(); } catch { /* already gone */ }
  try { session.child.kill(); } catch { /* already gone */ }
  // A DELIBERATE stop (pause, hibernate, restart, delete, model switch, idle) abandons the turn on
  // purpose — the marker comes off so the next boot does not "resume" something a person ended.
  void clearInflightMarker(cardId);
  logger.debug({ card: session.label }, "sdk driver stopped");
}

/**
 * Best-effort goodbye on the BACK's own shutdown (SIGTERM from a deploy): end every driver's stdin
 * (EOF is the driver's exit signal, it reaches across the docker exec) and kill the local clients —
 * but KEEP the in-flight markers: they are exactly what tells the next boot which turns this
 * shutdown interrupted (see ./resume.ts). Synchronous and non-blocking — docker stop gives seconds,
 * not promises.
 */
export function shutdownAllDrivers(): void {
  for (const session of sessions.values()) {
    clearIdleTimer(session);
    session.closed = true;
    try { session.child.stdin.end(); } catch { /* already gone */ }
    try { session.child.kill(); } catch { /* already gone */ }
    if (session.activeTurns > 0) {
      logger.warn(
        { audit: true, action: "sdk.driver.shutdown", card: session.label, turnsInFlight: session.activeTurns },
        "sdk driver shut down with a turn in flight — marker kept for the boot resume",
      );
    }
  }
  sessions.clear();
}

// Every path that ends a card's terminal (pause, hibernate, restart, delete, model/account
// switch) goes through killCardSession — the driver dies with it.
onCardSessionKill((cardId) => stopCardDriver(cardId));
