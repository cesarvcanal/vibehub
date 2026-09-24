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
  handleClientFrame,
  hasDriverSession,
  isCardChatInUse,
  injectSystemTurn,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
  shutdownAllDrivers,
  stopCardDriver,
} from "./manager.js";
import { readInflightMarker } from "./inflight.js";
import { notifyCardSessionKill } from "../board/workspace.js";

/**
 * THE BUG THIS FILE PINS (the reload-mid-turn bug): the SDK driver was a CHILD OF THE
 * WEBSOCKET — the user sent a message, reloaded the page, the socket died and took the driver down
 * MID-TURN. The message was swallowed: no answer in the transcript, and the reconnect's fresh
 * driver resumed the session without continuing the pending turn. The manager decouples the two:
 * ONE driver per card, owned by the backend, multiplexing every socket — a page can close and the
 * turn keeps running, keeps persisting, and the next connect reattaches to the SAME process.
 */

/** The board writes the manager makes: observed, not performed (no board.json in a unit test). */
const { humanActiveCalls } = vi.hoisted(() => ({ humanActiveCalls: [] as string[] }));
vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return {
    ...actual,
    markCardHumanActive: (cardId: string) => { humanActiveCalls.push(cardId); return Promise.resolve(undefined); },
  };
});

const CARD = "cccc498d-98dd-44b6-97ee-c06a181c3769";
const CARD2 = "dddd498d-98dd-44b6-97ee-c06a181c3769";

/** The stdin double is an EventEmitter (a real one is a stream): the manager listens for EPIPE. */
interface FakeStdin extends EventEmitter {
  write: (s: string) => boolean;
  end: () => void;
  written: string[];
  ended: boolean;
  writable: boolean;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: FakeStdin;
  exitCode: number | null;
  kill: () => void;
  killed: boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written: string[] = [];
  const stdin = new EventEmitter() as FakeStdin;
  stdin.written = written;
  stdin.ended = false;
  stdin.writable = true;
  stdin.write = (s: string) => { written.push(s); return true; };
  stdin.end = () => { stdin.ended = true; stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
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
  humanActiveCalls.length = 0;
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

  it("the synthesized `ready` says a turn is IN FLIGHT (reattach mid-turn — Terminal↔Chat mid-turn)", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    s1.emit("message", Buffer.from(`{"type":"user","text":"faz a coisa"}`));
    // the view remounts (tab switch): the fresh socket must LEARN the turn is running
    const s2 = fakeSocket();
    attachSocket(session, s2 as never);
    const ready = JSON.parse(s2.sent[0]!) as { type: string; turnActive?: boolean };
    expect(ready.type).toBe("ready");
    expect(ready.turnActive).toBe(true);
  });

