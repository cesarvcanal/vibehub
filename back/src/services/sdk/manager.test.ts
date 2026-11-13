import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { readCardCatalog } from "./catalog.js";
import { readHistory, rewindHistory } from "./history.js";
import { logger } from "../../utils/logger.js";
import {
  BACKGROUND_HOLD_MAX_MS,
  DRIVER_IDLE_MS,
  TYPING_RELAY_MIN_MS,
  attachSocket,
  driverActivity,
  driverTurnRunning,
  ensureDriverSession,
  dispatchClientFrame,
  hasDriverSession,
  isCardChatInUse,
  missedDuringSetup,
  onPeerTurn,
  injectSystemTurn,
  RESUME_CONFIRM_MS,
  RESUME_REENGAGE_TEXT,
  NOTE_RESUME_STALLED,
  onDriverCrashWithWork,
  sendAgentTurn,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
  shutdownAllDrivers,
  stopCardDriver,
} from "./manager.js";
import { readInflightMarker } from "./inflight.js";
import { loadQuestionDrafts, questionDraftsSettled } from "./questionDrafts.js";
import { BTW_COMMAND } from "./protocol.js";
import { createMirrorState, driverKeysFor, forgetDriverKeys, mirrorNewEvents } from "./mirror.js";
import { notifyCardSessionKill } from "../board/workspace.js";
import { mergeTranscriptReplay } from "./transcript.js";

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

/** The disk refusing a whole-file rewrite (ENOSPC): the log's rewrites must not claim they happened. */
const disk = vi.hoisted(() => ({ failRewrites: false }));
vi.mock("../../store/atomicWrite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/atomicWrite.js")>();
  return {
    ...actual,
    writeFileAtomic: (...args: Parameters<typeof actual.writeFileAtomic>) =>
      disk.failRewrites
        ? Promise.reject(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }))
        : actual.writeFileAtomic(...args),
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
  /** Same numbers as `ws`: OPEN = 1, CLOSED = 3. */
  readyState: number;
  send: (s: string) => void;
  close: () => void;
}

function fakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.sent = [];
  socket.closed = false;
  socket.readyState = 1;
  socket.send = (s: string) => socket.sent.push(s);
  socket.close = () => { socket.closed = true; socket.readyState = 3; };
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
  disk.failRewrites = false;
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
  // DRAINS the log's append queue before switching the data folder. `appendHistory` resolves the
  // file path INSIDE the queue, right when it writes: an append still queued here would wake up in
  // the next test and write to THAT test's temporary folder (and, on the rm path, would recreate the
  // directory in the middle of the removal — the intermittent ENOTEMPTY). `rewindHistory` with a
  // text that does not exist writes nothing: it just enters the queue and waits its turn, which is
  // what we need. An ORDER flake is worse than a slow one — it moves from test to test on each run.
  await Promise.all([rewindHistory(CARD, ""), rewindHistory(CARD2, ""), questionDraftsSettled(CARD), questionDraftsSettled(CARD2)]);
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

  // Production, 2026-10-20 (cards cfb8 and 4f4b): after the post-deploy resume the CLI went on in a turn
  // it opened itself (the background task had died). Whoever opened or reloaded the card got
  // `turnActive: false`: the chat was born stopped, the tool running with no spinner, and the person
  // sent "continue" to a card that was working.
  it("the synthesized `ready` says a turn is IN FLIGHT during a turn the CLI opened by itself", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    s1.emit("message", Buffer.from(`{"type":"user","text":"roda a suíte em background"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    // the task finished: the CLI wakes the model with no message at all
    spawned[0]!.stdout.emit("data", line({ type: "tool_use", id: "toolu_w", name: "Bash", input: { command: "npx vitest run" } }));
    const s2 = fakeSocket();
    attachSocket(session, s2 as never);
    const ready = JSON.parse(s2.sent[0]!) as { type: string; turnActive?: boolean };
    expect(ready.type).toBe("ready");
    expect(ready.turnActive).toBe(true);
    // that turn's result closes: whoever arrives afterwards sees the card truly stopped
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    const s3 = fakeSocket();
    attachSocket(session, s3 as never);
    expect((JSON.parse(s3.sent[0]!) as { turnActive?: boolean }).turnActive).toBe(false);
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
      BTW_COMMAND,
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

  it("um caractere multibyte partido entre dois chunks do stdout chega inteiro (nada de U+FFFD)", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    const bytes = line({ type: "assistant_text", text: "ação" });
    // The pipe cuts wherever it likes: here, in the middle of the two bytes of the "ç".
    const cut = bytes.indexOf(Buffer.from("ç")) + 1;
    spawned[0]!.stdout.emit("data", bytes.subarray(0, cut));
    spawned[0]!.stdout.emit("data", bytes.subarray(cut));
    const texts = socket.sent.map((s) => (JSON.parse(s) as { text?: string }).text);
    expect(texts).toContain("ação");
  });

  it("uma linha de MB em muitos chunks custa linear: o \\n é procurado só no pedaço novo", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    // ~8 MB of text in a single `assistant_text`, delivered in 1 KB chunks (the size of a pipe
    // under load). Re-searching the whole buffer on every chunk adds up to tens of GB scanned.
    const big = "x".repeat(8 * 1024 * 1024);
    const bytes = line({ type: "assistant_text", text: big });
    const started = performance.now();
    for (let i = 0; i < bytes.length; i += 1024) spawned[0]!.stdout.emit("data", bytes.subarray(i, i + 1024));
    const elapsed = performance.now() - started;
    expect(socket.sent.some((s) => s.length > big.length)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
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

/**
 * A turn cut short used to end in silence on the front: the answer stopped mid-sentence and the
 * SDK's abort result (is_error, no text) drew a red bubble reading literally "error". The manager
 * now NARRATES the cut — one system note, written when the aborted turn reports back, so it lands
 * after the last deltas and survives an F5 (it goes to the history too).
 */
describe("interrupt — a nota que conta o que aconteceu com o turno", () => {
  it("a plain stop notes the cut when the aborted turn's result lands, not before", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"faz a coisa"}`));
    socket.emit("message", Buffer.from(`{"type":"interrupt"}`));
    expect(sentTypes(socket)).not.toContain("system_note"); // the turn is still aborting

    spawned[0]!.stdout.emit("data", line({ type: "result", isError: true, subtype: "error_during_execution" }));
    const notes = socket.sent.map((s) => JSON.parse(s) as { type: string; text?: string }).filter((e) => e.type === "system_note");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("turn-interrupted");
    // the result comes FIRST — the note explains a truncation the reader has already seen
    expect(sentTypes(socket).indexOf("result")).toBeLessThan(sentTypes(socket).indexOf("system_note"));
    // and it is on disk: a reload still explains the cut
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.some((e) => e.type === "system_note" && (e as { text: string }).text === "turn-interrupted")).toBe(true);
    });
  });

  it("a stop for an EDIT says so — the note the edited message's reader needs", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"sobe pra prod"}`));
    socket.emit("message", Buffer.from(`{"type":"interrupt","reason":"edit"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: true }));

    const notes = socket.sent.map((s) => JSON.parse(s) as { type: string; text?: string }).filter((e) => e.type === "system_note");
    expect(notes.map((n) => n.text)).toEqual(["turn-interrupted-edit"]);
  });

  it("a stop with NOTHING running notes nothing — no turn was cut", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"interrupt"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    expect(sentTypes(socket)).not.toContain("system_note");
  });
});

describe("question_answer — reaches the LIVE driver", () => {
  it("funnels the answer frame into the driver's stdin without counting a turn", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    // the card this driver is parked on — the answer pairs with it by id
    spawned[0]!.stdout.emit("data", line({ type: "user_question", id: "q_1", questions: [{ question: "Formato?", options: [{ label: "Summary" }] }] }));
    socket.emit("message", Buffer.from(`{"type":"question_answer","id":"q_1","answers":[{"selected":["Summary"]}]}`));
    expect(spawned[0]!.stdin.written.some((w) => w.includes(`"question_answer"`) && w.includes(`"Summary"`))).toBe(true);
    expect(session.activeTurns).toBe(0); // an answer is not a new turn — the turn asking it is already counted
  });
});

/**
 * THE ORPHAN QUESTION (production, 2026-10-07). The driver died with a question card up (a deploy
 * restarted the back at 16:50; the question was from 16:41). The history redraws the card as
 * pending — but the new driver keeps questions only in memory and never heard of it:
 *  - the CLICK went to the new driver and came back "no pending question with id q_3_…" — answer lost;
 *  - the MESSAGE written instead did not close the card (only the driver that opened it knows how),
 *    and the tray kept asking for the answer to something already answered.
 */
