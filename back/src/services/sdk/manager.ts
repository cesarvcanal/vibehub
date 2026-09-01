import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebSocket } from "ws";
import * as registry from "../board/registry.js";
import { onCardSessionKill } from "../board/workspace.js";
import { appendHistory, replayableHistoryEvent } from "./history.js";
import { noteDriverEventFor } from "./mirror.js";
import { parseDriverLine, parseSdkClientFrame, encodeControl, type DriverEvent } from "./protocol.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { logger } from "../../utils/logger.js";

/**
 * SDK DRIVER MANAGER — ONE driver process per card, owned by the BACKEND, not by a websocket.
 *
 * The bug this closes (card prompt-56fc, sessão 69b30a1f): the driver used to be spawned per
 * CONNECTION and torn down in the socket's close handler — César sent a message on the native
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
  /** The session was stopped or its child closed — a new ensure must spawn anew. */
  closed: boolean;
}

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
  if (event.type === "ready") session.ready = true;
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
    logger.debug({ card: opts.label, stderr: chunk.toString().slice(0, 500) }, "sdk driver stderr");
  });
  child.on("error", (err) => {
    logger.warn({ card: opts.label, detail: err.message }, "sdk driver process error");
  });
  child.on("close", (code) => {
    // The driver died (idle stop, killCardSession, a crash): tell whoever is watching and close
    // their sockets — the front's reconnect loop spawns the successor on its next connect.
    clearIdleTimer(session);
    session.closed = true;
    if (sessions.get(opts.cardId) === session) sessions.delete(opts.cardId);
    broadcast(session, { type: "error", message: `driver exited (code ${code ?? "?"})` });
    for (const socket of session.sockets) {
      try { socket.close(); } catch { /* already closed */ }
    }
    session.sockets.clear();
    logger.debug({ card: opts.label, code }, "sdk driver exited");
  });
  return session;
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
  // synthesized one the fresh page would never enable its composer.
  if (session.ready) {
    try { socket.send(JSON.stringify({ type: "ready", resume: session.lastSessionId })); } catch { /* going away */ }
  }

  const keepalive = setInterval(() => {
    try { socket.ping?.(); } catch { /* the close handler cleans up */ }
  }, KEEPALIVE_MS);

  socket.on("message", (raw: Buffer) => {
    const control = parseSdkClientFrame(raw.toString());
    if (!control) return;
    try { session.child.stdin.write(encodeControl(control)); } catch { /* driver gone; close will fire */ }
    if (control.type === "user") {
      session.activeTurns += 1;
      clearIdleTimer(session);
      noteDriverEventFor(session.cardId, control);
      void appendHistory(session.cardId, { type: "user", text: control.text, at: Date.now(), from: origin });
    } else if (control.type === "interrupt") {
      // The driver drops its QUEUE on interrupt — only the running turn will still produce a
      // result. Forgetting the queued ones here keeps an abandoned queue from pinning the driver
      // past the idle stop forever.
      session.activeTurns = Math.min(session.activeTurns, 1);
    }
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
  logger.debug({ card: session.label }, "sdk driver stopped");
}

// Every path that ends a card's terminal (pause, hibernate, restart, delete, model/account
// switch) goes through killCardSession — the driver dies with it.
onCardSessionKill((cardId) => stopCardDriver(cardId));