  it("the synthesized `ready` says turnActive false when NOTHING is running (reattach idle)", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    s1.emit("message", Buffer.from(`{"type":"user","text":"faz a coisa"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    const s2 = fakeSocket();
    attachSocket(session, s2 as never);
    const ready = JSON.parse(s2.sent[0]!) as { type: string; turnActive?: boolean };
    expect(ready.turnActive).toBe(false);
  });

  it("the driver's REAL `ready` is stamped with the live turn count (message queued before boot)", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    // the message goes out before the driver said `ready` — it is queued on stdin
    s1.emit("message", Buffer.from(`{"type":"user","text":"faz a coisa"}`));
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    const ready = s1.sent.map((s) => JSON.parse(s) as { type: string; turnActive?: boolean }).find((e) => e.type === "ready");
    expect(ready?.turnActive).toBe(true);
  });
});

describe("the command catalogue (the chat's \"/\" menu)", () => {
  /** What the driver forwards from the CLI: the raw lists, before the back makes them a menu. */
  const rawCatalog = {
    type: "catalog",
    commands: [
      { name: "code-review", description: "Review the  diff\nfor bugs", argumentHint: "[<pr#>]", aliases: ["review"] },
      { name: "doctor", description: "terminal-only" },
      { name: "superpowers:brainstorm", description: "brainstorm" },
      { name: "../../etc/passwd", description: "not a command name" },
      "not an object",
    ],
    skills: ["code-review"],
    plugins: [{ name: "superpowers", path: "/root/.claude/plugins/superpowers" }],
    hidden: ["doctor"],
  };

  it("normalises what the driver forwards before any of it reaches a browser", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line(rawCatalog));
    const frame = socket.sent.map((s) => JSON.parse(s) as { type: string; commands?: unknown[] })
      .find((e) => e.type === "catalog")!;
    expect(frame.commands).toEqual([
      { name: "code-review", source: "skill", description: "Review the diff for bugs", argumentHint: "[<pr#>]", aliases: ["review"] },
      { name: "superpowers:brainstorm", source: "plugin", description: "brainstorm" },
    ]);
  });

  it("replays it to a page that attaches later — the driver only announces it at boot", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line(rawCatalog));

    const s2 = fakeSocket();
    attachSocket(session, s2 as never);
    const catalogs = s2.sent.map((s) => JSON.parse(s) as { type: string }).filter((e) => e.type === "catalog");
    expect(catalogs.length).toBe(1);
  });

  it("never writes it to the conversation — it is state, not something anybody said", async () => {
    const session = ensure();
    attachSocket(session, fakeSocket() as never);
    spawned[0]!.stdout.emit("data", line(rawCatalog));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const history = await readHistory(CARD);
    expect(history.some((e) => e.type === "catalog")).toBe(false);
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
    attachSocket(session, socket as never, { kind: "user", name: "alex" });
    socket.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      const user = history.find((e) => e.type === "user") as { from?: { name?: string } } | undefined;
      expect(user?.from?.name).toBe("alex");
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

describe("question_answer — reaches the LIVE driver", () => {
  it("funnels the answer frame into the driver's stdin without counting a turn", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"question_answer","id":"q_1","answers":[{"selected":["Summary"]}]}`));
    expect(spawned[0]!.stdin.written.some((w) => w.includes(`"question_answer"`) && w.includes(`"Summary"`))).toBe(true);
    expect(session.activeTurns).toBe(0); // an answer is not a new turn — the turn asking it is already counted
  });
});

