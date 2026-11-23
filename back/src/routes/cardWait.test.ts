import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockHostExecutor } from "../testkit/fakeHost.js";

vi.setConfig({ testTimeout: 30_000 });

const CLAUDE_ALIVE = { stdout: "bash\nnode\n", stderr: "" };

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "vibehub-wait-routes-"));
  vi.resetModules();
  const env = await import("../config/env.js");
  Object.assign(env.config, { dataDir, secretKey: "", sessionSecret: "", insecureCookies: true });
  env.config.runner.container = "vibehub-runner";
  const runScript = vi.fn<(script: string) => Promise<typeof CLAUDE_ALIVE>>(async () => CLAUDE_ALIVE);
  mockHostExecutor(runScript);
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
  }));
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js");
    return { ...actual, prepareCard: vi.fn(async () => undefined) };
  });
  const { buildServer } = await import("../index.js");
  const app = await buildServer();
  await app.ready();
  onTestFinished(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const registry = await import("../services/board/registry.js");
  const settings = await import("../services/settings/settings.js");
  await settings.updateSettings({ sdkDriver: false });
  return { app, registry, runScript };
}

type Booted = Awaited<ReturnType<typeof boot>>;

function sessionCookie(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((cookie) => cookie.name === "vibehub_session")?.value ?? ""}`;
}

async function createWorld({ app, registry }: Booted) {
  const owner = sessionCookie(await app.inject({ method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" } }));
  const memberId = (await app.inject({
    method: "POST", url: "/api/users", headers: { cookie: owner }, payload: { username: "alex", password: "supersecret", role: "member" },
  })).json().user.id as string;
  const member = sessionCookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" } }));
  const project = await registry.createProject({ name: "vibehub" });
  const target = await registry.createCard({ projectId: project.id, title: "Captura de falhas" });
  const waiting = await registry.createCard({ projectId: project.id, title: "Complemento" });
  await registry.applyOpenTerminal(waiting.id);
  await registry.setCardWait(waiting.id, { cardId: target.id, instruction: "faça o complemento", createdAt: 1, createdBy: memberId });
  const shareWaitingCard = async (level: "work" | "view") => app.inject({
    method: "POST", url: `/api/cards/${waiting.id}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level },
  });
  return { owner, member, target, waiting, shareWaitingCard };
}

describe("DELETE /api/cards/:id/wait", () => {
  it("cancela a espera do card e responde 404 quando não há espera", async () => {
    const booted = await boot();
    const world = await createWorld(booted);
    const cancel = () => booted.app.inject({ method: "DELETE", url: `/api/cards/${world.waiting.id}/wait`, headers: { cookie: world.owner } });
    const first = await cancel();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    expect((await booted.registry.getCard(world.waiting.id))?.waitingFor).toBeUndefined();
    expect((await cancel()).statusCode).toBe(404);
  });

  it.each([
    { access: "sem acesso ao card", level: undefined, status: 404 },
    { access: "que só vê o card", level: "view", status: 403 },
    { access: "que trabalha no card", level: "work", status: 200 },
  ] as const)("membro $access recebe $status", async ({ level, status }) => {
    const booted = await boot();
    const world = await createWorld(booted);
    if (level) await world.shareWaitingCard(level);
    const res = await booted.app.inject({ method: "DELETE", url: `/api/cards/${world.waiting.id}/wait`, headers: { cookie: world.member } });
    expect(res.statusCode).toBe(status);
    expect((await booted.registry.getCard(world.waiting.id))?.waitingFor === undefined).toBe(status === 200);
  });
});

describe("POST /api/cards/:id/wait/fire", () => {
  it("espera que ainda não está pronta responde 409 e não envia nada", async () => {
    const booted = await boot();
    const world = await createWorld(booted);
    const res = await booted.app.inject({ method: "POST", url: `/api/cards/${world.waiting.id}/wait/fire`, headers: { cookie: world.owner } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not ready/);
    expect(booted.runScript.mock.calls.some(([script]) => script.includes("faça o complemento"))).toBe(false);
  });

  it("espera pronta acorda o card agora com a instrução", async () => {
    const booted = await boot();
    const world = await createWorld(booted);
    await booted.registry.removeCard(world.target.id);
    const res = await booted.app.inject({ method: "POST", url: `/api/cards/${world.waiting.id}/wait/fire`, headers: { cookie: world.owner } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fired: true });
    expect(booted.runScript.mock.calls.some(([script]) => script.includes("faça o complemento"))).toBe(true);
  });

  it("membro que só vê o card não acorda a espera", async () => {
    const booted = await boot();
    const world = await createWorld(booted);
    await world.shareWaitingCard("view");
    const res = await booted.app.inject({ method: "POST", url: `/api/cards/${world.waiting.id}/wait/fire`, headers: { cookie: world.member } });
    expect(res.statusCode).toBe(403);
  });
});

describe("título do card esperado na listagem do board", () => {
  it("vai para quem vê o card esperado e fica de fora para quem não o vê", async () => {
    const booted = await boot();
    const world = await createWorld(booted);
    await world.shareWaitingCard("view");
    const listedFor = async (cookie: string) => {
      const cards = (await booted.app.inject({ method: "GET", url: "/api/cards", headers: { cookie } })).json().cards as { id: string }[];
      return cards.find((card) => card.id === world.waiting.id) as Record<string, unknown>;
    };
    expect(await listedFor(world.owner)).toMatchObject({ waitTargetTitle: "Captura de falhas", waitingFor: { cardId: world.target.id } });
    const forMember = await listedFor(world.member);
    expect(forMember.waitingFor).toMatchObject({ instruction: "faça o complemento" });
    expect(forMember.waitTargetTitle).toBeUndefined();
    const single = (await booted.app.inject({ method: "GET", url: `/api/cards/${world.waiting.id}`, headers: { cookie: world.owner } })).json().card;
    expect(single.waitTargetTitle).toBe("Captura de falhas");
  });
});