describe("pergunta órfã — o cartão sobreviveu ao driver que o abriu", () => {
  const QUESTIONS = [
    { question: "Onde entra a busca?", options: [{ label: "No cabeçalho" }, { label: "No item" }] },
    { question: "Como conto o prazo?", options: [{ label: "72h corridas" }] },
  ];

  /** Driver 1 asks and dies; driver 2 is the successor a reconnect spawns. */
  async function orphanedCard() {
    const first = ensure();
    spawned[0]!.stdout.emit("data", line({ type: "user_question", id: "q_3_1791402112898", questions: QUESTIONS }));
    await vi.waitFor(async () => expect((await readHistory(CARD)).some((e) => e.type === "user_question")).toBe(true));
    spawned[0]!.exitCode = 1;
    spawned[0]!.emit("close", 1);
    expect(first.closed).toBe(true);
    const successor = ensure();
    const socket = fakeSocket();
    attachSocket(successor, socket as never, { kind: "user", name: "cesar" });
    spawned[1]!.stdout.emit("data", line({ type: "ready" }));
    return { successor, socket };
  }

  it("a resposta da órfã leva junto o que os OUTROS marcaram antes do reinício, com o nome", async () => {
    const first = ensure();
    const albert = fakeSocket();
    attachSocket(first, albert as never, { kind: "user", name: "albert" });
    spawned[0]!.stdout.emit("data", line({ type: "user_question", id: "q_3_1791402112898", questions: QUESTIONS }));
    albert.emit("message", Buffer.from(JSON.stringify({ type: "question_draft", id: "q_3_1791402112898", picked: [["No cabeçalho"], []], other: ["", ""] })));
    await vi.waitFor(async () => expect((await readHistory(CARD)).some((e) => e.type === "user_question")).toBe(true));
    await questionDraftsSettled(CARD);
    resetSdkSessionsForTesting(); // the deploy
    const successor = ensure();
    const socket = fakeSocket();
    attachSocket(successor, socket as never, { kind: "user", name: "cesar" });
    spawned[1]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "question_answer", id: "q_3_1791402112898", answers: [{ selected: ["No item"] }, { selected: ["72h corridas"] }] })));
    await vi.waitFor(() => {
      const text = spawned[1]!.stdin.written.map((w) => JSON.parse(w) as { type: string; text?: string }).find((f) => f.type === "user")?.text ?? "";
      expect(text).toContain("cesar: No item");
      expect(text).toContain("albert: No cabeçalho");
    });
  });

  it("a órfã aberta conta como decisão pendente até ser respondida (revisão #222, f1)", async () => {
    const { successor, socket } = await orphanedCard();
    await vi.waitFor(() => expect(successor.awaitingDecision).toBe(true));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "question_answer", id: "q_3_1791402112898", answers: [{ selected: ["No item"] }, { selected: ["72h corridas"] }] })));
    await vi.waitFor(() => expect(successor.awaitingDecision).toBe(false));
  });

  it("o clique numa pergunta órfã chega ao modelo como mensagem — nunca 'no pending question'", async () => {
    const { successor, socket } = await orphanedCard();
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "question_answer",
      id: "q_3_1791402112898",
      answers: [{ selected: ["No cabeçalho"] }, { selected: ["72h corridas"] }],
    })));
    await vi.waitFor(() => {
      const user = spawned[1]!.stdin.written.map((w) => JSON.parse(w) as { type: string; text?: string }).find((c) => c.type === "user");
      expect(user?.text).toContain("«Onde entra a busca?» → No cabeçalho");
      expect(user?.text).toContain("«Como conto o prazo?» → 72h corridas");
    });
    // the successor never sees a question_answer it cannot pair
    expect(spawned[1]!.stdin.written.some((w) => w.includes(`"question_answer"`))).toBe(false);
    expect(successor.activeTurns).toBe(1); // it IS a turn now: the model has to read and act on it
    // the card settles everywhere — live and after an F5
    await vi.waitFor(async () => {
      const result = (await readHistory(CARD)).find((e) => e.type === "question_result") as { id?: string; answers?: unknown } | undefined;
      expect(result?.id).toBe("q_3_1791402112898");
      expect(result?.answers).toEqual([{ selected: ["No cabeçalho"] }, { selected: ["72h corridas"] }]);
    });
    expect(sentTypes(socket)).toContain("question_result");
  });

  it("duas abas respondendo a mesma órfã viram UMA mensagem só", async () => {
    const { socket } = await orphanedCard();
    const frame = Buffer.from(JSON.stringify({ type: "question_answer", id: "q_3_1791402112898", answers: [{ selected: ["No item"] }] }));
    socket.emit("message", frame);
    socket.emit("message", frame);
    await vi.waitFor(async () => expect((await readHistory(CARD)).some((e) => e.type === "question_result")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const users = spawned[1]!.stdin.written.filter((w) => w.includes(`"type":"user"`));
    expect(users).toHaveLength(1);
  });

  it("responder por MENSAGEM encerra a órfã — a bandeja não volta a pedir a resposta", async () => {
    const { socket } = await orphanedCard();
    socket.emit("message", Buffer.from(`{"type":"user","text":"no cabeçalho, e 72h corridas"}`));
    await vi.waitFor(async () => {
      const result = (await readHistory(CARD)).find((e) => e.type === "question_result") as { id?: string; superseded?: boolean } | undefined;
      expect(result).toMatchObject({ id: "q_3_1791402112898", superseded: true });
    });
    expect(sentTypes(socket)).toContain("question_result");
  });

  // ---- findings from the adversarial review of PR #98 ----

  it("F1: depois de um F5, a resposta da órfã NÃO volta do transcript como bolha 'do terminal'", async () => {
    const { socket } = await orphanedCard();
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "question_answer", id: "q_3_1791402112898", answers: [{ selected: ["No item"] }, { selected: [] }],
    })));
    let sent = "";
    await vi.waitFor(() => {
      const user = spawned[1]!.stdin.written.map((w) => JSON.parse(w) as { type: string; text?: string }).find((c) => c.type === "user");
      expect(user?.text).toBeTruthy();
      sent = user!.text!;
    });
    await vi.waitFor(async () => expect((await readHistory(CARD)).some((e) => e.type === "question_result")).toBe(true));
    // the CLI writes the message to the transcript; the next connect merges transcript + history
    const jsonl = JSON.stringify({ type: "user", uuid: "t-1", timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: "user", content: sent } });
    expect(mergeTranscriptReplay(jsonl, await readHistory(CARD)).filter((e) => e.type === "user")).toEqual([]);
  });

  it("F2: uma pergunta JÁ encerrada no disco (aba velha) não vira turno — volta o erro de antes", async () => {
    ensure();
    spawned[0]!.stdout.emit("data", line({ type: "user_question", id: "q_9_1", questions: QUESTIONS }));
    spawned[0]!.stdout.emit("data", line({ type: "question_result", id: "q_9_1", answers: [{ selected: ["No item"] }] }));
    await vi.waitFor(async () => expect((await readHistory(CARD)).some((e) => e.type === "question_result")).toBe(true));
    spawned[0]!.exitCode = 1;
    spawned[0]!.emit("close", 1);
    const successor = ensure();
    const socket = fakeSocket();
    attachSocket(successor, socket as never);
    socket.emit("message", Buffer.from(`{"type":"question_answer","id":"q_9_1","answers":[{"selected":["No cabeçalho"]}]}`));
    socket.emit("message", Buffer.from(`{"type":"question_answer","id":"bogus","answers":[{"selected":["rm -rf"]}]}`));
    await vi.waitFor(() => expect(socket.sent.filter((s) => s.includes("no pending question")).length).toBe(2));
    expect(spawned[1]!.stdin.written.some((w) => w.includes(`"type":"user"`))).toBe(false);
    expect(successor.activeTurns).toBe(0);
    expect((await readHistory(CARD)).filter((e) => e.type === "question_result")).toHaveLength(1);
  });

  it("F4: clicar a órfã com o driver já morto avisa a tela — a resposta não some calada", async () => {
    const { successor, socket } = await orphanedCard();
    spawned[1]!.exitCode = 1; // it died, and the close has not arrived yet
    socket.emit("message", Buffer.from(JSON.stringify({ type: "question_answer", id: "q_3_1791402112898", answers: [{ selected: ["No item"] }] })));
    await vi.waitFor(() => expect(sentTypes(socket)).toContain("error"));
    expect(successor.settledOrphans.has("q_3_1791402112898")).toBe(false); // the next driver still receives it
  });

  // ---- findings from the 2nd adversarial round of PR #98 ----

  it("R1: uma leitura do histórico que FALHA não dá a varredura por feita — a próxima mensagem encerra a órfã", async () => {
    const { socket } = await orphanedCard();
    const file = join(dir, "sdk-history", `${CARD}.ndjson`);
    await rename(file, `${file}.bak`);
    await mkdir(file); // readFile → EISDIR: a falha passageira (EBUSY/EMFILE) no primeiro envio
    socket.emit("message", Buffer.from(`{"type":"user","text":"primeira"}`));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(file, { recursive: true, force: true });
    await rename(`${file}.bak`, file);
    socket.emit("message", Buffer.from(`{"type":"user","text":"segunda"}`));
    await vi.waitFor(async () => {
      const result = (await readHistory(CARD)).find((e) => e.type === "question_result") as { superseded?: boolean } | undefined;
      expect(result).toMatchObject({ superseded: true });
    });
  });

  it("R2: clicar uma órfã que ESTE manager já encerrou recebe o erro — nunca silêncio", async () => {
    const { socket } = await orphanedCard();
    socket.emit("message", Buffer.from(`{"type":"user","text":"respondi por escrito"}`));
    await vi.waitFor(async () => expect((await readHistory(CARD)).some((e) => e.type === "question_result")).toBe(true));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "question_answer", id: "q_3_1791402112898", answers: [{ selected: ["No item"] }] })));
    await vi.waitFor(() => expect(socket.sent.some((s) => s.includes("no pending question with id q_3_1791402112898"))).toBe(true));
    expect(spawned[1]!.stdin.written.filter((w) => w.includes(`"type":"user"`))).toHaveLength(1); // only the written message
  });

  it("a pergunta que o driver VIVO acabou de encerrar não vira órfã na corrida com o disco", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "user_question", id: "q_1_1", questions: QUESTIONS }));
    await vi.waitFor(async () => expect((await readHistory(CARD)).some((e) => e.type === "user_question")).toBe(true));
    // the message releases the card: the driver answers RIGHT AWAY, before its append reaches the disk
    socket.emit("message", Buffer.from(`{"type":"user","text":"outra coisa"}`));
    spawned[0]!.stdout.emit("data", line({ type: "question_result", id: "q_1_1", superseded: true }));
    const results = async () => (await readHistory(CARD)).filter((e) => e.type === "question_result");
    await vi.waitFor(async () => expect((await results()).length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 200)); // the manager's read, if any, has already finished
    expect(await results()).toHaveLength(1);
  });

  // ---- production, 2026-10-19 (cards 98f4e270 and 8c417f8e): the tray demanded the OLD question ----
  // The deploy killed the driver with question Q1 up; the automatic resume made Claude ask
  // again (Q2), the person answered Q2 by CLICKING — and Q1 stayed pending forever, because only a
  // MESSAGE swept the orphans. Half an hour later the tray still asked to answer Q1.

  const orphanResult = async () =>
    (await readHistory(CARD)).find((e) => e.type === "question_result" && (e as { id?: string }).id === "q_3_1791402112898") as
      | { superseded?: boolean; answers?: unknown }
      | undefined;

  it("a retomada automática encerra a órfã — o agente vai perguntar de novo, a velha não fica cobrando", async () => {
    const { successor } = await orphanedCard();
    injectSystemTurn(successor, "continue de onde parou", { kind: "system", name: "vibehub" }, 1);
    await vi.waitFor(async () => expect(await orphanResult()).toMatchObject({ superseded: true }));
  });

  it("uma pergunta NOVA do driver vivo encerra a órfã — responder a nova pelo clique não deixa a velha de pé", async () => {
    await orphanedCard();
    spawned[1]!.stdout.emit("data", line({ type: "user_question", id: "q_1_1792423287705", questions: QUESTIONS }));
    await vi.waitFor(async () => expect(await orphanResult()).toMatchObject({ superseded: true }));
    // the new one belongs to the live driver: only it closes it
    expect((await readHistory(CARD)).some((e) => e.type === "question_result" && (e as { id?: string }).id === "q_1_1792423287705")).toBe(false);
  });

  it("clicar UMA órfã encerra as outras órfãs — a conversa seguiu com aquela resposta", async () => {
    ensure();
    spawned[0]!.stdout.emit("data", line({ type: "user_question", id: "q_1_old", questions: QUESTIONS }));
    spawned[0]!.exitCode = 1;
    spawned[0]!.emit("close", 1);
    ensure();
    spawned[1]!.stdout.emit("data", line({ type: "user_question", id: "q_1_new", questions: QUESTIONS }));
    await vi.waitFor(async () => expect((await readHistory(CARD)).filter((e) => e.type === "user_question")).toHaveLength(2));
    spawned[1]!.exitCode = 1;
    spawned[1]!.emit("close", 1);
    const third = ensure();
    const socket = fakeSocket();
    attachSocket(third, socket as never, { kind: "user", name: "cesar" });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "question_answer", id: "q_1_new", answers: [{ selected: ["No item"] }] })));
    await vi.waitFor(async () => {
      const results = (await readHistory(CARD)).filter((e) => e.type === "question_result") as { id: string; superseded?: boolean; answers?: unknown }[];
      expect(results.find((r) => r.id === "q_1_new")?.answers).toEqual([{ selected: ["No item"] }]);
      expect(results.find((r) => r.id === "q_1_old")).toMatchObject({ superseded: true });
    });
  });

  it("uma pergunta que o driver VIVO ainda espera não é tocada pelo manager — quem a encerra é o driver", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "user_question", id: "q_1_1", questions: QUESTIONS }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"outra coisa"}`));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readHistory(CARD)).some((e) => e.type === "question_result")).toBe(false);
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
    // Wait for BOTH sends to settle, not a fixed deadline: the per-card append queue is async, and
    // a `setTimeout(10)` under load read the log midway (intermittent failure of the whole suite).
    await vi.waitFor(async () => {
      expect((await readHistory(CARD)).filter((e) => e.type === "user").length).toBe(2);
    });
    const history = await readHistory(CARD);
    expect(history.some((e) => e.type === "turn_absorbed")).toBe(false);
  });
});

describe("end of life", () => {
  it("o close ATRASADO do driver velho não apaga a memória de dedupe do sucessor", () => {
    forgetDriverKeys(CARD);
    ensure();
    stopCardDriver(CARD); // model switch: the old one gets the kill, but the process has not closed yet
    const successor = ensure();
    expect(spawned.length).toBe(2);
    dispatchClientFrame(successor, `{"type":"user","text":"fala do sucessor"}`);
    expect(driverKeysFor(CARD).size).toBeGreaterThan(0);
    spawned[0]!.emit("close", null); // only now does the old one finish dying
    expect(driverKeysFor(CARD).size).toBeGreaterThan(0);
    expect(hasDriverSession(CARD)).toBe(true);
  });

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

  it("parada pedida (troca de conta/modelo) fecha os sockets SEM anunciar erro", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stderr.emit("data", Buffer.from("Warning: canUseTool will not be invoked\n"));
    notifyCardSessionKill(CARD); // what applySessionChange → killCardSession does on an account switch
    spawned[0]!.emit("close", null); // the kill arrives as a signal: code null
    expect(sentTypes(socket)).not.toContain("error");
    expect(socket.closed).toBe(true);
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

  it("dispatchClientFrame delivers a frame buffered during the route's setup gap as a normal user turn", async () => {
    // The production symptom: a message typed right after a reconnect (while the route was still
    // probing/replaying, with no listener attached) was silently dropped. The route now buffers
    // and drains through this same funnel.
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"e aí, como tá indo?"}`);
    const frames = spawned[0]!.stdin.written.map((s) => JSON.parse(s) as { type: string; text?: string });
    expect(frames).toEqual([{ type: "user", text: "e aí, como tá indo?" }]);
    expect(session.activeTurns).toBe(1);
  });
});

/**
 * THE CASE THAT SLIPPED PAST TWO PRS (production, 2026-10-19, card e35d): the person's turn closed with
 * the tests running in the background; when they finished, the CLI ITSELF opened a new turn, the
 * agent called the deploy (vibehub_deliver) and the deploy killed that turn. Only a person's or a
 * system message wrote the marker — the autonomous turn and the background had none, so the boot
 * resumed nothing and the card sat stopped for 44 min until someone asked "eai?".
 */
