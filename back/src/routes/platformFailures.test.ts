import { describe, it, expect, beforeEach, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

vi.setConfig({ testTimeout: 90_000 });

const sendToTerminal = vi.fn(async () => undefined);

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-platform-failures-route-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  const env = await import("../config/env.js");
  env.config.dataDir = dataDir;
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
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>(
      "../services/board/workspace.js",
    );
    return {
      ...actual,
      prepareCard: vi.fn(async () => undefined),
      openCard: vi.fn(async () => undefined),
      applySessionChange: vi.fn(async () => null),
      killCardSession: vi.fn(async () => undefined),
    };
  });
  vi.doMock("../services/maestro/maestro.js", async () => {
    const actual = await vi.importActual<typeof import("../services/maestro/maestro.js")>("../services/maestro/maestro.js");
    return { ...actual, sendToTerminal };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  onTestFinished(() => server.close());
  await server.ready();
  return server;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((cookie) => cookie.name === "vibehub_session")?.value ?? ""}`;
}

interface FailureWorld {
  app: FastifyInstance;
  owner: string;
  member: string;
  vibehubProjectId: string;
}

async function bootFailureWorld(): Promise<FailureWorld> {
  const app = await boot();
  const owner = cookieOf(await app.inject({ method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" } }));
  await app.inject({ method: "POST", url: "/api/users", headers: { cookie: owner }, payload: { username: "alex", password: "supersecret", role: "member" } });
  const member = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" } }));
  const vibehubProjectId = (await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "vibehub" } })).json().project.id as string;
  const saved = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: owner }, payload: { selfProjectId: vibehubProjectId } });
  expect(saved.statusCode).toBe(200);
  return { app, owner, member, vibehubProjectId };
}

async function recordFailure(symptom = "driver gone") {
  const failures = await import("../services/platformFailures/platformFailures.js");
  return (await failures.recordPlatformFailure({ source: "backend_error", component: "services/sdk/manager", symptom, evidence: `mensagem: ${symptom}` }))!;
}

beforeEach(() => { sendToTerminal.mockClear(); });

describe("rotas de falha da plataforma", () => {
  it("só o dono lista: membro 403 e sem sessão 401", async () => {
    const { app, ...world } = await bootFailureWorld();
    await recordFailure();
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.owner } })).json().failures).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.member } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures" })).statusCode).toBe(401);
  });

  it("investigar cria um card no projeto do vibehub e manda o brief com o relato", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const response = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } });
    expect(response.statusCode).toBe(200);
    const { card, failure: investigatingFailure } = response.json();
    expect(card.projectId).toBe(world.vibehubProjectId);
    expect(investigatingFailure).toMatchObject({ status: "investigating", investigationCardId: card.id });
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    expect(sendToTerminal).toHaveBeenCalledWith(card.id, expect.stringContaining("driver gone"), expect.objectContaining({ wake: true, viaNativeChat: true }));
  });

  it("dois cliques em investigar ao mesmo tempo criam um card só", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const [first, second] = await Promise.all([1, 2].map(() =>
      app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } })));
    expect(first!.json().card.id).toBe(second!.json().card.id);
    const cards = (await app.inject({ method: "GET", url: `/api/projects/${world.vibehubProjectId}/cards`, headers: { cookie: world.owner } })).json().cards;
    expect(cards).toHaveLength(1);
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
  });

  it("brief que não chega ao card libera a falha para investigar de novo, e o novo clique entrega", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    sendToTerminal.mockRejectedValueOnce(new Error("runner down"));
    const failed = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } });
    expect(failed.statusCode).toBe(500);
    const listed = (await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.owner } })).json().failures;
    expect(listed[0]).toMatchObject({ id: failure.id, status: "open" });
    const retried = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } });
    expect(retried.statusCode).toBe(200);
    expect(sendToTerminal).toHaveBeenCalledTimes(2);
    const cards = (await app.inject({ method: "GET", url: `/api/projects/${world.vibehubProjectId}/cards`, headers: { cookie: world.owner } })).json().cards;
    expect(cards.map((card: { id: string }) => card.id)).toEqual([retried.json().card.id]);
  });

  it("investigar de novo depois de concluída sem correção nasce num card novo, não no card concluído", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const first = (await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } })).json();
    await app.inject({ method: "PATCH", url: `/api/cards/${first.card.id}`, headers: { cookie: world.owner }, payload: { column: "done" } });
    const failures = await import("../services/platformFailures/platformFailures.js");
    await failures.settlePlatformFailureInvestigation(first.card.id, { merged: false });
    const again = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } });
    expect(again.statusCode).toBe(200);
    expect(again.json().card.id).not.toBe(first.card.id);
    expect(sendToTerminal).toHaveBeenLastCalledWith(again.json().card.id, expect.any(String), expect.any(Object));
  });

  it("investigar de novo uma falha presa cujo card já foi mergeado fecha a falha pelo PR, sem abrir card novo", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const first = (await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } })).json();
    const registry = await import("../services/board/registry.js");
    await registry.recordCardPr(first.card.id, { number: 7, url: "https://github.com/acme/vibehub/pull/7", base: "main", branch: "fix-falha" });
    await registry.markCardPrMerged(first.card.id, "main", 7, Date.now());
    await app.inject({ method: "PATCH", url: `/api/cards/${first.card.id}`, headers: { cookie: world.owner }, payload: { column: "done" } });
    const again = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ failure: { id: failure.id, status: "resolved" }, card: { id: first.card.id } });
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.owner } })).json().failures).toEqual([]);
  });

  it("brief que falha ao investigar de novo uma concluída sem correção devolve a falha a esse estado", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const first = (await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } })).json();
    await app.inject({ method: "PATCH", url: `/api/cards/${first.card.id}`, headers: { cookie: world.owner }, payload: { column: "done" } });
    const failures = await import("../services/platformFailures/platformFailures.js");
    await failures.settlePlatformFailureInvestigation(first.card.id, { merged: false });
    sendToTerminal.mockRejectedValueOnce(new Error("runner down"));
    const failed = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } });
    expect(failed.statusCode).toBe(500);
    const listed = (await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.owner } })).json().failures;
    expect(listed[0]).toMatchObject({ id: failure.id, status: "concluded_without_fix" });
  });

  it("projeto do vibehub sumido: investigar responde 400 e a falha continua listada", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const settings = await import("../services/settings/settings.js");
    await settings.updateSettings({ selfProjectId: "project-that-no-longer-exists" });
    const response = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.owner } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Settings/);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.owner } })).json().failures).toHaveLength(1);
  });

  it("falha desconhecida responde 404", async () => {
    const { app, ...world } = await bootFailureWorld();
    const response = await app.inject({ method: "POST", url: "/api/platform-failures/nope/dismiss", headers: { cookie: world.owner } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("platform failure nope not found");
  });

  it("'não é bug' tira a falha da lista", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    expect((await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/dismiss`, headers: { cookie: world.owner } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.owner } })).json().failures).toEqual([]);
  });

  it("membro não investiga nem dispensa", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    for (const action of ["investigate", "dismiss"]) {
      expect((await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/${action}`, headers: { cookie: world.member } })).statusCode).toBe(403);
    }
  });

  it("settings recusa selfProjectId de projeto que não existe", async () => {
    const { app, ...world } = await bootFailureWorld();
    const response = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: world.owner }, payload: { selfProjectId: "ghost" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/selfProjectId/);
  });
});
