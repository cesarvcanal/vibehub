import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Um vibehub servido pelo preview de OUTRO vibehub: com VIBEHUB_PREVIEW_PROXY_AUTH=1, o que chega
 * pelo proxy (x-forwarded-prefix: /preview/<porta>) já entra como o owner local — sem setup e sem
 * login. Desligado, ou sem o cabeçalho do proxy, nada muda.
 */

const PROXIED = { "x-forwarded-prefix": "/preview/4317" };

let dir = "";
let app: FastifyInstance;

async function boot(previewProxyAuth: boolean): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  env.config.previewProxyAuth = previewProxyAuth;
  env.config.voiceLive = { enabled: true, apiKey: "" };
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-preview-auth-"));
});
afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("VIBEHUB_PREVIEW_PROXY_AUTH=1", () => {
  beforeEach(async () => {
    app = await boot(true);
  });

  it("is not a fresh install: the wizard never shows", async () => {
    const res = await app.inject({ method: "GET", url: "/api/setup/state" });
    expect(res.json().fresh).toBe(false);
  });

  it("a request through the proxy is the local owner, with no cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: PROXIED });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: "preview-owner", role: "owner" });
    expect((await app.inject({ method: "GET", url: "/api/voice/live", headers: PROXIED })).statusCode).toBe(200);
  });

  it("keeps ONE owner across restarts", async () => {
    await app.close();
    app = await boot(true);
    const { listUsers } = await import("./users.js");
    expect((await listUsers()).filter((u) => u.role === "owner")).toHaveLength(1);
  });

  it.each([
    [{}, "no proxy header"],
    [{ "x-forwarded-prefix": "/elsewhere" }, "a prefix that is not a preview"],
    [{ "x-forwarded-prefix": "/preview/4317/../x" }, "a malformed preview prefix"],
  ])("anything else still needs a session (%s: %s)", async (headers) => {
    expect((await app.inject({ method: "GET", url: "/api/voice/live", headers })).statusCode).toBe(401);
  });

  it("the owner local password is never usable: nobody knows it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "preview-owner", password: "preview-owner" },
    });
    expect(res.statusCode).not.toBe(200);
  });
});

describe("off (the default)", () => {
  it("the proxy header alone signs in nobody, and the install stays fresh", async () => {
    app = await boot(false);
    expect((await app.inject({ method: "GET", url: "/api/setup/state" })).json().fresh).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/voice/live", headers: PROXIED })).statusCode).toBe(401);
  });
});

describe("previewProxyAuth (config)", () => {
  const saved = process.env.VIBEHUB_PREVIEW_PROXY_AUTH;
  afterEach(() => {
    if (saved === undefined) delete process.env.VIBEHUB_PREVIEW_PROXY_AUTH;
    else process.env.VIBEHUB_PREVIEW_PROXY_AUTH = saved;
  });

  it("refuses to boot on a non-loopback host", async () => {
    const { previewProxyAuth } = await import("../config/env.js");
    process.env.VIBEHUB_PREVIEW_PROXY_AUTH = "1";
    expect(() => previewProxyAuth("VIBEHUB_PREVIEW_PROXY_AUTH", "0.0.0.0")).toThrow(/loopback/);
    expect(previewProxyAuth("VIBEHUB_PREVIEW_PROXY_AUTH", "127.0.0.1")).toBe(true);
    process.env.VIBEHUB_PREVIEW_PROXY_AUTH = "true";
    expect(previewProxyAuth("VIBEHUB_PREVIEW_PROXY_AUTH", "0.0.0.0")).toBe(false);
  });
});