describe("inflight markers — trabalho que nenhuma mensagem abriu (segundo plano, turno do próprio CLI)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const emit = (event: object) => spawned[0]!.stdout.emit("data", line(event));

  async function personTurnThatClosed(): Promise<void> {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"roda a suíte e entrega"}`));
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).not.toBeNull());
  }

  it("O CASO REAL: tarefa em segundo plano → turno aberto pelo CLI → deploy: o marcador está lá para o boot", async () => {
    await personTurnThatClosed();
    emit({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npx vitest run", run_in_background: true } });
    emit({ type: "background_tasks", tasks: [{ id: "b1", type: "local_bash", description: "suíte do front" }] });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker?.background).toEqual({ tasks: ["suíte do front"], since: expect.any(Number), idle: true });
    });
    // the suite ends: the CLI opens the turn on its own, with nothing on stdin
    emit({ type: "background_tasks", tasks: [] });
    emit({ type: "assistant_text", text: "Front verde. Entregando." });
    emit({ type: "tool_use", id: "t2", name: "mcp__vibehub__vibehub_deliver", input: { branch: "main" } });
    // WAITS for the write, not a clock: the marker goes to disk through an async queue, and the fixed
    // 20 ms that used to be here are not enough on a busy machine (it failed running the file alone).
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker).not.toBeNull();
      expect(marker!.background).toBeUndefined();
    });
    // the deploy: SIGTERM on the back
    shutdownAllDrivers();
    await settle();
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).not.toBeNull());
  });

  it("turno aberto pelo CLI sem segundo plano anunciado: marcador enquanto roda, some no result dele", async () => {
    await personTurnThatClosed();
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
    emit({ type: "thinking", text: "a notificação chegou" });
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker?.preview).toMatch(/próprio Claude/);
      expect(marker?.attempts).toBe(0);
    });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
  });

  it("o passo de um SUBAGENTE em segundo plano não é um turno do principal: nenhum marcador sozinho", async () => {
    await personTurnThatClosed();
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
    emit({ type: "tool_use", id: "s1", name: "Read", input: {}, parentToolUseId: "agent-1" });
    emit({ type: "assistant_text", text: "achei", parentToolUseId: "agent-1" });
    await settle();
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("segundo plano que acaba sem turno depois: o aviso segura o marcador até a parada do driver", async () => {
    await personTurnThatClosed();
    emit({ type: "background_tasks", tasks: [{ id: "b1", type: "local_agent", description: "review" }] });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect((await readInflightMarker(CARD))?.background?.idle).toBe(true));
    emit({ type: "background_tasks", tasks: [] });
    // Before, the marker went away here — and a deploy in this interval erased the notice with no resume.
    await vi.waitFor(async () => {
      expect((await readInflightMarker(CARD))?.background?.tasks).toEqual(["aviso de término ainda não entregue: review"]);
    });
    stopCardDriver(CARD);
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
  });

  it("ScheduleWakeup pendente segura o marcador; o stop:true o libera", async () => {
    await personTurnThatClosed();
    emit({ type: "tool_use", id: "w1", name: "ScheduleWakeup", input: { delaySeconds: 600, reason: "esperar o CI", prompt: "/loop ci" } });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => {
      expect((await readInflightMarker(CARD))?.background?.tasks).toEqual(["retorno agendado (ScheduleWakeup): esperar o CI"]);
    });
    // the wakeup wins: the CLI opens the turn; it does not reschedule and stops the loop
    emit({ type: "tool_use", id: "w2", name: "ScheduleWakeup", input: { stop: true } });
    await vi.waitFor(async () => expect((await readInflightMarker(CARD))?.background).toBeUndefined());
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
  });

  it("o retorno agendado que vence abre o turno e deixa de ser pendente", async () => {
    await personTurnThatClosed();
    emit({ type: "tool_use", id: "w1", name: "ScheduleWakeup", input: { delaySeconds: 60, prompt: "checar deploy" } });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect((await readInflightMarker(CARD))?.background?.tasks?.[0]).toMatch(/checar deploy/));
    emit({ type: "assistant_text", text: "voltei" });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
  });

  it("mensagem da pessoa com segundo plano vivo: o marcador novo (attempts 0) diz o que segue rodando, idle=false", async () => {
    await personTurnThatClosed();
    emit({ type: "background_tasks", tasks: [{ id: "b1", type: "local_bash", description: "npm test" }] });
    emit({ type: "result", isError: false });
    const socket = fakeSocket();
    attachSocket(ensure(), socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"e aí?"}`));
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker?.preview).toBe("e aí?");
      expect(marker?.attempts).toBe(0);
      expect(marker?.background).toMatchObject({ tasks: ["npm test"], idle: false });
    });
  });

  it("a retomada que avança grava progressed SEM perder o segundo plano (e mantém attempts)", async () => {
    const session = ensure();
    emit({ type: "background_tasks", tasks: [{ id: "b1", type: "local_bash", description: "build" }] });
    injectSystemTurn(session, "continue", { kind: "system", name: "vibehub" }, 2);
    emit({ type: "tool_use", id: "x", name: "Bash", input: {} });
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker).toMatchObject({ attempts: 2, progressed: true, background: { tasks: ["build"] } });
    });
  });

  /**
   * THE RESUME THAT DID NOT RESUME (production, 2026-10-20). After a deploy, the injected turn
   * closed with only the filler "No response requested." — which the manager hides — and the card sat stopped
   * until someone wrote. A resume turn that closes WITHOUT progress, and goes on with no sign of life for
   * RESUME_CONFIRM_MS, gets the order again — once, saying in so many words that it is not an
   * automatic notification.
   */
  it("retomada que fecha sem avançar (só o filler) é reenviada UMA vez, com o texto de reengate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, "continue de onde parou", { kind: "system", name: "vibehub" }, 1);
    emit({ type: "assistant_text", text: "No response requested." });
    emit({ type: "result", isError: false });
    // Not on the `result`: the resend waits out the window with no sign of life (see RESUME_CONFIRM_MS).
    vi.advanceTimersByTime(RESUME_CONFIRM_MS + 1);
    const sends = spawned[0]!.stdin.written.map((w) => JSON.parse(w) as { type: string; text?: string })
      .filter((f) => f.type === "user");
    expect(sends.length).toBe(2);
    expect(sends[1]!.text).toBe(RESUME_REENGAGE_TEXT);
    expect(session.activeTurns).toBe(1);
    // The re-engage did not advance either: now it is a visible note, not a third send.
    emit({ type: "result", isError: false });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS + 1);
    vi.useRealTimers();
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.some((e) => e.type === "system_note" && e.text === NOTE_RESUME_STALLED)).toBe(true);
    });
    expect(spawned[0]!.stdin.written.filter((w) => w.includes('"type":"user"')).length).toBe(2);
  });

  /**
   * THE FALSE POSITIVE (production, 2026-10-20, right after the fix): when resuming, the CLI first CLOSES the
   * old turn with the filler ("No response requested.") — a `result` that arrives before the
   * continuation is read. Resending there sent the order twice. The resend waits out the window and only
   * goes if nothing moved in the meantime.
   */
  it("o result do turno velho chega antes da continuação andar: NÃO reenvia", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, "continue de onde parou", { kind: "system", name: "vibehub" }, 1);
    emit({ type: "assistant_text", text: "No response requested." });
    emit({ type: "result", isError: false });
    // The continuation starts moving inside the window.
    emit({ type: "tool_use", id: "t1", name: "Bash", input: {} });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS * 3);
    expect(spawned[0]!.stdin.written.filter((w) => w.includes('"type":"user"')).length).toBe(1);
    expect(session.activeTurns).toBe(0);
  });

  it("retomada que avança fecha normalmente — nada é reenviado", async () => {
    const session = ensure();
    injectSystemTurn(session, "continue de onde parou", { kind: "system", name: "vibehub" }, 1);
    emit({ type: "tool_use", id: "x", name: "Bash", input: {} });
    emit({ type: "result", isError: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned[0]!.stdin.written.filter((w) => w.includes('"type":"user"')).length).toBe(1);
    expect(session.activeTurns).toBe(0);
  });

  it("um turno de PESSOA que fecha sem avançar não é reenviado (só a retomada do painel)", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    emit({ type: "result", isError: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned[0]!.stdin.written.filter((w) => w.includes('"type":"user"')).length).toBe(1);
  });

  /**
   * THE NOTICE THE DEPLOY ERASED (production, 2026-10-20, card comando-btw): the last background
   * reviewer finished, the AI closed the turn saying "falta altitude" — the completion notice still
   * in the CLI's queue, waiting for the next turn — and the deploy came first. With no live task and no turn,
   * the marker had gone away: nothing to resume, card stopped. The pending notice now IS work.
   */
  it("tarefa de segundo plano que termina deixa o aviso PENDENTE no marcador até um turno começar", async () => {
    await personTurnThatClosed();
    emit({ type: "background_tasks", tasks: [{ id: "b1", type: "local_agent", description: "Altitude review" }] });
    emit({ type: "result", isError: false });
    emit({ type: "background_tasks", tasks: [] });
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker?.background?.tasks).toEqual(["aviso de término ainda não entregue: Altitude review"]);
    });
    // The CLI opens the notice's turn: delivered — and when that turn closes, nothing else remains.
    emit({ type: "assistant_text", text: "Altitude chegou." });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
  });

  it("parada deliberada com segundo plano vivo: o marcador sai mesmo assim", async () => {
    await personTurnThatClosed();
    emit({ type: "background_tasks", tasks: [{ id: "b1", type: "local_bash", description: "dev server" }] });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).not.toBeNull());
    stopCardDriver(CARD);
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toBeNull());
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

describe("edit_user — a edição vai ao driver com as DUAS formas, e ele escolhe", () => {
  it("escreve UM controle edit_user com o texto limpo e o supersede como plano B", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"sobe pra prod","text":"sobe pra dev"}`));
    const turns = spawned[0]!.stdin.written.map((w) => JSON.parse(w) as { type: string; text: string; original?: string; fallback?: string });
    expect(turns.length).toBe(1);
    expect(turns[0]!.type).toBe("edit_user");
    // the text the model reads on a rewind is the CLEAN version: the original ceased to exist
    expect(turns[0]!.text).toBe("sobe pra dev");
    expect(turns[0]!.original).toBe("sobe pra prod");
    // and plan B is still the usual supersede — the driver is the one that decides
    expect(turns[0]!.fallback).toContain("correção do usuário");
    expect(turns[0]!.fallback).toContain("«sobe pra prod»");
    expect(turns[0]!.fallback!.endsWith("sobe pra dev")).toBe(true);
  });

  it("o cid do navegador NUNCA vaza pro driver (ele é recibo do back, não conversa)", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"velha","text":"nova","cid":"r-42"}`));
    expect(spawned[0]!.stdin.written.join("")).not.toContain("r-42");
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
 * THE INCIDENT THIS BLOCK PINS (production, 2026-09-17 — "mandei a mensagem e ficou carregando; dei
 * F5 e era como se eu não tivesse enviado nada").
 *
 * A idle sweep hibernated the very card the person was chatting with, which killed its driver. The
 * message typed a second later was written into the dead stdin inside a `try {} catch {}`,
 * persisted to the history ANYWAY, counted as a turn in flight — and answered by nobody. On screen:
 * "enviando…" forever. On F5: either a message nobody answered, or nothing.
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

  it("disco cheio: a gravação falhou, então NÃO há user_ack — o navegador recebe user_nack e guarda as palavras", async () => {
    // The data directory becomes a FILE: any mkdir/append under it fails (ENOTDIR),
    // like a full disk or no permission — what matters is that the line does not reach the log.
    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "");
    config.dataDir = blocked;
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"some no F5?","cid":"c-disk"}`));

    await vi.waitFor(() => {
      const receipts = socket.sent.map((s) => JSON.parse(s) as { type: string; cid?: string })
        .filter((f) => f.type === "user_ack" || f.type === "user_nack");
      expect(receipts).toEqual([expect.objectContaining({ type: "user_nack", cid: "c-disk" })]);
    });
    config.dataDir = dir;
  });

  it("disco cheio que passa: o Reenviar do mesmo cid GRAVA a linha que faltou — sem segundo turno", async () => {
    // The driver ALREADY read the message; only the history failed. The resend carries the same cid, and returning
    // the old verdict (`false`) forever left the "não entregue" bubble with no way out: each
    // Reenviar got another nack, and Descartar + typing again made the model work twice.
    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "");
    config.dataDir = blocked;
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    const frame = Buffer.from(`{"type":"user","text":"some no F5?","cid":"c-disk2"}`);
    socket.emit("message", frame);
    await vi.waitFor(() => expect(sentTypes(socket)).toContain("user_nack"));

    config.dataDir = dir; // the disk freed up
    socket.emit("message", frame);

    await vi.waitFor(() => expect(sentTypes(socket)).toContain("user_ack"));
    const events = await readHistory(CARD);
    expect(events).toEqual([expect.objectContaining({ type: "user", text: "some no F5?" })]);
    expect(session.activeTurns).toBe(1); // a single turn
    expect(spawned[0]!.stdin.written.join("").match(/some no F5\?/g) ?? []).toHaveLength(1);
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

  /**
   * "REENVIAR" MUST NOT RUN THE TURN TWICE.
   *
   * The button exists for the case where the RECEIPT was lost, not the message: the socket dropped between
   * `appendHistory` and `user_ack` (the answer is silently thrown away when the socket has already
   * closed), or the deadline expired while the back was still setting up the connection. In both cases the server
   * HAS the message — and clicking "Reenviar" sent the same text to the driver again: a second
   * line in the history, a second turn, and the agent executing twice an instruction that may
   * be destructive ("apaga a branch", "faz o deploy").
   *
   * The `cid` is what solves it: the front resends with the SAME receipt, on purpose. An already accepted cid is not
   * a new message — it is the claim for a receipt that got lost. The back returns the receipt and does not
   * touch the driver.
   */
  describe("o mesmo recibo, duas vezes — o Reenviar não duplica o trabalho", () => {
    it("cid repetido: o recibo é reemitido, mas o driver não lê a mensagem de novo", async () => {
      const session = ensure();
      const socket = fakeSocket();
      attachSocket(session, socket as never);
      socket.emit("message", Buffer.from(`{"type":"user","text":"apaga a branch","cid":"c-r1"}`));
      await vi.waitFor(async () => expect((await readHistory(CARD)).length).toBe(1));

      // The ack got lost on the dropped socket; the person clicks "Reenviar" — same words, same cid.
      socket.emit("message", Buffer.from(`{"type":"user","text":"apaga a branch","cid":"c-r1"}`));
      await new Promise((r) => setImmediate(r));

      expect(await readHistory(CARD)).toHaveLength(1); // a single line in the history
      expect(session.activeTurns).toBe(1); // a single turn in flight
      const written = spawned[0]!.stdin.written.join("");
      expect(written.match(/apaga a branch/g) ?? []).toHaveLength(1); // the driver read it once
      // …and the receipt, which was what was missing, is returned.
      await vi.waitFor(() => {
        const acks = socket.sent
          .map((s) => JSON.parse(s) as { type: string; cid?: string })
          .filter((f) => f.type === "user_ack" && f.cid === "c-r1");
        expect(acks.length).toBeGreaterThanOrEqual(2);
      });
    });

    it("o driver morreu DEPOIS de a mensagem ter sido gravada: o reenvio ganha o recibo, não recusa", async () => {
      const session = ensure();
      const socket = fakeSocket();
      attachSocket(session, socket as never);
      socket.emit("message", Buffer.from(`{"type":"user","text":"já está no disco","cid":"c-r5"}`));
      await vi.waitFor(async () => expect((await readHistory(CARD)).length).toBe(1));
      stopCardDriver(CARD); // hibernation, deploy, crash — after the append

      socket.emit("message", Buffer.from(`{"type":"user","text":"já está no disco","cid":"c-r5"}`));

      // The receipt speaks of DURABILITY, not of the driver: the message is stored, and that is what it says.
      await vi.waitFor(() => {
        const acks = socket.sent
          .map((s) => JSON.parse(s) as { type: string; cid?: string })
          .filter((f) => f.type === "user_ack" && f.cid === "c-r5");
        expect(acks.length).toBeGreaterThanOrEqual(2);
      });
      expect(sentTypes(socket)).not.toContain("user_nack"); // refusing would be asking for the third copy
      expect(await readHistory(CARD)).toHaveLength(1);
    });

    it("mesmas palavras com recibo NOVO são uma mensagem nova — mandar duas vezes é um direito", async () => {
      const session = ensure();
      const socket = fakeSocket();
      attachSocket(session, socket as never);
      socket.emit("message", Buffer.from(`{"type":"user","text":"continua","cid":"c-r2"}`));
      socket.emit("message", Buffer.from(`{"type":"user","text":"continua","cid":"c-r3"}`));
      await vi.waitFor(async () => expect((await readHistory(CARD)).length).toBe(2));
      expect(session.activeTurns).toBe(2);
    });

    it("uma edição reenviada também não duplica o supersede nem o marcador 'editada'", async () => {
      const session = ensure();
      const socket = fakeSocket();
      attachSocket(session, socket as never);
      socket.emit("message", Buffer.from(`{"type":"edit_user","original":"a","text":"b","cid":"c-r4"}`));
      await vi.waitFor(async () => expect((await readHistory(CARD)).length).toBe(2));

      socket.emit("message", Buffer.from(`{"type":"edit_user","original":"a","text":"b","cid":"c-r4"}`));
      await new Promise((r) => setImmediate(r));

      expect(await readHistory(CARD)).toHaveLength(2); // message_edited + user, once each
      expect(session.activeTurns).toBe(1);
    });
  });

  /**
   * The "/" menu needs to exist at the INSTANT of the connect. The driver announces the catalog once, on
   * boot; keeping it on disk is what makes the list be there before the new driver speaks (see
   * ./catalog.ts and the route, which serves it when the session does not have its own yet).
   */
  it("o catálogo anunciado pelo driver é guardado em disco para o próximo connect", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);

    spawned[0]!.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({
        type: "catalog",
        commands: [{ name: "code-review", description: "Revisa o diff" }],
      })}\n`),
    );

    await vi.waitFor(async () => {
      const saved = await readCardCatalog(CARD);
      expect(saved?.commands.map((c) => c.name)).toEqual(["code-review", "btw"]);
    });
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
 * THE HIBERNATION VETO (the incident's root cause): the idle sweep hibernated the card the person
 * was using — and hibernating kills the driver. The card in use is now vetoed; an idle driver is not.
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

  it("um socket que JÁ fechou não é preso: o `close` dele não vem mais, e ele seguraria o card para sempre", () => {
    vi.useFakeTimers();
    const session = ensure();
    const socket = fakeSocket();
    socket.close(); // closed during the route's setup — the event has already passed
    attachSocket(session, socket as never);
    expect(session.sockets.size).toBe(0);
    expect(isCardChatInUse(CARD)).toBe(false);
    // Nobody holds the driver any more: the idle stop arms as if the socket had never come.
    vi.advanceTimersByTime(DRIVER_IDLE_MS + 1);
    expect(hasDriverSession(CARD)).toBe(false);
  });
});


/**
 * REWIND. Editing a message can REWIND the session: the model loses the original and everything that came
 * after. When that happens the LOG has to lose it too — a replay that brings back lines the
 * model does not have makes the screen and the model disagree about the conversation, which is the bug the rewind
 * exists to fix.
 *
 * The danger here is the cut firing when it should NOT: a `rewound` from another turn, a repeated
 * frame, or the driver saying it could not rewind. Each of these would erase live conversation.
 */
