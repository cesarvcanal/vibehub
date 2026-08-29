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
  return (
    `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\n` +
    `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
  );
}
