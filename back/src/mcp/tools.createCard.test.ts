import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
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
  const users = await import("../auth/users.js");
  const { createMcpServer } = await import("./server.js");

  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  const infraProject = await registry.createProject({ name: "tech.multi" });
  const vibehubProject = await registry.createProject({ name: "vibehub" });
  const callerCard = await registry.createCard({ projectId: infraProject.id, title: "faxina de volumes" });

  const server = createMcpServer("test");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "card-test", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    return JSON.parse(text) as Record<string, unknown>;
  };
  return { registry, owner, member, infraProject, vibehubProject, callerCard, client, call };
}

beforeAll(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "vibehub-create-card-warmup-"));
  await load();
  await rm(state.dir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "vibehub-create-card-"));
  runScript.mockReset();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(async () => { await rm(state.dir, { recursive: true, force: true }); });

describe("maestro MCP — um card cria card em qualquer projeto", () => {
  it("o terminal de um card enxerga vibehub_create_card e vibehub_list_projects", async () => {
    const env = await load();
    const names = (await env.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["vibehub_create_card", "vibehub_list_projects"]));
  });

  it("vibehub_list_projects devolve o id de um projeto que ainda não tem card", async () => {
    const env = await load();
    const out = await env.call("vibehub_list_projects");
    expect(out.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: env.vibehubProject.id, name: "vibehub" }),
    ]));
  });

  it("card cujo dono deu a ordem cria o card no outro projeto, no backlog, já com o dono como autor e o workspace sendo preparado", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const out = await env.call("vibehub_create_card", {
      from: env.callerCard.id, projectId: env.vibehubProject.id, title: "fix: faxina de volumes de teste",
    });
    expect(out.error).toBeUndefined();
    const created = await env.registry.getCard(String(out.cardId));
    expect(created).toMatchObject({
      projectId: env.vibehubProject.id, title: "fix: faxina de volumes de teste", column: "backlog",
      actorUserId: env.owner.id, participantUserIds: [env.owner.id],
    });
    await vi.waitFor(async () => expect((await env.registry.getCard(String(out.cardId)))?.preparedAt).toBeDefined());
  });

  it("card cuja última ordem veio de um membro não cria card, como no board", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.member.id);
    const out = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(out.error).toContain("only the owner");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
  });

  it("card sem ninguém que tenha dado ordem não cria card", async () => {
    const env = await load();
    const out = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(out.error).toContain("nobody gave");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
  });

  it("from que não é card nenhum é recusado", async () => {
    const env = await load();
    const out = await env.call("vibehub_create_card", { from: "nao-existe", projectId: env.vibehubProject.id, title: "x" });
    expect(out.error).toContain("card not found");
  });

  it("projeto inexistente é recusado sem criar nada", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const out = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: "nao-existe", title: "x" });
    expect(out.error).toContain("project not found");
  });
});