describe("rewound — o log só é cortado quando o driver confirma que rebobinou", () => {
  /** The conversation with the edit already SENT and the log settled — the state each case starts from. */
  const ANTES_DO_REWOUND = ["user", "assistant_text", "user", "assistant_text", "message_edited", "user"];

  async function conversaComEdicao(): Promise<void> {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"primeira"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "resposta da primeira" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"errada"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "meia resposta" }));
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"errada","text":"certa"}`));
    // Waiting for the log to SETTLE before sending the `rewound` is what makes the negative cases
    // honest: without it, "cut nothing" and "the append has not arrived yet" are indistinguishable.
    await vi.waitFor(async () => expect((await readHistory(CARD)).map((e) => e.type)).toEqual(ANTES_DO_REWOUND));
  }

  const emit = (frame: unknown): void => { spawned[0]!.stdout.emit("data", line(frame as never)); };
  /** The log cut is fired without await: waiting for it to SETTLE avoids an append landing in the tmp already
   *  removed by the afterEach (ENOTEMPTY) and, worse, a test measuring the previous test's log. */
  const logAssentado = async (): Promise<void> => {
    await vi.waitFor(async () => expect((await readHistory(CARD)).map((e) => e.type)).toEqual(["user", "assistant_text", "user"]));
  };
  /** Gives a wrongful cut time to happen, so that "did not cut" means something. */
  const deixaCortarSeForCortar = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10));
  };

  it("o `rewound` que vai à tela diz QUAL mensagem é a edição — com outra pessoa no card, ela não é a última", async () => {
    await conversaComEdicao();
    const viewer = fakeSocket();
    attachSocket(ensure(), viewer as never);
    emit({ type: "rewound", ok: true, uuid: "abc", originalText: "errada" });
    const rewound = viewer.sent.map((s) => JSON.parse(s) as { type: string; text?: string }).find((e) => e.type === "rewound");
    expect(rewound?.text).toBe("certa");
    await logAssentado();
  });

  it("editar a PRIMEIRA mensagem: `first` vai ao driver, ao marcador e ao `rewound` da tela, e o log corta desde a primeira cópia", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"dup"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "erro" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: true }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"dup"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "erro" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: true }));
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"dup","text":"nova","first":true}`));
    const control = spawned[0]!.stdin.written.map((w) => JSON.parse(w) as { type: string; first?: boolean }).find((c) => c.type === "edit_user");
    expect(control?.first).toBe(true);
    await vi.waitFor(async () => expect((await readHistory(CARD)).find((e) => e.type === "message_edited")).toMatchObject({ first: true }));
    const viewer = fakeSocket();
    attachSocket(ensure(), viewer as never);
    emit({ type: "rewound", ok: true, originalText: "dup" });
    const rewound = viewer.sent.map((s) => JSON.parse(s) as { type: string; first?: boolean }).find((e) => e.type === "rewound");
    expect(rewound?.first).toBe(true);
    await vi.waitFor(async () => expect((await readHistory(CARD)).map((e) => e.type)).toEqual(["user"]));
    expect((await readHistory(CARD))[0]).toMatchObject({ type: "user", text: "nova" });
  });

  it("ok: true corta o miolo e deixa o log igual ao que o modelo tem", async () => {
    await conversaComEdicao();
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await vi.waitFor(async () => {
      const events = await readHistory(CARD);
      expect(events.map((e) => e.type)).toEqual(["user", "assistant_text", "user"]);
      expect((events[0] as { text: string }).text).toBe("primeira");
      expect((events[2] as { text: string }).text).toBe("certa");
    });
  });

  /**
   * THE DISK REFUSED THE CUT (ENOSPC): the screen has already cut the lines and the model has already been rewound, but the
   * file still has everything. Auditing "dropped N" here was a lie — and the F5 brought the conversation back.
   */
  it("um corte que o disco recusa sai como FALHA, não como rewind feito, e a fila segue gravando", async () => {
    await conversaComEdicao();
    const info = vi.spyOn(logger, "info");
    onTestFinished(() => info.mockRestore());
    const warn = vi.spyOn(logger, "warn");
    onTestFinished(() => warn.mockRestore());
    disk.failRewrites = true;
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ audit: true, action: "sdk.rewind.failed", detail: "no space left on device" }),
      expect.any(String),
    ));
    expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ action: "sdk.rewind" }), expect.anything());
    expect((await readHistory(CARD)).map((e) => e.type)).toEqual(ANTES_DO_REWOUND);

    disk.failRewrites = false;
    emit({ type: "assistant_text", text: "resposta da certa" });
    await vi.waitFor(async () => expect((await readHistory(CARD)).at(-1)).toMatchObject({ text: "resposta da certa" }));
  });

  it("`not-delivered` com o disco recusando: a falha de tirar o invólucro é dita, não engolida", async () => {
    await conversaComEdicao();
    const warn = vi.spyOn(logger, "warn");
    onTestFinished(() => warn.mockRestore());
    disk.failRewrites = true;
    emit({ type: "rewound", ok: false, reason: "not-delivered" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "no space left on device" }),
      "could not unwrap the edited message in the sdk chat history",
    ));
    expect((await readHistory(CARD)).at(-1)).toMatchObject({ text: "certa", sent: expect.any(String) });
  });

  it("ok: false NÃO corta nada — houve supersede, e tudo que está no log ainda vale", async () => {
    for (const reason of ["absorbed", "no-fork-point"]) {
      await conversaComEdicao();
      emit({ type: "rewound", ok: false, reason });
      await deixaCortarSeForCortar();
      expect((await readHistory(CARD)).map((e) => e.type)).toEqual(ANTES_DO_REWOUND);
      resetSdkSessionsForTesting();
      spawned.length = 0;
      await rm(join(dir, "sdk-history"), { recursive: true, force: true });
    }
  });

  /**
   * THE ORIGINAL NEVER REACHED THE MODEL: the driver sent the clean text (`not-delivered`). Nothing is
   * cut — the rest of the conversation still holds —, but the clean text is the driver's speech (otherwise the mirror
   * republishes it from the transcript) and the log loses the wrapper (otherwise the replay draws it twice).
   */
  it("ok: false `not-delivered`: nada cortado, texto limpo conhecido e o log sem invólucro", async () => {
    forgetDriverKeys(CARD);
    await conversaComEdicao();
    emit({ type: "rewound", ok: false, reason: "not-delivered" });
    await vi.waitFor(() => expect(driverKeysFor(CARD).has("user:certa")).toBe(true));
    await vi.waitFor(async () => {
      const events = await readHistory(CARD);
      expect(events.map((e) => e.type)).toEqual(ANTES_DO_REWOUND);
      expect((events.at(-1) as { text: string; sent?: string })).toEqual(expect.objectContaining({ text: "certa" }));
      expect((events.at(-1) as { sent?: string }).sent).toBeUndefined();
    });
  });

  it("um `rewound` que não pertence a edição nenhuma não corta nada", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"errada"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "resposta" }));
    await vi.waitFor(async () => expect((await readHistory(CARD)).length).toBe(2));
    // no edit was sent: this frame is noise (old driver, reconnection, bug)
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await deixaCortarSeForCortar();
    expect((await readHistory(CARD)).map((e) => e.type)).toEqual(["user", "assistant_text"]);
  });

  /**
   * The target being consumed on the first frame is a DOUBLE protection: even if it were not, the cut requires both
   * ends in the log (the original message AND the marker), and after the first cut neither of the
   * two exists any more. This test checks the observable result — the log survives a repeated
   * frame — and not which of the two guards acted.
   */
  it("um segundo `rewound` repetido não corta de novo", async () => {
    await conversaComEdicao();
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await vi.waitFor(async () => expect((await readHistory(CARD)).length).toBe(3));
    // now the conversation goes on, and a repeated frame arrives late
    emit({ type: "assistant_text", text: "resposta da certa" });
    await vi.waitFor(async () => expect((await readHistory(CARD)).length).toBe(4));
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await deixaCortarSeForCortar();
    const events = await readHistory(CARD);
    expect(events.map((e) => e.type)).toEqual(["user", "assistant_text", "user", "assistant_text"]);
  });

  it("o `rewound` chega na tela — ela precisa dele pra decidir se apaga as linhas", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.sent.length = 0;
    spawned[0]!.stdout.emit("data", line({ type: "rewound", ok: false, reason: "absorbed" } as never));
    expect(socket.sent.map((s) => JSON.parse(s) as { type: string })).toContainEqual(
      expect.objectContaining({ type: "rewound", ok: false, reason: "absorbed" }),
    );
  });

  /**
   * THE SECOND BUBBLE (production, 2026-10-01 — "era para a mensagem ali em cima atualizar e não gerar
   * uma nova por baixo").
   *
   * An edit is written to the driver's stdin in BOTH forms, and only it chooses: the CLEAN text if it
   * manages to rewind, the supersede wrapper if not. The transcript mirror, however, was
   * told only about the wrapper — so, when the rewind worked, the line the CLI wrote in the
   * transcript (with the clean text) was not recognised as the driver's own speech and came back into
   * the conversation as if the TERMINAL had just said it: a second, identical bubble, right
   * below the message that had just been corrected.
   */
  it("depois de rebobinar, o texto LIMPO também é fala conhecida do driver", async () => {
    forgetDriverKeys(CARD); // the card's memory belongs to the MODULE: this case starts from a blank sheet
    await conversaComEdicao();
    const antes = new Set(driverKeysFor(CARD));
    expect(antes.has("user:certa")).toBe(false); // before the `rewound` only the wrapper is known
    expect([...antes].some((k) => k.includes("correção do usuário"))).toBe(true);

    emit({ type: "rewound", ok: true, uuid: "abc" });
    await vi.waitFor(() => expect(driverKeysFor(CARD).has("user:certa")).toBe(true));
    // and the wrapper stays known: a `rewound` does not undo what was already registered
    expect([...driverKeysFor(CARD)].some((k) => k.includes("correção do usuário"))).toBe(true);
    await logAssentado();
  });

  it("e por causa disso o espelho NÃO redesenha a mensagem corrigida vinda do transcript", async () => {
    await conversaComEdicao();
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await vi.waitFor(() => expect(driverKeysFor(CARD).has("user:certa")).toBe(true));
    await logAssentado();

    // the CLI's transcript carries the clean text — that is what the mirror sees next
    const state = createMirrorState(0, [], driverKeysFor(CARD));
    const out = mirrorNewEvents(state, JSON.stringify({
      type: "user", uuid: "u-certa", timestamp: "2026-10-01T12:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "certa" }] },
    }), CARD);
    expect(out).toEqual([]);
  });

  it("sem rebobinar (supersede), quem o espelho tem de calar é o INVÓLUCRO", async () => {
    await conversaComEdicao();
    emit({ type: "rewound", ok: false, reason: "absorbed" });
    await deixaCortarSeForCortar();
    const state = createMirrorState(0, [], driverKeysFor(CARD));
    const wrapped = [...driverKeysFor(CARD)].find((k) => k.includes("correção do usuário"))!.slice("user:".length);
    const out = mirrorNewEvents(state, JSON.stringify({
      type: "user", uuid: "u-wrapped", timestamp: "2026-10-01T12:00:00Z",
      message: { role: "user", content: [{ type: "text", text: wrapped }] },
    }), CARD);
    expect(out).toEqual([]);
  });

  /**
   * THE CUT NOTE DOES NOT SURVIVE THE REWIND.
   *
   * On the ordinary path the note already went out before the `rewound` (the screen only sends the edit when the turn
   * closes, and it is the closing that releases the note). But the screen has a grace period: if the old
   * turn does not close, it sends the edit anyway — and then the note is still in the pipeline. Writing it
   * afterwards would place it AFTER the marker, outside the cut, and an F5 would bring back "a resposta
   * acima ficou pela metade" hanging under the corrected message, talking about an answer the
   * rewind erased.
   */
  it("a edição pelo prazo de carência: a nota do corte não sobra no log", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"errada"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "meia resposta" }));
    // the turn does NOT close: the screen gives up waiting and sends the edit with it still open
    socket.emit("message", Buffer.from(`{"type":"interrupt","reason":"edit"}`));
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"errada","text":"certa"}`));
    await vi.waitFor(async () => {
      expect((await readHistory(CARD)).map((e) => e.type))
        .toEqual(["user", "assistant_text", "message_edited", "user"]);
    });
    // The driver's REAL ORDER: `endStream` WAITS for the dying stream's `result` before
    // `rewindAndSend` announces the rewind — so the result (and the note it releases) comes FIRST,
    // and the note lands AFTER the marker, out of the cut's reach. Swapping the two here would
    // test a sequence the driver does not produce.
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => {
      expect((await readHistory(CARD)).some((e) => e.type === "system_note")).toBe(true);
    });
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await vi.waitFor(async () => {
      const events = await readHistory(CARD);
      expect(events.map((e) => e.type)).toEqual(["user"]);
      expect((events[0] as { text: string }).text).toBe("certa");
    });
  });

  it("mas um `rewound` RECUSADO deixa a nota sair — ali nada foi apagado", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"errada"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "meia resposta" }));
    socket.emit("message", Buffer.from(`{"type":"interrupt","reason":"edit"}`));
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"errada","text":"certa"}`));
    emit({ type: "rewound", ok: false, reason: "absorbed" });
    emit({ type: "result", isError: false });
    await vi.waitFor(async () => {
      const notes = (await readHistory(CARD)).filter((e) => e.type === "system_note");
      expect(notes.map((e) => (e as { text: string }).text)).toEqual(["turn-interrupted-edit"]);
    });
  });

  /**
   * TWO EDITS IN FLIGHT. Nothing stops the person from correcting a second message before the first
   * is answered: with no turn running, the screen dispatches the edit right away. With a SINGLE slot, the
   * second overwrote the first — and then the first `rewound` cut the log at the WRONG message,
   * erasing a correction the person wrote and the model had already read.
   */
  it("duas edições em voo: cada `rewound` corta a SUA, na ordem em que foram mandadas", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"m1"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "a1" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"m2"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "a2" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"m1","text":"n1"}`));
    socket.emit("message", Buffer.from(`{"type":"edit_user","original":"m2","text":"n2"}`));
    await vi.waitFor(async () => expect((await readHistory(CARD)).length).toBe(8));

    // The first `rewound` belongs to the FIRST edit: it cuts at "m1" and leaves "n1" standing. With a single
    // slot, it would cut at "m2" (the second edit would have overwritten the target) and take "n1" along —
    // a correction the person wrote and the model read, erased from the history.
    emit({ type: "rewound", ok: true, uuid: "u1" });
    await vi.waitFor(async () => {
      const texts = (await readHistory(CARD)).filter((e) => e.type === "user").map((e) => (e as { text: string }).text);
      expect(texts).toContain("n1");
      expect(texts).not.toContain("m1");
    });
    expect(driverKeysFor(CARD).has("user:n1")).toBe(true);
    expect(driverKeysFor(CARD).has("user:n2")).toBe(false); // the second has not been answered yet

    emit({ type: "rewound", ok: true, uuid: "u2" }); // e agora a SEGUNDA
    await vi.waitFor(() => expect(driverKeysFor(CARD).has("user:n2")).toBe(true));
    const texts = (await readHistory(CARD)).filter((e) => e.type === "user").map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["n1", "n2"]);
  });

  /**
   * A `rewound: ok` WITH NO OWNER DOES NOT REACH THE SCREEN. In the log it was already harmless (without both ends,
   * nothing is cut), but `dropRewoundRows` cuts from the last "edited" line to the last message —
   * and a REFUSED edit leaves that mark forever. A lost frame would erase from the screen whole
   * turns the model still has.
   */
  it("um `rewound: ok` que não pertence a edição nenhuma não é repassado à tela", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    socket.sent.length = 0;
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await deixaCortarSeForCortar();
    expect(socket.sent.map((x) => JSON.parse(x) as { type: string }).some((e) => e.type === "rewound")).toBe(false);
  });

  it("mas o `ok: false` sem dono SEGUE indo — na tela ele não apaga nada, e cala o 'rebobinando'", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.sent.length = 0;
    emit({ type: "rewound", ok: false, reason: "absorbed" });
    expect(socket.sent.map((x) => JSON.parse(x) as { type: string })).toContainEqual(
      expect.objectContaining({ type: "rewound", ok: false, reason: "absorbed" }),
    );
  });

  it("o `rewound` NÃO vai pro log — é feedback do momento, não conversa", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    emit({ type: "rewound", ok: true, uuid: "abc" });
    await deixaCortarSeForCortar();
    expect((await readHistory(CARD)).some((e) => e.type === "rewound")).toBe(false);
  });
});

describe("attachSocket — \"está digitando\" entre as abas do card", () => {
  const CESAR = { kind: "user" as const, name: "cesar" };
  const MUSSA = { kind: "owner" as const, name: "mussa" };
  const typing = (active: boolean): Buffer => Buffer.from(JSON.stringify({ type: "typing", active }));
  const peerFrames = (socket: FakeSocket): Array<{ type: string; name?: string; active?: boolean }> =>
    socket.sent.map((s) => JSON.parse(s) as { type: string; name?: string; active?: boolean }).filter((e) => e.type === "peer_typing");

  it("repassa o nome de quem digita para as OUTRAS abas — nunca de volta para quem digita", () => {
    const session = ensure();
    const cesar = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, mussa as never, MUSSA);
    cesar.emit("message", typing(true));
    expect(peerFrames(mussa)).toEqual([{ type: "peer_typing", name: "cesar", active: true }]);
    expect(peerFrames(cesar)).toEqual([]);
  });

  it("é efêmero: não vira turno no driver nem linha no histórico", async () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, fakeSocket() as never, MUSSA);
    cesar.emit("message", typing(true));
    cesar.emit("message", typing(false));
    expect(spawned[0]!.stdin.written.join("")).not.toContain("typing");
    expect(session.activeTurns).toBe(0);
    expect(await readHistory(CARD)).toEqual([]);
  });

  it("não sobrecarrega: dentro da janela mínima, um segundo \"digitando\" da mesma aba não é repassado", () => {
    vi.useFakeTimers();
    const session = ensure();
    const cesar = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, mussa as never, MUSSA);
    cesar.emit("message", typing(true));
    cesar.emit("message", typing(true));
    cesar.emit("message", typing(true));
    expect(peerFrames(mussa).length).toBe(1);
    vi.advanceTimersByTime(TYPING_RELAY_MIN_MS);
    cesar.emit("message", typing(true));
    expect(peerFrames(mussa).length).toBe(2);
  });

  it("alternar digitando/parou em loop NÃO fura o teto: o recomeço também respeita a janela", () => {
    vi.useFakeTimers();
    const session = ensure();
    const cesar = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, mussa as never, MUSSA);
    for (let i = 0; i < 10; i += 1) {
      cesar.emit("message", typing(true));
      cesar.emit("message", typing(false));
    }
    // one "digitando" and its "parou" — the rest of the loop, inside the window, does not leave the server
    expect(peerFrames(mussa)).toEqual([
      { type: "peer_typing", name: "cesar", active: true },
      { type: "peer_typing", name: "cesar", active: false },
    ]);
    vi.advanceTimersByTime(TYPING_RELAY_MIN_MS);
    cesar.emit("message", typing(true));
    expect(peerFrames(mussa).length).toBe(3);
  });

  it("mandar um /btw também encerra o \"digitando\" nas outras abas", () => {
    const session = ensure();
    const cesar = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, mussa as never, MUSSA);
    cesar.emit("message", typing(true));
    cesar.emit("message", Buffer.from(JSON.stringify({ type: "btw", id: "b1", question: "e aí?" })));
    expect(peerFrames(mussa)).toEqual([
      { type: "peer_typing", name: "cesar", active: true },
      { type: "peer_typing", name: "cesar", active: false },
    ]);
  });

  it("o \"parou\" passa sempre (fura a janela) — e só quando havia um \"digitando\" no ar", () => {
    const session = ensure();
    const cesar = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, mussa as never, MUSSA);
    cesar.emit("message", typing(false)); // nada no ar: nada a apagar
    expect(peerFrames(mussa)).toEqual([]);
    cesar.emit("message", typing(true));
    cesar.emit("message", typing(false));
    expect(peerFrames(mussa)).toEqual([
      { type: "peer_typing", name: "cesar", active: true },
      { type: "peer_typing", name: "cesar", active: false },
    ]);
  });

  it("a aba que fecha no meio da digitação apaga o próprio indicador nas outras", () => {
    const session = ensure();
    const cesar = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, mussa as never, MUSSA);
    cesar.emit("message", typing(true));
    cesar.emit("close");
    expect(peerFrames(mussa).at(-1)).toEqual({ type: "peer_typing", name: "cesar", active: false });
  });

  it("enviar a mensagem encerra a digitação para os outros (o \"parou\" do front pode se perder)", () => {
    const session = ensure();
    const cesar = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, mussa as never, MUSSA);
    cesar.emit("message", typing(true));
    cesar.emit("message", Buffer.from(`{"type":"user","text":"pronto"}`));
    expect(peerFrames(mussa).at(-1)).toEqual({ type: "peer_typing", name: "cesar", active: false });
  });

  it("um socket sem autor conhecido não anuncia ninguém (não há nome para mostrar)", () => {
    const session = ensure();
    const anon = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, anon as never);
    attachSocket(session, mussa as never, MUSSA);
    anon.emit("message", typing(true));
    expect(peerFrames(mussa)).toEqual([]);
  });
});

/**
 * THE QUESTION THAT VANISHED "SEM RESPOSTA" (production, 2026-10-26): someone stopped the turn and the card dropped on
 * the other person's screen as if the deadline had expired. Now the result says who stopped it and how.
 */
describe("dispatchClientFrame — quem parou o turno cancela a pergunta, e o cartão diz quem", () => {
  const CESAR = { kind: "user" as const, name: "cesar" };
  const MUSSA = { kind: "owner" as const, name: "mussa" };
  const emit = (event: object) => spawned[0]!.stdout.emit("data", line(event as never));
  const results = (socket: FakeSocket) =>
    socket.sent.map((x) => JSON.parse(x) as Record<string, unknown>).filter((e) => e.type === "question_result");
  const ask = () => emit({ type: "user_question", id: "q1", questions: [{ question: "Como?", options: [{ label: "A" }] }] });

  it("o botão de parar: a pergunta cancelada carrega o nome de quem parou", async () => {
    const session = ensure();
    const cesar = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, mussa as never, MUSSA);
    mussa.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    ask();
    mussa.emit("message", Buffer.from(`{"type":"interrupt"}`));
    emit({ type: "question_result", id: "q1", timedOut: false, superseded: false });
    expect(results(cesar)).toEqual([expect.objectContaining({ id: "q1", cancelledBy: "mussa", cancelledHow: "stop" })]);
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10)); // the history writes in the background
    expect((await readHistory(CARD)).find((e) => e.type === "question_result")).toMatchObject({ cancelledBy: "mussa" });
  });

  it("o \"enviar agora\" com a pergunta aberta também a cancela — e diz isso", () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    cesar.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    ask();
    cesar.emit("message", Buffer.from(`{"type":"user","text":"faz assim","now":true}`));
    emit({ type: "question_result", id: "q1", timedOut: false, superseded: false });
    expect(results(cesar)[0]).toMatchObject({ cancelledBy: "cesar", cancelledHow: "send_now" });
  });

  it("prazo vencido e resposta por mensagem continuam sendo o que são", () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    cesar.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    ask();
    cesar.emit("message", Buffer.from(`{"type":"interrupt"}`));
    emit({ type: "question_result", id: "q1", timedOut: true });
    expect(results(cesar)[0]).not.toHaveProperty("cancelledBy");
  });

  it("um stop de um turno que já fechou não marca a pergunta do turno seguinte", () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    cesar.emit("message", Buffer.from(`{"type":"user","text":"oi"}`));
    cesar.emit("message", Buffer.from(`{"type":"interrupt"}`));
    emit({ type: "result", subtype: "error_during_execution", isError: true });
    cesar.emit("message", Buffer.from(`{"type":"user","text":"de novo"}`));
    ask();
    emit({ type: "question_result", id: "q1", timedOut: false, superseded: false });
    expect(results(cesar)[0]).not.toHaveProperty("cancelledHow");
  });
});

/**
 * TWO PEOPLE, ONE QUESTION: only the first answer counts. The card's draft goes to the other tabs
 * while the person ticks and writes, so nobody sends a different answer without knowing.
 */
describe("attachSocket — rascunho do cartão de pergunta em tempo real", () => {
  const CESAR = { kind: "user" as const, name: "cesar" };
  const ALBERT = { kind: "user" as const, name: "albert" };
  const emit = (event: object) => spawned[0]!.stdout.emit("data", line(event as never));
  const draft = (id: string, picked: string[][], other: string[]): Buffer =>
    Buffer.from(JSON.stringify({ type: "question_draft", id, picked, other }));
  type PeerDraft = { type: string; id?: string; name?: string; picked?: string[][]; other?: string[] };
  const draftFrames = (socket: FakeSocket): PeerDraft[] =>
    socket.sent.map((s) => JSON.parse(s) as PeerDraft).filter((e) => e.type === "peer_question_draft");

  it("repassa o que foi marcado e escrito às OUTRAS abas, com o nome — nunca de volta", () => {
    const session = ensure();
    const cesar = fakeSocket();
    const albert = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, albert as never, ALBERT);
    cesar.emit("message", draft("q1", [["No item"]], ["72h pulando"]));
    expect(draftFrames(albert)).toEqual([
      { type: "peer_question_draft", id: "q1", name: "cesar", picked: [["No item"]], other: ["72h pulando"] },
    ]);
    expect(draftFrames(cesar)).toEqual([]);
  });

  it("é efêmero: não vira turno no driver nem linha no histórico", async () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, fakeSocket() as never, ALBERT);
    cesar.emit("message", draft("q1", [[]], ["oi"]));
    expect(spawned[0]!.stdin.written.join("")).not.toContain("question_draft");
    expect(session.activeTurns).toBe(0);
    expect(await readHistory(CARD)).toEqual([]);
  });

  it("quem abre o card DEPOIS vê o rascunho de quem já está respondendo", () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    cesar.emit("message", draft("q1", [[]], ["primeiro"]));
    cesar.emit("message", draft("q1", [[]], ["primeiro, segundo"]));
    const albert = fakeSocket();
    attachSocket(session, albert as never, ALBERT);
    expect(draftFrames(albert)).toEqual([
      { type: "peer_question_draft", id: "q1", name: "cesar", picked: [[]], other: ["primeiro, segundo"] },
    ]);
  });

  it("apagar tudo apaga nos outros e não fica guardado", () => {
    const session = ensure();
    const cesar = fakeSocket();
    const albert = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, albert as never, ALBERT);
    cesar.emit("message", draft("q1", [[]], ["x"]));
    cesar.emit("message", draft("q1", [[]], [""]));
    expect(draftFrames(albert).at(-1)).toEqual({ type: "peer_question_draft", id: "q1", name: "cesar", picked: [[]], other: [""] });
    const late = fakeSocket();
    attachSocket(session, late as never, ALBERT);
    expect(draftFrames(late)).toEqual([]);
  });

  it("a pergunta respondida esquece os rascunhos dela", () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    emit({ type: "user_question", id: "q1", questions: [{ question: "Como?", options: [{ label: "A" }] }] });
    cesar.emit("message", draft("q1", [["A"]], [""]));
    emit({ type: "question_result", id: "q1", answers: [{ selected: ["A"] }] });
    const albert = fakeSocket();
    attachSocket(session, albert as never, ALBERT);
    expect(draftFrames(albert)).toEqual([]);
  });

  it("a aba que fecha NÃO apaga o que a pessoa marcou: os outros a veem como ausente", () => {
    const session = ensure();
    const cesar = fakeSocket();
    const albert = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, albert as never, ALBERT);
    cesar.emit("message", draft("q1", [[]], ["meio"]));
    cesar.emit("close");
    expect(draftFrames(albert).at(-1)).toEqual({ type: "peer_question_draft", id: "q1", name: "cesar", picked: [[]], other: ["meio"], away: true });
    expect(session.questionDrafts.get("q1")?.get("cesar")).toMatchObject({ other: ["meio"] });
    // whoever arrives later sees it too — as absent
    const late = fakeSocket();
    attachSocket(session, late as never, ALBERT);
    expect(draftFrames(late)).toEqual([{ type: "peer_question_draft", id: "q1", name: "cesar", picked: [[]], other: ["meio"], away: true }]);
  });

  it("com outra aba da mesma pessoa ainda no cartão, fechar uma não a deixa ausente", () => {
    const session = ensure();
    const cesarA = fakeSocket();
    const cesarB = fakeSocket();
    const albert = fakeSocket();
    attachSocket(session, cesarA as never, CESAR);
    attachSocket(session, cesarB as never, CESAR);
    attachSocket(session, albert as never, ALBERT);
    cesarA.emit("message", draft("q1", [["A"]], [""]));
    cesarB.emit("message", draft("q1", [["A"]], ["mais"]));
    cesarA.emit("close");
    expect(draftFrames(albert).some((f) => (f as { away?: boolean }).away)).toBe(false);
  });

  it("O CASO REAL (produção, 2026-11-03): o que cada pessoa marcou sobrevive ao reinício do back", async () => {
    const session = ensure();
    const cesar = fakeSocket();
    const albert = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, albert as never, ALBERT);
    cesar.emit("message", draft("q1", [["Faixa de capacidade"], []], ["pela placa", ""]));
    albert.emit("message", draft("q1", [[], ["Bloqueia"]], ["", ""]));
    await questionDraftsSettled(CARD);
    // the deploy: the process dies with everything it had in memory
    resetSdkSessionsForTesting();
    const next = ensure();
    await next.draftsLoaded;
    const back = fakeSocket();
    attachSocket(next, back as never, CESAR);
    expect(draftFrames(back)).toEqual([
      { type: "peer_question_draft", id: "q1", name: "cesar", picked: [["Faixa de capacidade"], []], other: ["pela placa", ""], away: true },
      { type: "peer_question_draft", id: "q1", name: "albert", picked: [[], ["Bloqueia"]], other: ["", ""], away: true },
    ]);
  });

  it("a aba que já estava conectada recebe o que o disco tinha assim que a leitura termina", async () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    cesar.emit("message", draft("q1", [["A"]], [""]));
    await questionDraftsSettled(CARD);
    resetSdkSessionsForTesting();
    const next = ensure();
    const early = fakeSocket();
    attachSocket(next, early as never, ALBERT); // before the read finishes
    await next.draftsLoaded;
    expect(draftFrames(early)).toEqual([{ type: "peer_question_draft", id: "q1", name: "cesar", picked: [["A"]], other: [""], away: true }]);
  });

  it("a versão mais NOVA vence: a aba que volta com um rascunho velho recebe o novo, e o velho não grava", async () => {
    const session = ensure();
    const phone = fakeSocket();
    const laptop = fakeSocket();
    attachSocket(session, phone as never, CESAR);
    attachSocket(session, laptop as never, CESAR);
    phone.emit("message", Buffer.from(JSON.stringify({ type: "question_draft", id: "q1", picked: [["Novo"]], other: [""], at: 2_000 })));
    laptop.emit("message", Buffer.from(JSON.stringify({ type: "question_draft", id: "q1", picked: [["Velho"]], other: [""], at: 1_000 })));
    expect(session.questionDrafts.get("q1")?.get("cesar")).toEqual({ picked: [["Novo"]], other: [""], at: 2_000 });
    expect(draftFrames(laptop).at(-1)).toEqual({ type: "peer_question_draft", id: "q1", name: "cesar", picked: [["Novo"]], other: [""], at: 2_000 });
    await questionDraftsSettled(CARD);
    expect((await loadQuestionDrafts(CARD)).get("q1")?.get("cesar")?.picked).toEqual([["Novo"]]);
  });

  it("a pergunta encerrada sai do disco também", async () => {
    const session = ensure();
    const cesar = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    emit({ type: "user_question", id: "q1", questions: [{ question: "Como?", options: [{ label: "A" }] }] });
    cesar.emit("message", draft("q1", [["A"]], [""]));
    emit({ type: "question_result", id: "q1", answers: [{ selected: ["A"] }] });
    await questionDraftsSettled(CARD);
    expect((await loadQuestionDrafts(CARD)).size).toBe(0);
  });

  it("socket sem autor e frame malformado não anunciam nada (e não viram mensagem)", () => {
    const session = ensure();
    const anon = fakeSocket();
    const cesar = fakeSocket();
    const albert = fakeSocket();
    attachSocket(session, anon as never);
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, albert as never, ALBERT);
    anon.emit("message", draft("q1", [[]], ["x"]));
    cesar.emit("message", Buffer.from(`{"type":"question_draft","id":42}`));
    expect(draftFrames(albert)).toEqual([]);
    expect(session.activeTurns).toBe(0);
  });
});

/**
 * TWO PEOPLE, ONE QUESTION — ALL ANSWERS COUNT (production, 2026-11-03): César and Albert
 * were answering the same card; the first answer sent closed the question and what the other had
 * written was lost. Now the answer carries along what the others already ticked/wrote, with the name,
 * and whoever sends AFTERWARDS becomes a message for the AI to compare — if it contradicts, it asks again.
 */
describe("attachSocket — respostas de várias pessoas ao mesmo cartão", () => {
  const CESAR = { kind: "user" as const, name: "cesar" };
  const ALBERT = { kind: "user" as const, name: "albert" };
  const emit = (event: object) => spawned[0]!.stdout.emit("data", line(event as never));
  const draft = (id: string, picked: string[][], other: string[]): Buffer =>
    Buffer.from(JSON.stringify({ type: "question_draft", id, picked, other }));
  const answer = (id: string, selected: string[][]): Buffer =>
    Buffer.from(JSON.stringify({ type: "question_answer", id, answers: selected.map((s) => ({ selected: s })) }));
  type Answers = { selected: string[] }[];
  type Written = { type: string; id?: string; text?: string; keepQuestions?: boolean; answers?: Answers; forModel?: Answers };
  const written = (): Written[] => spawned[0]!.stdin.written.map((w) => JSON.parse(w) as Written);
  const QUESTIONS = [
    { question: "Produto sem peso: o que acontece?", options: [{ label: "Bloqueia" }, { label: "Avisa" }] },
    { question: "O limite de paletes continua?", options: [{ label: "Não" }, { label: "Sim" }] },
  ];
  const two = () => {
    const session = ensure();
    const cesar = fakeSocket();
    const albert = fakeSocket();
    attachSocket(session, cesar as never, CESAR);
    attachSocket(session, albert as never, ALBERT);
    emit({ type: "user_question", id: "q1", questions: QUESTIONS });
    return { session, cesar, albert };
  };

  it("o modelo lê junto o rascunho do outro, com nome; o cartão segue com a resposta limpa", () => {
    const { cesar, albert } = two();
    albert.emit("message", draft("q1", [[], ["Sim"]], ["a space tem os pesos", "10 pallets"]));
    cesar.emit("message", answer("q1", [["Bloqueia"], ["Não"]]));
    const sent = written().find((c) => c.type === "question_answer")!;
    // What comes back in the question_result and the card draws: only what the sender ticked.
    expect(sent.answers).toEqual([{ selected: ["Bloqueia"] }, { selected: ["Não"] }]);
    expect(sent.forModel![0]!.selected).toEqual([
      "cesar: Bloqueia",
      "albert: a space tem os pesos",
      expect.stringMatching(/pessoas diferentes.*contradit/),
    ]);
    expect(sent.forModel![1]!.selected.slice(0, 2)).toEqual(["cesar: Não", "albert: Sim, 10 pallets"]);
  });

  it("sem outra opinião (só o próprio rascunho, ou rascunho igual ao enviado) não há forModel", () => {
    const { cesar, albert } = two();
    cesar.emit("message", draft("q1", [["Bloqueia"], []], ["", ""]));
    albert.emit("message", draft("q1", [["Bloqueia"], ["Não"]], ["", ""]));
    cesar.emit("message", answer("q1", [["Bloqueia"], ["Não"]]));
    expect(written().find((c) => c.type === "question_answer")).not.toHaveProperty("forModel");
  });

  it("quem responde DEPOIS da pergunta fechada vira mensagem para a IA comparar — não se perde", async () => {
    const { session, cesar, albert } = two();
    cesar.emit("message", answer("q1", [["Bloqueia"], ["Não"]]));
    emit({ type: "question_result", id: "q1", answers: [{ selected: ["Bloqueia"] }, { selected: ["Não"] }] });
    albert.emit("message", answer("q1", [["Avisa"], ["Sim"]]));
    expect(written().filter((c) => c.type === "question_answer")).toHaveLength(1);
    const msg = written().find((c) => c.type === "user")!;
    expect(msg.text).toContain("albert");
    expect(msg.text).toContain("cesar");
    expect(msg.text).toContain("«O limite de paletes continua?» → Sim");
    expect(msg.text).toMatch(/contradit/);
    expect(session.activeTurns).toBe(1);
    // The conversation shows only what Albert chose, in his name; what the model read stays in `sent`.
    await vi.waitFor(async () => {
      const row = (await readHistory(CARD)).find((e) => e.type === "user") as { text: string; sent?: string; from?: { name: string } };
      expect(row.from?.name).toBe("albert");
      expect(row.text).not.toMatch(/AskUserQuestion/);
      expect(row.text).toContain("→ Sim");
      expect(row.sent).toBe(msg.text);
    });
  });

  it("a resposta tardia não libera a pergunta que o agente fez depois", () => {
    const { cesar, albert } = two();
    cesar.emit("message", answer("q1", [["Bloqueia"], ["Não"]]));
    emit({ type: "question_result", id: "q1", answers: [{ selected: ["Bloqueia"] }, { selected: ["Não"] }] });
    emit({ type: "user_question", id: "q2", questions: [{ question: "E agora?", options: [{ label: "A" }] }] });
    albert.emit("message", answer("q1", [["Avisa"], ["Sim"]]));
    expect(written().find((c) => c.type === "user")!.keepQuestions).toBe(true);
  });

  it("a corrida: a segunda resposta antes do resultado do driver também vira mensagem", () => {
    const { cesar, albert } = two();
    cesar.emit("message", answer("q1", [["Bloqueia"], ["Não"]]));
    albert.emit("message", answer("q1", [["Avisa"], ["Sim"]]));
    expect(written().filter((c) => c.type === "question_answer")).toHaveLength(1);
    expect(written().find((c) => c.type === "user")!.text).toContain("«Produto sem peso: o que acontece?» → Avisa");
  });

  it("a mesma pessoa de novo (duas abas, duplo clique) e a resposta vazia não viram turno", () => {
    const { session, cesar, albert } = two();
    cesar.emit("message", answer("q1", [["Bloqueia"], ["Não"]]));
    cesar.emit("message", answer("q1", [["Avisa"], ["Sim"]]));
    albert.emit("message", answer("q1", [[" "], []]));
    expect(written().some((c) => c.type === "user")).toBe(false);
    expect(session.activeTurns).toBe(0);
  });

  it("pergunta encerrada sem resposta (prazo/mensagem) segue o caminho de sempre", () => {
    const { albert } = two();
    emit({ type: "question_result", id: "q1", timedOut: true });
    albert.emit("message", answer("q1", [["Avisa"], ["Sim"]]));
    expect(written().some((c) => c.type === "user")).toBe(false);
    expect(written().filter((c) => c.type === "question_answer")).toHaveLength(1);
  });

  it("a resposta escrita que o driver recusou (o prazo venceu antes) não vira base de comparação", () => {
    const { cesar, albert } = two();
    cesar.emit("message", answer("q1", [["Bloqueia"], ["Não"]]));
    emit({ type: "question_result", id: "q1", timedOut: true });
    albert.emit("message", answer("q1", [["Avisa"], ["Sim"]]));
    expect(written().some((c) => c.type === "user")).toBe(false);
  });
});

/**
 * ONE PERSON'S MESSAGE ON THE OTHERS' SCREENS (production, 2026-10-08): Albert typed — the
 * "está digitando…" showed up for the others —, hit Enter, and the message showed up for nobody
 * but him until an F5. The turn went to the driver and to disk, but the send was never relayed to the
 * card's other tabs: only the model's answer arrived, without the question that produced it.
 */
describe("attachSocket — a mensagem enviada aparece ao vivo nas outras abas do card", () => {
  const ALBERT = { kind: "user" as const, name: "albert" };
  const MUSSA = { kind: "owner" as const, name: "mussa" };
  type Frame = { type: string; text?: string; from?: { name: string }; at?: number; originalText?: string };
  const frames = (socket: FakeSocket, type: string): Frame[] =>
    socket.sent.map((s) => JSON.parse(s) as Frame).filter((e) => e.type === type);

  it("repassa a mensagem às OUTRAS abas com autor e horário — quem enviou já a desenhou", () => {
    const session = ensure();
    const albert = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, albert as never, ALBERT);
    attachSocket(session, mussa as never, MUSSA);
    albert.emit("message", Buffer.from(`{"type":"user","text":"sobe o deploy","cid":"c1"}`));
    const seen = frames(mussa, "user");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "user", text: "sobe o deploy", from: { name: "albert" } });
    expect(typeof seen[0]!.at).toBe("number");
    expect(frames(albert, "user")).toEqual([]);
  });

  it("o Reenviar (mesmo cid) não desenha a mensagem duas vezes nos outros", () => {
    const session = ensure();
    const albert = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, albert as never, ALBERT);
    attachSocket(session, mussa as never, MUSSA);
    albert.emit("message", Buffer.from(`{"type":"user","text":"sobe o deploy","cid":"c1"}`));
    albert.emit("message", Buffer.from(`{"type":"user","text":"sobe o deploy","cid":"c1"}`));
    expect(frames(mussa, "user")).toHaveLength(1);
  });

  it("uma mensagem RECUSADA (driver morto) não aparece para ninguém — ela não entrou na conversa", () => {
    const session = ensure();
    const albert = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, albert as never, ALBERT);
    attachSocket(session, mussa as never, MUSSA);
    spawned[0]!.stdin.writable = false;
    albert.emit("message", Buffer.from(`{"type":"user","text":"sobe o deploy","cid":"c1"}`));
    expect(frames(mussa, "user")).toEqual([]);
  });

  it("a edição chega aos outros: a original esmaece e a nova versão aparece", () => {
    const session = ensure();
    const albert = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, albert as never, ALBERT);
    attachSocket(session, mussa as never, MUSSA);
    albert.emit("message", Buffer.from(`{"type":"edit_user","original":"sobe pra prod","text":"sobe pra dev","cid":"c2"}`));
    expect(frames(mussa, "message_edited")).toEqual([expect.objectContaining({ originalText: "sobe pra prod" })]);
    expect(frames(mussa, "user")).toEqual([expect.objectContaining({ text: "sobe pra dev", from: { kind: "user", name: "albert" } })]);
    expect(frames(albert, "user")).toEqual([]);
  });

  it("quem ainda está conectando (setup da rota) também ouve o envio — e para de ouvir ao sair", () => {
    const session = ensure();
    const albert = fakeSocket();
    attachSocket(session, albert as never, ALBERT);
    const heard: string[] = [];
    const off = onPeerTurn(CARD, (e) => heard.push(e.type === "user" ? e.text : e.type));
    albert.emit("message", Buffer.from(`{"type":"user","text":"sobe o deploy"}`));
    off();
    albert.emit("message", Buffer.from(`{"type":"user","text":"depois"}`));
    expect(heard).toEqual(["sobe o deploy"]);
  });

  it("do que foi ouvido no setup, só o que o replay NÃO trouxe é entregue (nunca duas vezes)", () => {
    const noReplay = { type: "user" as const, text: "a", at: 1, from: ALBERT };
    const depois = { type: "user" as const, text: "b", at: 2, from: ALBERT };
    const marca = { type: "message_edited" as const, originalText: "b", at: 3 };
    expect(missedDuringSetup([noReplay, depois, marca], [{ ...noReplay }])).toEqual([depois, marca]);
  });

  it("o turno que o próprio back injeta (retomada pós-deploy) também aparece em quem está olhando", () => {
    const session = ensure();
    const mussa = fakeSocket();
    attachSocket(session, mussa as never, MUSSA);
    injectSystemTurn(session, "continue de onde parou", { kind: "system", name: "vibehub" }, 1);
    expect(frames(mussa, "user")).toEqual([expect.objectContaining({ text: "continue de onde parou", from: { kind: "system", name: "vibehub" } })]);
  });

  it("vale também para a mensagem guardada durante o setup da conexão (o caminho do buffer)", () => {
    const session = ensure();
    const albert = fakeSocket();
    const mussa = fakeSocket();
    attachSocket(session, albert as never, ALBERT);
    attachSocket(session, mussa as never, MUSSA);
    dispatchClientFrame(session, `{"type":"user","text":"e aí, como tá indo?"}`, ALBERT, albert as never);
    expect(frames(mussa, "user")).toEqual([expect.objectContaining({ text: "e aí, como tá indo?" })]);
    expect(frames(albert, "user")).toEqual([]);
  });
});

/**
 * BACKGROUND TASKS (production, 2026-10-07): Claude fired a `sleep 200` in the background, the
 * turn closed and the chat went silent — "parece que ela parou, mas está rodando". The live set comes
 * from the CLI (`background_tasks`, REPLACE semantics) and is session STATE, like the catalog.
 */
describe("background_tasks — o trabalho que segue depois do turno", () => {
  const running = { type: "background_tasks", tasks: [{ id: "b1", type: "local_bash", description: "Aguarda o deploy" }] };
  const none = { type: "background_tasks", tasks: [] };

  it("chega às abas abertas e é reenviado a uma aba que conecta depois", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line(running));
    expect(sentTypes(s1)).toContain("background_tasks");

    const s2 = fakeSocket();
    attachSocket(session, s2 as never);
    const frames = s2.sent.map((s) => JSON.parse(s) as { type: string; tasks?: unknown }).filter((e) => e.type === "background_tasks");
    expect(frames).toEqual([running]);
  });

  it("não reenvia nada quando o conjunto esvaziou", () => {
    const session = ensure();
    attachSocket(session, fakeSocket() as never);
    spawned[0]!.stdout.emit("data", line(running));
    spawned[0]!.stdout.emit("data", line(none));
    const late = fakeSocket();
    attachSocket(session, late as never);
    expect(sentTypes(late)).not.toContain("background_tasks");
  });

  it("nunca vai para a conversa gravada — é estado, não algo que alguém disse", async () => {
    const session = ensure();
    attachSocket(session, fakeSocket() as never);
    spawned[0]!.stdout.emit("data", line(running));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const history = await readHistory(CARD);
    expect(history.some((e) => e.type === "background_tasks")).toBe(false);
  });

  it("um driver NOVO começa sem tarefas: as do processo antigo morreram com ele", () => {
    const session = ensure();
    attachSocket(session, fakeSocket() as never);
    spawned[0]!.stdout.emit("data", line(running));
    stopCardDriver(CARD);
    const fresh = ensure();
    const late = fakeSocket();
    attachSocket(fresh, late as never);
    expect(fresh).not.toBe(session);
    expect(sentTypes(late)).not.toContain("background_tasks");
  });

  it("o idle stop NÃO mata um driver com tarefa em segundo plano viva — só quando ela termina", () => {
    vi.useFakeTimers();
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"espera o deploy em background"}`));
    spawned[0]!.stdout.emit("data", line(running));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("close");
    vi.advanceTimersByTime(DRIVER_IDLE_MS * 3);
    expect(spawned[0]!.killed).toBe(false);
    expect(isCardChatInUse(CARD)).toBe(true);
    expect(driverActivity(CARD)).toBe("turn");

    spawned[0]!.stdout.emit("data", line(none));
    expect(isCardChatInUse(CARD)).toBe(false);
    expect(driverActivity(CARD)).toBe("idle");
    vi.advanceTimersByTime(DRIVER_IDLE_MS + 1);
    expect(spawned[0]!.killed).toBe(true);
  });

  it("tem TETO: uma tarefa que nunca termina (npm run dev, tail -f) não segura o driver para sempre sem ninguém olhando", () => {
    vi.useFakeTimers();
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "background_tasks", tasks: [{ id: "b1", type: "local_bash", description: "npm run dev" }] }));
    socket.emit("close");
    vi.advanceTimersByTime(BACKGROUND_HOLD_MAX_MS - 1);
    expect(spawned[0]!.killed).toBe(false);
    expect(isCardChatInUse(CARD)).toBe(true);
    vi.advanceTimersByTime(DRIVER_IDLE_MS + 2);
    expect(isCardChatInUse(CARD)).toBe(false);
    expect(spawned[0]!.killed).toBe(true);
  });

  // THE TURN THE CLI OPENS ON ITS OWN (the task finished and the model was woken up) is NOT counted by the
  // manager: inferring it from the event type stuck the count at 1 — the driver does not know about this turn
  // (its `turnActive` is only born in `sendUser`), so a message in the middle of it does not become
  // `turn_absorbed` and a CLI that drops midway does not pay the `result`. Counting that turn is the
  // DRIVER's job (outside this PR's scope); until then, the count stays exactly as on main.
  it("mensagem enviada no meio do turno autônomo não prende a contagem: um result e volta a zero", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"espera o deploy"}`));
    spawned[0]!.stdout.emit("data", line(running));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    spawned[0]!.stdout.emit("data", line(none));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_delta", text: "Deploy ok, " }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"e o cert?"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    expect(session.activeTurns).toBe(0);
    expect(driverActivity(CARD)).toBe("idle");
  });

  it("o turno que o CLI abre sozinho conta como trabalho: o board vê `turn` e o idle stop não o mata", () => {
    vi.useFakeTimers();
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"espera o deploy"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("close");
    spawned[0]!.stdout.emit("data", line({ type: "tool_use", id: "toolu_w", name: "Bash", input: { command: "npx vitest run" } }));
    expect(driverActivity(CARD)).toBe("turn");
    expect(isCardChatInUse(CARD)).toBe(true);
    vi.advanceTimersByTime(DRIVER_IDLE_MS * 3);
    expect(spawned[0]!.killed).toBe(false);
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    expect(driverActivity(CARD)).toBe("idle");
    vi.advanceTimersByTime(DRIVER_IDLE_MS + 1);
    expect(spawned[0]!.killed).toBe(true);
  });

  it("CLI que cai no meio do turno autônomo não deixa o driver ocupado para sempre", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"espera o deploy"}`));
    spawned[0]!.stdout.emit("data", line(running));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("close");
    spawned[0]!.stdout.emit("data", line(none));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "woke" }));
    spawned[0]!.stdout.emit("data", line({ type: "error", message: "CLI process exited with code 1" }));
    expect(session.activeTurns).toBe(0);
    expect(isCardChatInUse(CARD)).toBe(false);
  });

  it("parar sem turno nenhum não deixa nota de interrupção para o próximo turno", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"espera o deploy"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_delta", text: "acordei" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"e agora?"}`));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("message", Buffer.from(`{"type":"interrupt"}`));
    expect(session.pendingInterruptNote).toBeUndefined();
  });
});

