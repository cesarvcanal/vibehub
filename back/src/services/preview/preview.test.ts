import { describe, it, expect } from "vitest";
import {
  PROC_MARKER,
  badGatewayResponse,
  buildProxyHead,
  isInfraPort,
  isValidPreviewPort,
  listPortsScript,
  parseListeningPorts,
  parsePreviewTarget,
  stripSessionCookie,
  stoppedPreviewPage,
  tunnelRemoteCommand,
  escapeHtml,
  wantsHtmlInterstitial,
} from "./preview.js";
import { VNC_PORT_BASE, CDP_PORT_BASE, SLOT_SPACE } from "../browser/ports.js";

/**
 * The preview feature's pure seams. INVARIANTS:
 *  - parsers are TOTAL (garbage in → [] / null, never a throw: they sit on request paths);
 *  - the proxy head never forwards hop-by-hop headers or vibehub's session cookie;
 *  - the runner's own plumbing ports (VNC/CDP slots) never show up as "your app".
 */

/** A /proc/net/tcp line, with only the fields the parser reads made variable. */
function tcpLine(o: { addr: string; port: number; st?: string; inode?: string }): string {
  const portHex = o.port.toString(16).toUpperCase().padStart(4, "0");
  return `   1: ${o.addr}:${portHex} 00000000:0000 ${o.st ?? "0A"} 00000000:00000000 00:00000000 00000000     0        0 ${o.inode ?? "0"} 1 0000000000000000 100 0 0 10 0`;
}

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

describe("parseListeningPorts", () => {
  it("finds listening ports and maps them to their process by inode", () => {
    const raw = [
      HEADER,
      tcpLine({ addr: "0100007F", port: 5173, inode: "111" }),
      tcpLine({ addr: "00000000", port: 3000, inode: "222" }),
      PROC_MARKER,
      "111 40 node",
      "222 41 python3",
    ].join("\n");
    expect(parseListeningPorts(raw)).toEqual([
      { port: 3000, address: "all", process: "python3", pid: 41 },
      { port: 5173, address: "loopback", process: "node", pid: 40 },
    ]);
  });

  it("ignores non-listening sockets (established, time-wait)", () => {
    const raw = [
      HEADER,
      tcpLine({ addr: "0100007F", port: 8080, st: "01" }),
      tcpLine({ addr: "0100007F", port: 9090, st: "06" }),
    ].join("\n");
    expect(parseListeningPorts(raw)).toEqual([]);
  });

  it("collapses a v4+v6 double bind into one entry preferring the widest address", () => {
    const raw = [
      HEADER,
      tcpLine({ addr: "0100007F", port: 4000, inode: "9" }),
      tcpLine({ addr: "00000000000000000000000000000000", port: 4000, inode: "9" }),
      PROC_MARKER,
      "9 12 node",
    ].join("\n");
    const ports = parseListeningPorts(raw);
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ port: 4000, address: "all", process: "node" });
  });

  it("classifies ::1 as loopback", () => {
    const raw = tcpLine({ addr: "00000000000000000000000001000000", port: 7777 });
    expect(parseListeningPorts(raw)).toEqual([{ port: 7777, address: "loopback", process: undefined, pid: undefined }]);
  });

  it("hides vibehub's own VNC/CDP slot ports", () => {
    const raw = [
      tcpLine({ addr: "0100007F", port: VNC_PORT_BASE + 5 }),
      tcpLine({ addr: "0100007F", port: CDP_PORT_BASE + 5 }),
      tcpLine({ addr: "0100007F", port: 5173 }),
    ].join("\n");
    expect(parseListeningPorts(raw).map((p) => p.port)).toEqual([5173]);
  });

  it("is TOTAL: garbage, empty and truncated input yield []", () => {
    for (const raw of ["", "not a proc file\nat all", HEADER, `${PROC_MARKER}\nonly procs`]) {
      expect(parseListeningPorts(raw)).toEqual([]);
    }
  });

  it("survives a process section with malformed lines", () => {
    const raw = [tcpLine({ addr: "0100007F", port: 5173, inode: "111" }), PROC_MARKER, "garbage", "111 40 node", ""].join("\n");
    expect(parseListeningPorts(raw)[0]).toMatchObject({ process: "node" });
  });
});

describe("isInfraPort", () => {
  it("covers exactly the VNC and CDP slot ranges", () => {
    expect(isInfraPort(VNC_PORT_BASE)).toBe(true);
    expect(isInfraPort(VNC_PORT_BASE + SLOT_SPACE - 1)).toBe(true);
    expect(isInfraPort(VNC_PORT_BASE + SLOT_SPACE)).toBe(false);
    expect(isInfraPort(CDP_PORT_BASE)).toBe(true);
    expect(isInfraPort(5173)).toBe(false);
    expect(isInfraPort(3000)).toBe(false);
  });
});

