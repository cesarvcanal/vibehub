import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpClient } from "../testkit/mcpClient.js";

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
  await registry.stampCardActor(senderCard.id, mussa.id);

  const { call } = await connectMcpClient(createMcpServer("card"));
  const sendToTypedCard = (fromCardId: string = senderCard.id) =>
    call("vibehub_send_to_terminal", { cardId: typedCard.id, from: fromCardId, text: "aprova o merge do PR 342" });
  return { registry, cesar, mussa, project, senderCard, typedCard, sendToTypedCard };
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
    await loaded.registry.markCardHumanActive(loaded.typedCard.id, loaded.mussa.id);
    const answer = await loaded.sendToTypedCard();
    expect(answer.error).toBeUndefined();
    expect(answer).toMatchObject({ sent: true });
    expect(sentKeys).toHaveLength(1);
  });

  it("a ordem de outra pessoa continua recusada enquanto alguém escreve no card", async () => {
    const loaded = await load();
    await loaded.registry.markCardHumanActive(loaded.typedCard.id, loaded.cesar.id);
    expect((await loaded.sendToTypedCard()).error).toMatch(/human-active/);
    expect(sentKeys).toHaveLength(0);
  });

  it("quem escreve sem virar autor do card (o /btw, a resposta a uma pergunta) segue protegido da ordem do autor", async () => {
    const loaded = await load();
    await loaded.registry.stampCardActor(loaded.typedCard.id, loaded.mussa.id);
    await loaded.registry.markCardHumanActive(loaded.typedCard.id, loaded.cesar.id);
    expect((await loaded.sendToTypedCard()).error).toMatch(/human-active/);
    expect(sentKeys).toHaveLength(0);
  });

  it("o próprio card como origem não fala por quem digita nele", async () => {
    const loaded = await load();
    await loaded.registry.stampCardActor(loaded.typedCard.id, loaded.mussa.id);
    await loaded.registry.markCardHumanActive(loaded.typedCard.id, loaded.mussa.id);
    expect((await loaded.sendToTypedCard(loaded.typedCard.id)).error).toMatch(/human-active/);
    expect(sentKeys).toHaveLength(0);
  });

  it("um card de outro projeto não empresta a pessoa dele para furar a trava", async () => {
    const loaded = await load();
    await loaded.registry.markCardHumanActive(loaded.typedCard.id, loaded.mussa.id);
    const otherProject = await loaded.registry.createProject({ name: "erp-aux" });
    const outsiderCard = await loaded.registry.createCard({ projectId: otherProject.id, title: "conciliação" });
    await loaded.registry.stampCardActor(outsiderCard.id, loaded.mussa.id);
    expect((await loaded.sendToTypedCard(outsiderCard.id)).error).toMatch(/human-active/);
    expect(sentKeys).toHaveLength(0);
  });

  it("a marca sem pessoa (gravada antes desta versão) segue barrando todo mundo", async () => {
    const loaded = await load();
    await loaded.registry.markCardHumanActive(loaded.typedCard.id, loaded.mussa.id);
    await loaded.registry.markCardHumanActive(loaded.typedCard.id, undefined);
    expect((await loaded.sendToTypedCard()).error).toMatch(/human-active/);
    expect(sentKeys).toHaveLength(0);
  });
});