/**
 * /clear (production, 2026-10-08): the CLI clears the context and opens a new session, but the card's screen and log
 * kept the whole conversation — on F5 it came back, and to whoever was watching the /clear "não
 * funcionava". The reset deletes the LOG (the replay) and leaves a note saying the conversation was cleared.
 */
describe("conversation_reset — o /clear limpa a conversa de verdade", () => {
  it("repassa o reset às abas, apaga o log da conversa antiga e grava a nota do /clear", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "conversa antiga" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"/clear"}`));
    spawned[0]!.stdout.emit("data", line({ type: "conversation_reset", trigger: "clear" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    expect(sentTypes(socket)).toContain("conversation_reset");
    const reset = sentTypes(socket).indexOf("conversation_reset");
    expect(sentTypes(socket).slice(reset)).toContain("system_note");

    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.map((e) => [e.type, (e as { text?: string }).text])).toEqual([
        ["user", "/clear"],
        ["system_note", "conversation-cleared"],
      ]);
    }, { timeout: 5000 });
  });

  it("o corte do /clear que o disco recusa é dito no log do servidor, não engolido como compactação", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "conversa antiga" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"/clear"}`));
    await vi.waitFor(async () => expect(await readHistory(CARD)).toHaveLength(2));
    const warn = vi.spyOn(logger, "warn");
    onTestFinished(() => warn.mockRestore());
    disk.failRewrites = true;
    spawned[0]!.stdout.emit("data", line({ type: "conversation_reset", trigger: "clear" }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "no space left on device" }),
      "could not clear the sdk chat history",
    ));
    disk.failRewrites = false;
    expect((await readHistory(CARD)).map((e) => (e as { text?: string }).text)).toContain("conversa antiga");
  });

  it("uma mensagem enviada DEPOIS do /clear (fila do CLI) sobrevive: só sai o que veio antes dele", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"faz a tarefa longa"}`));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "conversa antiga" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"/clear"}`));
    spawned[0]!.stdout.emit("data", line({ type: "turn_absorbed" }));
    socket.emit("message", Buffer.from(`{"type":"user","text":"agora roda os testes"}`));
    spawned[0]!.stdout.emit("data", line({ type: "turn_absorbed" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    spawned[0]!.stdout.emit("data", line({ type: "conversation_reset", trigger: "clear" }));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "testes passaram" }));

    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.map((e) => [e.type, (e as { text?: string }).text])).toEqual([
        ["user", "/clear"],
        ["user", "agora roda os testes"],
        ["system_note", "conversation-cleared"],
        ["assistant_text", "testes passaram"],
      ]);
    }, { timeout: 5000 });
  });

  it("um reset que NÃO veio de /clear (outro fluxo de sessão nova) não apaga a conversa nem escreve a nota", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "plano aprovado" }));
    spawned[0]!.stdout.emit("data", line({ type: "conversation_reset", trigger: "plan_exit" }));
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "implementando" }));
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.map((e) => (e as { text?: string }).text)).toEqual(["plano aprovado", "implementando"]);
    }, { timeout: 5000 });
  });
});

