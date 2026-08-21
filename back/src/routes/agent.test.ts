import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

let dir = "";
let app: FastifyInstance;
let cookie = "";

const setAccountToken = vi.fn();
const removeAccountToken = vi.fn();
const accountsTokenStatus = vi.fn();
const applyMcpsEverywhere = vi.fn();
const setMcpSecretById = vi.fn();
const applyBrainEverywhere = vi.fn();
const importSessions = vi.fn();

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
    runnerToken: vi.fn(async () => "token"),
    statusUrl: () => "http://vibehub:3010/api/runner/status",
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  vi.doMock("../services/accounts/token.js", () => ({
    setAccountToken, removeAccountToken, accountsTokenStatus,
  }));
  vi.doMock("../services/mcp/mcp.js", async () => {
    const actual = await vi.importActual<typeof import("../services/mcp/mcp.js")>("../services/mcp/mcp.js");
    return { ...actual, applyMcpsEverywhere, setMcpSecretById };
  });
  vi.doMock("../services/brain/brain.js", async () => {
    const actual = await vi.importActual<typeof import("../services/brain/brain.js")>("../services/brain/brain.js");
    return { ...actual, applyBrainEverywhere };
  });
  vi.doMock("../services/import/import.js", () => ({ importSessions }));
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-agent-"));
  vi.clearAllMocks();
  app = await boot();
  const res = await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  });
  cookie = `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

describe("account tokens", () => {
  it("stores a long-lived token", async () => {
    setAccountToken.mockResolvedValueOnce({ runners: 1 });
    const res = await app.inject({
      method: "POST", url: "/api/accounts/work/token", headers: { cookie }, payload: { token: "sk-ant-x" },
    });
    expect(res.statusCode).toBe(200);
    expect(setAccountToken).toHaveBeenCalledWith("work", "sk-ant-x");
  });

  it("400s a malformed token and 502s an unreachable runner", async () => {
    setAccountToken.mockRejectedValueOnce(new Error("token does not look like a Claude OAuth token"));
    expect((await app.inject({
      method: "POST", url: "/api/accounts/work/token", headers: { cookie }, payload: { token: "nope" },
    })).statusCode).toBe(400);

    setAccountToken.mockRejectedValueOnce(new Error("the runner is unreachable"));
    expect((await app.inject({
      method: "POST", url: "/api/accounts/work/token", headers: { cookie }, payload: { token: "sk-ant-x" },
    })).statusCode).toBe(502);
  });

  it("removes a token and reports which accounts have one", async () => {
    removeAccountToken.mockResolvedValueOnce({ runners: 1 });
    expect((await app.inject({ method: "DELETE", url: "/api/accounts/work/token", headers: { cookie } })).statusCode).toBe(200);
    accountsTokenStatus.mockResolvedValueOnce({ bySlug: { work: true }, defaultHasToken: false });
    const res = await app.inject({ method: "GET", url: "/api/accounts/tokens", headers: { cookie } });
    expect(res.json()).toEqual({ bySlug: { work: true }, defaultHasToken: false });
  });

  it("never echoes the token back", async () => {
    setAccountToken.mockResolvedValueOnce({ runners: 1 });
    const res = await app.inject({
      method: "POST", url: "/api/accounts/work/token", headers: { cookie }, payload: { token: "sk-ant-secret" },
    });
    expect(res.body).not.toContain("sk-ant-secret");
  });
});

describe("mcps", () => {
  it("applies every MCP to every profile", async () => {
    applyMcpsEverywhere.mockResolvedValueOnce({ runners: 1, mcps: 3 });
    const res = await app.inject({ method: "POST", url: "/api/mcps/apply", headers: { cookie } });
    expect(res.json()).toEqual({ ok: true, runners: 1, mcps: 3 });
  });

  it("404s a secret for an unknown MCP", async () => {
    setMcpSecretById.mockRejectedValueOnce(new Error("MCP not found"));
    const res = await app.inject({
      method: "POST", url: "/api/mcps/ghost/secret", headers: { cookie }, payload: { key: "TOKEN", value: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a secret the MCP never declared", async () => {
    setMcpSecretById.mockRejectedValueOnce(new Error("'EVIL' is not an env var or header declared by MCP 'x'"));
    const res = await app.inject({
      method: "POST", url: "/api/mcps/abc/secret", headers: { cookie }, payload: { key: "EVIL", value: "x" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("brain", () => {
  it("reads, writes and resets the shared instructions", async () => {
    const initial = (await app.inject({ method: "GET", url: "/api/brain", headers: { cookie } })).json();
    expect(initial).toHaveProperty("text");

    const saved = await app.inject({
      method: "POST", url: "/api/brain", headers: { cookie }, payload: { text: "# House rules\nBe brief." },
    });
    expect(saved.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/brain", headers: { cookie } })).json().text)
      .toContain("House rules");

    await app.inject({ method: "DELETE", url: "/api/brain", headers: { cookie } });
    expect((await app.inject({ method: "GET", url: "/api/brain", headers: { cookie } })).json().text)
      .not.toContain("House rules");
  });

  it("pushes the brain into every profile", async () => {
    applyBrainEverywhere.mockResolvedValueOnce({ runners: 1, bytes: 120 });
    const res = await app.inject({ method: "POST", url: "/api/brain/apply", headers: { cookie } });
    expect(res.json()).toEqual({ ok: true, runners: 1, bytes: 120 });
  });
});

describe("import", () => {
  it("adopts staged sessions as cards", async () => {
    importSessions.mockResolvedValueOnce({ results: [], created: 2, skipped: 1, failed: 0 });
    const res = await app.inject({
      method: "POST", url: "/api/import", headers: { cookie },
      payload: { items: [{ repo: "octocat/hello", title: "a session", sessionId: "u-1" }] },
    });
    expect(res.json()).toMatchObject({ created: 2, skipped: 1 });
    // The importer must be handed the workspace's own cwd derivation, not build paths itself.
    expect(typeof importSessions.mock.calls[0]?.[1]).toBe("function");
  });

  it("502s when the runner is not ready", async () => {
    importSessions.mockRejectedValueOnce(new Error("the runner is not provisioned — set it up before importing"));
    const res = await app.inject({
      method: "POST", url: "/api/import", headers: { cookie }, payload: { items: [] },
    });
    expect(res.statusCode).toBe(502);
  });
});

describe("agent routes require a session", () => {
  it("401s without a cookie", async () => {
    for (const [method, url] of [["GET", "/api/brain"], ["POST", "/api/mcps/apply"], ["POST", "/api/import"]] as const) {
      expect((await app.inject({ method, url })).statusCode, url).toBe(401);
    }
  });
});