describe("listPortsScript", () => {
  it("quotes the container name and reads /proc, not ss/netstat", () => {
    const script = listPortsScript("vibehub-runner");
    expect(script).toContain("docker exec -i 'vibehub-runner'");
    expect(script).toContain("/proc/net/tcp");
    expect(script).toContain(PROC_MARKER);
  });
});

describe("tunnelRemoteCommand", () => {
  it("targets the runner's loopback so loopback-bound dev servers are reachable", () => {
    expect(tunnelRemoteCommand("vibehub-runner", 5173)).toBe(
      "docker exec -i 'vibehub-runner' socat STDIO TCP:127.0.0.1:5173",
    );
  });

  it("refuses a port outside 1..65535 — the command line is not a place for surprises", () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(() => tunnelRemoteCommand("c", port)).toThrow();
    }
  });
});

describe("parsePreviewTarget", () => {
  it("extracts port and app-relative path, query preserved", () => {
    expect(parsePreviewTarget("/preview/5173/src/main.tsx?t=1")).toEqual({ port: 5173, path: "/src/main.tsx?t=1" });
    expect(parsePreviewTarget("/preview/3000/")).toEqual({ port: 3000, path: "/" });
    expect(parsePreviewTarget("/preview/3000")).toEqual({ port: 3000, path: "/" });
  });

  it("rejects everything else", () => {
    for (const url of ["/api/preview/ports", "/preview/", "/preview/abc/x", "/preview/99999/", "/previews/1/", "", "/preview/5173x/"]) {
      expect(parsePreviewTarget(url)).toBeNull();
    }
  });
});

describe("isValidPreviewPort", () => {
  it("accepts 1..65535 integers only", () => {
    expect(isValidPreviewPort(1)).toBe(true);
    expect(isValidPreviewPort(65535)).toBe(true);
    expect(isValidPreviewPort(0)).toBe(false);
    expect(isValidPreviewPort(65536)).toBe(false);
    expect(isValidPreviewPort(80.5)).toBe(false);
  });
});

describe("stripSessionCookie", () => {
  it("removes only vibehub's session, keeping the app's own cookies", () => {
    expect(stripSessionCookie("vibehub_session=abc.1.def; theme=dark; sid=x")).toBe("theme=dark; sid=x");
    expect(stripSessionCookie("theme=dark")).toBe("theme=dark");
    expect(stripSessionCookie("vibehub_session=abc")).toBe("");
  });
});

describe("buildProxyHead", () => {
  const base = {
    method: "GET",
    path: "/index.html",
    port: 5173,
    headers: {
      host: "192.0.2.10:3010",
      accept: "text/html",
      cookie: "vibehub_session=tok; app=1",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "x-forwarded-for": "6.6.6.6",
    } as Record<string, string>,
    clientIp: "192.0.2.2",
  };

  it("rewrites the request line and host, forwards app headers, drops hop-by-hop ones", () => {
    const head = buildProxyHead({ kind: "http", ...base });
    expect(head.startsWith("GET /index.html HTTP/1.1\r\n")).toBe(true);
    expect(head).toContain("host: 127.0.0.1:5173\r\n");
    expect(head).toContain("accept: text/html\r\n");
    expect(head).toContain("cookie: app=1\r\n");
    expect(head).not.toContain("keep-alive");
    expect(head).not.toContain("transfer-encoding");
    expect(head).not.toContain("vibehub_session");
    expect(head.endsWith("\r\n\r\n")).toBe(true);
  });

  it("derives X-Forwarded-* itself instead of trusting the client's", () => {
    const head = buildProxyHead({ kind: "http", ...base });
    expect(head).toContain("x-forwarded-host: 192.0.2.10:3010\r\n");
    expect(head).toContain("x-forwarded-proto: http\r\n");
    expect(head).toContain("x-forwarded-for: 192.0.2.2\r\n");
    expect(head).toContain("x-forwarded-prefix: /preview/5173\r\n");
    expect(head).not.toContain("6.6.6.6");
  });

  it("closes the connection per request on plain HTTP, and never leaks websocket fields into it", () => {
    const head = buildProxyHead({
      kind: "http", ...base,
      headers: { ...base.headers, "sec-websocket-key": "abc" },
    });
    expect(head).toContain("connection: close\r\n");
    expect(head).not.toContain("sec-websocket-key");
  });

  it("sets content-length for entity requests from the buffered body", () => {
    const head = buildProxyHead({ kind: "http", ...base, method: "POST", bodyLength: 42 });
    expect(head).toContain("content-length: 42\r\n");
    const get = buildProxyHead({ kind: "http", ...base, bodyLength: 0 });
    expect(get).not.toContain("content-length");
  });

  it("keeps the websocket handshake intact on an upgrade", () => {
    const head = buildProxyHead({
      kind: "upgrade", ...base,
      headers: { ...base.headers, upgrade: "websocket", "sec-websocket-key": "abc", "sec-websocket-version": "13" },
    });
    expect(head).toContain("connection: upgrade\r\n");
    expect(head).toContain("upgrade: websocket\r\n");
    expect(head).toContain("sec-websocket-key: abc\r\n");
    expect(head).toContain("sec-websocket-version: 13\r\n");
    expect(head).not.toContain("connection: close");
  });

  it("cannot be used to split headers — CR/LF in values is flattened", () => {
    const head = buildProxyHead({
      kind: "http", ...base,
      headers: { host: "h", "x-evil": "a\r\nx-injected: 1" },
    });
    // The CR/LF is flattened to a space, so no new header LINE can be forged.
    expect(head).not.toMatch(/\r\nx-injected: /);
    expect(head).toContain("x-evil: a x-injected: 1\r\n");
  });
});

