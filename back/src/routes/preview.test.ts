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

describe("preview lifecycle routes", () => {
  /** A card with a registered preview, written through the SAME registry the booted server uses. */
  async function seedPreview(recipe: { command?: string; cwd?: string } = {}): Promise<string> {
    const registry = await import("../services/board/registry.js");
    const project = await registry.createProject({ name: "Shop" });
    const card = await registry.createCard({ projectId: project.id, title: "Checkout" });
    await registry.registerCardPreview(card.id, 5173, { label: "front", ...recipe });
    return card.id;
  }

  it("POST restart: 409 with the 'ask the agent' message when there is no stored command", async () => {
    const cardId = await seedPreview();
    const res = await app.inject({
      method: "POST", url: `/api/cards/${cardId}/previews/5173/restart`, headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no stored start command/);
  });

  it("POST restart: relaunches and answers with the proxy path once the port listens", async () => {
    const cardId = await seedPreview({ command: "npm run dev", cwd: "/work/app" });
    runScript.mockImplementation((script: string) => {
      if (script.includes("new-session")) return Promise.resolve({ stdout: "", stderr: "" });
      return Promise.resolve({
        stdout: "   1: 00000000:1435 00000000:0000 0A 0:0 0:0 0 0 1 1\n__VIBEHUB_PROC__\n",
        stderr: "",
      });
    });
    const res = await app.inject({
      method: "POST", url: `/api/cards/${cardId}/previews/5173/restart`, headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ restarted: true, port: 5173, path: "/preview/5173/" });
  });

  it("DELETE: kills the dedicated session, removes the chip; a second stop is a 409", async () => {
    const cardId = await seedPreview({ command: "npm run dev", cwd: "/work/app" });
    runScript.mockResolvedValue({ stdout: "", stderr: "" });
    const res = await app.inject({
      method: "DELETE", url: `/api/cards/${cardId}/previews/5173`, headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true, port: 5173 });
    const registry = await import("../services/board/registry.js");
    expect((await registry.getCard(cardId))?.previews).toBeUndefined();

    const again = await app.inject({
      method: "DELETE", url: `/api/cards/${cardId}/previews/5173`, headers: { cookie },
    });
    expect(again.statusCode).toBe(409);
  });

  it("both routes require a session", async () => {
    const cardId = await seedPreview();
    for (const [method, url] of [
      ["POST", `/api/cards/${cardId}/previews/5173/restart`],
      ["DELETE", `/api/cards/${cardId}/previews/5173`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
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

  it("relays a response that only arrives after a delay — the tunnel must not half-close early", async () => {
    // The prod bug: the relay ended the tunnel's stdin right after the request, socat half-closed
    // the upstream connection (FIN), and a Node http server destroys the socket on FIN — so any
    // response slower than the FIN's arrival came back as ZERO bytes and the user saw "nothing is
    // listening" with the port alive. A response written only later reproduces it deterministically.
    const upstream = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late but alive");
      }, 400);
    });
    const port = await listen(upstream);
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/preview/${port}/slow`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("late but alive");
    } finally {
      upstream.close();
    }
  });

  it("a slow response to a request WITH a body also survives — the body is delimited, not EOF-framed", async () => {
    let received = "";
    const upstream = createServer((req, res) => {
      req.on("data", (d: Buffer) => { received += d.toString(); });
      req.on("end", () => {
        setTimeout(() => { res.writeHead(200); res.end("ok:" + received); }, 300);
      });
    });
    const port = await listen(upstream);
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/preview/${port}/api`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"b":2}',
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok:{"b":2}');
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

  /**
   * The REDIRECT TRAP. A vite dev server with `base: '/preview/<port>/'` answers the path the proxy
   * hands it (`/`, prefix stripped) with a 302 back to `/preview/<port>/` — where the browser
   * already is. Left alone, the tab dies with ERR_TOO_MANY_REDIRECTS while the port is perfectly
   * alive, which is exactly how this reached a user.
   */
  it("absorbs a redirect back onto its own prefix and serves the page instead of looping", async () => {
    const paths: string[] = [];
    let port = 0;
    const upstream = createServer((req, res) => {
      paths.push(req.url ?? "");
      if (req.url === "/") {
        res.writeHead(302, { location: `/preview/${port}/` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><script src="/preview/${port}/@vite/client"></script>`);
    });
    port = await listen(upstream);
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/preview/${port}/`, {
        headers: { cookie, accept: "text/html" },
        redirect: "manual",
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("@vite/client");
      // Two upstream requests, one browser request: the second is the app's own base path, verbatim.
      expect(paths).toEqual(["/", `/preview/${port}/`]);
    } finally {
      upstream.close();
    }
  });

  it("absorbs ONE hop only — an app that keeps redirecting gets its 302 relayed, not a hang", async () => {
    let port = 0;
    let hits = 0;
    const upstream = createServer((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: `/preview/${port}/` });
      res.end();
    });
    port = await listen(upstream);
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/preview/${port}/`, {
        headers: { cookie, accept: "text/html" },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/preview/${port}/`);
      expect(hits).toBe(2);
    } finally {
      upstream.close();
    }
  });

  it("leaves an app that HONOURS x-forwarded-prefix alone — its redirect must reach the browser", async () => {
    let port = 0;
    const upstream = createServer((req, res) => {
      const prefix = String(req.headers["x-forwarded-prefix"] ?? "");
      if (req.url === "/") {
        res.writeHead(302, { location: `${prefix}/login` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("login page");
    });
    port = await listen(upstream);
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/preview/${port}/`, {
        headers: { cookie, accept: "text/html" },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/preview/${port}/login`);
    } finally {
      upstream.close();
    }
  });

  it("answers a JSON 502 when nothing is listening and the caller is not a navigation", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/preview/59999/`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toContain("59999");
  });

  it("a NAVIGATION to a dead REGISTERED preview gets the 'Preview parado' screen with Reiniciar", async () => {
    const registry = await import("../services/board/registry.js");
    const project = await registry.createProject({ name: "Shop" });
    const card = await registry.createCard({ projectId: project.id, title: "Checkout" });
    await registry.registerCardPreview(card.id, 59998, { label: "front", command: "npm run dev", cwd: "/work/app" });

    const res = await fetch(`http://127.0.0.1:${appPort}/preview/59998/`, {
      headers: { cookie, accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Preview &quot;front&quot; parado");
    expect(body).toContain("Reiniciar");
    // The restart call is RELATIVE — it must work on whatever host the panel is reached through.
    expect(body).toContain(`"/api/cards/${card.id}/previews/59998/restart"`);
  });

  it("a navigation to a dead UNREGISTERED port gets the screen with guidance, no button", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/preview/59997/`, {
      headers: { cookie, accept: "text/html" },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).not.toContain('id="restart"');
    expect(body).toContain("agente");
  });

  it("an ASSET request (non-html Accept) to a dead port keeps the structured JSON error", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/preview/59996/main.js`, {
      headers: { cookie, accept: "*/*" },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
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
