import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockHostExecutor } from "../testkit/fakeHost.js";
import { sessionCookie } from "../testkit/sessionCookie.js";

vi.setConfig({ testTimeout: 30_000 });

const CLAUDE_ALIVE = { stdout: "bash\nnode\n", stderr: "" };

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "vibehub-account-backup-routes-"));
  vi.resetModules();
  const env = await import("../config/env.js");
  Object.assign(env.config, { dataDir, secretKey: "", sessionSecret: "", insecureCookies: true });
  env.config.runner.container = "vibehub-runner";
  mockHostExecutor(vi.fn(async () => CLAUDE_ALIVE));
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
  return { app, registry };
}

type Booted = Awaited<ReturnType<typeof boot>>;

async function createWorld({ app, registry }: Booted) {
  const owner = sessionCookie(await app.inject({ method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" } }));
  const memberId = (await app.inject({
    method: "POST", url: "/api/users", headers: { cookie: owner }, payload: { username: "alex", password: "supersecret", role: "member" },
  })).json().user.id as string;
  const member = sessionCookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" } }));
  await registry.createAccount({ name: "albert" });
  await registry.createAccount({ name: "cesar" });
  await registry.setAccountBackup("albert", "cesar");
  const project = await registry.createProject({ name: "vibehub" });
  const card = await registry.createCard({ projectId: project.id, title: "Checkout" }, { accountSlug: "albert" });
  await registry.switchCardToBackupAccount(card.id, { reason: "usage_limit", renewsAt: Date.now() + 60_000 });
  const shareCard = async (level: "work" | "view") => app.inject({
    method: "POST", url: `/api/cards/${card.id}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level },
  });
  return { owner, member, card, shareCard };
}

describe("PUT /api/accounts/:slug/backup", () => {
  it("o dono define e limpa a reserva, e a listagem de contas mostra a da conta padrão", async () => {
    const booted = await boot();
    const world = await createWorld(booted);
    const setBackup = (slug: string, backupAccountSlug: string | null) => booted.app.inject({
      method: "PUT", url: `/api/accounts/${slug}/backup`, headers: { cookie: world.owner }, payload: { backupAccountSlug },
    });

    const named = await setBackup("cesar", "albert");
    expect(named.statusCode).toBe(200);
    expect(named.json()).toEqual({ accountSlug: "cesar", backupAccountSlug: "albert" });
    expect((await setBackup("default", "cesar")).statusCode).toBe(200);
    const listed = (await booted.app.inject({ method: "GET", url: "/api/accounts", headers: { cookie: world.owner } })).json();
    expect(listed.defaultBackup).toBe("cesar");
    expect(listed.accounts.find((account: { slug: string }) => account.slug === "cesar").backupAccountSlug).toBe("albert");
    expect((await setBackup("cesar", null)).json()).toEqual({ accountSlug: "cesar", backupAccountSlug: null });
  });

  it.each([
    { case: "reserva inexistente", slug: "albert", backup: "ghost", status: 404 },
    { case: "conta reserva dela mesma", slug: "albert", backup: "albert", status: 400 },
  ])("$case responde $status", async ({ slug, backup, status }) => {
    const booted = await boot();
    const world = await createWorld(booted);

    const res = await booted.app.inject({
      method: "PUT", url: `/api/accounts/${slug}/backup`, headers: { cookie: world.owner }, payload: { backupAccountSlug: backup },
    });

    expect(res.statusCode).toBe(status);
  });

  it("membro não define reserva", async () => {
    const booted = await boot();
    const world = await createWorld(booted);

    const res = await booted.app.inject({
      method: "PUT", url: "/api/accounts/albert/backup", headers: { cookie: world.member }, payload: { backupAccountSlug: null },
    });

    expect(res.statusCode).toBe(403);
    expect((await booted.registry.readAccountBackups()).get("albert")).toBe("cesar");
  });
});

describe("POST /api/cards/:id/account-return", () => {
  it("devolve o card à conta original e apaga o empréstimo", async () => {
    const booted = await boot();
    const world = await createWorld(booted);

    const res = await booted.app.inject({ method: "POST", url: `/api/cards/${world.card.id}/account-return`, headers: { cookie: world.owner } });

    expect(res.statusCode).toBe(200);
    expect(res.json().card.accountSlug).toBe("albert");
    expect(res.json().card.accountLoan).toBeUndefined();
    expect((await booted.registry.getCard(world.card.id))?.accountSlug).toBe("albert");
  });

  it("card sem empréstimo responde 400", async () => {
    const booted = await boot();
    const world = await createWorld(booted);
    await booted.registry.returnCardAccount(world.card.id);

    const res = await booted.app.inject({ method: "POST", url: `/api/cards/${world.card.id}/account-return`, headers: { cookie: world.owner } });

    expect(res.statusCode).toBe(400);
  });

  it.each([
    { access: "sem acesso ao card", level: undefined, status: 404 },
    { access: "que só vê o card", level: "view", status: 403 },
    { access: "que trabalha no card", level: "work", status: 200 },
  ] as const)("membro $access recebe $status", async ({ level, status }) => {
    const booted = await boot();
    const world = await createWorld(booted);
    if (level) await world.shareCard(level);

    const res = await booted.app.inject({ method: "POST", url: `/api/cards/${world.card.id}/account-return`, headers: { cookie: world.member } });

    expect(res.statusCode).toBe(status);
    expect((await booted.registry.getCard(world.card.id))?.accountSlug).toBe(status === 200 ? "albert" : "cesar");
  });
});
