import { SLOT_SPACE, VNC_PORT_BASE, CDP_PORT_BASE } from "../browser/ports.js";
import { shQuote } from "../../runtime/host.js";

/**
 * PREVIEW — open, in the USER'S OWN BROWSER, an app that a card's agent started inside the runner
 * (a vite dev server, an API, anything listening on a TCP port).
 *
 * The runner publishes no ports and sits on a Docker bridge the user's machine cannot route to, so
 * "just link to it" does not exist. Instead vibehub PROXIES: `/preview/<port>/...` on the vibehub
 * origin is relayed into the runner over a per-connection tunnel — `docker exec … socat
 * STDIO TCP:127.0.0.1:<port>` through the host executor, the exact mechanism the VNC bridge already
 * uses. That choice buys two things a direct TCP hop would not:
 *
 *  - it reaches servers bound to LOOPBACK, which is what dev servers bind by default (vite!);
 *  - it works identically with a local Docker socket, Docker Desktop and an SSH-remote host,
 *    because nothing here knows where Docker lives.
 *
 * The cost is honesty about HTTP: each request rides its own tunnel (`connection: close`, no
 * keep-alive), which is fine for a preview and wrong for a load balancer. WebSockets (vite HMR) are
 * relayed byte-for-byte on one tunnel per socket, so they are unaffected.
 *
 * Everything in this file is PURE — script/head builders and parsers — so the seams are testable
 * without a runner. The I/O lives in routes/preview.ts.
 */

/* ------------------------------------------------------------------ ports */

/** Marker separating the /proc/net/tcp dump from the inode→process map in the scan output. */
export const PROC_MARKER = "__VIBEHUB_PROC__";

export interface ListeningPort {
  port: number;
  /** Where the server bound: loopback (127.0.0.1/::1), all interfaces, or a specific address. */
  address: "loopback" | "all" | "other";
  /** Best-effort process name (`comm`), when the inode could be mapped to a /proc entry. */
  process?: string;
  pid?: number;
}

/**
 * Ports vibehub itself occupies in the runner — the per-card browser plumbing. Listing them as
 * "your app" would only confuse; a slot is x11vnc RFB or Chromium CDP, never something to preview.
 */
export function isInfraPort(port: number): boolean {
  return (
    (port >= VNC_PORT_BASE && port < VNC_PORT_BASE + SLOT_SPACE) ||
    (port >= CDP_PORT_BASE && port < CDP_PORT_BASE + SLOT_SPACE)
  );
}

/**
 * Scan script, run on the HOST: dumps the runner's /proc/net/tcp{,6} plus a socket-inode→process
 * map (each open fd that is a socket, with its pid and comm). Parsing happens here in Node — the
 * runner image is not guaranteed to carry `ss` or `netstat`, but /proc is always there. PURE.
 */
export function listPortsScript(container: string): string {
  return [
    `docker exec -i ${shQuote(container)} sh -s <<'VIBEHUB_PORTS'`,
    "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null",
    `echo ${PROC_MARKER}`,
    'for fd in /proc/[0-9]*/fd/*; do',
    '  tgt=$(readlink "$fd" 2>/dev/null) || continue',
    "  case \"$tgt\" in",
    '    "socket:["*) pid=${fd#/proc/}; pid=${pid%%/*}; inode=${tgt#socket:[}; inode=${inode%]};',
    '      echo "$inode $pid $(cat /proc/$pid/comm 2>/dev/null)";;',
    "  esac",
    "done",
    "VIBEHUB_PORTS",
  ].join("\n");
}

/** Hex address classification for a /proc/net/tcp{,6} local_address field. */
function classifyAddress(hex: string): "loopback" | "all" | "other" {
  const h = hex.toUpperCase();
  if (/^0+$/.test(h)) return "all";
  // v4 loopback little-endian (0100007F) and v6 ::1 / v4-mapped ::ffff:127.0.0.1.
  if (h === "0100007F") return "loopback";
  if (h === "00000000000000000000000001000000") return "loopback";
  if (h === "0000000000000000FFFF00000100007F") return "loopback";
  return "other";
}

/**
 * Parses the scan output (see listPortsScript) into the LISTENING ports of the runner, one entry
 * per port, infra ports removed, sorted ascending. TOTAL: malformed lines are skipped, an empty or
 * garbage input yields []. PURE.
 */
