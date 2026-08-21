import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { parseTerminalFrame, isValidTermSize } from "./session.js";

describe("terminal frames", () => {
  it("treats plain keystrokes as data", () => {
    expect(parseTerminalFrame("ls -la\r")).toEqual({ type: "data", data: "ls -la\r" });
  });

  it("understands a resize instruction", () => {
    expect(parseTerminalFrame(JSON.stringify({ type: "resize", cols: 120, rows: 40 })))
      .toEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("passes a typed brace through as input instead of choking on it", () => {
    expect(parseTerminalFrame("{not json")).toEqual({ type: "data", data: "{not json" });
  });

  it("refuses an out-of-range or fractional geometry", () => {
    for (const size of [{ cols: 0, rows: 40 }, { cols: 120, rows: 9999 }, { cols: 80.5, rows: 24 }]) {
      const frame = parseTerminalFrame(JSON.stringify({ type: "resize", ...size }));
      expect(frame.type).toBe("data");
    }
  });

  it("validates terminal sizes", () => {
    expect(isValidTermSize(80)).toBe(true);
    expect(isValidTermSize(9)).toBe(false);
    expect(isValidTermSize(501)).toBe(false);
    expect(isValidTermSize("80")).toBe(false);
  });
});

let dir = "";
let app: FastifyInstance;
let cookie = "";

const openCard = vi.fn();
const pauseCard = vi.fn();
const restartCard = vi.fn();
const restartAllCards = vi.fn();
const dropCardWorkspace = vi.fn();
const uploadCardImage = vi.fn();

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
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
    statusUrl: () => "http://vibehub:3010/api/runner/status",
  }));
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>(
      "../services/board/workspace.js",
    );
    return { ...actual, openCard, pauseCard, restartCard, restartAllCards, dropCardWorkspace, uploadCardImage };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

async function makeCard(): Promise<string> {
  const project = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "p" } });
  const res = await app.inject({
    method: "POST", url: "/api/cards", headers: { cookie },
    payload: { projectId: project.json().project.id, title: "a card" },
  });
  return res.json().card.id as string;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-session-"));
  vi.clearAllMocks();
  app = await boot();
  const res = await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  });
  cookie = `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

describe("card lifecycle routes", () => {
  it("opens a card", async () => {
    const id = await makeCard();
    openCard.mockResolvedValueOnce({ id, column: "waiting" });
    const res = await app.inject({ method: "POST", url: `/api/cards/${id}/open`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(openCard).toHaveBeenCalledWith(id);
  });

  it("404s an unknown card and 502s a runner that is down", async () => {
    openCard.mockRejectedValueOnce(new Error("card not found"));
    expect((await app.inject({ method: "POST", url: "/api/cards/ghost/open", headers: { cookie } })).statusCode).toBe(404);
    const id = await makeCard();
    openCard.mockRejectedValueOnce(new Error("the runner is unreachable"));
    expect((await app.inject({ method: "POST", url: `/api/cards/${id}/open`, headers: { cookie } })).statusCode).toBe(502);
  });

  it("pauses and restarts", async () => {
    const id = await makeCard();
    pauseCard.mockResolvedValueOnce({ id, column: "paused" });
    restartCard.mockResolvedValueOnce({ id, column: "waiting" });
    expect((await app.inject({ method: "POST", url: `/api/cards/${id}/pause`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/cards/${id}/restart`, headers: { cookie } })).statusCode).toBe(200);
  });

  it("restarts everything at once", async () => {
    restartAllCards.mockResolvedValueOnce({ restarted: 3, skipped: 1 });
    const res = await app.inject({ method: "POST", url: "/api/cards/restart-all", headers: { cookie } });
    expect(res.json()).toEqual({ restarted: 3, skipped: 1 });
  });

  it("deletes the runner side before dropping the card from the board", async () => {
    const id = await makeCard();
    const res = await app.inject({ method: "DELETE", url: `/api/cards/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(dropCardWorkspace).toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: `/api/cards/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it("still deletes the card when the runner cannot be cleaned", async () => {
    const id = await makeCard();
    dropCardWorkspace.mockRejectedValueOnce(new Error("runner unreachable"));
    const res = await app.inject({ method: "DELETE", url: `/api/cards/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/cards/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it("uploads an image and returns the path inside the runner", async () => {
    const id = await makeCard();
    uploadCardImage.mockResolvedValueOnce({ path: "/work/.uploads/x/1-image.png" });
    const res = await app.inject({
      method: "POST", url: `/api/cards/${id}/upload`, headers: { cookie },
      payload: { name: "shot.png", content: "aGVsbG8=" },
    });
    expect(res.json()).toEqual({ path: "/work/.uploads/x/1-image.png" });
  });

  it("400s an upload the workspace rejects", async () => {
    const id = await makeCard();
    uploadCardImage.mockRejectedValueOnce(new Error("invalid base64 content"));
    const res = await app.inject({
      method: "POST", url: `/api/cards/${id}/upload`, headers: { cookie }, payload: { name: "x", content: "!!!" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("session routes require a session", () => {
  it("401s without a cookie", async () => {
    const id = await makeCard();
    for (const url of [`/api/cards/${id}/open`, `/api/cards/${id}/pause`, "/api/cards/restart-all"]) {
      expect((await app.inject({ method: "POST", url })).statusCode, url).toBe(401);
    }
  });
});

describe("terminal transport tuning", () => {
  it("turns Nagle off on the socket under the websocket — a 1-byte echo must not wait ~40ms", async () => {
    const { disableNagle } = await import("./session.js");
    const setNoDelay = vi.fn();
    expect(disableNagle({ _socket: { setNoDelay } })).toBe(true);
    expect(setNoDelay).toHaveBeenCalledWith(true);
  });

  it("survives a socket with no raw handle (adapters, tests) instead of throwing", async () => {
    const { disableNagle } = await import("./session.js");
    expect(disableNagle({})).toBe(false);
    expect(disableNagle(null)).toBe(false);
    expect(disableNagle({ _socket: { setNoDelay: () => { throw new Error("closing"); } } })).toBe(false);
  });
});
