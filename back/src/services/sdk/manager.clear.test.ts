import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";

/**
 * /clear e a FROTA DE WORKFLOW: o painel de uma rodada da conversa apagada não pode voltar num F5 —
 * a tela ao vivo já o tirou junto com as linhas. Arquivo à parte porque o módulo de workflow é
 * MOCKADO aqui (a sondagem real precisa de um runner), e o manager.test.ts usa o de verdade.
 */
const { forgetCardWorkflows } = vi.hoisted(() => ({ forgetCardWorkflows: vi.fn() }));
vi.mock("./workflow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workflow.js")>();
  return { ...actual, forgetCardWorkflows };
});

const { attachSocket, ensureDriverSession, resetSdkSessionsForTesting, setDriverSpawnerForTesting } = await import("./manager.js");

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.writable = true;
  stdin.write = () => true;
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => { child.killed = true; };
  return child;
}

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (s: string) => void };
  socket.readyState = 1;
  socket.send = () => {};
  return socket;
}

const line = (event: object) => Buffer.from(JSON.stringify(event) + "\n");

let dir = "";
let savedDataDir = "";
let child: ReturnType<typeof fakeChild>;

beforeEach(async () => {
  forgetCardWorkflows.mockClear();
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-clear-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  setDriverSpawnerForTesting(() => {
    child = fakeChild();
    return child as never;
  });
});

afterEach(async () => {
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

describe("conversation_reset — a frota da conversa apagada", () => {
  it("o /clear esquece o painel de workflow da conversa antiga", () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    attachSocket(session, fakeSocket() as never);
    (child.stdout as EventEmitter).emit("data", line({ type: "ready" }));
    forgetCardWorkflows.mockClear();
    (child.stdout as EventEmitter).emit("data", line({ type: "conversation_reset", trigger: "clear" }));
    expect(forgetCardWorkflows).toHaveBeenCalledWith(CARD);
  });
});