export function parseListeningPorts(raw: string): ListeningPort[] {
  const markerAt = raw.indexOf(PROC_MARKER);
  const sockets = markerAt >= 0 ? raw.slice(0, markerAt) : raw;
  const procSection = markerAt >= 0 ? raw.slice(markerAt + PROC_MARKER.length) : "";

  const byInode = new Map<string, { pid: number; comm?: string }>();
  for (const line of procSection.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const comm = m[3]!.trim();
    byInode.set(m[1]!, { pid: Number(m[2]), comm: comm || undefined });
  }

  const byPort = new Map<number, ListeningPort>();
  for (const line of sockets.split("\n")) {
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode ...
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const local = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/.exec(cols[1]!);
    if (!local) continue;
    if (cols[3] !== "0A") continue; // TCP_LISTEN
    const port = Number.parseInt(local[2]!, 16);
    if (!Number.isInteger(port) || port <= 0 || isInfraPort(port)) continue;
    const address = classifyAddress(local[1]!);
    const proc = byInode.get(cols[9]!);
    const existing = byPort.get(port);
    // A port listening on v4 and v6 is ONE server; prefer the row that knows its process, then the
    // widest binding (so ":: + 127.0.0.1" reads as reachable rather than loopback-only).
    if (!existing || (!existing.process && proc?.comm) || (existing.address !== "all" && address === "all")) {
      byPort.set(port, {
        port,
        address,
        process: proc?.comm ?? existing?.process,
        pid: proc?.pid ?? existing?.pid,
      });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/* ----------------------------------------------------------------- tunnel */

/** A usable TCP port for the proxy path. */
export function isValidPreviewPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The tunnel's remote command: socat wiring the process stdio to the app's port on the RUNNER'S
 * loopback (which reaches every binding — loopback, wildcard or container IP). One tunnel per
 * client connection. The port is validated numeric; the container name is shQuoted. PURE.
 */
export function tunnelRemoteCommand(container: string, port: number): string {
  if (!isValidPreviewPort(port)) throw new Error(`invalid preview port: ${port}`);
  return `docker exec -i ${shQuote(container)} socat STDIO TCP:127.0.0.1:${port}`;
}

/* ------------------------------------------------------------ URL parsing */

export interface PreviewTarget {
  port: number;
  /** Path AS THE APP SEES IT: prefix stripped, query kept, always starting with "/". */
  path: string;
}

/**
 * `/preview/<port>/<rest>?<query>` → the port and the path the upstream app should receive.
 * `/preview/<port>` (no slash) also matches — the route answers it with a redirect, but the upgrade
 * interceptor needs the match too. Anything else → null. PURE, TOTAL.
 */
export function parsePreviewTarget(url: string): PreviewTarget | null {
  const m = /^\/preview\/(\d{1,5})(\/[^\s]*)?$/.exec(url);
  if (!m) return null;
  const port = Number(m[1]);
  if (!isValidPreviewPort(port)) return null;
  return { port, path: m[2] && m[2].length > 0 ? m[2] : "/" };
}

/* ----------------------------------------------------------- request head */

/** Hop-by-hop headers a proxy must not forward (RFC 9110 §7.6.1), plus what we recompute. */
const DROP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  // Forwarded-* are re-derived here, never trusted from the client.
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-forwarded-prefix",
]);

/**
 * Removes vibehub's own session cookie from a Cookie header before it crosses into the previewed
 * app. That app is the user's, running in their runner — but the session cookie is a bearer
 * credential for vibehub itself, and no upstream needs it. PURE.
 */
export function stripSessionCookie(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("vibehub_session="))
    .join("; ");
}

export interface ProxyHeadOpts {
  kind: "http" | "upgrade";
  method: string;
  /** Path as the app sees it (from parsePreviewTarget). */
  path: string;
  port: number;
  /** The client's request headers (node's lowercased view). */
  headers: Record<string, string | string[] | undefined>;
  clientIp?: string;
  /** Body length for entity-bearing requests; the body itself is written after the head. */
  bodyLength?: number;
}

/**
 * Serializes the request head sent to the upstream app: the rewritten request line, the client's
 * headers minus hop-by-hop ones, the X-Forwarded-* set, and the connection policy — `close` for
 * plain HTTP (one tunnel per request), the original websocket fields for an upgrade. PURE.
 *
 * `X-Forwarded-Prefix: /preview/<port>` is the app's chance to generate correct absolute URLs; an
 * app that ignores it needs its base path configured (see docs/preview.md).
 */
