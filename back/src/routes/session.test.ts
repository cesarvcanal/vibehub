import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { parseTerminalFrame, isValidTermSize, needsProvisioning, stillPausedAfterGrace } from "./session.js";

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
/** Card creation pre-provisions in the background; these tests have no runner to do it in. */
const prepareCard = vi.fn(async () => undefined);
const pauseCard = vi.fn();
const restartCard = vi.fn();
const hibernateCard = vi.fn();
const restartAllCards = vi.fn();
const purgeCardWorkspace = vi.fn();
const uploadCardImage = vi.fn();
const readCardUpload = vi.fn();
/** The terminal websocket's pty — never a real process here; see `fakeTerm`. */
const ptySpawn = vi.fn();
/** The VNC bridge's argv; each test picks the process standing in for `docker exec … socat`. */
const cardVncBridge = vi.fn();
/**
 * Fire-and-forget board write from the websocket; a test makes it reject (a disk that refused).
 * A PLAIN function on purpose: a `vi.fn` subscribes to the promises it returns to record them,
 * which would mark the rejection handled and hide exactly what the test is looking for.
 */
let markCardHumanActive: (cardId: string) => Promise<unknown> = async () => undefined;
/** Records the status writes the websocket makes (the real write still happens behind it). */
const appliedStatus = vi.fn();

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
    return {
      ...actual,
      openCard, prepareCard, pauseCard, restartCard, hibernateCard, restartAllCards, purgeCardWorkspace,
      uploadCardImage, readCardUpload,
    };
  });
  vi.doMock("node-pty", () => ({ default: { spawn: ptySpawn } }));
  vi.doMock("../services/browser/browser.js", async () => {
    const actual = await vi.importActual<typeof import("../services/browser/browser.js")>(
      "../services/browser/browser.js",
    );
    return { ...actual, cardVncBridge };
  });
  vi.doMock("../services/board/registry.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/registry.js")>(
      "../services/board/registry.js",
    );
    return {
      ...actual,
      markCardHumanActive: (cardId: string) => markCardHumanActive(cardId),
      applyCardStatus: async (cardId: string, status: Parameters<typeof actual.applyCardStatus>[1]) => {
        appliedStatus(cardId, status);
        return await actual.applyCardStatus(cardId, status);
      },
    };
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

  it("hibernates a card, and answers with the card unchanged when there is nothing to hibernate", async () => {
    const id = await makeCard();
    hibernateCard.mockResolvedValueOnce({ id, column: "waiting", hibernatedAt: 42 });
    const cold = await app.inject({ method: "POST", url: `/api/cards/${id}/hibernate`, headers: { cookie } });
    expect(cold.statusCode).toBe(200);
    expect(cold.json().card.hibernatedAt).toBe(42);
    expect(hibernateCard).toHaveBeenCalledWith(id);

    // Nothing to do (working, already cold, never opened) is not an error — the card comes back as is.
    hibernateCard.mockResolvedValueOnce(undefined);
    const noop = await app.inject({ method: "POST", url: `/api/cards/${id}/hibernate`, headers: { cookie } });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().card.id).toBe(id);
    expect(noop.json().card.hibernatedAt).toBeUndefined();

    // An id that is not on the board at all still 404s.
    hibernateCard.mockResolvedValueOnce(undefined);
    expect(
      (await app.inject({ method: "POST", url: "/api/cards/ghost/hibernate", headers: { cookie } })).statusCode,
    ).toBe(404);
  });

  it("restarts everything at once", async () => {
    restartAllCards.mockResolvedValueOnce({ restarted: 3, skipped: 1 });
    const res = await app.inject({ method: "POST", url: "/api/cards/restart-all", headers: { cookie } });
    expect(res.json()).toEqual({ restarted: 3, skipped: 1 });
  });

  it("DELETE is a PURGE: the runner side is erased and the card leaves the board, completely", async () => {
    const id = await makeCard();
    const res = await app.inject({ method: "DELETE", url: `/api/cards/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(purgeCardWorkspace).toHaveBeenCalled();
    // The answer carries the purge report, which is what the UI shows the user. (This test has no
    // docker, so the browser teardown is the one step that cannot succeed here; the report's
    // completeness with a runner is pinned in services/board/purge.test.ts.)
    expect(res.json().ok).toBe(true);
    expect(res.json().incomplete).not.toContain("runner");
    expect(res.json().steps.map((s: { name: string }) => s.name)).toEqual(
      ["sessions", "previews", "browser", "board", "runner", "chat-history", "provenance", "inflight", "outbox"],
    );
    expect((await app.inject({ method: "GET", url: `/api/cards/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it("still deletes the card when the runner cannot be cleaned — and SAYS what survived", async () => {
    const id = await makeCard();
    purgeCardWorkspace.mockRejectedValueOnce(new Error("runner unreachable"));
    const res = await app.inject({ method: "DELETE", url: `/api/cards/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // A dead runner must not make a card undeletable, and must not be reported as a clean delete:
    // the orphan sweep is what finishes the job.
    expect(res.json().incomplete).toContain("runner");
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

  it("serves an uploaded image back, as the image, cached for good", async () => {
    const id = await makeCard();
    const body = Buffer.from("PNG-ish content");
    readCardUpload.mockResolvedValueOnce({ body, contentType: "image/png" });
    const res = await app.inject({
      method: "GET", url: `/api/cards/${id}/uploads/1790375878344-shot.png`, headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.rawPayload.equals(body)).toBe(true);
    expect(readCardUpload).toHaveBeenCalledWith(id, "1790375878344-shot.png");
  });

  it("404s an upload that is not there — the chat falls back to printing the path", async () => {
    const id = await makeCard();
    readCardUpload.mockRejectedValueOnce(new Error("upload not found"));
    const res = await app.inject({
      method: "GET", url: `/api/cards/${id}/uploads/1790375878344-gone.png`, headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
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

/**
 * The websocket is the fast path: it attaches with `tmux new-session -A` and does not wait for
 * anything. That is only safe once the card HAS a workspace — otherwise tmux creates the session in
 * whatever directory it can, and what you get is a terminal with no Claude in it.
 */
describe("attaching a terminal to a card that has no workspace yet", () => {
  it("needsProvisioning: only a card that was never opened AND never prepared", () => {
    expect(needsProvisioning({ openedAt: undefined, preparedAt: undefined })).toBe(true);
    expect(needsProvisioning({ openedAt: 1, preparedAt: undefined })).toBe(false);
    // Pre-provisioned at creation: the worktree and the session are already there.
    expect(needsProvisioning({ openedAt: undefined, preparedAt: 1 })).toBe(false);
    expect(needsProvisioning({ openedAt: 1, preparedAt: 1 })).toBe(false);
  });
});

/**
 * A PAUSE HAS TO STICK.
 *
 * The deck keeps every pane it has ever opened mounted and connected, so pausing a card drops that
 * pane's socket and `reconnect.ts` dials again 400ms later — and the attach is `tmux new-session -A`,
 * which RECREATES the very session the pause just killed. The card came back to life and, once its
 * pane also re-ran `POST /open`, landed in Waiting: "I click pause and it goes to waiting; I click
 * again and then it pauses". The attach now refuses a paused card instead of resurrecting it.
 */
describe("a terminal attach never resurrects a paused card", () => {
  const noSleep = async () => {};

  it("refuses when the card is still paused after the grace period", async () => {
    const read = async () => ({ pausedAt: 1 });
    expect(await stillPausedAfterGrace("c1", read, noSleep, 0)).toBe(true);
  });

  it("lets a card that was never paused through untouched", async () => {
    const read = async () => ({ pausedAt: null });
    expect(await stillPausedAfterGrace("c1", read, noSleep, 0)).toBe(false);
  });

  /**
   * Opening a paused card is a RACE the open has to win: the card has been opened before, so the
   * front attaches instantly while `POST /open` is still clearing `pausedAt`. The grace period is
   * what tells a real open apart from a reconnect — without it, deliberately resuming a paused card
   * would be refused by its own websocket.
   */
  it("lets the attach through as soon as an open in flight lifts the pause", async () => {
    let calls = 0;
    const read = async () => ({ pausedAt: ++calls < 3 ? 1 : null });
    expect(await stillPausedAfterGrace("c1", read, noSleep, 10_000)).toBe(false);
    expect(calls).toBe(3);
  });

  /** A card deleted mid-attach reads as undefined: nothing to keep parked, let the caller carry on. */
  it("does not refuse a card that no longer exists", async () => {
    const read = async () => undefined;
    expect(await stillPausedAfterGrace("c1", read, noSleep, 0)).toBe(false);
  });
});

describe("session routes require a session", () => {
  it("401s without a cookie", async () => {
    const id = await makeCard();
    for (const url of [
      `/api/cards/${id}/open`,
      `/api/cards/${id}/pause`,
      `/api/cards/${id}/hibernate`,
      "/api/cards/restart-all",
    ]) {
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

describe("human-active stamping throttle", () => {
  it("writes at most once per window per card, then again after it passes", async () => {
    const { shouldStampHumanActive, resetHumanStampThrottleForTesting, HUMAN_ACTIVE_THROTTLE_MS } = await import("./session.js");
    resetHumanStampThrottleForTesting();
    const t0 = 1_000_000;
    expect(shouldStampHumanActive("card-a", t0)).toBe(true); // first keystroke stamps
    expect(shouldStampHumanActive("card-a", t0 + 100)).toBe(false); // within the window — no write
    expect(shouldStampHumanActive("card-a", t0 + HUMAN_ACTIVE_THROTTLE_MS)).toBe(true); // window passed
    // the gate is per-card
    expect(shouldStampHumanActive("card-b", t0 + 100)).toBe(true);
  });
});

/* ------------------------------------------------------------------ websockets */

/** A pty that records what the bridge does to it. */
function fakeTerm(): { onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  return { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
}

async function connect(path: string): Promise<WebSocket> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { cookie } });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve();
    else ws.once("close", () => resolve());
  });
}

/** Lets the server drain what is in flight (socket events, settled promises). */
const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The terminal's setup can take seconds (the paused-card grace) or minutes (provisioning a card
 * that was never opened). Whatever the browser does in that window must not be lost.
 */
describe("terminal websocket setup", () => {
  /** A card that was never opened: the attach provisions it first, and the test holds that open. */
  function holdTheOpen(): () => void {
    let release = (): void => {};
    openCard.mockImplementationOnce(() => new Promise<void>((resolve) => { release = () => resolve(); }));
    return () => release();
  }

  it("a socket that closes while the card is being prepared never spawns a pty — it would be orphaned for good", async () => {
    const id = await makeCard();
    const release = holdTheOpen();
    const ws = await connect(`/api/cards/${id}/terminal`);
    await settle();
    ws.close();
    await closed(ws);
    await settle();
    release();
    await settle();
    expect(openCard).toHaveBeenCalledWith(id);
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  it("the resize the browser sends on open, before the pty exists, still sizes the pty", async () => {
    const term = fakeTerm();
    ptySpawn.mockReturnValueOnce(term);
    const id = await makeCard();
    const release = holdTheOpen();
    const ws = await connect(`/api/cards/${id}/terminal`);
    ws.send(JSON.stringify({ type: "resize", cols: 200, rows: 50 }));
    await settle();
    release();
    await vi.waitFor(() => expect(ptySpawn).toHaveBeenCalled());
    expect(term.resize).toHaveBeenCalledWith(200, 50);
    ws.close();
    await closed(ws);
  });

  /**
   * What the setup keeps for the bridge is bounded: provisioning can take minutes, and an unbounded
   * buffer let one socket grow the server's memory for as long as the clone ran (each frame can be
   * up to maxPayload). Past the cap the socket is closed 1009 — and never attached.
   */
  it("frames piling up while the card is prepared close the socket 1009 instead of growing memory", async () => {
    const { EARLY_FRAMES_MAX_BYTES } = await import("./session.js");
    const id = await makeCard();
    const release = holdTheOpen();
    const ws = await connect(`/api/cards/${id}/terminal`);
    const code = new Promise<number>((resolve) => ws.once("close", (c: number) => resolve(c)));
    const chunk = "x".repeat(Math.ceil(EARLY_FRAMES_MAX_BYTES / 2));
    for (let i = 0; i < 3; i++) ws.send(chunk);
    expect(await code).toBe(1009);
    release();
    await settle();
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  /**
   * The 1009 close is a HANDSHAKE: the server's `close` event only fires once the peer answers (up to
   * ws's 30s closeTimeout). A setup that ends inside that window must not attach to a socket that
   * is already closing. Pausing the client's reads holds the handshake open deterministically.
   */
  it("a setup that ends while the 1009 close is still in flight does not spawn a pty", async () => {
    const { EARLY_FRAMES_MAX_BYTES } = await import("./session.js");
    const id = await makeCard();
    const release = holdTheOpen();
    const ws = await connect(`/api/cards/${id}/terminal`);
    const chunk = "x".repeat(Math.ceil(EARLY_FRAMES_MAX_BYTES / 2));
    for (let i = 0; i < 3; i++) ws.send(chunk);
    const raw = (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    raw.pause(); // the server's close frame is never read, so its handshake never completes
    await settle();
    release();
    await settle();
    expect(ptySpawn).not.toHaveBeenCalled();
    raw.resume();
    ws.terminate();
  });

  /**
   * The setup's slow path IS the paused card's grace — exactly when a person types before the pty
   * exists. What they typed reaches the pty through the replay; it must revive the card as well,
   * or the card sits in `done`/`paused` (and the idle sweep treats it as parked) while it works.
   */
  it("typing into a finished card before the pty exists revives it, like typing after", async () => {
    const term = fakeTerm();
    ptySpawn.mockReturnValueOnce(term);
    const id = await makeCard();
    const moved = await app.inject({
      method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { column: "done" },
    });
    expect(moved.statusCode).toBe(200);
    const release = holdTheOpen();
    const ws = await connect(`/api/cards/${id}/terminal`);
    ws.send("ls\r");
    await settle();
    release();
    await vi.waitFor(() => expect(term.write).toHaveBeenCalledWith("ls\r"));
    await vi.waitFor(() => expect(appliedStatus).toHaveBeenCalledWith(id, "working"));
    ws.close();
    await closed(ws);
  });

  it("a board write that fails behind a keystroke never becomes an unhandled rejection", async () => {
    const { resetHumanStampThrottleForTesting } = await import("./session.js");
    resetHumanStampThrottleForTesting();
    const term = fakeTerm();
    ptySpawn.mockReturnValueOnce(term);
    openCard.mockResolvedValueOnce(undefined);
    const stamped = vi.fn();
    markCardHumanActive = (cardId) => {
      stamped(cardId);
      return Promise.reject(new Error("disk full"));
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const id = await makeCard();
      const ws = await connect(`/api/cards/${id}/terminal`);
      await vi.waitFor(() => expect(ptySpawn).toHaveBeenCalled());
      ws.send("x");
      await vi.waitFor(() => expect(stamped).toHaveBeenCalled());
      await settle();
      expect(term.write).toHaveBeenCalledWith("x");
      expect(unhandled).not.toHaveBeenCalled();
      ws.close();
      await closed(ws);
    } finally {
      process.off("unhandledRejection", unhandled);
      markCardHumanActive = async () => undefined;
    }
  });
});

/**
 * The VNC relay pipes the browser's frames into a child process. A child that cannot start, or
 * that dies while frames keep arriving, must cost that one socket — never the whole server.
 */
describe("vnc websocket", () => {
  it("a bridge that cannot even start closes the socket instead of crashing the process", async () => {
    cardVncBridge.mockResolvedValueOnce({
      command: { file: "vibehub-no-such-binary-for-the-test", args: [] },
      ports: { display: 1, vncPort: 5901, cdpPort: 9301 },
    });
    const id = await makeCard();
    const ws = await connect(`/api/cards/${id}/vnc`);
    ws.on("error", () => { /* the server hanging up is the point */ });
    await closed(ws);
  });

  it("frames that keep coming after the bridge died do not take the server down (EPIPE)", async () => {
    // Exits at once without reading stdin: every frame written after that is a write to a dead pipe.
    cardVncBridge.mockResolvedValueOnce({
      command: { file: process.execPath, args: ["-e", "process.exit(0)"] },
      ports: { display: 1, vncPort: 5901, cdpPort: 9301 },
    });
    const id = await makeCard();
    const ws = await connect(`/api/cards/${id}/vnc`);
    ws.on("error", () => { /* the server hanging up is the point */ });
    const frame = Buffer.alloc(256 * 1024, 1);
    for (let i = 0; i < 20 && ws.readyState === WebSocket.OPEN; i++) {
      ws.send(frame);
      await settle(20);
    }
    await closed(ws);
    await settle();
  });
});
