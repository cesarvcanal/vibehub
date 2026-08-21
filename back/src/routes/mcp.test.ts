import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { bearerToken } from "./mcp.js";

describe("bearerToken", () => {
  it("reads the value out of an Authorization header", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
  });
  it("ignores anything that is not a bearer", () => {
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

let dir = "";
let app: FastifyInstance;
const TOKEN = "runner-token-for-the-mcp";

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
    runnerToken: vi.fn(async () => TOKEN),
    statusUrl: () => "http://vibehub:3010/api/runner/status",
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

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-mcp-")); app = await boot(); });
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

const INITIALIZE = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

describe("/mcp authentication", () => {
  it("401s with no credential and points at bearer auth", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", payload: INITIALIZE });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("401s a wrong token of the same length", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${"x".repeat(TOKEN.length)}` },
      payload: INITIALIZE,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the runner's service token", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" },
      payload: INITIALIZE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("vibehub");
  });

  it("rejects GET with a useful message", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toMatch(/POST/);
  });
});

describe("/mcp tools", () => {
  it("advertises exactly the three maestro tools", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(200);
    for (const name of ["vibehub_list_terminals", "vibehub_send_to_terminal", "vibehub_read_terminal"]) {
      expect(res.body).toContain(name);
    }
  });
});