/**
 * THE PLAN LIMIT WARNING (the "You've used 91% of your session limit" in the CLI's footer): session
 * state, like the background tasks — normalised, resent to whoever connects, never recorded.
 */
describe("rate_limit — o aviso de limite do plano", () => {
  const warn = { type: "rate_limit", status: "allowed_warning", window: "five_hour", utilization: 0.91, resetsAt: 1_792_440_000 };
  const parsed = (socket: ReturnType<typeof fakeSocket>) =>
    socket.sent.map((s) => JSON.parse(s) as { type: string }).filter((e) => e.type === "rate_limit");

  it("sai em percentual e epoch em ms, e é reenviado (um por janela) a uma aba que conecta depois", async () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line(warn));
    spawned[0]!.stdout.emit("data", line({ ...warn, utilization: 0.93 }));
    spawned[0]!.stdout.emit("data", line({ type: "rate_limit", status: "allowed", window: "seven_day", utilization: 0.4 }));
    const expected = { type: "rate_limit", status: "allowed_warning", window: "five_hour", utilization: 93, resetsAt: 1_792_440_000_000 };
    expect(parsed(s1)[1]).toEqual(expected);

    const late = fakeSocket();
    attachSocket(session, late as never);
    expect(parsed(late)).toEqual([expected, { type: "rate_limit", status: "allowed", window: "seven_day", utilization: 40 }]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await readHistory(CARD)).some((e) => e.type === "rate_limit")).toBe(false);
  });

  it("descarta um aviso torto em vez de mandá-lo à tela", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "rate_limit", status: "whatever", window: "five_hour" }));
    spawned[0]!.stdout.emit("data", line({ type: "rate_limit", status: "rejected" }));
    expect(parsed(s1)).toEqual([]);
  });
});

