import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

let dir = "";
let app: FastifyInstance;

/** A server wired to a throwaway data dir, with the runner/docker layer stubbed out. */
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

async function signUp(server: FastifyInstance): Promise<string> {
  const res = await server.inject({
    method: "POST", url: "/api/setup/owner",
    payload: { username: "owner", password: "supersecret" },
  });
  const cookie = res.cookies.find((c) => c.name === "vibehub_session");
  return `vibehub_session=${cookie?.value ?? ""}`;
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-routes-")); app = await boot(); });
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("health", () => {
  it("answers without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
});

describe("setup state", () => {
  it("is public and reports a fresh install", async () => {
    const res = await app.inject({ method: "GET", url: "/api/setup/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fresh: true, steps: { owner: false } });
  });

  it("leaks nothing about the install while fresh", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/setup/state" })).json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["completed", "fresh", "runner", "steps"]);
  });

  it("flips owner to done once the owner exists", async () => {
    await signUp(app);
    const res = await app.inject({ method: "GET", url: "/api/setup/state" });
    expect(res.json()).toMatchObject({ fresh: false, steps: { owner: true, runner: true, claude: true } });
  });
});

describe("owner creation", () => {
  it("creates the owner and signs them in", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name === "vibehub_session")).toBe(true);
  });

  it("refuses a second owner", async () => {
    await signUp(app);
    const res = await app.inject({
      method: "POST", url: "/api/setup/owner", payload: { username: "intruder", password: "supersecret" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a weak password with a useful message", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "123" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least 8/);
  });
});

describe("login", () => {
  it("signs in with the right credentials", async () => {
    await signUp(app);
    const res = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "supersecret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe("owner");
  });

  it("401s on a bad password without saying which half was wrong", async () => {
    await signUp(app);
    const res = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid username or password");
  });

  it("401s an unknown user with the same message", async () => {
    await signUp(app);
    const res = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "ghost", password: "supersecret" },
    });
    expect(res.json().error).toBe("invalid username or password");
  });
});

describe("protected routes", () => {
  it("401 without a session", async () => {
    for (const url of ["/api/settings", "/api/runner", "/api/github", "/api/auth/me"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });

  it("200 with a session", async () => {
    const cookie = await signUp(app);
    for (const url of ["/api/settings", "/api/runner", "/api/github", "/api/auth/me"]) {
      expect((await app.inject({ method: "GET", url, headers: { cookie } })).statusCode, url).toBe(200);
    }
  });

  it("ignores a forged session cookie", async () => {
    await signUp(app);
    const res = await app.inject({
      method: "GET", url: "/api/settings", headers: { cookie: "vibehub_session=user-1.999.deadbeef" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("settings", () => {
  it("returns runner topology alongside the settings", async () => {
    const cookie = await signUp(app);
    const body = (await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } })).json();
    expect(body.runner).toMatchObject({ kind: expect.any(String), container: expect.any(String) });
    expect(body.git).toMatchObject({ name: expect.any(String), email: expect.any(String) });
  });

  it("patches and validates", async () => {
    const cookie = await signUp(app);
    const ok = await app.inject({
      method: "PATCH", url: "/api/settings", headers: { cookie }, payload: { git: { name: "Ada" } },
    });
    expect(ok.json().git.name).toBe("Ada");
    const bad = await app.inject({
      method: "PATCH", url: "/api/settings", headers: { cookie }, payload: { git: { email: "nope" } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("github", () => {
  it("reports disconnected before a token is added", async () => {
    const cookie = await signUp(app);
    const res = await app.inject({ method: "GET", url: "/api/github", headers: { cookie } });
    expect(res.json()).toEqual({ connected: false });
  });

  it("stores a valid token and adopts its identity for git commits", async () => {
    const cookie = await signUp(app);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ login: "octocat", name: "Octo Cat", email: "octo@example.com" }),
      { headers: { "content-type": "application/json", "x-oauth-scopes": "repo" } },
    )));
    const res = await app.inject({
      method: "POST", url: "/api/github/token", headers: { cookie }, payload: { token: "ghp_x" },
    });
    expect(res.json()).toMatchObject({ connected: true, login: "octocat" });
    const settings = (await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } })).json();
    expect(settings.git).toEqual({ name: "Octo Cat", email: "octo@example.com" });
  });

  it("does not overwrite a git identity the operator already chose", async () => {
    const cookie = await signUp(app);
    await app.inject({
      method: "PATCH", url: "/api/settings", headers: { cookie },
      payload: { git: { name: "Ada", email: "ada@example.com" } },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ login: "octocat", name: "Octo Cat", email: "octo@example.com" }),
      { headers: { "content-type": "application/json" } },
    )));
    await app.inject({ method: "POST", url: "/api/github/token", headers: { cookie }, payload: { token: "ghp_x" } });
    const settings = (await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } })).json();
    expect(settings.git.email).toBe("ada@example.com");
  });

  it("400s a token GitHub rejects", async () => {
    const cookie = await signUp(app);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const res = await app.inject({
      method: "POST", url: "/api/github/token", headers: { cookie }, payload: { token: "bad" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("runner", () => {
  it("reports status", async () => {
    const cookie = await signUp(app);
    const res = await app.inject({ method: "GET", url: "/api/runner", headers: { cookie } });
    expect(res.json()).toMatchObject({ running: true, claudeInstalled: true });
  });

  it("starts provisioning and is idempotent while it runs", async () => {
    const cookie = await signUp(app);
    const first = await app.inject({ method: "POST", url: "/api/runner/provision", headers: { cookie } });
    expect(first.json()).toMatchObject({ ok: true });
    const second = await app.inject({ method: "POST", url: "/api/runner/provision", headers: { cookie } });
    expect(second.json().ok).toBe(true);
  });
});

describe("unknown api routes", () => {
  it("404 as JSON rather than falling through to the UI", async () => {
    const cookie = await signUp(app);
    const res = await app.inject({ method: "GET", url: "/api/nope", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });
});
