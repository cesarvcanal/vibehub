import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { readHistory } from "./history.js";
import {
  DRIVER_IDLE_MS,
  attachSocket,
  ensureDriverSession,
  hasDriverSession,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
  stopCardDriver,
} from "./manager.js";
import { notifyCardSessionKill } from "../board/workspace.js";

/**
 * THE BUG THIS FILE PINS (card prompt-56fc, sessão 69b30a1f): the SDK driver was a CHILD OF THE
 * WEBSOCKET — César sent a message, reloaded the page, the socket died and took the driver down
 * MID-TURN. The message was swallowed: no answer in the transcript, and the reconnect's fresh
 * driver resumed the session without continuing the pending turn. The manager decouples the two:
 * ONE driver per card, owned by the backend, multiplexing every socket — a page can close and the
 * turn keeps running, keeps persisting, and the next connect reattaches to the SAME process.
 */

const CARD = "cccc498d-98dd-44b6-97ee-c06a181c3769";
const CARD2 = "dddd498d-98dd-44b6-97ee-c06a181c3769";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (s: string) => boolean; end: () => void; written: string[]; ended: boolean };
  kill: () => void;
  killed: boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written: string[] = [];
  child.stdin = {
    written,
    ended: false,
    write: (s: string) => { written.push(s); return true; },
    end: () => { child.stdin.ended = true; },
  };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

interface FakeSocket extends EventEmitter {
  sent: string[];
  closed: boolean;
  send: (s: string) => void;
  close: () => void;
}

function fakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.sent = [];
  socket.closed = false;
  socket.send = (s: string) => socket.sent.push(s);
  socket.close = () => { socket.closed = true; };
  return socket;
}

function line(event: object): Buffer {
  return Buffer.from(JSON.stringify(event) + "\n");
}

function sentTypes(socket: FakeSocket): string[] {
  return socket.sent.map((s) => (JSON.parse(s) as { type: string }).type);
}

let dir = "";
let savedDataDir = "";
let spawned: FakeChild[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-manager-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  spawned = [];
  setDriverSpawnerForTesting(() => {
    const child = fakeChild();
    spawned.push(child);
    return child as never;
  });
});

afterEach(async () => {
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function ensure(cardId: string = CARD) {
  return ensureDriverSession({ cardId, label: "t", command: { file: "docker", args: ["exec"] } });
}

describe("ensureDriverSession — one driver per card", () => {
  it("spawns ONCE for a card: the second ensure (a reconnect, a second tab) reuses the live driver", () => {
    const a = ensure();
    const b = ensure();
    expect(b).toBe(a);
    expect(spawned.length).toBe(1);
    expect(hasDriverSession(CARD)).toBe(true);
  });

  it("keeps cards apart: two cards get two drivers", () => {
    ensure(CARD);
    ensure(CARD2);
    expect(spawned.length).toBe(2);
  });

  it("spawns anew after the driver died", () => {
    ensure();
    spawned[0]!.emit("close", 0);
    expect(hasDriverSession(CARD)).toBe(false);
    ensure();
    expect(spawned.length).toBe(2);
  });
});

describe("attachSocket — multiplexing (duas abas = uma sessão)", () => {
  it("broadcasts every driver event to every attached socket", () => {
    const session = ensure();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    attachSocket(session, s1 as never);
    attachSocket(session, s2 as never);
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "oi" }));
    expect(sentTypes(s1)).toContain("assistant_text");
    expect(sentTypes(s2)).toContain("assistant_text");
    expect(spawned.length).toBe(1);
  });

  it("a user message from ONE tab reaches the driver's stdin exactly once", () => {
    const session = ensure();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    attachSocket(session, s1 as never);
    attachSocket(session, s2 as never);
    s1.emit("message", Buffer.from(`{"type":"user","text":"roda os testes"}`));
    const writes = spawned[0]!.stdin.written.filter((w) => w.includes("roda os testes"));
    expect(writes.length).toBe(1);
  });

  it("synthesizes `ready` for a socket that attaches to an ALREADY-ready driver (the reconnect)", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "session", sessionId: "abc-123" }));
    // the reconnect: a fresh socket joins the live driver — it must not wait forever for a `ready`
    // the driver only says once, at boot
    const s2 = fakeSocket();
    attachSocket(session, s2 as never);
    const readyFrames = s2.sent.map((s) => JSON.parse(s) as { type: string; resume?: string }).filter((e) => e.type === "ready");
    expect(readyFrames.length).toBe(1);
    expect(readyFrames[0]!.resume).toBe("abc-123");
  });

  it("does NOT synthesize `ready` before the driver said it (the real one is coming)", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    expect(sentTypes(s1)).toEqual([]);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    expect(sentTypes(s1)).toEqual(["ready"]);
  });
});

