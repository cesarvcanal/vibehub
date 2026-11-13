import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { onCardStatusSink } from "../board/agentState.js";
import {
  driverTurnRunning,
  ensureDriverSession,
  dispatchClientFrame,
  injectSystemTurn,
  onDriverCrashWithWork,
  RESUME_CONFIRM_MS,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
} from "./manager.js";

/**
 * THE CARD'S DOT follows the native chat's driver (production, 2026-10-20): the card stayed grey with
 * the chat working, or green with the chat stopped, because the dot only listened to the CLI's HTTP
 * hooks — and a lost hook had nobody to correct it. Here the board is observed, not written.
 */
const { applied, cards } = vi.hoisted(() => ({
  applied: [] as Array<{ cardId: string; status: string }>,
  cards: new Map<string, Record<string, unknown>>(),
}));
vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return {
    ...actual,
    markCardHumanActive: () => Promise.resolve(undefined),
    updateCard: () => Promise.resolve(undefined),
    getCard: (id: string) => Promise.resolve(cards.get(id)),
  };
});

/** The hooks path (services/board/status.ts), observed: what the driver reports arrives here. */
onCardStatusSink((cardId, status) => {
  applied.push({ cardId, status });
  const card = cards.get(cardId);
  if (card) card.status = status;
  return Promise.resolve(card);
});

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (s: string) => boolean; end: () => void; writable: boolean };
  exitCode: number | null;
  kill: () => void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.writable = true;
  stdin.write = () => true;
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => {};
  return child;
}

const line = (event: object) => Buffer.from(JSON.stringify(event) + "\n");
const flush = () => new Promise((r) => setTimeout(r, 0));

let dir = "";
let savedDataDir = "";
let spawned: FakeChild[] = [];

beforeEach(async () => {
  applied.length = 0;
  cards.clear();
  cards.set(CARD, { id: CARD, column: "waiting", status: "waiting", pausedAt: null, restartPendingAt: null });
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-board-status-"));
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
  await flush();
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

function ensure() {
  return ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
}

describe("sdk manager — a bolinha do card segue o driver", () => {
  it("grava working quando o turno abre e waiting quando o result fecha", async () => {
    const session = ensure();
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    dispatchClientFrame(session, `{"type":"user","text":"roda os testes"}`);
    await flush();
    expect(applied).toEqual([{ cardId: CARD, status: "working" }]);
    expect(driverTurnRunning(CARD)).toBe(true);

    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await flush();
    expect(applied).toEqual([{ cardId: CARD, status: "working" }, { cardId: CARD, status: "waiting" }]);
    expect(driverTurnRunning(CARD)).toBe(false);
  });

  it("um turno que o próprio CLI abre (retorno agendado, tarefa em segundo plano) também acende", async () => {
    ensure();
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }));
    await flush();
    expect(applied).toEqual([{ cardId: CARD, status: "working" }]);
  });

  it("não regrava o que o card já mostra", async () => {
    cards.get(CARD)!.status = "working";
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"oi"}`);
    await flush();
    expect(applied).toEqual([]);
  });

  it("driver que morre com turno aberto devolve a bolinha para aguardando", async () => {
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"oi"}`);
    await flush();
    spawned[0]!.emit("close", 1);
    await flush();
    expect(applied.map((a) => a.status)).toEqual(["working", "waiting"]);
    expect(driverTurnRunning(CARD)).toBe(false);
  });

  it("driver ocioso que morre não mexe no card", async () => {
    ensure();
    spawned[0]!.emit("close", 0);
    await flush();
    expect(applied).toEqual([]);
  });

  it("pausa pendente: o fim do turno é reportado pelo caminho dos hooks, que executa a pausa", async () => {
    cards.get(CARD)!.column = "paused";
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"oi"}`);
    await flush();
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await flush();
    expect(applied.map((a) => a.status)).toEqual(["working", "waiting"]);
  });

});

/**
 * THE RESUME DOES NOT BLINK "AGUARDANDO". In the real CLI, the boot's empty turn closes with a `result`
 * seconds before the real turn (E2E, 2026-10-20). Counted as the end of a turn, the dot went to
 * `waiting` and back to `working` — and the "turno terminou" notice (services/events) went out in the
 * middle of the resume. While the watcher waits, the card keeps working; only giving up puts it on hold.
 */
describe("sdk manager — a bolinha durante a retomada", () => {
  const emit = (event: object) => spawned[0]!.stdout.emit("data", line(event));

  it("o result vazio do arranque não põe o card em aguardando; o turno de verdade fecha normal", async () => {
    const session = ensure();
    injectSystemTurn(session, "continue", { kind: "system", name: "vibehub" }, 1);
    await flush();
    emit({ type: "result", isError: false });
    await flush();
    expect(applied).toEqual([{ cardId: CARD, status: "working" }]);
    expect(driverTurnRunning(CARD)).toBe(true);
    emit({ type: "tool_use", id: "t", name: "Bash", input: {} });
    emit({ type: "result", isError: false });
    await flush();
    expect(applied).toEqual([{ cardId: CARD, status: "working" }, { cardId: CARD, status: "waiting" }]);
  });

  it("a retomada que não pegou nem com o reenvio: aguardando, uma vez", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = ensure();
      injectSystemTurn(session, "continue", { kind: "system", name: "vibehub" }, 1);
      for (let i = 0; i < 2; i++) {
        emit({ type: "result", isError: false });
        vi.advanceTimersByTime(RESUME_CONFIRM_MS + 1);
      }
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(applied).toEqual([{ cardId: CARD, status: "working" }, { cardId: CARD, status: "waiting" }]);
    expect(driverTurnRunning(CARD)).toBe(false);
  });
});

/**
 * THE DRIVER'S CRASH AND THE DOT. The close forced `waiting` — the transition the events hub
 * (#182) reads as "turno terminou" — and 10 s later the crash resume went back to `working`: the
 * notice had already gone out to whoever was away from the board. With a resumer subscribed, the
 * dot waits for its verdict (resume.ts sets `waiting` when it does not resume).
 */
describe("sdk manager — a bolinha numa queda com trabalho em voo", () => {
  it("com quem retome inscrito: segue trabalhando", async () => {
    const off = onDriverCrashWithWork(() => undefined);
    try {
      const session = ensure();
      dispatchClientFrame(session, `{"type":"user","text":"tarefa longa"}`);
      await flush();
      spawned[0]!.emit("close", 137);
      await flush();
      expect(applied).toEqual([{ cardId: CARD, status: "working" }]);
    } finally {
      off();
    }
  });

  it("sem ninguém para retomar: aguardando, como sempre", async () => {
    const session = ensure();
    dispatchClientFrame(session, `{"type":"user","text":"tarefa longa"}`);
    await flush();
    spawned[0]!.emit("close", 137);
    await flush();
    expect(applied).toEqual([{ cardId: CARD, status: "working" }, { cardId: CARD, status: "waiting" }]);
  });
});