describe("streaming input — mensagem no meio do turno (turn_absorbed)", () => {
  it("a mid-turn send folded into the running turn closes on ONE result (marker off, count zeroed)", async () => {
    // Two sends, ONE turn: the second arrived mid-turn and the driver folded it in (streaming
    // input). The driver says so with `turn_absorbed`; without it the manager would wait forever
    // for a second result — spinner pinned, idle stop never armed, marker never cleared.
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"faz a tarefa"}`));
    socket.emit("message", Buffer.from(`{"type":"user","text":"aproveita e ajusta o título"}`)); // mid-turn
    expect(session.activeTurns).toBe(2);
    // Wait for the SECOND send's marker write to land before the result clears it — the writes are
    // fire-and-forget, and a late write racing past the clear would flake this test, not the code.
    await vi.waitFor(async () => {
      expect((await readInflightMarker(CARD))?.preview).toBe("aproveita e ajusta o título");
    }, { timeout: 5000 });
    spawned[0]!.stdout.emit("data", line({ type: "turn_absorbed" }));
    expect(session.activeTurns).toBe(1); // the fold took the second send's +1 back — one result owed
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    expect(session.activeTurns).toBe(0);
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull(), { timeout: 5000 }); // ONE result closed the flight
  });

  it("broadcasts turn_absorbed to the sockets (the front labels the bubble)", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"um"}`));
    socket.emit("message", Buffer.from(`{"type":"user","text":"dois"}`));
    spawned[0]!.stdout.emit("data", line({ type: "turn_absorbed" }));
    expect(sentTypes(socket)).toContain("turn_absorbed");
  });

  it("turn_absorbed floors at ONE — an absorbed send implies a turn in flight, its result still owed", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"um"}`));
    expect(session.activeTurns).toBe(1);
    // A stray/duplicated absorbed frame must not zero the count while the turn runs.
    spawned[0]!.stdout.emit("data", line({ type: "turn_absorbed" }));
    expect(session.activeTurns).toBe(1);
  });

  it("turn_absorbed is live-only: it never lands in the history (a replay has nothing to label)", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"um"}`));
    socket.emit("message", Buffer.from(`{"type":"user","text":"dois"}`));
    spawned[0]!.stdout.emit("data", line({ type: "turn_absorbed" }));
    await new Promise((r) => setTimeout(r, 10));
    const history = await readHistory(CARD);
    expect(history.some((e) => e.type === "turn_absorbed")).toBe(false);
    expect(history.filter((e) => e.type === "user").length).toBe(2); // both sends persisted normally
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

  it("a crash is NEVER silent: the exit frame carries the code AND the stderr tail", () => {
    // The original incident: the driver died with stderr at debug level and the exit frame on a
    // closed socket — nothing anywhere said WHY. The post-mortem now travels in the frame itself.
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stderr.emit("data", Buffer.from("TypeError: boom at resume\n"));
    spawned[0]!.emit("close", 1);
    const last = JSON.parse(socket.sent[socket.sent.length - 1]!) as { type: string; message?: string };
    expect(last.type).toBe("error");
    expect(last.message).toContain("code 1");
    expect(last.message).toContain("TypeError: boom");
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
    socket.emit("message", Buffer.from(`{"type":"user","text":"dois"}`)); // already in the CLI's stream
    socket.emit("message", Buffer.from(`{"type":"interrupt"}`)); // aborts the running turn
    // at most the RUNNING turn still produces a result
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

describe("inflight markers — a durabilidade do turno em voo (o bug do deploy)", () => {
  it("a user turn writes the durable marker; the closing result removes it", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"trabalho longo"}`));
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker).not.toBeNull();
      expect(marker!.attempts).toBe(0);
      expect(marker!.preview).toBe("trabalho longo");
    });
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await vi.waitFor(async () => {
      expect(await readInflightMarker(CARD)).toBeNull();
    });
  });

  it("two turns in flight: the marker only comes off when the LAST one closes", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"um"}`));
    socket.emit("message", Buffer.from(`{"type":"user","text":"dois"}`));
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).not.toBeNull());
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    // one turn still running — the marker stays
    await new Promise((r) => setImmediate(r));
    expect(await readInflightMarker(CARD)).not.toBeNull();
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await vi.waitFor(async () => {
      expect(await readInflightMarker(CARD)).toBeNull();
    });
  });

  it("a DELIBERATE stop (pause/hibernate/delete) clears the marker — no resume of what a person ended", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"faz a coisa"}`));
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).not.toBeNull());
    stopCardDriver(CARD);
    await vi.waitFor(async () => {
      expect(await readInflightMarker(CARD)).toBeNull();
    });
  });

  it("shutdownAllDrivers (SIGTERM do deploy) KEEPS the marker — it is the message to the next boot", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"faz a coisa"}`));
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).not.toBeNull());
    shutdownAllDrivers();
    expect(spawned[0]!.stdin.ended).toBe(true); // the clean goodbye that crosses the docker exec
    expect(hasDriverSession(CARD)).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(await readInflightMarker(CARD)).not.toBeNull(); // the boot sweep's input survives
  });

  it("injectSystemTurn: normal user turn on stdin, system provenance in history, attempts carried", async () => {
    const session = ensure();
    injectSystemTurn(session, "continue de onde parou", { kind: "system", name: "vibehub" }, 1);
    const frames = spawned[0]!.stdin.written.map((s) => JSON.parse(s) as { type: string; text?: string });
    expect(frames).toEqual([{ type: "user", text: "continue de onde parou" }]); // NEVER wrapped
    expect(session.activeTurns).toBe(1);
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.length).toBe(1);
      expect(history[0]!.type).toBe("user");
      expect(history[0]!.from).toEqual({ kind: "system", name: "vibehub" });
      expect((await readInflightMarker(CARD))?.attempts).toBe(1);
    });
  });

  it("handleClientFrame delivers a frame buffered during the route's setup gap as a normal user turn", async () => {
    // The production symptom: a message typed right after a reconnect (while the route was still
    // probing/replaying, with no listener attached) was silently dropped. The route now buffers
    // and drains through this same funnel.
    const session = ensure();
    handleClientFrame(session, `{"type":"user","text":"e aí, como tá indo?"}`);
    const frames = spawned[0]!.stdin.written.map((s) => JSON.parse(s) as { type: string; text?: string });
    expect(frames).toEqual([{ type: "user", text: "e aí, como tá indo?" }]);
    expect(session.activeTurns).toBe(1);
  });
});

