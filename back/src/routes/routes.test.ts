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
  it("reports no connections before a token is added", async () => {
    const cookie = await signUp(app);
    const res = await app.inject({ method: "GET", url: "/api/github", headers: { cookie } });
    expect(res.json()).toEqual({ connections: [] });
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

describe("github connections (multiple accounts)", () => {
  /** Every /user call answers as `login` — enough for connect and for the live check in GET. */
  function stubIdentity(login: string, scopes = ""): void {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ login, name: null, email: null }),
      { headers: { "content-type": "application/json", ...(scopes ? { "x-oauth-scopes": scopes } : {}) } },
    )));
  }

  async function connect(cookie: string, label: string, token: string) {
    const res = await app.inject({
      method: "POST", url: "/api/github/connections", headers: { cookie }, payload: { label, token },
    });
    expect(res.statusCode).toBe(201);
    return res.json().connection as { id: string; label: string; login: string };
  }

  it("adds two accounts and lists both with a live check", async () => {
    const cookie = await signUp(app);
    stubIdentity("octocat", "repo");
    const personal = await connect(cookie, "personal", "ghp_personal");
    stubIdentity("acme-inc");
    const org = await connect(cookie, "acme org", "ghp_org");

    stubIdentity("octocat");
    const listed = (await app.inject({ method: "GET", url: "/api/github", headers: { cookie } })).json();
    expect(listed.connections.map((c: { id: string }) => c.id)).toEqual([personal.id, org.id]);
    expect(listed.connections.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(listed.connections[0].label).toBe("personal");
    // the token itself is NEVER echoed back
    expect(JSON.stringify(listed)).not.toContain("ghp_");
  });

  it("400s an account whose token GitHub rejects, and stores nothing", async () => {
    const cookie = await signUp(app);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const res = await app.inject({
      method: "POST", url: "/api/github/connections", headers: { cookie }, payload: { label: "x", token: "bad" },
    });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/github", headers: { cookie } })).json().connections).toEqual([]);
  });

  it("removes an account", async () => {
    const cookie = await signUp(app);
    stubIdentity("octocat");
    const c = await connect(cookie, "personal", "ghp_personal");
    const res = await app.inject({
      method: "DELETE", url: `/api/github/connections/${c.id}`, headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/github", headers: { cookie } })).json().connections).toEqual([]);
  });

  it("409s removing an account a project still points at", async () => {
    const cookie = await signUp(app);
    stubIdentity("octocat");
    const c = await connect(cookie, "personal", "ghp_personal");
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "erp", githubConnectionId: c.id },
    });
    const res = await app.inject({
      method: "DELETE", url: `/api/github/connections/${c.id}`, headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/in use by 1 project/);
  });

  it("404s an account that is not there", async () => {
    const cookie = await signUp(app);
    const res = await app.inject({ method: "DELETE", url: "/api/github/connections/NOPE", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("reads repos and branches through the account named in the query", async () => {
    const cookie = await signUp(app);
    stubIdentity("octocat");
    await connect(cookie, "personal", "ghp_personal");
    stubIdentity("acme-inc");
    const org = await connect(cookie, "acme org", "ghp_org");

    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>).authorization));
      if (url.includes("/user/repos")) {
        return new Response(JSON.stringify([{
          full_name: "acme-inc/erp", clone_url: "https://github.com/acme-inc/erp.git", private: true,
          default_branch: "dev", updated_at: "2026-08-01T00:00:00Z", description: null,
        }]), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("/branches")) {
        return new Response(JSON.stringify([{ name: "dev" }, { name: "prod" }]), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ default_branch: "dev" }), { headers: { "content-type": "application/json" } });
    }));

    const repos = await app.inject({
      method: "GET", url: `/api/github/repos?connection=${org.id}&q=erp`, headers: { cookie },
    });
    expect(repos.json().repos.map((r: { fullName: string }) => r.fullName)).toEqual(["acme-inc/erp"]);

    const branches = await app.inject({
      method: "GET", url: `/api/github/repos/acme-inc/erp/branches?connection=${org.id}`, headers: { cookie },
    });
    expect(branches.json().branches).toEqual(["dev", "prod"]);
    expect(seen.every((h) => h === "Bearer ghp_org")).toBe(true);
  });

  it("falls back to the FIRST account when the query names none", async () => {
    const cookie = await signUp(app);
    stubIdentity("octocat");
    await connect(cookie, "personal", "ghp_personal");
    stubIdentity("acme-inc");
    await connect(cookie, "acme org", "ghp_org");

    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>).authorization));
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }));
    await app.inject({ method: "GET", url: "/api/github/repos", headers: { cookie } });
    expect(seen[0]).toBe("Bearer ghp_personal");
  });

  it("400s the pickers when there is no account at all", async () => {
    const cookie = await signUp(app);
    const res = await app.inject({ method: "GET", url: "/api/github/repos", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not connected/);
  });

  it("refuses a project pointing at an account that does not exist", async () => {
    const cookie = await signUp(app);
    const res = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "erp", githubConnectionId: "GHOST" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not exist/);
  });

  it("DELETE /api/github forgets every account", async () => {
    const cookie = await signUp(app);
    stubIdentity("octocat");
    await connect(cookie, "personal", "ghp_personal");
    stubIdentity("acme-inc");
    await connect(cookie, "acme org", "ghp_org");
    await app.inject({ method: "DELETE", url: "/api/github", headers: { cookie } });
    expect((await app.inject({ method: "GET", url: "/api/github", headers: { cookie } })).json().connections).toEqual([]);
  });

  it("POST /api/github/token still works for the wizard: create, then replace in place", async () => {
    const cookie = await signUp(app);
    stubIdentity("octocat");
    const first = await app.inject({
      method: "POST", url: "/api/github/token", headers: { cookie }, payload: { token: "ghp_a" },
    });
    expect(first.json()).toMatchObject({ connected: true, login: "octocat" });
    stubIdentity("octocat");
    await app.inject({ method: "POST", url: "/api/github/token", headers: { cookie }, payload: { token: "ghp_b" } });
    expect((await app.inject({ method: "GET", url: "/api/github", headers: { cookie } })).json().connections).toHaveLength(1);
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
