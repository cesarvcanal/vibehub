import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { absoluteAssetRefs, diagnosePreview, type PreviewProbe } from "./probe.js";

/**
 * The end-to-end check behind `vibehub_preview`. The pure diagnosis is tested directly; probePreview
 * is tested against a REAL upstream on localhost, with the tunnel resolved to a stdio↔TCP relay —
 * the same stand-in for `docker exec … socat` the route tests use, and the only way to prove the
 * probe speaks the proxy's HTTP (prefix stripped, x-forwarded-prefix set) and follows the one hop
 * the proxy absorbs.
 */

/** stdio↔TCP relay, standing in for `docker exec … socat STDIO TCP:127.0.0.1:<port>`. */
function relayArgv(remoteCommand: string): { file: string; args: string[] } {
  const port = /TCP:127\.0\.0\.1:(\d+)/.exec(remoteCommand)?.[1] ?? "0";
  const js =
    `const net=require("net");const s=net.connect(${port},"127.0.0.1");` +
    `s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0));` +
    `process.stdin.pipe(s);s.pipe(process.stdout);`;
  return { file: process.execPath, args: ["-e", js] };
}

async function loadProbe() {
  vi.resetModules();
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", pipeCommand: relayArgv }) };
  });
  return import("./probe.js");
}

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.doUnmock("../../runtime/host.js");
});

describe("absoluteAssetRefs (pure)", () => {
  it("flags the root-absolute assets an app assuming '/' emits", () => {
    const html = '<script type="module" src="/@vite/client"></script><link rel="stylesheet" href="/style.css">';
    expect(absoluteAssetRefs(html, 5183)).toEqual(["/@vite/client", "/style.css"]);
  });

  it("accepts everything that actually resolves under the prefix", () => {
    const html =
      '<script src="/preview/5183/@vite/client"></script><img src="./logo.png"><a href="about.html">' +
      '<img src="https://cdn.example.com/x.png"><script src="//cdn.example.com/y.js"></script>' +
      '<a href="/preview/5183">root</a>';
    expect(absoluteAssetRefs(html, 5183)).toEqual([]);
  });

  it("dedupes and stops at a handful — the warning is a sample, not an inventory", () => {
    const html = Array.from({ length: 9 }, (_, i) => `<img src='/a${i}.png'><img src='/a${i}.png'>`).join("");
    expect(absoluteAssetRefs(html, 5183)).toEqual(["/a0.png", "/a1.png", "/a2.png"]);
  });

  it("is TOTAL: empty and garbage input yield nothing", () => {
    expect(absoluteAssetRefs("", 5183)).toEqual([]);
    expect(absoluteAssetRefs("<<<src= >>> href=", 5183)).toEqual([]);
  });
});

describe("diagnosePreview (pure)", () => {
  const probe = (o: Partial<PreviewProbe>): PreviewProbe => ({ status: 200, loop: false, body: "", ...o });

  it("REFUSES the redirect loop, naming the fix", () => {
    const d = diagnosePreview(5183, probe({ status: 302, loop: true, location: "/preview/5183/" }));
    expect(d.fatal).toMatch(/loop de redirect/);
    expect(d.fatal).toMatch(/x-forwarded-prefix/);
    expect(d.warning).toBeUndefined();
  });

  it("warns (but does not refuse) a 404 on / — an API's front page is a legitimate preview", () => {
    const d = diagnosePreview(5183, probe({ status: 404 }));
    expect(d.fatal).toBeUndefined();
    expect(d.warning).toMatch(/respondeu 404/);
  });

  it("warns about a redirect that leaves the prefix — that URL lands on vibehub, not the app", () => {
    const d = diagnosePreview(5183, probe({ status: 302, location: "/login" }));
    expect(d.fatal).toBeUndefined();
    expect(d.warning).toMatch(/\/login/);
  });

  it("warns about absolute assets in the HTML — the 404s the user would only see in the browser", () => {
    const d = diagnosePreview(
      5183,
      probe({ contentType: "text/html; charset=utf-8", body: '<script src="/src/main.tsx"></script>' }),
    );
    expect(d.warning).toMatch(/assets absolutos/);
    expect(d.warning).toContain("/src/main.tsx");
  });

  it("says nothing about a page that opens clean, and never scans a non-HTML body", () => {
    expect(diagnosePreview(5183, probe({ contentType: "text/html", body: '<script src="./main.js">' }))).toEqual({});
    expect(diagnosePreview(5183, probe({ contentType: "application/json", body: '{"src":"/x.js"}' }))).toEqual({});
  });
});

describe("probePreview (through a real upstream)", () => {
  it("opens '/' the way the proxy does — prefix stripped, x-forwarded-prefix set", async () => {
    const seen: { url?: string; prefix?: string } = {};
    const port = await listen(
      createServer((req, res) => {
        seen.url = req.url;
        seen.prefix = String(req.headers["x-forwarded-prefix"]);
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<script src="./main.js"></script>');
      }),
    );
    const { probePreview, diagnosePreview: diagnose } = await loadProbe();
    const probe = (await probePreview(port))!;
    expect(seen.url).toBe("/");
    expect(seen.prefix).toBe(`/preview/${port}`);
    expect(probe).toMatchObject({ status: 200, loop: false });
    expect(diagnose(port, probe)).toEqual({});
  });

  it("follows the hop the proxy absorbs: a vite based at the prefix is NOT reported as broken", async () => {
    const paths: string[] = [];
    const port = await listen(
      createServer((req, res) => {
        paths.push(req.url ?? "");
        if (req.url === "/") {
          res.writeHead(302, { location: `/preview/${port}/` });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<script type="module" src="/preview/${port}/@vite/client"></script>`);
      }),
    );
    const { probePreview, diagnosePreview: diagnose } = await loadProbe();
    const probe = (await probePreview(port))!;
    expect(paths).toEqual(["/", `/preview/${port}/`]);
    expect(probe).toMatchObject({ status: 200, loop: false });
    expect(diagnose(port, probe)).toEqual({});
  });

  it("reports the LOOP when the app redirects to the prefix even on the absorbed hop", async () => {
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(302, { location: `/preview/${port}/` });
        res.end();
      }),
    );
    const { probePreview, diagnosePreview: diagnose } = await loadProbe();
    const probe = (await probePreview(port))!;
    expect(probe.loop).toBe(true);
    expect(diagnose(port, probe).fatal).toMatch(/loop de redirect/);
  });

  it("returns null when nothing answers HTTP — a non-HTTP port must never block an announcement", async () => {
    const { probePreview } = await loadProbe();
    expect(await probePreview(59995)).toBeNull();
  });
});
