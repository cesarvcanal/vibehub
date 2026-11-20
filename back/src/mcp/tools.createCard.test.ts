import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpClient } from "../testkit/mcpClient.js";

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
const canPushToRepo = vi.fn(async (_connectionId: string, _fullName: string) => true);
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
  vi.doMock("../services/github/client.js", async () => {
    const actual = await vi.importActual<typeof import("../services/github/client.js")>("../services/github/client.js");
    return { ...actual, canPushToRepo, gitAuthHeaderFor: vi.fn(async () => "") };
  });
  const registry = await import("../services/board/registry.js");
  const users = await import("../auth/users.js");
  const userGit = await import("../auth/userGit.js");
  const { createMcpServer } = await import("./server.js");

  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  const infraProject = await registry.createProject({ name: "tech.multi" });
  const vibehubProject = await registry.createProject({ name: "vibehub", repoFullName: "cesarvcanal/vibehub" });
  const githubAccount = await registry.addGithubConnection({ label: "cesar", login: "cesar-gh" });
  const callerCard = await registry.createCard({ projectId: infraProject.id, title: "faxina de volumes" });

  const { client, call } = await connectMcpClient(createMcpServer("test"));
  return { registry, userGit, githubAccount, owner, member, infraProject, vibehubProject, callerCard, client, call };
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
  canPushToRepo.mockReset();
  canPushToRepo.mockResolvedValue(true);
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
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const answer = await env.call("vibehub_list_projects", { from: env.callerCard.id });
    expect(answer.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: env.vibehubProject.id, name: "vibehub" }),
    ]));
  });

  it("card cujo dono deu a ordem cria o card no outro projeto, no backlog, já com o dono como autor e o workspace sendo preparado", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const answer = await env.call("vibehub_create_card", {
      from: env.callerCard.id, projectId: env.vibehubProject.id, title: "fix: faxina de volumes de teste",
    });
    expect(answer.error).toBeUndefined();
    const created = await env.registry.getCard(String(answer.cardId));
    expect(created).toMatchObject({
      projectId: env.vibehubProject.id, title: "fix: faxina de volumes de teste", column: "backlog",
      actorUserId: env.owner.id, participantUserIds: [env.owner.id],
    });
    await vi.waitFor(async () => expect((await env.registry.getCard(String(answer.cardId)))?.preparedAt).toBeDefined());
  });

  it("o card criado nasce na conta Claude de quem deu a ordem", async () => {
    const env = await load();
    const account = await env.registry.createAccount({ name: "cesar" });
    await env.userGit.setUserGit(env.owner.id, { claudeAccountSlug: account.slug });
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "fix" });
    expect((await env.registry.getCard(String(answer.cardId)))?.accountSlug).toBe(account.slug);
    await vi.waitFor(async () => expect((await env.registry.getCard(String(answer.cardId)))?.preparedAt).toBeDefined());
  });

  it("card cuja última ordem veio de um membro não cria card, como no board", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.member.id);
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(answer.error).toContain("only the owner");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
  });

  it("card sem ninguém que tenha dado ordem não cria card", async () => {
    const env = await load();
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(answer.error).toContain("nobody gave");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
  });

  it("card cujo autor foi removido do vibehub diz isso, sem criar card", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, "usuario-removido");
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(answer.error).toContain("no longer a user");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
  });

  it("from que não é card nenhum é recusado", async () => {
    const env = await load();
    const answer = await env.call("vibehub_create_card", { from: "nao-existe", projectId: env.vibehubProject.id, title: "x" });
    expect(answer.error).toContain("card not found");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
  });

  it("projeto inexistente é recusado sem criar nada", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: "nao-existe", title: "x" });
    expect(answer.error).toContain("project not found");
    expect((await env.registry.listAllCards()).map((card) => card.id)).toEqual([env.callerCard.id]);
  });
});

