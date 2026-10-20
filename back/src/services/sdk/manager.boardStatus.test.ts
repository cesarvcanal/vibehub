import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import {
  driverTurnRunning,
  ensureDriverSession,
  handleClientFrame,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
} from "./manager.js";

/**
 * A BOLINHA DO CARD segue o driver do chat nativo (produção, 2026-10-20): o card ficava cinza com o
 * chat trabalhando, ou verde com o chat parado, porque a bolinha só ouvia os hooks HTTP do CLI — e
 * um hook perdido não tinha quem corrigisse. Aqui o board é observado, não gravado.
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
    applyCardStatus: (cardId: string, status: string) => {
      applied.push({ cardId, status });
      const card = cards.get(cardId);
      if (card) card.status = status;
      return Promise.resolve(card);
    },
  };
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
    handleClientFrame(session, `{"type":"user","text":"roda os testes"}`);
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
    handleClientFrame(session, `{"type":"user","text":"oi"}`);
    await flush();
    expect(applied).toEqual([]);
  });

  it("driver que morre com turno aberto devolve a bolinha para aguardando", async () => {
    const session = ensure();
    handleClientFrame(session, `{"type":"user","text":"oi"}`);
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

  it("pausa ou restart pendente ficam com os hooks: o waiting deles executa o efeito", async () => {
    cards.get(CARD)!.column = "paused";
    const session = ensure();
    handleClientFrame(session, `{"type":"user","text":"oi"}`);
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await flush();
    expect(applied).toEqual([]);

    cards.get(CARD)!.column = "working";
    cards.get(CARD)!.restartPendingAt = Date.now();
    handleClientFrame(session, `{"type":"user","text":"de novo"}`);
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await flush();
    expect(applied).toEqual([]);
  });
});
