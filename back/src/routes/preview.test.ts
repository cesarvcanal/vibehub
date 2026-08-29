import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket } from "ws";

/**
 * The preview surface, end to end against a REAL upstream on localhost:
 *
 *  - the ports endpoint (executor mocked — the scan itself is unit-tested in services/preview);
 *  - the HTTP proxy: bytes reach the app with the rewritten path and forwarded headers, and the
 *    app's response comes back verbatim; nothing listening → a clean 502;
 *  - the WEBSOCKET relay (vite HMR is the reason the feature exists): echo through the tunnel;
 *  - auth: both paths refuse a caller with no session.
 *
 * The tunnel command normally runs socat through docker; here pipeCommand is resolved to a tiny
 * node relay that connects to the same port on the test host — the exact stdio contract socat has.
 */

let dir = "";
let app: FastifyInstance;
let cookie = "";
let appPort = 0;

const runScript = vi.fn();

/** stdio↔TCP relay, standing in for `docker exec … socat STDIO TCP:127.0.0.1:<port>`. */
function relayArgv(remoteCommand: string): { file: string; args: string[] } {
  const port = /TCP:127\.0\.0\.1:(\d+)/.exec(remoteCommand)?.[1] ?? "0";
  const js =
    `const net=require("net");const s=net.connect(${port},"127.0.0.1");` +
    `s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0));` +
    `process.stdin.pipe(s);s.pipe(process.stdout);`;
  return { file: process.execPath, args: ["-e", js] };
}

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  vi.doMock("../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../runtime/host.js")>("../runtime/host.js");
    return {
      ...actual,
      hostExecutor: () => ({
        kind: "local" as const,
        label: "test",
        runScript,
        writeFile: vi.fn(),
        ptyCommand: (cmd: string) => ({ file: "bash", args: ["-lc", cmd] }),
        pipeCommand: relayArgv,
      }),
    };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.listen({ port: 0, host: "127.0.0.1" });
  appPort = (server.server.address() as AddressInfo).port;
  return server;
}

async function signIn(): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  });
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-preview-"));
  runScript.mockReset();
  app = await boot();
  cookie = await signIn();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  vi.doUnmock("../runtime/host.js");
});

describe("GET /api/preview/ports", () => {
  it("scans the runner and returns the parsed ports", async () => {
    runScript.mockResolvedValueOnce({
      stdout: [
        "   1: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 77 1",
        "__VIBEHUB_PROC__",
        "77 12 node",
      ].join("\n"),
      stderr: "",
    });
    const res = await app.inject({ method: "GET", url: "/api/preview/ports", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ports).toEqual([{ port: 5173, address: "loopback", process: "node", pid: 12 }]);
  });

  it("turns an unreachable runner into a 502, not a crash", async () => {
    runScript.mockRejectedValueOnce(new Error("docker not reachable"));
    const res = await app.inject({ method: "GET", url: "/api/preview/ports", headers: { cookie } });
    expect(res.statusCode).toBe(502);
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/preview/ports" });
    expect(res.statusCode).toBe(401);
  });
});

describe("/preview/:port proxy", () => {
  it("relays a request into the runner and the response back verbatim", async () => {
    const seen: { url?: string; prefix?: string; session?: string } = {};
    const upstream = createServer((req, res) => {
      seen.url = req.url;
      seen.prefix = String(req.headers["x-forwarded-prefix"]);
      seen.session = String(req.headers.cookie ?? "");
      res.writeHead(200, { "content-type": "text/plain", "x-app": "mine" });
      res.end("hello from the runner");
    });
    const port = await listen(upstream);
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/preview/${port}/hello?x=1`, {
        headers: { cookie, "accept": "text/plain" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-app")).toBe("mine");
      expect(await res.text()).toBe("hello from the runner");
      expect(seen.url).toBe("/hello?x=1");
      expect(seen.prefix).toBe(`/preview/${port}`);
      // vibehub's bearer credential never crosses into the previewed app.
      expect(seen.session).not.toContain("vibehub_session");
    } finally {
      upstream.close();
    }
  });

  it("forwards a request body", async () => {
    let body = "";
    const upstream = createServer((req, res) => {
      req.on("data", (d: Buffer) => { body += d.toString(); });
      req.on("end", () => { res.writeHead(200); res.end("ok"); });
    });
    const port = await listen(upstream);
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/preview/${port}/api`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"a":1}',
      });
      expect(res.status).toBe(200);
      expect(body).toBe('{"a":1}');
    } finally {
      upstream.close();
    }
  });

  it("answers 502 when nothing is listening on the port", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/preview/59999/`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toContain("59999");
  });

  it("redirects /preview/<port> to the trailing slash so relative URLs resolve", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/preview/3000`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/preview/3000/");
  });

  it("rejects an out-of-range port", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/preview/99999/x`, { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("requires a session", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/preview/3000/`);
    expect(res.status).toBe(401);
  });

  it("relays websockets both ways — the HMR path", async () => {
    const upstream = createServer();
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (socket) => {
      socket.on("message", (data: Buffer) => socket.send(`echo:${data.toString()}`));
    });
    const port = await listen(upstream);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${appPort}/preview/${port}/hmr`, { headers: { cookie } });
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws relay timed out")), 8000);
        ws.on("open", () => ws.send("ping"));
        ws.on("message", (data: Buffer) => { clearTimeout(timer); resolve(data.toString()); });
        ws.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
      expect(reply).toBe("echo:ping");
      ws.close();
    } finally {
      wss.close();
      upstream.close();
    }
  });

  it("refuses a websocket upgrade with no session", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/preview/3000/hmr`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });

  it("leaves other upgrades (terminals) to their own listeners", async () => {
    // The runner terminal route exists and its upgrade must still be routed by @fastify/websocket —
    // an unauthenticated attempt is REJECTED by that route rather than swallowed by the preview
    // interceptor (which would surface as a hang or a preview 502).
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/runner/terminal`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("unexpected-response", (_req, res) => resolve(`status:${res.statusCode}`));
      ws.on("error", () => resolve("refused"));
    });
    expect(outcome).toMatch(/status:401|refused/);
  });
});
