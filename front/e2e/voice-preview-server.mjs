/**
 * PREVIEW SERVER for the voice call in the card chat — what the vibehub preview proxy
 * (`/preview/<port>/`) opens. Real: the built front (base `/preview/<port>/`), a real isolated
 * vibehub back-end (auth, board, voice turns saved to its own data dir). Simulated, because the
 * runner has neither: the card's Claude driver (the `/api/cards/:id/sdk` websocket replays the
 * card's real history and answers typed messages) and GPT-Live (front/e2e/voice-demo.js, injected
 * into the page; `/voice/sessions` answers a dummy SDP).
 *
 *   node front/e2e/voice-preview-server.mjs --port 4417 --back http://127.0.0.1:3923 \
 *     --dist <built front> --data <back data dir>
 */
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { WebSocketServer } = createRequire(join(here, "../../back/package.json"))("ws");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port);
const BACK = new URL(args.back);
const DIST = args.dist;
const DATA = args.data;
const DEMO = readFileSync(join(here, "voice-demo.js"), "utf8");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json", ".ico": "image/x-icon" };

function history(card) {
  const file = join(DATA, "sdk-history", `${card}.ndjson`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

function proxy(req, res) {
  const up = request(
    { host: BACK.hostname, port: BACK.port, method: req.method, path: req.url, headers: { ...req.headers, host: BACK.host } },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end('{"error":"preview back-end is down"}');
  });
  req.pipe(up);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (/^\/api\/cards\/[^/]+\/voice\/sessions$/.test(url.pathname) && req.method === "POST") {
    req.resume();
    res.writeHead(201, { "content-type": "application/json" });
    return res.end('{"sessionId":"sess_demo","sdp":"v=0 demo"}');
  }
  if (url.pathname.startsWith("/api/")) return proxy(req, res);
  if (url.pathname === "/voice-demo.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    return res.end(DEMO);
  }
  // Static build, SPA fallback; the page gets the demo before the app.
  const file = normalize(join(DIST, url.pathname));
  if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() && !file.endsWith("index.html")) {
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "public, max-age=300" });
    return res.end(readFileSync(file));
  }
  const prefix = req.headers["x-forwarded-prefix"] ?? "";
  const html = readFileSync(join(DIST, "index.html"), "utf8").replace("<head>", `<head><script src="${prefix}/voice-demo.js"></script>`);
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(html);
});

// The card's driver, simulated: replay its real history, acknowledge and answer typed messages.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const m = /^\/api\/cards\/([^/]+)\/sdk/.exec(req.url ?? "");
  if (m) {
    return wss.handleUpgrade(req, socket, head, (ws) => {
      for (const line of history(m[1])) ws.send(line);
      ws.send(JSON.stringify({ type: "ready" }));
      ws.on("message", (raw) => {
        let frame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.type !== "user") return;
        ws.send(JSON.stringify({ type: "user_ack", cid: frame.cid }));
        const reply = `(demonstração — o agente do card é simulado neste preview) Recebi: "${String(frame.text).slice(0, 200)}".`;
        setTimeout(() => ws.send(JSON.stringify({ type: "assistant_delta", text: reply.slice(0, 40) })), 700);
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "assistant_text", text: reply }));
          ws.send(JSON.stringify({ type: "result", isError: false }));
        }, 1800);
      });
    });
  }
  // Every other websocket goes to the real back-end untouched.
  const up = connect(Number(BACK.port), BACK.hostname, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`voice preview on 127.0.0.1:${PORT} → back ${BACK.href}`));
