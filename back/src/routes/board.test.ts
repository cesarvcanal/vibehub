import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

let dir = "";
let app: FastifyInstance;
let cookie = "";

const RUNNER_TOKEN = "runner-token-abcdef";

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
    runnerToken: vi.fn(async () => RUNNER_TOKEN),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

async function signIn(): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  });
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

async function makeProject(name = "vibehub"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name } });
  return res.json().project.id as string;
}

async function makeCard(projectId: string, title = "first card"): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId, title },
  });
  return res.json().card.id as string;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-board-routes-"));
  app = await boot();
  cookie = await signIn();
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

describe("projects", () => {
  it("creates, lists and deletes", async () => {
    const id = await makeProject();
    const list = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(list.json().projects).toHaveLength(1);
    const del = await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } })).json().projects).toHaveLength(0);
  });

  it("returns the cascaded cards so the session layer can tear them down", async () => {
    const id = await makeProject();
    await makeCard(id, "one");
    await makeCard(id, "two");
    const del = await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { cookie } });
    expect(del.json().cards).toHaveLength(2);
  });

  it("400s a project with no name and 404s an unknown id", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: " " } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "PATCH", url: "/api/projects/does-not-exist", headers: { cookie }, payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects a repository name that is not owner/repo", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "p", repoFullName: "not-a-repo; rm -rf /" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reorders the sidebar", async () => {
    const first = await makeProject("first");
    await makeProject("second");
    const res = await app.inject({
      method: "PATCH", url: `/api/projects/${first}/order`, headers: { cookie }, payload: { position: 1 },
    });
    expect(res.json().projects.map((p: { name: string }) => p.name)).toEqual(["second", "first"]);
  });

  it("400s a bogus position", async () => {
    const id = await makeProject();
    const res = await app.inject({
      method: "PATCH", url: `/api/projects/${id}/order`, headers: { cookie }, payload: { position: -1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("cards", () => {
  it("creates a card in the backlog with derived session and worktree names", async () => {
    const projectId = await makeProject();
    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId, title: "Refatorar Ação!" },
    });
    const card = res.json().card;
    expect(card.column).toBe("backlog");
    expect(card.tmuxSession).toMatch(/^card-[0-9a-f]{8}$/);
    expect(card.worktreeSlug).toMatch(/^[a-z0-9-]+$/);
  });

  it("applies optional fields through the same validation an edit uses", async () => {
    const projectId = await makeProject();
    const ok = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie },
      payload: { projectId, title: "with model", model: "claude-opus-5" },
    });
    expect(ok.json().card.model).toBe("claude-opus-5");
    const bad = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie },
      payload: { projectId, title: "bad model", model: "gpt-9" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("404s an unknown card and 400s an unknown project", async () => {
    expect((await app.inject({ method: "GET", url: "/api/cards/nope", headers: { cookie } })).statusCode).toBe(404);
    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId: "nope", title: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a branch name carrying shell metacharacters", async () => {
    const projectId = await makeProject();
    const id = await makeCard(projectId);
    const res = await app.inject({
      method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { branch: "feat/x; rm -rf /" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists cards per project", async () => {
    const a = await makeProject("a");
    const b = await makeProject("b");
    await makeCard(a, "a1");
    await makeCard(b, "b1");
    const res = await app.inject({ method: "GET", url: `/api/projects/${a}/cards`, headers: { cookie } });
    expect(res.json().cards.map((c: { title: string }) => c.title)).toEqual(["a1"]);
  });
});

describe("status callback", () => {
  async function postStatus(card: string, status: string, token?: string) {
    return await app.inject({
      method: "POST", url: "/api/runner/status",
      headers: token ? { "x-vibehub-token": token } : {},
      payload: { card, status },
    });
  }

  it("401s without the service token — and a session cookie is NOT enough", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    expect((await postStatus(card, "working")).statusCode).toBe(401);
    const withCookie = await app.inject({
      method: "POST", url: "/api/runner/status", headers: { cookie }, payload: { card, status: "working" },
    });
    expect(withCookie.statusCode).toBe(401);
  });

  it("401s a wrong token of the same length", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    const wrong = "x".repeat(RUNNER_TOKEN.length);
    expect((await postStatus(card, "working", wrong)).statusCode).toBe(401);
  });

  it("moves a card between waiting and working — the mirror rule", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    // A card in the backlog is sticky: a hook must not drag it out.
    await postStatus(card, "working", RUNNER_TOKEN);
    let current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("backlog");

    await app.inject({ method: "PATCH", url: `/api/cards/${card}`, headers: { cookie }, payload: { column: "waiting" } });
    await postStatus(card, "working", RUNNER_TOKEN);
    current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("working");

    await postStatus(card, "waiting", RUNNER_TOKEN);
    current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("waiting");
  });

  it("never drags a card out of done on an idle report", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    await app.inject({ method: "PATCH", url: `/api/cards/${card}`, headers: { cookie }, payload: { column: "done" } });
    // `waiting` fires on SessionStart/Stop/Notification, without anybody asking for anything.
    await postStatus(card, "waiting", RUNNER_TOKEN);
    const current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("done");
  });

  it("brings a done card back when somebody actually types in it", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    await app.inject({ method: "PATCH", url: `/api/cards/${card}`, headers: { cookie }, payload: { column: "done" } });
    // `working` means a prompt was submitted in that terminal — the work came back.
    await postStatus(card, "working", RUNNER_TOKEN);
    const current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("working");
  });

  it("400s an unknown status value", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    expect((await postStatus(card, "thinking", RUNNER_TOKEN)).statusCode).toBe(400);
  });

  it("answers 200 for an unknown card — a fire-and-forget hook must not retry", async () => {
    const res = await postStatus("no-such-card", "working", RUNNER_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, applied: false });
  });
});

describe("accounts and mcps", () => {
  it("creates an account and refuses to delete it while a project points at it", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/accounts", headers: { cookie }, payload: { name: "Work Account" },
    });
    const slug = created.json().account.slug;
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "p", defaultAccountSlug: slug },
    });
    const res = await app.inject({ method: "DELETE", url: `/api/accounts/${slug}`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });

  it("round-trips an MCP server", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/mcps", headers: { cookie },
      payload: { name: "playwright", kind: "stdio", command: "npx", args: ["playwright-mcp"] },
    });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/mcps", headers: { cookie } });
    expect(list.json().mcps).toHaveLength(1);
    await app.inject({ method: "DELETE", url: `/api/mcps/${created.json().mcp.id}`, headers: { cookie } });
    expect((await app.inject({ method: "GET", url: "/api/mcps", headers: { cookie } })).json().mcps).toHaveLength(0);
  });

  it("rejects an MCP name with shell metacharacters", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/mcps", headers: { cookie },
      payload: { name: "bad; rm -rf /", kind: "stdio", command: "npx" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("board routes require a session", () => {
  it("401s every board route without a cookie", async () => {
    for (const url of ["/api/projects", "/api/cards", "/api/accounts", "/api/mcps"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});
