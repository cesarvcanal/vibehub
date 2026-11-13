import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * POST /api/cards/:id/chat/key — the chat's Stop button, through the real route. The key is a NAME
 * from a whitelist; only what the whitelist itself holds may reach tmux. A name the prototype of a
 * plain object answers (`__proto__`, `toString`) once typed `[object Object]` into the card's prompt.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let dir = "";
let app: FastifyInstance;
let owner = "";
const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
const sendToTerminal = vi.fn(async (..._args: unknown[]) => undefined);

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  env.config.trustProxy = false;
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js");
    return { ...actual, prepareCard: vi.fn(async () => undefined), openCard: vi.fn(async () => undefined) };
  });
  vi.doMock("../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../runtime/host.js")>("../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ ...actual.hostExecutor(), runScript }) };
  });
  vi.doMock("../services/maestro/maestro.js", async () => {
    const actual = await vi.importActual<typeof import("../services/maestro/maestro.js")>("../services/maestro/maestro.js");
    return { ...actual, sendToTerminal };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

/** A card with a live session, as an opened card has. */
async function liveCard(): Promise<string> {
  const projectId = (await app.inject({
    method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "p" },
  })).json().project.id as string;
  const id = (await app.inject({
    method: "POST", url: "/api/cards", headers: { cookie: owner }, payload: { projectId, title: "stop" },
  })).json().card.id as string;
  const { applyOpenTerminal } = await import("../services/board/registry.js");
  await applyOpenTerminal(id);
  return id;
}

function pressKey(cardId: string, key: unknown, cookie = owner) {
  return app.inject({ method: "POST", url: `/api/cards/${cardId}/chat/key`, headers: { cookie }, payload: { key } });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-chat-key-"));
  runScript.mockClear();
  sendToTerminal.mockClear();
  app = await boot();
  owner = cookieOf(await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("POST /api/cards/:id/chat/key", () => {
  it("presses a whitelisted key in the card's session", async () => {
    const id = await liveCard();
    const res = await pressKey(id, "escape");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true });
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(String(runScript.mock.calls[0]?.[0])).toContain("tmux send-keys -t \"$1\" Escape");
  });

  it("answers 400 to a name only Object.prototype knows — nothing reaches the terminal", async () => {
    const id = await liveCard();
    for (const key of ["__proto__", "toString", "valueOf", "constructor", "hasOwnProperty", "Enter", ""]) {
      const res = await pressKey(id, key);
      expect(res.statusCode, key).toBe(400);
      expect(res.json().error).toMatch(/unknown key/);
    }
    expect(runScript).not.toHaveBeenCalled();
  });

  it("a read-only share cannot press anything, whitelisted or not", async () => {
    const id = await liveCard();
    const memberId = (await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: owner },
      payload: { username: "alex", password: "supersecret", role: "member" },
    })).json().user.id as string;
    await app.inject({
      method: "POST", url: `/api/cards/${id}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level: "view" },
    });
    const member = cookieOf(await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" },
    }));
    expect((await pressKey(id, "escape", member)).statusCode).toBe(403);
    expect((await pressKey(id, "__proto__", member)).statusCode).toBe(403);
    expect((await pressKey(id, "escape", "")).statusCode).toBe(401);
    expect(runScript).not.toHaveBeenCalled();
  });
});

describe("POST /api/cards/:id/chat — who sent it", () => {
  it("the send carries the sender the gate resolved: owner as `owner`, a member as `user`, by username", async () => {
    const id = await liveCard();
    const memberId = (await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: owner },
      payload: { username: "alex", password: "supersecret", role: "member" },
    })).json().user.id as string;
    await app.inject({
      method: "POST", url: `/api/cards/${id}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level: "work" },
    });
    const member = cookieOf(await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" },
    }));

    for (const cookie of [owner, member]) {
      const res = await app.inject({ method: "POST", url: `/api/cards/${id}/chat`, headers: { cookie }, payload: { text: "oi" } });
      expect(res.statusCode).toBe(200);
    }
    const origins = sendToTerminal.mock.calls.map((call) => (call[2] as { origin?: unknown; by?: string }));
    expect(origins.map((o) => o.origin)).toEqual([{ kind: "owner", name: "owner" }, { kind: "user", name: "alex" }]);
    expect(origins[1]?.by).toBe(memberId);
  });
});
