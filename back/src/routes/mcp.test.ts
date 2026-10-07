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

  it("send_to_terminal advertises the `from` parameter (the sender card, for chat attribution)", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("YOUR OWN card id");
    expect(res.body).toContain("WHO sent the message");
  });
});

describe("/mcp actor — who the audit says did it", () => {
  /** Records the actor each request's server was built for, delegating to the real factory. */
  async function bootRecordingActors(): Promise<string[]> {
    const actors: string[] = [];
    await app.close();
    vi.resetModules();
    vi.doMock("../mcp/server.js", async () => {
      const actual = await vi.importActual<typeof import("../mcp/server.js")>("../mcp/server.js");
      return {
        ...actual,
        createMcpServer: (actor?: string) => { actors.push(String(actor)); return actual.createMcpServer(actor); },
      };
    });
    app = await boot();
    vi.doUnmock("../mcp/server.js");
    return actors;
  }

  it("is the browser when the OWNER'S COOKIE is what authenticated — a junk bearer beside it changes nothing", async () => {
    const actors = await bootRecordingActors();
    const setup = await app.inject({
      method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
    });
    const cookie = `vibehub_session=${setup.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { cookie, authorization: "Bearer not-the-runner-token", accept: "application/json, text/event-stream" },
      payload: INITIALIZE,
    });
    expect(res.statusCode).toBe(200);
    expect(actors).toEqual(["browser"]);
  });

  it("is the card when the runner's token is what authenticated", async () => {
    const actors = await bootRecordingActors();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" },
      payload: INITIALIZE,
    });
    expect(res.statusCode).toBe(200);
    expect(actors).toEqual(["card"]);
  });
});
