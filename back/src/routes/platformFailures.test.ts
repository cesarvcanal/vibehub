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
  const envModule = await import("../config/env.js");
  envModule.config.dataDir = dataDir;
  envModule.config.secretKey = "";
  envModule.config.sessionSecret = "";
  envModule.config.insecureCookies = true;
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

function readSessionCookie(authResponse: { statusCode: number; cookies: { name: string; value: string }[] }): string {
  const sessionCookie = authResponse.cookies.find((cookie) => cookie.name === "vibehub_session");
  if (!sessionCookie) throw new Error(`no vibehub_session cookie in the ${authResponse.statusCode} auth response`);
  return `vibehub_session=${sessionCookie.value}`;
}

interface FailureWorld {
  app: FastifyInstance;
  ownerCookie: string;
  memberCookie: string;
  vibehubProjectId: string;
}

async function bootFailureWorld(): Promise<FailureWorld> {
  const app = await boot();
  const ownerCookie = readSessionCookie(await app.inject({ method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" } }));
  await app.inject({ method: "POST", url: "/api/users", headers: { cookie: ownerCookie }, payload: { username: "alex", password: "supersecret", role: "member" } });
  const memberCookie = readSessionCookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" } }));
  const vibehubProjectId = (await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie }, payload: { name: "vibehub" } })).json().project.id as string;
  const settingsResponse = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: ownerCookie }, payload: { selfProjectId: vibehubProjectId } });
  expect(settingsResponse.statusCode).toBe(200);
  return { app, ownerCookie, memberCookie, vibehubProjectId };
}

async function recordFailure(symptom = "driver gone") {
  const platformFailuresService = await import("../services/platformFailures/platformFailures.js");
  return (await platformFailuresService.recordPlatformFailure({ source: "backend_error", component: "services/sdk/manager", symptom, evidence: `mensagem: ${symptom}` }))!;
}

beforeEach(() => { sendToTerminal.mockClear(); });