describe("harness filler — 'No response requested.' nunca vira resposta no chat", () => {
  it("drops the canned close-out arriving live from a resumed session", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "No response requested." }));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "Resposta de verdade." }));
    const texts = socket.sent
      .map((s) => JSON.parse(s) as { type: string; text?: string })
      .filter((e) => e.type === "assistant_text")
      .map((e) => e.text);
    expect(texts).toEqual(["Resposta de verdade."]);
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.map((e) => (e as { text?: string }).text)).toEqual(["Resposta de verdade."]);
    });
  });
});

describe("edit_user — a edição de mensagem vira supersede no stdin", () => {
  it("writes ONE wrapped user turn to stdin and never a raw edit_user control", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"sobe pra prod","text":"sobe pra dev"}`));
    const written = spawned[0]!.stdin.written.join("");
    expect(written).not.toContain("edit_user");
    const turns = spawned[0]!.stdin.written.map((w) => JSON.parse(w) as { type: string; text: string });
    expect(turns.length).toBe(1);
    expect(turns[0]!.type).toBe("user");
    expect(turns[0]!.text).toContain("correção do usuário");
    expect(turns[0]!.text).toContain("«sobe pra prod»");
    expect(turns[0]!.text.endsWith("sobe pra dev")).toBe(true);
  });

  it("counts a turn and writes the durable inflight marker with the CLEAN preview", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"velha","text":"nova versão"}`));
    expect(session.activeTurns).toBe(1);
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker).not.toBeNull();
      expect(marker!.preview).toBe("nova versão");
      expect(marker!.attempts).toBe(0);
    });
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
  });

  it("history gets the marker line AND the new message with clean text + the wrapped `sent`", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"sobe pra prod"}`));
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"sobe pra prod","text":"sobe pra dev"}`));
    await vi.waitFor(async () => {
      const events = await readHistory(CARD);
      const types = events.map((e) => e.type);
      expect(types).toEqual(["user", "message_edited", "user"]);
      expect((events[1] as { originalText: string }).originalText).toBe("sobe pra prod");
      const edited = events[2] as { text: string; sent?: string };
      expect(edited.text).toBe("sobe pra dev");
      expect(edited.sent).toContain("correção do usuário");
      expect(edited.sent).toContain("«sobe pra prod»");
    });
  });

  it("an interrupt then the edit: the queue forgets, the edit counts its own turn", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"primeira"}`));
    socket.emit("message", Buffer.from(`{"type":"interrupt"}`));
    expect(session.activeTurns).toBe(1); // only the running turn survives the interrupt
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"primeira","text":"primeira, corrigida"}`));
    expect(session.activeTurns).toBe(2);
  });
});

describe("warm-up — subir o driver no connect não conta turno", () => {
  it("ensure + attach alone: zero turns, no inflight marker, driver alive", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    expect(hasDriverSession(CARD)).toBe(true);
    expect(session.activeTurns).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(await readInflightMarker(CARD)).toBeNull();
  });
});

/**
 * THE INCIDENT THIS BLOCK PINS (produção, 2026-09-17 — "mandei a mensagem e ficou carregando; dei
 * F5 e era como se eu não tivesse enviado nada").
 *
 * A idle sweep hibernated the very card the person was chatting with, which killed its driver. The
 * message typed a second later was written into the dead stdin inside a `try {} catch {}`,
 * persisted to the history ANYWAY, counted as a turn in flight — and answered by nobody. On screen:
 * "enviando…" para sempre. No F5: ou uma mensagem que ninguém respondeu, ou nada.
 *
 * The rule now: a turn is only ever recorded when the driver actually took it, and every send gets
 * an explicit receipt (`user_ack` after it is on disk, `user_nack` when it was refused).
 */
