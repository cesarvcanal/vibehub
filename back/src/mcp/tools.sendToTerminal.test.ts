import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const READY_PANE = "╭────╮\n│ > │\n╰────╯\n  ⏵⏵ bypass permissions on · ? for shortcuts";
const sentKeys: string[] = [];
const runScript = vi.fn(async (script: string) => {
  if (script.includes("tmux send-keys")) sentKeys.push(script);
  if (script.includes("list-panes")) return { stdout: "bash\nclaude\n", stderr: "" };
  if (script.includes("capture-pane")) return { stdout: READY_PANE, stderr: "" };
  return { stdout: "", stderr: "" };
});
const state = { dir: "" };

async function load() {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = state.dir;
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../runtime/host.js")>("../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, ptyCommand: vi.fn(), pipeCommand: vi.fn() }) };
  });
  const registry = await import("../services/board/registry.js");
  const settings = await import("../services/settings/settings.js");
  const users = await import("../auth/users.js");
  const { createMcpServer } = await import("./server.js");
  await settings.updateSettings({ sdkDriver: false });

  const cesar = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const mussa = users.publicUser(await users.createUser("mussa", "senha-forte-456", "owner"));
  const project = await registry.createProject({ name: "vibehub" });
  const senderCard = await registry.createCard({ projectId: project.id, title: "Error na hora de mergear" });
  const typedCard = await registry.createCard({ projectId: project.id, title: "Chamada de voz sobrevive ao deploy" });
  await registry.applyOpenTerminal(typedCard.id);

  const server = createMcpServer("card");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "card-test", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const sendToTerminal = async (text: string, fromCardId: string = senderCard.id) => {
    const response = await client.callTool({
      name: "vibehub_send_to_terminal", arguments: { cardId: typedCard.id, from: fromCardId, text },
    });
    const answerText = (response.content as { type: string; text: string }[])[0]!.text;
    return JSON.parse(answerText) as Record<string, unknown>;
  };
  return { registry, cesar, mussa, senderCard, typedCard, sendToTerminal };
}

type Loaded = Awaited<ReturnType<typeof load>>;

async function typedJustNowBy(loaded: Loaded, typistId: string, senderPersonId: string): Promise<void> {
  await loaded.registry.stampCardActor(loaded.typedCard.id, typistId);
  await loaded.registry.markCardHumanActive(loaded.typedCard.id, Date.now());
  await loaded.registry.stampCardActor(loaded.senderCard.id, senderPersonId);
}

beforeAll(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "vibehub-send-terminal-warmup-"));
  await load();
  await rm(state.dir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "vibehub-send-terminal-"));
  sentKeys.length = 0;
  runScript.mockClear();
});
afterEach(async () => { await rm(state.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

describe("vibehub_send_to_terminal — a trava human-active protege quem digita de OUTRA pessoa", () => {
  it("a ordem da mesma pessoa que acabou de escrever no card passa pela trava", async () => {
    const loaded = await load();
    await typedJustNowBy(loaded, loaded.mussa.id, loaded.mussa.id);
    const answer = await loaded.sendToTerminal("aprova o merge do PR 342");
    expect(answer.error).toBeUndefined();
    expect(answer).toMatchObject({ sent: true });
    expect(sentKeys).toHaveLength(1);
  });

  it("a ordem de outra pessoa continua recusada enquanto alguém escreve no card", async () => {
    const loaded = await load();
    await typedJustNowBy(loaded, loaded.mussa.id, loaded.cesar.id);
    const answer = await loaded.sendToTerminal("aprova o merge do PR 342");
    expect(answer.error).toMatch(/human-active/);
    expect(sentKeys).toHaveLength(0);
  });

  it("um card de outro projeto não empresta a pessoa dele para furar a trava", async () => {
    const loaded = await load();
    await typedJustNowBy(loaded, loaded.mussa.id, loaded.mussa.id);
    const otherProject = await loaded.registry.createProject({ name: "erp-aux" });
    const outsiderCard = await loaded.registry.createCard({ projectId: otherProject.id, title: "conciliação" });
    await loaded.registry.stampCardActor(outsiderCard.id, loaded.mussa.id);
    const answer = await loaded.sendToTerminal("aprova o merge do PR 342", outsiderCard.id);
    expect(answer.error).toMatch(/human-active/);
    expect(sentKeys).toHaveLength(0);
  });
});
