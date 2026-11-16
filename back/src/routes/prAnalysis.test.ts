import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { OpenPull } from "../services/github/client.js";

/**
 * PR ANALYSIS ROUTES — who sees the project's open PRs and who may start an analysis. The server, the
 * board, the users and the shares are REAL; GitHub (`listOpenPulls`) and typing into the card
 * (`sendToTerminal`) are mocked at the boundary.
 *
 * Every test boots a server and scrypt-hashes several passwords; the budget is wide on purpose.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let dir = "";
let app: FastifyInstance;
let githubDown = false;
const PULL: OpenPull = {
  number: 636, title: "Conciliação", url: "https://github.com/acme/erp/pull/636", author: "albert-gh",
  branch: "feat/conciliacao", base: "dev", fromFork: false, draft: false, updatedAt: "2026-11-16T12:00:00Z",
};
const listOpenPulls = vi.fn(async () => {
  if (githubDown) throw new Error("GitHub returned 502 while listing pull requests");
  return [PULL];
});
const readPull = vi.fn(async (_c: unknown, _o: string, _r: string, n: number) => (n === PULL.number ? { ...PULL, open: true } : null));
const sendToTerminal = vi.fn(async (cardId: string) => ({ sent: true, cardId, title: "", project: "" }));

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
  vi.doMock("../services/board/workspace.js", async () => ({
    ...(await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js")),
    prepareCard: vi.fn(async () => undefined),
    openCard: vi.fn(async () => undefined),
    reapplyCardIdentity: vi.fn(async () => true),
  }));
  vi.doMock("../services/github/client.js", async () => ({
    ...(await vi.importActual<typeof import("../services/github/client.js")>("../services/github/client.js")),
    listOpenPulls,
    readPull,
  }));
  vi.doMock("../services/maestro/maestro.js", async () => ({
    ...(await vi.importActual<typeof import("../services/maestro/maestro.js")>("../services/maestro/maestro.js")),
    sendToTerminal,
  }));
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

/** An owner with a project on GitHub, plus a member who has been given nothing yet. */
async function world() {
  const owner = cookieOf(await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  }));
  const memberId = (await app.inject({
    method: "POST", url: "/api/users", headers: { cookie: owner },
    payload: { username: "albert", password: "supersecret", role: "member" },
  })).json().user.id as string;
  const member = cookieOf(await app.inject({
    method: "POST", url: "/api/auth/login", payload: { username: "albert", password: "supersecret" },
  }));
  const projectId = (await app.inject({
    method: "POST", url: "/api/projects", headers: { cookie: owner },
    payload: { name: "erp", repoFullName: "acme/erp", cloneUrl: "https://github.com/acme/erp.git", baseBranch: "dev" },
  })).json().project.id as string;
  const shareProject = (level: "work" | "view") => app.inject({
    method: "POST", url: `/api/projects/${projectId}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level },
  });
  return { owner, member, memberId, projectId, shareProject };
}

const list = (cookie: string, projectId: string) =>
  app.inject({ method: "GET", url: `/api/projects/${projectId}/prs`, headers: { cookie } });
const analyse = (cookie: string, projectId: string, pr: number | string) =>
  app.inject({ method: "POST", url: `/api/projects/${projectId}/prs/${pr}/analysis`, headers: { cookie } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-pr-analysis-"));
  githubDown = false;
  listOpenPulls.mockClear();
  sendToTerminal.mockClear();
  app = await boot();
});
afterEach(async () => {
  await app.close();
  for (const mod of ["../runtime/runner.js", "../services/board/workspace.js", "../services/github/client.js", "../services/maestro/maestro.js"]) {
    vi.doUnmock(mod);
  }
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/projects/:id/prs", () => {
  it("lista as PRs abertas para quem alcança o projeto, e esconde de quem não alcança", async () => {
    const w = await world();
    expect((await list(w.member, w.projectId)).statusCode).toBe(404);
    await w.shareProject("view");
    const res = await list(w.member, w.projectId);
    expect(res.statusCode).toBe(200);
    expect(res.json().pulls).toEqual([PULL]);
    expect((await list(w.owner, w.projectId)).json().pulls).toHaveLength(1);
  });

  it("sem sessão é 401; GitHub fora do ar é 502 com o motivo, nunca lista vazia", async () => {
    const w = await world();
    expect((await app.inject({ method: "GET", url: `/api/projects/${w.projectId}/prs` })).statusCode).toBe(401);
    githubDown = true;
    const res = await list(w.owner, w.projectId);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/502/);
  });
});

describe("POST /api/projects/:id/prs/:number/analysis", () => {
  it("quem trabalha no projeto dispara a análise; a PR passa a apontar para o card", async () => {
    const w = await world();
    await w.shareProject("work");
    const res = await analyse(w.member, w.projectId, 636);
    expect(res.statusCode).toBe(200);
    const { card, created } = res.json() as { card: { id: string; title: string }; created: boolean };
    expect(created).toBe(true);
    expect(card.title).toBe("Análise PR #636 · Conciliação");
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    expect((await list(w.member, w.projectId)).json().pulls[0].analysisCardId).toBe(card.id);
    // the second click answers with the same card
    expect((await analyse(w.member, w.projectId, 636)).json()).toMatchObject({ created: false, card: { id: card.id } });
  });

  it("um card compartilhado mostra o projeto, mas não dá trabalho no projeto: vê a lista, não dispara", async () => {
    const w = await world();
    const cardId = (await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: w.owner }, payload: { projectId: w.projectId, title: "conciliação" },
    })).json().card.id as string;
    await app.inject({ method: "POST", url: `/api/cards/${cardId}/shares`, headers: { cookie: w.owner }, payload: { userId: w.memberId, level: "work" } });
    expect((await list(w.member, w.projectId)).statusCode).toBe(200);
    expect((await analyse(w.member, w.projectId, 636)).statusCode).toBe(403);
    expect(sendToTerminal).not.toHaveBeenCalled();
    // the owner's analysis card was not shared with this member: the list does not reveal it
    const ownersCard = (await analyse(w.owner, w.projectId, 636)).json().card.id as string;
    expect((await list(w.owner, w.projectId)).json().pulls[0].analysisCardId).toBe(ownersCard);
    expect((await list(w.member, w.projectId)).json().pulls[0].analysisCardId).toBeUndefined();
  });

  it("leitura não dispara (403), sem acesso é 404, PR inválida ou fechada é 400", async () => {
    const w = await world();
    expect((await analyse(w.member, w.projectId, 636)).statusCode).toBe(404);
    await w.shareProject("view");
    expect((await analyse(w.member, w.projectId, 636)).statusCode).toBe(403);
    expect((await analyse(w.owner, w.projectId, "abc")).statusCode).toBe(400);
    const closed = await analyse(w.owner, w.projectId, 999);
    expect(closed.statusCode).toBe(400);
    expect(closed.json().error).toMatch(/pr_nao_aberta/);
    expect(sendToTerminal).not.toHaveBeenCalled();
  });
});