describe("o recibo de entrega — nenhuma mensagem some em silêncio", () => {
  it("driver MORTO (o card foi hibernado debaixo da conversa): recusa, não grava nada e devolve user_nack", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    stopCardDriver(CARD); // exactly what hibernateCard → killCardSession does

    socket.emit("message", Buffer.from(`{"type":"user","text":"instrução longa","cid":"c-1"}`));

    expect(session.activeTurns).toBe(0); // no phantom turn in flight
    const nack = socket.sent.map((s) => JSON.parse(s) as { type: string; cid?: string });
    expect(nack.some((f) => f.type === "user_nack" && f.cid === "c-1")).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(await readHistory(CARD)).toEqual([]); // nothing was written down
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("driver vivo: a mensagem vira user_ack — e SÓ depois de estar no histórico em disco", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"roda os testes","cid":"c-2"}`));

    await vi.waitFor(() => {
      const ack = socket.sent.map((s) => JSON.parse(s) as { type: string; cid?: string })
        .find((f) => f.type === "user_ack");
      expect(ack?.cid).toBe("c-2");
    });
    const events = await readHistory(CARD);
    expect(events.map((e) => e.type)).toEqual(["user"]);
    expect(spawned[0]!.stdin.written.join("")).toContain("roda os testes");
  });

  it("o `cid` é recibo entre back e front — nunca entra no stdin do driver", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"oi","cid":"c-3"}`));
    expect(spawned[0]!.stdin.written.join("")).not.toContain("c-3");
  });

  it("uma edição também é recusada quando o driver morreu (nada de marcador 'editada' fantasma)", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    stopCardDriver(CARD);
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"a","text":"b","cid":"c-4"}`));
    await new Promise((r) => setImmediate(r));
    expect(await readHistory(CARD)).toEqual([]);
    expect(socket.sent.map((s) => (JSON.parse(s) as { type: string }).type)).toContain("user_nack");
  });

  it("um cliente antigo (sem cid) segue funcionando: entrega normal, sem recibo", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"sem cid"}`));
    expect(session.activeTurns).toBe(1);
    await vi.waitFor(async () => {
      expect((await readHistory(CARD)).length).toBe(1);
    });
    expect(sentTypes(socket)).not.toContain("user_ack");
  });

  it("EPIPE no stdin (o docker exec caiu): o erro vira frame, não silêncio", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdin.emit("error", new Error("write EPIPE"));
    const errors = socket.sent.map((s) => JSON.parse(s) as { type: string; message?: string })
      .filter((f) => f.type === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain("EPIPE");
  });

  it("conversar no chat nativo é sinal de vida do card (o que impedia a hibernação de matar o driver)", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    await vi.waitFor(() => expect(humanActiveCalls).toContain(CARD));
    expect(session.activeTurns).toBe(1);
  });
});

/**
 * O VETO DE HIBERNAÇÃO (a causa-raiz do incidente): o idle sweep hibernava o card que a pessoa
 * estava usando — e hibernar mata o driver. O card em uso agora é vetado; um driver ocioso, não.
 */
describe("isCardChatInUse — o que impede o idle sweep de matar a conversa", () => {
  it("card com aba conectada: EM USO", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    expect(isCardChatInUse(CARD)).toBe(true);
  });

  it("aba fechada e nada rodando: liberado (o próprio idle stop o mataria de qualquer jeito)", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("close");
    expect(isCardChatInUse(CARD)).toBe(false);
  });

  it("aba fechada MAS turno em voo: EM USO (não se mata trabalho em andamento)", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"trabalho longo"}`));
    socket.emit("close");
    expect(session.activeTurns).toBe(1);
    expect(isCardChatInUse(CARD)).toBe(true);
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    expect(isCardChatInUse(CARD)).toBe(false);
  });

  it("card sem driver nenhum: liberado", () => {
    expect(isCardChatInUse(CARD2)).toBe(false);
  });
});