describe("badGatewayResponse", () => {
  it("is a complete, self-terminating HTTP response naming the port", () => {
    const res = badGatewayResponse(5173);
    expect(res.startsWith("HTTP/1.1 502 Bad Gateway\r\n")).toBe(true);
    expect(res).toContain("5173");
    const body = res.split("\r\n\r\n")[1]!;
    expect(res).toContain(`content-length: ${Buffer.byteLength(body)}\r\n`);
  });
});

describe("wantsHtmlInterstitial", () => {
  it("is true only for a navigation: GET asking for text/html", () => {
    expect(wantsHtmlInterstitial("GET", "text/html,application/xhtml+xml")).toBe(true);
    expect(wantsHtmlInterstitial("get", "TEXT/HTML")).toBe(true);
    expect(wantsHtmlInterstitial(undefined, "text/html")).toBe(true); // method defaults to GET
  });

  it("keeps the JSON error for assets, APIs and non-GETs", () => {
    expect(wantsHtmlInterstitial("GET", "application/json")).toBe(false);
    expect(wantsHtmlInterstitial("GET", "*/*")).toBe(false);
    expect(wantsHtmlInterstitial("GET", undefined)).toBe(false);
    expect(wantsHtmlInterstitial("POST", "text/html")).toBe(false);
  });

  it("tolerates an array Accept header", () => {
    expect(wantsHtmlInterstitial("GET", ["application/json", "text/html"])).toBe(true);
  });
});

describe("escapeHtml", () => {
  it("neutralizes every HTML metacharacter and tolerates garbage", () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
    expect(escapeHtml(undefined as unknown as string)).toBe("");
  });
});

describe("stoppedPreviewPage", () => {
  const info = { cardId: "660fa4e5-7139-4f6a-8fe5-7df8207a0425", label: "front", restartable: true };

  it("is a complete text/html 502 with the Reiniciar button posting the RELATIVE restart endpoint", () => {
    const res = stoppedPreviewPage(3100, info);
    expect(res.startsWith("HTTP/1.1 502 Bad Gateway\r\n")).toBe(true);
    expect(res).toContain("content-type: text/html");
    const body = res.split("\r\n\r\n")[1]!;
    expect(res).toContain(`content-length: ${Buffer.byteLength(body)}\r\n`);
    expect(body).toContain("Preview &quot;front&quot; parado");
    // RELATIVE url — the restart must work on whatever host the panel is being reached through.
    expect(body).toContain(`"/api/cards/${info.cardId}/previews/3100/restart"`);
    expect(body).toContain("Reiniciar");
  });

  it("without a relaunch recipe it renders the guidance, not a button", () => {
    const res = stoppedPreviewPage(3100, { cardId: info.cardId, restartable: false });
    expect(res).not.toContain("Reiniciar<");
    expect(res).toContain("agente");
    // An unregistered port (no card at all) gets the same honest guidance.
    const bare = stoppedPreviewPage(3100, { restartable: true });
    expect(bare).not.toContain("id=\"restart\"");
  });

  it("escapes the label — a hostile label cannot inject markup", () => {
    const res = stoppedPreviewPage(3100, { ...info, label: `<script>alert(1)</script>` });
    expect(res).not.toContain("<script>alert(1)");
    expect(res).toContain("&lt;script&gt;");
  });

  it("refuses an invalid port instead of interpolating it", () => {
    expect(() => stoppedPreviewPage(0, info)).toThrow(/invalid preview port/);
  });
});
