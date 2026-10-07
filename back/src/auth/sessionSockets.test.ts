import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";

/**
 * The registry works on the server's `upgrade` event, not on any one route: a plain `ws` server
 * stands in here for the terminal, /sdk, /chat and VNC routes (the preview tunnel is covered end to
 * end in routes/preview.test.ts).
 */

let dir = "";
let server: Server;
let wss: WebSocketServer;
let port = 0;

async function fresh() {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.sessionSecret = "";
  return {
    users: await import("./users.js"),
    session: await import("./session.js"),
    sockets: await import("./sessionSockets.js"),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sockets-"));
  server = createServer();
  wss = new WebSocketServer({ noServer: true });
});
afterEach(async () => {
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

async function start(track: (s: Server) => void): Promise<void> {
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, () => undefined));
  track(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
}

async function open(token: string): Promise<{ ws: WebSocket; closed: Promise<void> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie: `vibehub_session=${token}` } });
  const closed = new Promise<void>((r) => ws.on("close", () => r()));
  await new Promise<void>((resolve, reject) => { ws.on("open", () => resolve()); ws.on("error", reject); });
  return { ws, closed };
}

describe("endRevokedSessionSockets", () => {
  it("closes the sockets of a revoked session and leaves a still-valid one open", async () => {
    const { users, session, sockets } = await fresh();
    await start(sockets.trackSessionSockets);
    const ada = await users.createUser("ada", "supersecret");
    const old = await open(await session.issueToken(ada.id, Date.now() - 1000));

    await users.changePassword(ada.id, "anothersecret");
    const renewed = await open(await session.issueToken(ada.id, Date.now() + 1000));
    await sockets.endRevokedSessionSockets(ada.id);

    await old.closed;
    expect(renewed.ws.readyState).toBe(WebSocket.OPEN);
    renewed.ws.close();
  });

  it("touches nobody else's sockets", async () => {
    const { users, session, sockets } = await fresh();
    await start(sockets.trackSessionSockets);
    const ada = await users.createUser("ada", "supersecret");
    const bob = await users.createUser("bob", "supersecret");
    const bobs = await open(await session.issueToken(bob.id));
    const adas = await open(await session.issueToken(ada.id));

    await users.removeUser(ada.id);
    await sockets.endRevokedSessionSockets(ada.id);

    await adas.closed;
    expect(bobs.ws.readyState).toBe(WebSocket.OPEN);
    bobs.ws.close();
  });
});