describe("the turn survives the page (o bug do Cmd+Shift+R)", () => {
  it("closing the last socket does NOT kill the driver mid-turn, and its events still persist", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"faz a coisa"}`));
    // the page dies mid-turn
    socket.emit("close");
    expect(spawned[0]!.killed).toBe(false);
    expect(spawned[0]!.stdin.ended).toBe(false);
    // the driver keeps talking with NOBODY connected — and the history keeps recording
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "feito" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false, sessionId: "s-1" }));
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      const texts = history.map((e) => (e as { text?: string }).text);
      expect(texts).toContain("faz a coisa");
      expect(texts).toContain("feito");
    });
  });

  it("stamps the sender's origin on the user message it persists", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never, { kind: "user", name: "mussa" });
    socket.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      const user = history.find((e) => e.type === "user") as { from?: { name?: string } } | undefined;
      expect(user?.from?.name).toBe("mussa");
    });
  });
});

describe("interrupt — reaches the LIVE driver", () => {
  it("forwards an interrupt frame to the driver's stdin", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"interrupt"}`));
    expect(spawned[0]!.stdin.written.some((w) => w.includes(`"interrupt"`))).toBe(true);
  });
});

describe("end of life", () => {
  it("stopCardDriver ends stdin (the driver's liveness check) and kills the child", () => {
    ensure();
    stopCardDriver(CARD);
    expect(spawned[0]!.stdin.ended).toBe(true);
    expect(spawned[0]!.killed).toBe(true);
    expect(hasDriverSession(CARD)).toBe(false);
  });

  it("killCardSession (pause/hibernate/restart/delete) also stops the card's driver", () => {
    ensure();
    // killCardSession's first act is notifyCardSessionKill(card.id) — the manager listens on it
    notifyCardSessionKill(CARD);
    expect(spawned[0]!.killed).toBe(true);
    expect(hasDriverSession(CARD)).toBe(false);
  });

  it("a dead driver tells the sockets and closes them (the front's reconnect takes over)", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.emit("close", 1);
    const last = JSON.parse(socket.sent[socket.sent.length - 1]!) as { type: string; message?: string };
    expect(last.type).toBe("error");
    expect(last.message).toContain("driver exited");
    expect(socket.closed).toBe(true);
    expect(hasDriverSession(CARD)).toBe(false);
  });
});

describe("idle shutdown — ocioso e sem ninguém olhando", () => {
  it("stops the driver after DRIVER_IDLE_MS with no sockets and no running turn", () => {
    vi.useFakeTimers();
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("close");
    vi.advanceTimersByTime(DRIVER_IDLE_MS + 1);
    expect(spawned[0]!.killed).toBe(true);
    expect(hasDriverSession(CARD)).toBe(false);
  });

  it("does NOT stop a driver whose turn is still running (o exato bug: sem página, turno vivo)", () => {
    vi.useFakeTimers();
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"tarefa longa"}`));
    socket.emit("close"); // page gone, turn still running
    vi.advanceTimersByTime(DRIVER_IDLE_MS * 3);
    expect(spawned[0]!.killed).toBe(false);
    // the turn ends with nobody connected -> NOW the idle clock starts
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    vi.advanceTimersByTime(DRIVER_IDLE_MS + 1);
    expect(spawned[0]!.killed).toBe(true);
  });

  it("a socket attaching cancels the pending idle stop", () => {
    vi.useFakeTimers();
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    s1.emit("close");
    vi.advanceTimersByTime(DRIVER_IDLE_MS / 2);
    const s2 = fakeSocket();
    attachSocket(session, s2 as never);
    vi.advanceTimersByTime(DRIVER_IDLE_MS * 2);
    expect(spawned[0]!.killed).toBe(false);
  });

  it("an interrupt forgets the queued turns so an abandoned queue cannot pin the driver forever", () => {
    vi.useFakeTimers();
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"um"}`));
    socket.emit("message", Buffer.from(`{"type":"user","text":"dois"}`)); // queued in the driver
    socket.emit("message", Buffer.from(`{"type":"interrupt"}`)); // driver drops the queue
    // only the RUNNING turn will produce a result
    spawned[0]!.stdout.emit("data", line({ type: "result", subtype: "aborted", isError: false }));
    socket.emit("close");
    vi.advanceTimersByTime(DRIVER_IDLE_MS + 1);
    expect(spawned[0]!.killed).toBe(true);
  });
});

describe("session id persistence", () => {
  it("remembers the latest session id (the resume key a late socket's synthesized ready carries)", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "session", sessionId: "first" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false, sessionId: "second" }));
    const s2 = fakeSocket();
    attachSocket(session, s2 as never);
    const ready = JSON.parse(s2.sent[0]!) as { type: string; resume?: string };
    expect(ready.resume).toBe("second");
  });
});