describe("rotas de falha da plataforma", () => {
  it("só o dono lista: membro 403 e sem sessão 401", async () => {
    const { app, ...world } = await bootFailureWorld();
    await recordFailure();
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.memberCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures" })).statusCode).toBe(401);
  });

  it("investigar cria um card no projeto do vibehub e manda o brief com o relato", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const investigationResponse = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } });
    expect(investigationResponse.statusCode).toBe(200);
    const { card, failure: investigatingFailure } = investigationResponse.json();
    expect(card.projectId).toBe(world.vibehubProjectId);
    expect(investigatingFailure).toMatchObject({ status: "investigating", investigationCardId: card.id });
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    expect(sendToTerminal).toHaveBeenCalledWith(card.id, expect.stringContaining("driver gone"), expect.objectContaining({ wake: true, viaNativeChat: true }));
  });

  it("dois cliques em investigar ao mesmo tempo criam um card só", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const [firstClickResponse, secondClickResponse] = await Promise.all([1, 2].map(() =>
      app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } })));
    expect(firstClickResponse!.json().card.id).toBe(secondClickResponse!.json().card.id);
    const cards = (await app.inject({ method: "GET", url: `/api/projects/${world.vibehubProjectId}/cards`, headers: { cookie: world.ownerCookie } })).json().cards;
    expect(cards).toHaveLength(1);
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
  });

  it("brief que não chega ao card libera a falha para investigar de novo, e o novo clique entrega", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    sendToTerminal.mockRejectedValueOnce(new Error("runner down"));
    const failedInvestigationResponse = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } });
    expect(failedInvestigationResponse.statusCode).toBe(500);
    const listedFailures = (await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures;
    expect(listedFailures[0]).toMatchObject({ id: failure.id, status: "open" });
    const retriedInvestigationResponse = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } });
    expect(retriedInvestigationResponse.statusCode).toBe(200);
    expect(sendToTerminal).toHaveBeenCalledTimes(2);
    const cards = (await app.inject({ method: "GET", url: `/api/projects/${world.vibehubProjectId}/cards`, headers: { cookie: world.ownerCookie } })).json().cards;
    expect(cards.map((card: { id: string }) => card.id)).toEqual([retriedInvestigationResponse.json().card.id]);
  });

  it("investigar de novo depois de concluída sem correção nasce num card novo, não no card concluído", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const firstInvestigation = (await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } })).json();
    await app.inject({ method: "PATCH", url: `/api/cards/${firstInvestigation.card.id}`, headers: { cookie: world.ownerCookie }, payload: { column: "done" } });
    const platformFailuresService = await import("../services/platformFailures/platformFailures.js");
    await platformFailuresService.settlePlatformFailureInvestigation(firstInvestigation.card.id, { merged: false });
    const secondInvestigationResponse = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } });
    expect(secondInvestigationResponse.statusCode).toBe(200);
    expect(secondInvestigationResponse.json().card.id).not.toBe(firstInvestigation.card.id);
    expect(sendToTerminal).toHaveBeenLastCalledWith(secondInvestigationResponse.json().card.id, expect.any(String), expect.any(Object));
  });

  it("investigar de novo uma falha presa cujo card já foi mergeado fecha a falha pelo PR, sem abrir card novo", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const firstInvestigation = (await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } })).json();
    const boardRegistry = await import("../services/board/registry.js");
    await boardRegistry.recordCardPr(firstInvestigation.card.id, { number: 7, url: "https://github.com/acme/vibehub/pull/7", base: "main", branch: "fix-falha" });
    await boardRegistry.markCardPrMerged(firstInvestigation.card.id, "main", 7, Date.now());
    await app.inject({ method: "PATCH", url: `/api/cards/${firstInvestigation.card.id}`, headers: { cookie: world.ownerCookie }, payload: { column: "done" } });
    const secondInvestigationResponse = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } });
    expect(secondInvestigationResponse.statusCode).toBe(200);
    expect(secondInvestigationResponse.json()).toMatchObject({ failure: { id: failure.id, status: "resolved" }, card: { id: firstInvestigation.card.id } });
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures).toEqual([]);
  });

  it("investigar de novo uma falha presa cujo card foi concluído sem merge abre card novo e a falha segue em investigação nele", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const firstInvestigation = (await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } })).json();
    await app.inject({ method: "PATCH", url: `/api/cards/${firstInvestigation.card.id}`, headers: { cookie: world.ownerCookie }, payload: { column: "done" } });
    const secondInvestigationResponse = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } });
    expect(secondInvestigationResponse.statusCode).toBe(200);
    const secondInvestigationCardId = secondInvestigationResponse.json().card.id;
    expect(secondInvestigationCardId).not.toBe(firstInvestigation.card.id);
    expect(sendToTerminal).toHaveBeenCalledTimes(2);
    const listedFailures = (await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures;
    expect(listedFailures[0]).toMatchObject({ id: failure.id, status: "investigating", investigationCardId: secondInvestigationCardId });
  });

  it("brief que falha ao investigar de novo uma concluída sem correção devolve a falha a esse estado", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const firstInvestigation = (await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } })).json();
    await app.inject({ method: "PATCH", url: `/api/cards/${firstInvestigation.card.id}`, headers: { cookie: world.ownerCookie }, payload: { column: "done" } });
    const platformFailuresService = await import("../services/platformFailures/platformFailures.js");
    await platformFailuresService.settlePlatformFailureInvestigation(firstInvestigation.card.id, { merged: false });
    sendToTerminal.mockRejectedValueOnce(new Error("runner down"));
    const failedInvestigationResponse = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } });
    expect(failedInvestigationResponse.statusCode).toBe(500);
    const listedFailures = (await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures;
    expect(listedFailures[0]).toMatchObject({ id: failure.id, status: "concluded_without_fix" });
  });

  it("projeto do vibehub sumido: investigar responde 400 e a falha continua listada", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    const settingsService = await import("../services/settings/settings.js");
    await settingsService.updateSettings({ selfProjectId: "project-that-no-longer-exists" });
    const investigationResponse = await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/investigate`, headers: { cookie: world.ownerCookie } });
    expect(investigationResponse.statusCode).toBe(400);
    expect(investigationResponse.json().error).toMatch(/Settings/);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures).toHaveLength(1);
  });

  it("falha desconhecida responde 404", async () => {
    const { app, ...world } = await bootFailureWorld();
    const dismissResponse = await app.inject({ method: "POST", url: "/api/platform-failures/nope/dismiss", headers: { cookie: world.ownerCookie } });
    expect(dismissResponse.statusCode).toBe(404);
    expect(dismissResponse.json().error).toBe("platform failure nope not found");
  });

  it("'não é bug' tira a falha da lista", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    expect((await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/dismiss`, headers: { cookie: world.ownerCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures).toEqual([]);
  });

  it("membro não investiga nem dispensa", async () => {
    const { app, ...world } = await bootFailureWorld();
    const failure = await recordFailure();
    for (const action of ["investigate", "dismiss"]) {
      expect((await app.inject({ method: "POST", url: `/api/platform-failures/${failure.id}/${action}`, headers: { cookie: world.memberCookie } })).statusCode).toBe(403);
    }
  });

  it("settings recusa selfProjectId de projeto que não existe", async () => {
    const { app, ...world } = await bootFailureWorld();
    const settingsResponse = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: world.ownerCookie }, payload: { selfProjectId: "ghost" } });
    expect(settingsResponse.statusCode).toBe(400);
    expect(settingsResponse.json().error).toMatch(/selfProjectId/);
  });

  it("erro que a tela mostrou vira falha screen_error, de quem tiver sessão, e sem sessão é 401", async () => {
    const { app, ...world } = await bootFailureWorld();
    const screenError = { message: "Cannot read properties of undefined (reading 'title')", stack: "TypeError: x\n    at CardView (https://vh.example/assets/index-abc.js:1:200)", screen: "/board" };
    const memberResponse = await app.inject({ method: "POST", url: "/api/platform-failures/screen-errors", headers: { cookie: world.memberCookie }, payload: screenError });
    expect(memberResponse.statusCode).toBe(200);
    expect(memberResponse.json()).toEqual({ recorded: true });
    expect((await app.inject({ method: "POST", url: "/api/platform-failures/screen-errors", payload: screenError })).statusCode).toBe(401);
    const failures = (await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures;
    expect(failures).toEqual([expect.objectContaining({
      source: "screen_error", component: "front", symptom: screenError.message,
      evidence: expect.stringContaining("tela: /board"),
    })]);
    expect(failures[0].evidence).toContain("at CardView");
  });

  it.each([
    ["sem mensagem", { screen: "/board" }],
    ["mensagem vazia", { message: "", screen: "/board" }],
    ["sem tela", { message: "x" }],
    ["pilha que não é texto", { message: "x", screen: "/board", stack: 7 }],
    ["mensagem longa demais", { message: "x".repeat(2001), screen: "/board" }],
  ])("erro de tela malformado (%s) responde 400 e não grava nada", async (_case, payload) => {
    const { app, ...world } = await bootFailureWorld();
    const response = await app.inject({ method: "POST", url: "/api/platform-failures/screen-errors", headers: { cookie: world.ownerCookie }, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual(expect.any(String));
    expect((await app.inject({ method: "GET", url: "/api/platform-failures", headers: { cookie: world.ownerCookie } })).json().failures).toEqual([]);
  });
});
