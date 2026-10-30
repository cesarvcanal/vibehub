import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { onCardStatusSink } from "../board/agentState.js";
import {
  ensureDriverSession,
  handleClientFrame,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
} from "./manager.js";

/**
 * A CONVERSA PAROU NUMA PERGUNTA: no fim de cada turno o manager pede a releitura do log do card,
 * que carimba (ou limpa) `pendingQuestionAt` — o ícone "precisa de você" do board. Só quando a
 * conversa PAROU de fato: um turno que fecha com outro ainda na fila não é o fim.
 */
const { synced } = vi.hoisted(() => ({ synced: [] as string[] }));
vi.mock("./pendingQuestion.js", () => ({
  syncPendingQuestion: (cardId: string) => { synced.push(cardId); return Promise.resolve(); },
}));
vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return {
    ...actual,
    markCardHumanActive: () => Promise.resolve(undefined),
    updateCard: () => Promise.resolve(undefined),
    getCard: () => Promise.resolve({ id: CARD, column: "working", status: "working", pausedAt: null }),
    setCardAwaitingDecision: () => Promise.resolve(),
  };
});
onCardStatusSink(() => Promise.resolve(undefined));

const CARD = "cccc498d-98dd-44b6-97ee-c06a181c3769";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (s: string) => boolean; end: () => void; writable: boolean };
  exitCode: number | null;
  kill: () => void;
  written: string[];
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.writable = true;
  stdin.write = (s: string) => { child.written.push(s); return true; };
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
  synced.length = 0;
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-pending-q-"));
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

describe("sdk manager — o fim do turno relê a pergunta pendente", () => {
  it("o turno que fecha manda reler o log do card", async () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    handleClientFrame(session, `{"type":"user","text":"revisa"}`);
    spawned[0]!.stdout.emit("data", line({ type: "assistant_text", text: "Posso fazer o merge?" }));
    await flush();
    expect(synced).toEqual([]); // turno aberto: ainda não é o fim da fala
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await flush();
    expect(synced).toEqual([CARD]);
  });

  it("um result com outra mensagem ainda na fila não é a conversa parando", async () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    handleClientFrame(session, `{"type":"user","text":"um"}`);
    handleClientFrame(session, `{"type":"user","text":"dois"}`);
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await flush();
    expect(synced).toEqual([]);
    spawned[0]!.stdout.emit("data", line({ type: "result", isError: false }));
    await flush();
    expect(synced).toEqual([CARD]);
  });
});
