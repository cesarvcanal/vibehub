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
  stopCardDriver,
} from "./manager.js";

/**
 * O CARD QUE ESPERA UMA DECISÃO. Com um cartão de pergunta (AskUserQuestion) ou um pedido de
 * permissão aberto no chat nativo, o turno segue aberto — e o ícone do card mostrava o spinner de
 * "trabalhando": a pessoa achava que o Claude estava ocupado e não ia decidir. O driver carimba
 * `awaitingDecisionAt` no card enquanto houver pergunta dele pendente, e o front troca o ícone.
 */
const { stamps } = vi.hoisted(() => ({ stamps: [] as Array<number | null> }));
vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return {
    ...actual,
    markCardHumanActive: () => Promise.resolve(undefined),
    updateCard: () => Promise.resolve(undefined),
    getCard: () => Promise.resolve({ id: CARD, column: "working", status: "working", pausedAt: null }),
    setCardAwaitingDecision: (_id: string, at: number | null) => {
      stamps.push(at);
      return Promise.resolve();
    },
  };
});
onCardStatusSink(() => Promise.resolve(undefined));

const CARD = "aaaa498d-98dd-44b6-97ee-c06a181c3769";

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
const QUESTION = { type: "user_question", id: "q1", questions: [{ question: "Qual?", options: [{ label: "A" }, { label: "B" }] }] };

let dir = "";
let savedDataDir = "";
let spawned: FakeChild[] = [];
const emit = (event: object) => spawned[0]!.stdout.emit("data", line(event));
/** Os carimbos que o driver gravou, como "set"/"clear" (o spawn limpa o resto de um driver anterior). */
const writes = () => stamps.map((at) => (at === null ? "clear" : "set"));

beforeEach(async () => {
  stamps.length = 0;
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-awaiting-"));
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

function startTurn() {
  const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
  emit({ type: "ready" });
  handleClientFrame(session, `{"type":"user","text":"decide comigo"}`);
  stamps.length = 0; // só interessa o que vem depois do turno aberto
  return session;
}

describe("sdk manager — o card espera uma decisão", () => {
  it("a pergunta aberta carimba o card; a resposta tira o carimbo", async () => {
    startTurn();
    emit(QUESTION);
    await flush();
    expect(writes()).toEqual(["set"]);
    expect(typeof stamps[0]).toBe("number");
    emit({ type: "question_result", id: "q1", answers: [] });
    await flush();
    expect(writes()).toEqual(["set", "clear"]);
  });

  it("o pedido de permissão também; a decisão tira o carimbo", async () => {
    startTurn();
    emit({ type: "permission_request", id: "p1", tool: "Bash" });
    emit({ type: "permission", id: "p1", tool: "Bash", decision: "allow", sensitive: true });
    await flush();
    expect(writes()).toEqual(["set", "clear"]);
  });

  it("só sai quando TODAS as pendentes encerram, e grava só quando muda", async () => {
    startTurn();
    emit(QUESTION);
    emit({ type: "permission_request", id: "p1", tool: "Bash" });
    emit({ type: "question_result", id: "q1", answers: [] });
    await flush();
    expect(writes()).toEqual(["set"]);
    emit({ type: "permission", id: "p1", tool: "Bash", decision: "deny", sensitive: true, timedOut: true });
    await flush();
    expect(writes()).toEqual(["set", "clear"]);
  });

  it("o fim do turno tira o carimbo, mesmo com o cartão sem resultado", async () => {
    startTurn();
    emit(QUESTION);
    emit({ type: "result", isError: false });
    await flush();
    expect(writes()).toEqual(["set", "clear"]);
  });

  it("parar o driver tira o carimbo", async () => {
    startTurn();
    emit(QUESTION);
    await flush();
    stopCardDriver(CARD);
    await flush();
    expect(writes()).toEqual(["set", "clear"]);
  });

  it("o driver que morre com a pergunta aberta tira o carimbo", async () => {
    startTurn();
    emit(QUESTION);
    await flush();
    spawned[0]!.emit("close", 1);
    await flush();
    expect(writes()).toEqual(["set", "clear"]);
  });
});
