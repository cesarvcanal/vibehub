import { spawn } from "node:child_process";
import { hostExecutor } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import {
  buildProxyHead,
  loopingRedirectPath,
  parseResponseHead,
  prefixRedirectPath,
  tunnelRemoteCommand,
} from "./preview.js";
import { logger } from "../../utils/logger.js";

/**
 * PREVIEW PROBE — does the page actually OPEN?
 *
 * `vibehub_preview` used to answer `registered: true` on one fact alone: the port is LISTENING. A
 * vite dev server based at `/preview/5183/` is listening the whole time it answers `/` with a 302
 * back to `/preview/5183/` — the proxy strips the prefix again, and the user's tab dies with
 * ERR_TOO_MANY_REDIRECTS. The agent had shipped a link it had never opened, and the user found the
 * breakage in the browser.
 *
 * So the tool now opens it: one GET through the SAME tunnel and with the SAME head the proxy would
 * send (prefix stripped, `x-forwarded-prefix` set), following the one redirect the proxy absorbs.
 * What comes back is judged by pure functions below — a redirect that still loops is fatal, an HTML
 * that points at assets outside the prefix is a warning, everything else passes.
 *
 * Best effort by design: a port that speaks something other than HTTP (a database, a raw socket) is
 * a legitimate preview target, and a probe that cannot get an answer must never block the
 * announcement — it returns null and the tool stays as permissive as it was.
 */

/** A probe waits for the WHOLE response of one request; a dev server's index is fast or broken. */
export const PROBE_TIMEOUT_MS = 6_000;

/** Only the beginning of the body is ever read — enough for the <head> of an index.html. */
export const PROBE_MAX_BYTES = 128 * 1024;

export interface ProbeResponse {
  status: number;
  location?: string;
  contentType?: string;
  body: string;
}

export interface PreviewProbe extends ProbeResponse {
  /** The app still redirects into its own `/preview/<port>/` prefix AFTER the proxy's absorbing hop. */
  loop: boolean;
}

/** One request through the preview tunnel, spoken exactly as the proxy speaks it. */
async function requestThroughTunnel(port: number, path: string): Promise<ProbeResponse | null> {
  const head = buildProxyHead({
    kind: "http",
    method: "GET",
    path,
    port,
    // No accept-encoding: an identity body is what makes the asset scan below possible at all.
    headers: { accept: "text/html,*/*", "user-agent": "vibehub-preview-check" },
  });
  const { file, args } = hostExecutor().pipeCommand(tunnelRemoteCommand(config.runner.container, port));
  const raw = await new Promise<Buffer>((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
    child.stdin.on("error", () => { /* the tunnel died; whatever arrived is the answer */ });
    child.stdin.write(head);
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length >= PROBE_MAX_BYTES) finish();
    });
    child.on("error", finish);
    child.on("close", finish);
  });
  const parsed = parseResponseHead(raw);
  if (!parsed) return null;
  return {
    status: parsed.status,
    location: parsed.headers.location,
    contentType: parsed.headers["content-type"],
    body: raw.subarray(parsed.length).toString("utf8"),
  };
}

/**
 * Opens `/` the way the browser will and reports what the browser would get. Mirrors the proxy: the
 * one redirect it absorbs is followed here too, so a correctly based app is NOT reported as broken.
 * null = the port did not speak HTTP within the timeout — not a verdict, an absence of one.
 */
export async function probePreview(port: number): Promise<PreviewProbe | null> {
  try {
    const first = await requestThroughTunnel(port, "/");
    if (!first) return null;
    const follow = loopingRedirectPath({ status: first.status, location: first.location, port, path: "/" });
    if (!follow) return { ...first, loop: false };
    const second = await requestThroughTunnel(port, follow);
    if (!second) return null;
    // On the absorbed hop ANY redirect back into the prefix is a loop: the browser would land on a
    // URL the proxy turns into the request that just failed.
    const again = prefixRedirectPath({ status: second.status, location: second.location, port });
    return { ...second, loop: Boolean(again) };
  } catch (err) {
    logger.debug({ err: (err as Error).message, port }, "preview probe could not run");
    return null;
  }
}

/* ------------------------------------------------------------ diagnosis (pure) */

/** How many offending asset URLs the warning names before it stops being useful. */
const ASSET_SAMPLE = 3;

/**
 * The absolute asset references an HTML page makes OUTSIDE the preview prefix — `src="/assets/x.js"`
 * from an app that assumes it is served at the root. In the browser those resolve against the panel
 * origin, miss `/preview/<port>/` entirely and 404, which is a blank page for an SPA. Relative and
 * already-prefixed references are fine, and so are protocol-relative/absolute URLs (another origin
 * is the author's business). PURE, TOTAL.
 */
export function absoluteAssetRefs(html: string, port: number, limit = ASSET_SAMPLE): string[] {
  const prefix = `/preview/${port}`;
  const found: string[] = [];
  const attr = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  for (let m = attr.exec(html); m; m = attr.exec(html)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!value.startsWith("/") || value.startsWith("//")) continue;
    if (value === prefix || value.startsWith(`${prefix}/`)) continue;
    if (!found.includes(value)) found.push(value);
    if (found.length >= limit) break;
  }
  return found;
}

export interface PreviewDiagnosis {
  /** The preview cannot be opened at all — the announcement is refused with this text. */
  fatal?: string;
  /** It opens, but something the user will notice is wrong — announced with this text attached. */
  warning?: string;
}

/**
 * Turns a probe into what the agent has to hear, in Portuguese (it is relayed to the user as is).
 * Only the redirect loop is fatal: a 404 on `/` is an API's normal front page, and absolute assets
 * still leave a page that partially loads — both are worth saying, neither is worth refusing. PURE.
 */
export function diagnosePreview(port: number, probe: PreviewProbe): PreviewDiagnosis {
  if (probe.loop) {
    return {
      fatal:
        `o app na porta ${port} redireciona "/" para /preview/${port}/, e o proxy do preview remove ` +
        `esse prefixo antes de entregar — o navegador entra em loop de redirect (ERR_TOO_MANY_REDIRECTS). ` +
        `Sirva o app na raiz (base relativa "./" ou o build estático), ou honre o header x-forwarded-prefix.`,
    };
  }
  if (probe.status >= 400) {
    return {
      warning:
        `o app na porta ${port} respondeu ${probe.status} em "/" — o link abre, mas é essa a página ` +
        `que o usuário vai ver.`,
    };
  }
  if (probe.status >= 300) {
    return {
      warning:
        `o app na porta ${port} redireciona "/" para "${probe.location ?? "?"}", que fica fora de ` +
        `/preview/${port}/ — no navegador esse endereço cai no vibehub, não no seu app. Use caminhos ` +
        `relativos nos redirects ou honre o header x-forwarded-prefix.`,
    };
  }
  if ((probe.contentType ?? "").includes("text/html")) {
    const assets = absoluteAssetRefs(probe.body, port);
    if (assets.length > 0) {
      return {
        warning:
          `o HTML da porta ${port} aponta assets absolutos fora do prefixo (${assets.join(", ")}) — ` +
          `no navegador eles vão dar 404. Use base relativa ("./") ou configure a base "/preview/${port}/".`,
      };
    }
  }
  return {};
}