export function buildProxyHead(o: ProxyHeadOpts): string {
  const lines: string[] = [`${o.method.toUpperCase()} ${o.path} HTTP/1.1`];
  const push = (name: string, value: string) => {
    // Node validates incoming headers, but a serializer that can emit CR/LF is a splitter waiting
    // to happen — strip defensively.
    lines.push(`${name}: ${value.replace(/[\r\n]+/g, " ")}`);
  };
  push("host", `127.0.0.1:${o.port}`);
  for (const [name, rawValue] of Object.entries(o.headers)) {
    const key = name.toLowerCase();
    if (rawValue === undefined || DROP_HEADERS.has(key)) continue;
    if (o.kind === "http" && key.startsWith("sec-websocket-")) continue;
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      if (key === "cookie") {
        const kept = stripSessionCookie(value);
        if (kept) push("cookie", kept);
      } else {
        push(name, value);
      }
    }
  }
  const originalHost = o.headers["x-forwarded-host"] ?? o.headers["host"];
  if (typeof originalHost === "string" && originalHost) push("x-forwarded-host", originalHost);
  push("x-forwarded-proto", "http");
  if (o.clientIp) push("x-forwarded-for", o.clientIp);
  push("x-forwarded-prefix", `/preview/${o.port}`);
  if (o.kind === "upgrade") {
    push("connection", "upgrade");
    const upgrade = o.headers["upgrade"];
    push("upgrade", typeof upgrade === "string" && upgrade ? upgrade : "websocket");
  } else {
    push("connection", "close");
    if ((o.bodyLength ?? 0) > 0 || !["GET", "HEAD", "OPTIONS", "DELETE"].includes(o.method.toUpperCase())) {
      push("content-length", String(o.bodyLength ?? 0));
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** The raw 502 written on a tunnel that never produced a byte (nothing listening, socat missing). */
export function badGatewayResponse(port: number): string {
  const body = JSON.stringify({
    error: `nothing answered on port ${port} inside the runner — is the server running and listening?`,
  });
  return rawResponse("application/json", body);
}

function rawResponse(contentType: string, body: string): string {
  return (
    `HTTP/1.1 502 Bad Gateway\r\ncontent-type: ${contentType}; charset=utf-8\r\n` +
    `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
  );
}

/* -------------------------------------------- upstream response / redirects */

/**
 * The REDIRECT TRAP this section exists for.
 *
 * The proxy strips `/preview/<port>` before handing the request to the app (parsePreviewTarget), so
 * an app configured with that prefix as its base — a vite dev server with `base: '/preview/5183/'`
 * is the case that burned us — sees a bare `/` and answers `302 Location: /preview/5183/`. The
 * browser is ALREADY at that URL: it asks again, the proxy strips again, the app redirects again,
 * and the tab dies with ERR_TOO_MANY_REDIRECTS.
 *
 * What tells a trap apart from an honest redirect is not "the Location has our prefix" — an app
 * that correctly honours X-Forwarded-Prefix emits exactly that, and those redirects MUST reach the
 * browser. It is whether following it would reproduce the very request we just sent upstream. That
 * is the only shape that cannot make progress, and it is the one the proxy absorbs (routes/preview.ts
 * re-issues it once, internally) instead of relaying.
 */

export interface UpstreamHead {
  status: number;
  /** Lowercased names, first value wins (Location and friends are single-valued). */
  headers: Record<string, string>;
  /** Byte length of the head, blank line included — where the body starts. */
  length: number;
}

/**
 * False as soon as the first bytes cannot be an HTTP/1 status line — a raw TCP app on the port, or
 * socat's own noise. The relay uses it to stop buffering and go back to moving bytes. PURE, TOTAL.
 */
export function looksLikeHttpResponse(raw: Buffer | string): boolean {
  const head = (typeof raw === "string" ? raw : raw.toString("latin1")).slice(0, 5);
  return "HTTP/".startsWith(head);
}

/**
 * Parses an upstream response HEAD, or null while it is still incomplete (or not HTTP). latin1 is
 * deliberate: one char per byte, so `length` is a byte offset into the original buffer and the body
 * that follows is never mangled by a decode. PURE, TOTAL.
 */
export function parseResponseHead(raw: Buffer | string): UpstreamHead | null {
  const text = typeof raw === "string" ? raw : raw.toString("latin1");
  const end = /\r?\n\r?\n/.exec(text);
  if (!end) return null;
  const lines = text.slice(0, end.index).split(/\r?\n/);
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] ?? "");
  if (!status) return null;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name in headers) continue;
    headers[name] = line.slice(colon + 1).trim();
  }
  return { status: Number(status[1]), headers, length: end.index + end[0].length };
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** The path+query of a Location, absolute-URL or absolute-path; anything else → null. PURE, TOTAL. */
function locationPath(location: string): string | null {
  const value = location.trim();
  if (!value) return null;
  // scheme://host/path and protocol-relative //host/path — the host is irrelevant here: the proxy
  // is the only way back in, so what matters is where on OUR origin the browser would land.
  const stripped = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/[^/?#]*(.*)$/.exec(value);
  const path = stripped ? stripped[1] || "/" : value;
  return path.startsWith("/") ? path : null;
}

export interface RedirectLook {
  status: number;
  location?: string;
  /** Only GET/HEAD can be absorbed — re-issuing a POST is not the proxy's call to make. */
  method?: string;
  port: number;
}

/**
 * The Location path when the response is a 3xx pointing INTO this preview's own prefix (any path
 * under it), else null. Says nothing about whether it loops — see loopingRedirectPath. PURE, TOTAL.
 */
export function prefixRedirectPath(o: RedirectLook): string | null {
  if (!["GET", "HEAD"].includes((o.method ?? "GET").toUpperCase())) return null;
  if (!REDIRECT_STATUS.has(o.status)) return null;
  const path = locationPath(o.location ?? "");
  if (!path) return null;
  const target = parsePreviewTarget(path);
  return target && target.port === o.port ? path : null;
}

/**
 * The Location path when following the redirect would reproduce the request we just sent upstream —
 * the loop, and the only case the proxy absorbs. `path` is what the app received (prefix already
 * stripped); the answer is the path to re-issue upstream, which is the Location VERBATIM: for an
 * app whose base is the prefix, that is the one path that actually serves content. PURE, TOTAL.
 */
export function loopingRedirectPath(o: RedirectLook & { path: string }): string | null {
  const location = prefixRedirectPath(o);
  if (!location) return null;
  const target = parsePreviewTarget(location);
  return target && target.path === o.path ? location : null;
}

/* ------------------------------------------------- stopped-preview screen */

/**
 * True when a failed proxy exchange should answer with the HUMAN screen instead of JSON: a
 * navigation — a person opening the link in a tab (GET + an Accept that asks for text/html).
 * Assets and API calls made BY the previewed app keep the structured JSON error. PURE, TOTAL.
 */
export function wantsHtmlInterstitial(method: string | undefined, accept: string | string[] | undefined): boolean {
  if ((method ?? "GET").toUpperCase() !== "GET") return false;
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  return typeof value === "string" && value.toLowerCase().includes("text/html");
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Minimal HTML escaping for the few dynamic values embedded in the interstitial. PURE, TOTAL. */
export function escapeHtml(value: string): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

export interface StoppedPageInfo {
  /** Card that registered this port, when one did — the restart endpoint is per card. */
  cardId?: string;
  /** The preview's label, purely for the headline. */
  label?: string;
  /** Whether a relaunch recipe (command + cwd) is stored — decides button vs guidance. */
  restartable: boolean;
}

/**
 * The "Preview parado" INTERSTITIAL: the full 502 response for a navigation that hit a dead port.
 * With a registered, relaunchable preview it renders a Reiniciar button that POSTs the per-card
 * restart endpoint (same-origin — the session cookie rides along, and the RELATIVE url keeps it
 * working on every host the panel is reached through) and reloads the tab once the port listens.
 * Without a recipe it says the honest thing: ask the card's agent to start the server again. PURE.
 */
export function stoppedPreviewPage(port: number, info: StoppedPageInfo): string {
  if (!isValidPreviewPort(port)) throw new Error(`invalid preview port: ${port}`);
  const name = escapeHtml(info.label?.trim() || `:${port}`);
  const action = info.restartable && info.cardId
    ? `<button id="restart" onclick="restart()">Reiniciar</button>
       <p id="status" hidden></p>
       <script>
         async function restart() {
           const btn = document.getElementById("restart");
           const status = document.getElementById("status");
           btn.disabled = true; status.hidden = false; status.textContent = "Reiniciando\\u2026";
           try {
             const res = await fetch(${JSON.stringify(`/api/cards/${info.cardId}/previews/${port}/restart`)}, { method: "POST" });
             if (!res.ok) {
               const body = await res.json().catch(() => null);
               throw new Error((body && body.error) || ("HTTP " + res.status));
             }
             status.textContent = "Preview no ar \\u2014 recarregando\\u2026";
             location.reload();
           } catch (err) {
             btn.disabled = false;
             status.textContent = "Falha ao reiniciar: " + (err && err.message ? err.message : err);
           }
         }
       </script>`
    : `<p class="muted">Este preview não tem um comando de relançamento registrado — peça ao agente
       do card para subir o servidor de novo (ele vai reanunciar o link com <code>vibehub_preview</code>).</p>`;
  const body = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview parado</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 system-ui, sans-serif; background: #f6f6f7; color: #1c1c1f; }
  @media (prefers-color-scheme: dark) { body { background: #141417; color: #e6e6ea; } }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  .muted { opacity: .7; font-size: .9rem; }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  button { margin-top: 1rem; padding: .55rem 1.4rem; font: inherit; border-radius: .5rem;
           border: 1px solid #d97706; background: #f59e0b22; color: inherit; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  #status { font-size: .85rem; opacity: .8; }
</style>
</head>
<body><main>
<h1>Preview &quot;${name}&quot; parado</h1>
<p class="muted">Nada está escutando na porta ${port} dentro do runner.</p>
${action}
</main></body></html>`;
  return rawResponse("text/html", body);
}
