import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * CONTA CLAUDE POR USUÁRIO — o card nasce na conta Claude de quem o criou. Sem isso, todo card de
 * quem não escolhia conta rodava no perfil padrão do runner (o do César): memória, histórico e cota
 * dele misturados com o trabalho dos outros.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let dir = "";
let app: FastifyInstance;
const prepareCard = vi.fn(async () => undefined);

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js");
    return { ...actual, prepareCard };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

async function signUpOwner(): Promise<string> {
  return cookieOf(await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "cesar", password: "supersecret" },
  }));
}

/** Cria a pessoa e devolve { id, cookie } dela. */
async function addUser(owner: string, username: string, role: "owner" | "member"): Promise<{ id: string; cookie: string }> {
  const created = await app.inject({
    method: "POST", url: "/api/users", headers: { cookie: owner }, payload: { username, password: "supersecret", role },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "supersecret" } });
  return { id: created.json().user.id as string, cookie: cookieOf(login) };
}

async function createAccount(owner: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner }, payload: { name } });
  return res.json().account.slug as string;
}

async function makeProject(owner: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "vibehub" } });
  return res.json().project.id as string;
}

async function assignAccount(owner: string, userId: string, claudeAccountSlug: string | null) {
  return await app.inject({
    method: "PATCH", url: `/api/users/${userId}`, headers: { cookie: owner }, payload: { claudeAccountSlug },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-claude-per-user-"));
  prepareCard.mockClear();
  app = await boot();
});
afterEach(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

describe("o owner liga cada pessoa a uma conta Claude", () => {
  it("grava a conta da pessoa e a lista de usuários devolve junto", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const slug = await createAccount(owner, "albert");

    const res = await assignAccount(owner, albert.id, slug);
    expect(res.statusCode).toBe(200);
    expect(res.json().git.claudeAccountSlug).toBe(slug);

    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } });
    expect(list.json().users.find((u: { id: string }) => u.id === albert.id).git.claudeAccountSlug).toBe(slug);
  });

  it("recusa conta que não existe e não grava nada", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const res = await assignAccount(owner, albert.id, "nao-existe");
    expect(res.statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } });
    expect(list.json().users.find((u: { id: string }) => u.id === albert.id).git).toBeUndefined();
  });

  it("null desliga a pessoa da conta (volta ao padrão)", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const slug = await createAccount(owner, "albert");
    await assignAccount(owner, albert.id, slug);
    const res = await assignAccount(owner, albert.id, null);
    expect(res.statusCode).toBe(200);
    expect(res.json().git?.claudeAccountSlug).toBeUndefined();
  });

  it("aceita a conta padrão do runner como a conta da pessoa (o César fica ligado à dele)", async () => {
    const owner = await signUpOwner();
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } });
    const res = await assignAccount(owner, me.json().user.id, "default");
    expect(res.statusCode).toBe(200);
    expect(res.json().git.claudeAccountSlug).toBe("default");
    // /auth/me diz que ele TEM conta: o diálogo de novo card não avisa mais
    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } });
    expect(after.json().user.claudeAccountSlug).toBe("default");
  });

  it("o membro NÃO escolhe a própria conta Claude pela porta de autoatendimento", async () => {
    const owner = await signUpOwner();
    const mussa = await addUser(owner, "mussa", "member");
    // a conta do César existe com nome — o membro tentaria se apontar pra ela
    const cesar = await createAccount(owner, "cesar");
    const res = await app.inject({
      method: "PATCH", url: "/api/me/git", headers: { cookie: mussa.cookie }, payload: { claudeAccountSlug: cesar },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().git?.claudeAccountSlug).toBeUndefined();
    const mine = await app.inject({ method: "GET", url: "/api/me/git", headers: { cookie: mussa.cookie } });
    expect(mine.json().git?.claudeAccountSlug).toBeUndefined();
  });

  it("/auth/me conta à pessoa qual conta Claude é a dela (o front avisa quando não há)", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const before = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: albert.cookie } });
    expect(before.json().user.claudeAccountSlug).toBeUndefined();

    const slug = await createAccount(owner, "albert");
    await assignAccount(owner, albert.id, slug);
    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: albert.cookie } });
    expect(after.json().user.claudeAccountSlug).toBe(slug);
  });

  it("não deixa apagar uma conta Claude que ainda é de alguém", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const slug = await createAccount(owner, "albert");
    await assignAccount(owner, albert.id, slug);

    const res = await app.inject({ method: "DELETE", url: `/api/accounts/${slug}`, headers: { cookie: owner } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/albert/);
    const accounts = await app.inject({ method: "GET", url: "/api/accounts", headers: { cookie: owner } });
    expect(accounts.json().accounts.map((a: { slug: string }) => a.slug)).toContain(slug);
  });
});

describe("o card nasce na conta Claude de quem o criou", () => {
  it("card criado pelo Albert roda na conta do Albert, não na padrão", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const slug = await createAccount(owner, "albert");
    await assignAccount(owner, albert.id, slug);
    const projectId = await makeProject(owner);

    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: albert.cookie }, payload: { projectId, title: "Tarefa do Albert" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.accountSlug).toBe(slug);
  });

  it("a conta da pessoa vence a conta padrão do projeto", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const mine = await createAccount(owner, "albert");
    const projectAccount = await createAccount(owner, "projeto");
    await assignAccount(owner, albert.id, mine);
    const projectId = await makeProject(owner);
    await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: owner },
      payload: { defaultAccountSlug: projectAccount },
    });

    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: albert.cookie }, payload: { projectId, title: "x" },
    });
    expect(res.json().card.accountSlug).toBe(mine);
  });

  it("conta escolhida no próprio card vence a da pessoa", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const mine = await createAccount(owner, "albert");
    const other = await createAccount(owner, "outra");
    await assignAccount(owner, albert.id, mine);
    const projectId = await makeProject(owner);

    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: albert.cookie },
      payload: { projectId, title: "x", accountSlug: other },
    });
    expect(res.json().card.accountSlug).toBe(other);
  });

  it("quem não tem conta própria continua caindo no padrão (comportamento antigo)", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const projectId = await makeProject(owner);

    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: albert.cookie }, payload: { projectId, title: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.accountSlug).toBeUndefined();
  });

  it("pessoa ligada à conta padrão cria card sem conta gravada (roda no perfil embutido)", async () => {
    const owner = await signUpOwner();
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } });
    await assignAccount(owner, me.json().user.id, "default");
    const projectId = await makeProject(owner);

    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: owner }, payload: { projectId, title: "do César" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.accountSlug).toBeUndefined();
  });

  it("o card de um não herda a conta do outro", async () => {
    const owner = await signUpOwner();
    const albert = await addUser(owner, "albert", "owner");
    const slug = await createAccount(owner, "albert");
    await assignAccount(owner, albert.id, slug);
    const projectId = await makeProject(owner);

    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: owner }, payload: { projectId, title: "do César" },
    });
    expect(res.json().card.accountSlug).toBeUndefined();
  });
});