/**
 * THE CONTEXT METER: the last reading of how much of the window the session takes — normalised,
 * resent to whoever connects (the reading only comes at the end of a turn), never recorded in the history.
 */
describe("context_usage — o medidor de contexto", () => {
  const parsed = (socket: ReturnType<typeof fakeSocket>) =>
    socket.sent.map((s) => JSON.parse(s) as { type: string }).filter((e) => e.type === "context_usage");

  it("sai com percentual sobre a janela crua, e só a ÚLTIMA leitura é reenviada a quem conecta depois", async () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "context_usage", usedTokens: 20_000, maxTokens: 200_000, model: "claude-opus-5-5" }));
    spawned[0]!.stdout.emit("data", line({ type: "context_usage", usedTokens: 84_000, maxTokens: 200_000, model: "claude-opus-5-5" }));
    const expected = { type: "context_usage", usedTokens: 84_000, maxTokens: 200_000, percent: 42, model: "claude-opus-5-5" };
    expect(parsed(s1)[1]).toEqual(expected);

    const late = fakeSocket();
    attachSocket(session, late as never);
    expect(parsed(late)).toEqual([expected]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await readHistory(CARD)).some((e) => e.type === "context_usage")).toBe(false);
  });

  it("descarta uma leitura sem janela e mantém a anterior", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    spawned[0]!.stdout.emit("data", line({ type: "context_usage", usedTokens: 10_000, maxTokens: 100_000 }));
    spawned[0]!.stdout.emit("data", line({ type: "context_usage", usedTokens: 10 }));
    expect(parsed(s1)).toEqual([{ type: "context_usage", usedTokens: 10_000, maxTokens: 100_000, percent: 10 }]);
  });

  it("card reaberto que retoma a MESMA sessão já mostra a última leitura; outra sessão não herda", () => {
    const first = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.stdout.emit("data", line({ type: "session", sessionId: "s-1" }));
    spawned[0]!.stdout.emit("data", line({ type: "context_usage", usedTokens: 130_000, maxTokens: 200_000 }));
    stopCardDriver(CARD);
    expect(first.closed).toBe(true);

    const resumed = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec", "--resume", "s-1"] } });
    const s1 = fakeSocket();
    attachSocket(resumed, s1 as never);
    expect(parsed(s1)).toEqual([{ type: "context_usage", usedTokens: 130_000, maxTokens: 200_000, percent: 65 }]);
    stopCardDriver(CARD);

    const other = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec", "--resume", "s-2"] } });
    const s2 = fakeSocket();
    attachSocket(other, s2 as never);
    expect(parsed(s2)).toEqual([]);
  });

  it("o /clear apaga a leitura: quem conecta depois não vê o medidor da conversa apagada", () => {
    const session = ensure();
    spawned[0]!.stdout.emit("data", line({ type: "session", sessionId: "s-1" }));
    spawned[0]!.stdout.emit("data", line({ type: "context_usage", usedTokens: 130_000, maxTokens: 200_000 }));
    spawned[0]!.stdout.emit("data", line({ type: "conversation_reset", trigger: "clear" }));
    const late = fakeSocket();
    attachSocket(session, late as never);
    expect(parsed(late)).toEqual([]);
    stopCardDriver(CARD);
    const resumed = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec", "--resume", "s-1"] } });
    const s2 = fakeSocket();
    attachSocket(resumed, s2 as never);
    expect(parsed(s2)).toEqual([]);
  });

  it("uma sessão sem leitura não manda medidor nenhum a quem conecta", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    expect(parsed(s1)).toEqual([]);
  });
});

/**
 * THE ORDER WAITS FOR THE IDENTITY OF WHOEVER GAVE IT. When the message is from another person (author switch), the
 * driver only receives it after their token and author have landed in the runner — and what comes after,
 * from that socket, does not jump ahead of it.
 */