describe("maestro MCP — a permissão de quem pediu é conferida antes de criar", () => {
  it("vibehub_list_projects diz, por projeto, se quem deu a ordem pode criar card e por quê", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    canPushToRepo.mockImplementation(async (_connectionId, fullName) => fullName !== "cesarvcanal/vibehub");
    const answer = await env.call("vibehub_list_projects", { from: env.callerCard.id });
    expect(answer.requestedBy).toBe("cesar");
    expect(answer.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: env.infraProject.id, canCreateCard: true }),
      expect.objectContaining({
        id: env.vibehubProject.id, canCreateCard: false,
        reason: expect.stringContaining("'cesar-gh'") as unknown,
      }),
    ]));
    expect(canPushToRepo).toHaveBeenCalledWith(env.githubAccount.id, "cesarvcanal/vibehub");
  });

  it("membro vê em todos os projetos que não pode criar, sem consulta ao GitHub", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.member.id);
    const answer = await env.call("vibehub_list_projects", { from: env.callerCard.id });
    expect(answer.requestedBy).toBe("mussa");
    const projects = answer.projects as { canCreateCard: boolean; reason: string }[];
    expect(projects.every((project) => !project.canCreateCard && project.reason.includes("only the owner"))).toBe(true);
    expect(canPushToRepo).not.toHaveBeenCalled();
  });

  it("dono cujo token GitHub não dá push no repo de destino não cria card, e nada é provisionado", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    canPushToRepo.mockResolvedValue(false);
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(answer.error).toContain("cannot push to cesarvcanal/vibehub");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("confere o token da conta GitHub da pessoa, não o primeiro do vibehub", async () => {
    const env = await load();
    const personal = await env.registry.addGithubConnection({ label: "pessoal", login: "cesar-pessoal" });
    await env.userGit.setUserGit(env.owner.id, { githubConnectionId: personal.id });
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(canPushToRepo).toHaveBeenCalledWith(personal.id, "cesarvcanal/vibehub");
    await vi.waitFor(async () => expect((await env.registry.getCard(String(answer.cardId)))?.preparedAt).toBeDefined());
  });

  it("falha do GitHub na conferência aparece como erro e não cria card", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    canPushToRepo.mockRejectedValue(new Error("GitHub returned 502 while checking access to cesarvcanal/vibehub"));
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(answer.error).toContain("502");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
  });

  it("projeto com repositório e nenhuma conta GitHub conectada não cria card, e diz isso", async () => {
    const env = await load();
    await env.registry.removeGithubConnection(env.githubAccount.id);
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.vibehubProject.id, title: "x" });
    expect(answer.error).toContain("no GitHub account is connected");
    expect(await env.registry.listCards(env.vibehubProject.id)).toEqual([]);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("falha do GitHub num repo marca só aquele projeto, com o motivo, e lista os outros", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    canPushToRepo.mockRejectedValue(new Error("GitHub returned 502 while checking access to cesarvcanal/vibehub"));
    const answer = await env.call("vibehub_list_projects", { from: env.callerCard.id });
    expect(answer.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: env.infraProject.id, canCreateCard: true }),
      expect.objectContaining({ id: env.vibehubProject.id, canCreateCard: false, reason: expect.stringContaining("502") as unknown }),
    ]));
  });

  it("vários projetos no mesmo repositório custam uma consulta ao GitHub só", async () => {
    const env = await load();
    await env.registry.createProject({ name: "vibehub-docs", repoFullName: "cesarvcanal/vibehub" });
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    await env.call("vibehub_list_projects", { from: env.callerCard.id });
    expect(canPushToRepo).toHaveBeenCalledTimes(1);
  });

  it("projeto sem repositório só depende de quem pediu ser dono", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.callerCard.id, env.owner.id);
    const answer = await env.call("vibehub_create_card", { from: env.callerCard.id, projectId: env.infraProject.id, title: "x" });
    expect(answer.error).toBeUndefined();
    expect(canPushToRepo).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await env.registry.getCard(String(answer.cardId)))?.preparedAt).toBeDefined());
  });
});