describe("attachSocket — beforeTurn segura a mensagem até a identidade aterrissar", () => {
  const writesOf = (text: string) => spawned[0]!.stdin.written.filter((w) => w.includes(text));

  it("sem troca pendente, o frame vai na hora (nada de await por mensagem)", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never, undefined, { beforeTurn: () => undefined });
    s1.emit("message", Buffer.from(`{"type":"user","text":"commita"}`));
    expect(writesOf("commita").length).toBe(1);
  });

  it("com troca pendente, a mensagem espera — e a interrupção que veio depois não a ultrapassa", async () => {
    const session = ensure();
    const s1 = fakeSocket();
    let landed!: () => void;
    const identity = new Promise<void>((r) => { landed = r; });
    attachSocket(session, s1 as never, undefined, {
      beforeTurn: (raw) => (raw.includes("corrige") ? identity : undefined),
    });
    s1.emit("message", Buffer.from(`{"type":"user","text":"corrige o review"}`));
    s1.emit("message", Buffer.from(`{"type":"interrupt"}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(writesOf("corrige o review").length).toBe(0);
    expect(writesOf(`"interrupt"`).length).toBe(0);

    landed();
    await new Promise((r) => setTimeout(r, 20));
    const written = spawned[0]!.stdin.written;
    const user = written.findIndex((w) => w.includes("corrige o review"));
    const stop = written.findIndex((w) => w.includes(`"interrupt"`));
    expect(user).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(user);
  });

  it("o funil devolvido entrega os frames guardados no setup pela MESMA fila", async () => {
    const session = ensure();
    const s1 = fakeSocket();
    let landed!: () => void;
    const identity = new Promise<void>((r) => { landed = r; });
    const feed = attachSocket(session, s1 as never, undefined, {
      beforeTurn: (raw) => (raw.includes("primeira") ? identity : undefined),
    });
    feed(`{"type":"user","text":"primeira"}`);
    s1.emit("message", Buffer.from(`{"type":"user","text":"segunda"}`));
    landed();
    await new Promise((r) => setTimeout(r, 20));
    const written = spawned[0]!.stdin.written;
    expect(written.findIndex((w) => w.includes("segunda"))).toBeGreaterThan(written.findIndex((w) => w.includes("primeira")));
    expect(writesOf("primeira").length).toBe(1);
  });
});

/**
 * THE RESUME THAT DID NOT TAKE (production, 2026-10-20, card 4f4b, 18:18 and 19:02): the boot resumed the turn,
 * but the freshly started CLI first opened a turn of ITS OWN — the notification that the subagent died
 * with the previous process — and closed it with an empty `result` ("No response requested."). The
 * continuation never became a turn; the manager counted that `result` as the end of the resume, deleted the
 * marker and the card sat stopped for 16 min, with "Retomando a sessão…" as the last line, until the person
 * wrote. Reproduced on the real CLI (SDK 0.3.300): the boot's `result ""` arrives before the turn.
 */
describe("retomada automática — confirmação de que pegou", () => {
  const CONT = "Continue de onde parou";
  const SYS = { kind: "system", name: "vibehub" } as const;
  const emit = (event: object) => spawned[0]!.stdout.emit("data", line(event));
  const userWrites = () => spawned[0]!.stdin.written
    .map((s) => JSON.parse(s) as { type: string; text?: string })
    .filter((f) => f.type === "user");

  it("o result do arranque fecha sem a IA produzir nada: a ordem é reenviada depois da janela", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    emit({ type: "assistant_text", text: "No response requested." }); // the harness filler
    emit({ type: "result", isError: false });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS - 1);
    expect(userWrites()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(userWrites()).toEqual([{ type: "user", text: CONT }, { type: "user", text: RESUME_REENGAGE_TEXT }]);
    expect(session.activeTurns).toBe(1);
  });

  it("enquanto a retomada não pegou, o marcador fica — com as MESMAS attempts (o próximo deploy ainda sabe)", async () => {
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 2);
    emit({ type: "result", isError: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(await readInflightMarker(CARD)).toMatchObject({ attempts: 2 });
    expect((await readInflightMarker(CARD))?.progressed).toBeUndefined();
  });

  it("o turno de verdade chega logo depois do result vazio: nada é reenviado e attempts não zera", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 2);
    emit({ type: "result", isError: false });
    emit({ type: "tool_use", id: "t1", name: "Bash", input: {} });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS * 3);
    expect(userWrites()).toHaveLength(1);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await readInflightMarker(CARD)).toMatchObject({ attempts: 2, progressed: true }));
  });

  it("sinal de vida sem texto ainda (raciocínio em curso) adia o reenvio", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    emit({ type: "result", isError: false });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS - 100);
    emit({ type: "thinking_delta", text: "hmm" });
    vi.advanceTimersByTime(200);
    expect(userWrites()).toHaveLength(1);
  });

  it("a pessoa escreveu na janela: a mensagem dela manda, nada de continuação extra", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    emit({ type: "result", isError: false });
    dispatchClientFrame(session, `{"type":"user","text":"e aí?"}`);
    vi.advanceTimersByTime(RESUME_CONFIRM_MS * 3);
    expect(userWrites().map((f) => f.text)).toEqual([CONT, "e aí?"]);
  });

  it("o reenvio também não pegou: uma linha no chat diz, e o marcador sai", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    for (let i = 0; i < 3; i++) {
      emit({ type: "result", isError: false });
      vi.advanceTimersByTime(RESUME_CONFIRM_MS + 1);
    }
    expect(userWrites()).toHaveLength(2);
    expect(session.activeTurns).toBe(0);
    vi.useRealTimers();
    await vi.waitFor(async () => {
      const notes = (await readHistory(CARD)).filter((e) => e.type === "system_note");
      expect(notes.map((n) => (n as { text: string }).text)).toEqual([NOTE_RESUME_STALLED]);
      expect(await readInflightMarker(CARD)).toBeNull();
    });
  });

  it("o driver morreu na janela: nada é escrito num pipe morto", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    emit({ type: "result", isError: false });
    stopCardDriver(CARD);
    vi.advanceTimersByTime(RESUME_CONFIRM_MS * 3);
    expect(userWrites()).toHaveLength(1);
    expect(session.closed).toBe(true);
  });

  it("a pessoa clicou Parar na retomada: o painel não manda a ordem de novo por cima", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    dispatchClientFrame(session, `{"type":"interrupt"}`);
    emit({ type: "result", isError: false });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS * 3);
    expect(userWrites()).toHaveLength(1);
    expect(driverActivity(CARD)).toBe("idle");
  });

  it("um turno que termina sem result (erro do stream) não deixa o vigia preso: ele volta a valer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    emit({ type: "result", isError: false });
    emit({ type: "thinking", text: "hmm" }); // the CLI opened a turn on its own
    vi.advanceTimersByTime(RESUME_CONFIRM_MS + 1);
    emit({ type: "error", message: "stream caiu" }); // …which died without a result
    vi.advanceTimersByTime(RESUME_CONFIRM_MS + 1);
    expect(userWrites().map((f) => f.text)).toEqual([CONT, RESUME_REENGAGE_TEXT]);
  });

  it("o que um SUBAGENTE faz não prova que a retomada pegou", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    emit({ type: "tool_use", id: "s1", name: "Bash", input: {}, parentToolUseId: "toolu_x" });
    emit({ type: "result", isError: false });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS + 1);
    expect(userWrites().map((f) => f.text)).toEqual([CONT, RESUME_REENGAGE_TEXT]);
  });

  it("outro card falou com este na janela: a conversa seguiu, nada de reenvio", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    emit({ type: "result", isError: false });
    sendAgentTurn(session, "do outro card", { kind: "agent", name: "maestro" } as never);
    emit({ type: "result", isError: false });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS * 3);
    expect(userWrites().map((f) => f.text)).toEqual([CONT, "do outro card"]);
  });

  it("na janela o chat conta como em uso: nem hibernar nem desligar por ociosidade derrubam a retomada", () => {
    const session = ensure();
    injectSystemTurn(session, CONT, SYS, 1);
    emit({ type: "result", isError: false });
    expect(isCardChatInUse(CARD)).toBe(true);
    expect(driverActivity(CARD)).toBe("turn");
  });

  it("turno de pessoa que fecha sem texto não é vigiado (o watchdog é só da retomada)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"/compact"}`);
    emit({ type: "result", isError: false });
    vi.advanceTimersByTime(RESUME_CONFIRM_MS * 3);
    expect(userWrites()).toHaveLength(1);
  });
});

/**
 * THE DRIVER DROPPED ON ITS OWN (OOM, kill, a docker exec that died) with the back up: the marker stayed on
 * disk signed by a LIVE process — the boot sweep did not see it as an orphan — and the turn only
 * "came back" on the next deploy, hours later and out of context. A drop with work in flight now
 * warns whoever handles the resume (resume.ts), right away.
 */
describe("queda do driver com trabalho em voo", () => {
  const emit = (event: object) => spawned[0]!.stdout.emit("data", line(event));

  it("queda não pedida com turno em voo: avisa com o card e o marcador", () => {
    const seen: Array<{ cardId: string; attempts: number }> = [];
    const off = onDriverCrashWithWork((cardId, marker) => seen.push({ cardId, attempts: marker.attempts }));
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"tarefa longa"}`);
    spawned[0]!.emit("close", 137);
    off();
    expect(seen).toEqual([{ cardId: CARD, attempts: 0 }]);
  });

  it("parada pedida (pausa, troca de modelo, ocioso) não é queda", () => {
    const seen: string[] = [];
    const off = onDriverCrashWithWork((cardId) => seen.push(cardId));
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"tarefa longa"}`);
    stopCardDriver(CARD);
    spawned[0]!.emit("close", null);
    off();
    expect(seen).toEqual([]);
  });

  it("o desligamento do back (SIGTERM) não é queda: quem retoma é o boot do próximo", () => {
    const seen: string[] = [];
    const off = onDriverCrashWithWork((cardId) => seen.push(cardId));
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"tarefa longa"}`);
    shutdownAllDrivers();
    spawned[0]!.emit("close", null);
    off();
    expect(seen).toEqual([]);
  });

  it("queda sem nada em voo: nada a retomar", () => {
    const seen: string[] = [];
    const off = onDriverCrashWithWork((cardId) => seen.push(cardId));
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"oi"}`);
    emit({ type: "result", isError: false });
    spawned[0]!.emit("close", 1);
    off();
    expect(seen).toEqual([]);
  });
});

/**
 * The /btw: a SIDE question, asked with the turn running, that the main agent never reads. It arrives
 * in a frame of its own, goes to the driver as a control of its own, does not count as a turn and only the answer (which
 * carries the question) stays in the card's log.
 */
describe("/btw — pergunta lateral", () => {
  function driverControls(): Array<Record<string, unknown>> {
    return spawned[0]!.stdin.written.map((w) => JSON.parse(w) as Record<string, unknown>);
  }
  const btwFrame = JSON.stringify({ type: "btw", id: "b1", question: "o que falta?" });

  it("vai ao driver como controle btw, sem virar turno nem marcador de turno em voo", async () => {
    const session = ensure();
    dispatchClientFrame(session, btwFrame);
    expect(driverControls()).toEqual([{ type: "btw", id: "b1", question: "o que falta?" }]);
    expect(driverTurnRunning(CARD)).toBe(false);
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("com um turno rodando, não mexe na contagem dele", () => {
    const session = ensure();
    dispatchClientFrame(session, JSON.stringify({ type: "user", text: "roda os testes" }));
    expect(driverTurnRunning(CARD)).toBe(true);
    dispatchClientFrame(session, btwFrame);
    spawned[0]!.stdout.emit("data", line({ type: "result", subtype: "success" }));
    expect(driverTurnRunning(CARD)).toBe(false);
  });

  it("a resposta vai a todas as abas e fica no log do card (o F5 a redesenha)", async () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    dispatchClientFrame(session, btwFrame);
    spawned[0]!.stdout.emit("data", line({ type: "btw_answer", id: "b1", question: "o que falta?", text: "falta o PR" }));
    expect(sentTypes(socket)).toContain("btw_answer");
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.some((e) => e.type === "btw_answer" && (e as { text?: string }).text === "falta o PR")).toBe(true);
    });
  });

  it("driver morto: quem perguntou recebe a falha na hora, em vez de esperar para sempre", () => {
    const session = ensure();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    spawned[0]!.exitCode = 1;
    dispatchClientFrame(session, btwFrame, undefined, socket as never);
    const answer = socket.sent.map((s) => JSON.parse(s) as Record<string, unknown>).find((e) => e.type === "btw_answer");
    expect(answer).toMatchObject({ id: "b1", question: "o que falta?", error: expect.any(String) });
    expect(String(answer!.error)).not.toBe("driver-gone"); // a sentence for the person, not internal code
    expect(driverControls()).toEqual([]);
  });
});

/**
 * THE COMPACTION IN PROGRESS is session state: whoever opens the card in the middle of it sees the bar running
 * since it started; the outcome goes to the log (the F5 redraws the divider).
 */
describe("compaction — a barra do /compact", () => {
  const parsed = (socket: ReturnType<typeof fakeSocket>) =>
    socket.sent.map((s) => JSON.parse(s) as { type: string; phase?: string; startedAt?: number }).filter((e) => e.type === "compaction");

  it("o início sai com a hora em que começou, e quem conecta no meio recebe a barra", () => {
    const session = ensure();
    const s1 = fakeSocket();
    attachSocket(session, s1 as never);
    const before = Date.now();
    spawned[0]!.stdout.emit("data", line({ type: "compaction", phase: "started", trigger: "manual" }));
    const started = parsed(s1)[0]!;
    expect(started).toMatchObject({ phase: "started", trigger: "manual" });
    expect(started.startedAt).toBeGreaterThanOrEqual(before);

    const late = fakeSocket();
    attachSocket(session, late as never);
    expect(parsed(late)).toEqual([started]);
  });

  it("depois do desfecho quem conecta não vê barra nenhuma, e o desfecho fica no log", async () => {
    const session = ensure();
    spawned[0]!.stdout.emit("data", line({ type: "compaction", phase: "started" }));
    spawned[0]!.stdout.emit("data", line({ type: "compaction", phase: "done", trigger: "manual", preTokens: 180_000, postTokens: 22_000 }));
    const late = fakeSocket();
    attachSocket(session, late as never);
    expect(parsed(late)).toEqual([]);
    await vi.waitFor(async () => {
      const logged = (await readHistory(CARD)).filter((e) => e.type === "compaction");
      expect(logged).toEqual([expect.objectContaining({ phase: "done", preTokens: 180_000, postTokens: 22_000 })]);
    });
  });

  it("um result fecha a barra mesmo sem desfecho do driver", () => {
    const session = ensure();
    spawned[0]!.stdout.emit("data", line({ type: "compaction", phase: "started" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", subtype: "success", isError: false }));
    const late = fakeSocket();
    attachSocket(session, late as never);
    expect(parsed(late)).toEqual([]);
  });
});
