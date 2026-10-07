import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser, requestUser, requireSession, verifySessionUser, sessionTokenFromCookieHeader } from "../auth/session.js";
import type { PublicUser } from "../auth/users.js";
import { requireCardWork, visibleCards } from "../auth/access.js";
import { hostExecutor } from "../runtime/host.js";
import { isBrowserSlotPort } from "../services/browser/ports.js";
import { config } from "../config/env.js";
import {
  badGatewayResponse,
  buildProxyHead,
  listPortsScript,
  looksLikeHttpResponse,
  loopingRedirectPath,
  parseListeningPorts,
  parseResponseHead,
  parsePreviewTarget,
  stoppedPreviewPage,
  tunnelRemoteCommand,
  wantsHtmlInterstitial,
} from "../services/preview/preview.js";
import { restartPreview, stopPreview } from "../services/preview/lifecycle.js";
import { currentPreviewOwners, findCardPreviewByPort, listAllCards, pruneCardPreviews } from "../services/board/registry.js";
import { logger } from "../utils/logger.js";

/**
 * PREVIEW routes — the port scan the UI lists, and the proxy that puts an app running inside the
 * runner into the user's own browser tab. The mechanism and its reasons live in
 * services/preview/preview.ts; this file is the I/O: spawn the tunnel, move the bytes, own the
 * lifecycles.
 *
 * Two paths into the runner:
 *
 *  - plain HTTP:  a Fastify route on `/preview/:port/*`. The reply is HIJACKED and the upstream's
 *    response bytes are relayed verbatim — status line, headers, body, compression and all.
 *  - websockets:  vite's HMR lives here, so this is not optional. @fastify/websocket owns the
 *    server's `upgrade` event, so the preview interceptor WRAPS the existing listeners: preview
 *    upgrades are tunneled raw, everything else is handed to whoever was listening before.
 *
 * WHO reaches WHAT (both paths, and the port list): a session is not enough — a port in the runner
 * can be anything, including the per-card Chromium's CDP, which is full remote control of a
 * browser holding someone's logged-in sessions. See {@link canOpenPreviewPort}.
 */

/**
 * The ports this user may open as previews: every port for the owner, and for a member only the
 * ports whose CURRENT card is visible to them — a share is what puts a card's preview in a member's
 * hands, exactly as it puts the card on their board. Any level will do: opening a preview is
 * looking at the card's work. "Current" is currentPreviewOwners' rule (the newest registration
 * wins), the same one the stopped screen and the restart use: a shared card that once registered
 * 5173 must not open the private card's server that holds 5173 today.
 */
async function previewPortScope(user: PublicUser): Promise<"all" | Set<number>> {
  if (user.role === "owner") return "all";
  const cards = await listAllCards();
  const visible = new Set((await visibleCards(user, cards)).map((c) => c.id));
  const ports = new Set<number>();
  for (const [port, { card }] of currentPreviewOwners(cards)) if (visible.has(card.id)) ports.add(port);
  return ports;
}

/**
 * May this user open the preview on `port`? Never for vibehub's own browser plumbing (VNC, CDP) —
 * not even the owner: those belong to the card's browser panel, not to a tab on the panel origin.
 *
 * previewPortScope's rule for ONE port, asked as cheaply as it can be: this runs on every request
 * the proxy relays (a vite dev page is hundreds of module fetches), so a member's check resolves the
 * port's current card and asks about that card alone instead of building the whole scope.
 */
async function canOpenPreviewPort(user: PublicUser | null, port: number): Promise<boolean> {
  if (!user) return false;
  // Resolving the port's card loads the board — and with it every allocated browser slot, which is
  // what isBrowserSlotPort reads. Asked first, right after a boot, the slot table could still be
  // empty and wave a CDP port through: the check must never depend on what ran before it.
  const current = await findCardPreviewByPort(port);
  if (isBrowserSlotPort(port)) return false;
  if (user.role === "owner") return true;
  return current !== undefined && (await visibleCards(user, [current.card])).length > 0;
}

/**
 * The proxy's preHandler: session, target and access in one pass — 401 without a live session, 400
 * for a malformed path, 404 for a port this user may not open (like requireCardAccess: to them there
 * is no preview). Folded together so the session is verified ONCE per relayed request rather than
 * by requireSession and again by the handler.
 */
async function requirePreviewAccess(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await currentUser(req);
  if (!user) {
    await reply.code(401).send({ error: "not authenticated" });
    return;
  }
  const target = parsePreviewTarget(req.raw.url ?? "");
  if (!target) {
    await reply.code(400).send({ error: "invalid preview path" });
    return;
  }
  if (!(await canOpenPreviewPort(user, target.port))) {
    await reply.code(404).send({ error: "preview not found" });
  }
}

/** One tunnel: the spawned transport process whose stdio is the TCP stream. */
function openTunnel(port: number): ChildProcessWithoutNullStreams {
  const { file, args } = hostExecutor().pipeCommand(tunnelRemoteCommand(config.runner.container, port));
  return spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
}

/** One plain-HTTP exchange over one tunnel. */
interface HttpExchange {
  port: number;
  /** Method, so only GET/HEAD can be re-issued internally (see the redirect absorption below). */
  method: string;
  /** Path sent upstream — prefix already stripped. What a looping redirect is compared against. */
  path: string;
  head: string;
  body?: Buffer;
  /** Response written when the tunnel produces no byte at all (dead port). */
  fallback: string;
  /**
   * Rebuilds the request head for a path the proxy decides to fetch internally. Absent = this IS
   * the internal hop, and whatever comes back is relayed as it is.
   */
  rehead?: (path: string) => string;
}

/** Enough for any sane response head; past it we stop looking and go back to moving bytes. */
const MAX_HEAD_BYTES = 64 * 1024;

/**
 * Relays one plain-HTTP exchange. The client socket is already hijacked: from here on, bytes only.
 *
 * The upstream was asked for `connection: close`, so its response ends when the tunnel's stdout
 * ends — piping with end:true closes the client socket, which is also what tells a browser without
 * a content-length where the body stops.
 *
 * The tunnel's stdin is deliberately NOT ended after the request. socat answers a stdin EOF by
 * half-closing the upstream connection (FIN), and a Node http server destroys its socket on FIN —
 * so any response slower than that FIN came back as ZERO bytes, and the user saw "nothing is
 * listening" with the port alive (the prod bug). The request needs no EOF to be complete: it is
 * delimited by its content-length. The exchange ends from the OTHER side — the upstream closes
 * after responding (connection: close), the tunnel exits, and the close handler ends the client.
 *
 * The one thing NOT relayed verbatim is the redirect loop (loopingRedirectPath): an app based at
 * `/preview/<port>/` answers the stripped `/` with a 302 back to `/preview/<port>/`, which the
 * browser is already on — ERR_TOO_MANY_REDIRECTS, the bug the user hit in a real tab while the tool
 * happily reported the port as up. The head is buffered just long enough to spot it, and the
 * response is fetched again internally at the path the app asked for. ONE hop, always: if the
 * second answer redirects too, it is relayed as it is and the browser decides.
 */
function relayHttp(socket: Duplex, x: HttpExchange): void {
  const child = openTunnel(x.port);
  let sawBytes = false;
  let stderr = "";
  let pending: Buffer[] = [];
  let pendingLength = 0;
  /** The head is settled: from here the tunnel's bytes go straight to the client. */
  let relaying = false;
  /** An internal hop owns the socket now — this exchange must touch neither socket nor fallback. */
  let abandoned = false;

  const relayFrom = (buffered: Buffer): void => {
    relaying = true;
    pending = [];
    if (buffered.length > 0) socket.write(buffered);
    // end:false — a tunnel that dies WITHOUT producing a byte must still get to write the 502; an
    // auto-ended socket races that write and the browser sees a bare connection reset instead.
    child.stdout.pipe(socket, { end: false });
  };

  child.stdin.on("error", () => { /* tunnel died first; the close handler reports */ });
  child.stdin.write(x.head);
  if (x.body && x.body.length > 0) child.stdin.write(x.body);

  child.stdout.on("data", (chunk: Buffer) => {
    sawBytes = true;
    if (relaying || abandoned) return;
    pending.push(chunk);
    pendingLength += chunk.length;
    const raw = Buffer.concat(pending);
    if (!looksLikeHttpResponse(raw) || pendingLength >= MAX_HEAD_BYTES) {
      relayFrom(raw);
      return;
    }
    const parsed = parseResponseHead(raw);
    if (!parsed) return; // head still arriving
    const rehead = x.rehead;
    const follow = rehead
      ? loopingRedirectPath({ status: parsed.status, location: parsed.headers.location, method: x.method, port: x.port, path: x.path })
      : null;
    if (!follow || !rehead) {
      relayFrom(raw);
      return;
    }
    abandoned = true;
    child.kill("SIGKILL");
    logger.info({ port: x.port, from: x.path, to: follow }, "preview absorbed a redirect onto its own prefix");
    // No body on the hop: only GET/HEAD get here, and the app already answered the original one.
    relayHttp(socket, { ...x, path: follow, head: rehead(follow), body: undefined, rehead: undefined });
  });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

  child.on("error", (err) => {
    if (abandoned) return;
    logger.warn({ err: err.message, port: x.port }, "preview tunnel failed to spawn");
    socket.end(x.fallback);
  });
  child.on("close", (code) => {
    if (abandoned) return;
    if (sawBytes) {
      // A response too short to complete a head (or cut mid-head) still has to reach the client.
      if (!relaying && pendingLength > 0) socket.end(Buffer.concat(pending));
      else socket.end();
      return;
    }
    // socat could not connect (nothing listening) — it exits without writing a byte.
    if (code !== 0) logger.info({ port: x.port, detail: stderr.trim().slice(0, 300) }, "preview target unreachable");
    socket.end(x.fallback);
  });
  // The browser gave up (tab closed, navigation) — the tunnel must not outlive it.
  socket.on("close", () => { child.kill("SIGKILL"); });
  socket.on("error", () => { child.kill("SIGKILL"); });
}

/** Relays one websocket, byte-for-byte in both directions, after writing the rewritten handshake. */
function relayUpgrade(socket: Duplex, port: number, head: string, early: Buffer): void {
  const child = openTunnel(port);
  let sawBytes = false;

  child.stdin.on("error", () => { /* torn down below */ });
  child.stdin.write(head);
  if (early.length > 0) child.stdin.write(early);

  child.stdout.on("data", () => { sawBytes = true; });
  // Same end:false as the HTTP relay, for the same 502 race; the close handler below guarantees
  // neither side is left half-open — a half-open HMR socket is a client that silently stops
  // reloading.
  child.stdout.pipe(socket, { end: false });
  socket.pipe(child.stdin);

  child.on("error", () => { socket.destroy(); });
  child.on("close", () => {
    if (!sawBytes) socket.end(badGatewayResponse(port));
    else socket.destroy();
  });
  socket.on("close", () => { child.kill("SIGKILL"); });
  socket.on("error", () => { child.kill("SIGKILL"); });
}

/**
 * Wraps the server's `upgrade` listeners so `/preview/<port>/...` websockets are tunneled into the
 * runner and every other upgrade (terminals, VNC) reaches the original listeners untouched. Called
 * from an onReady hook — by then @fastify/websocket has attached its listener.
 */
export function installPreviewUpgrade(server: Server): void {
  const prior = server.listeners("upgrade").slice() as Array<(req: IncomingMessage, socket: Duplex, head: Buffer) => void>;
  server.removeAllListeners("upgrade");
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, early: Buffer) => {
    const target = parsePreviewTarget(req.url ?? "");
    if (!target) {
      for (const listener of prior) listener.call(server, req, socket, early);
      return;
    }
    void (async () => {
      const token = sessionTokenFromCookieHeader(req.headers.cookie);
      // currentUser's rule, from a raw cookie: a signed cookie of a deleted account, or one revoked by
      // a password change, is no session — the HTTP proxy already refuses both.
      const user = token ? await verifySessionUser(token) : null;
      if (!user) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      if (!(await canOpenPreviewPort(user, target.port))) {
        socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      const head = buildProxyHead({
        kind: "upgrade",
        method: req.method ?? "GET",
        path: target.path,
        port: target.port,
        headers: req.headers,
        clientIp: req.socket.remoteAddress ?? undefined,
      });
      relayUpgrade(socket, target.port, head, early);
    })().catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, "preview upgrade failed");
      socket.destroy();
    });
  });
}

const PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export async function previewRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The ports the UI offers: everything listening in the runner, minus vibehub's own plumbing — and,
   * for a member, minus every port whose current card is not theirs to see (previewPortScope).
   */
  app.get("/api/preview/ports", { preHandler: requireSession }, async (req, reply) => {
    const user = await requestUser(req);
    if (!user) return await reply.code(401).send({ error: "not authenticated" });
    try {
      const { stdout } = await hostExecutor().runScript(listPortsScript(config.runner.container), {
        timeoutMs: 20_000,
      });
      const ports = parseListeningPorts(stdout);
      // The scan is also the CLEANUP moment for registered previews: a chip pointing at a port that
      // no longer answers is a dead link, and this is the one place that knows which ports live.
      // Best-effort — a registry hiccup must not break the listing the user asked for.
      try {
        await pruneCardPreviews(ports.map((p) => p.port));
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "preview prune failed (listing continues)");
      }
      const scope = await previewPortScope(user);
      return await reply.send({ ports: scope === "all" ? ports : ports.filter((p) => scope.has(p.port)) });
    } catch (err) {
      return await reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * RELAUNCH a registered preview in its dedicated session (the "Reiniciar" of the stopped-preview
   * screen) and wait until the port listens. 409 = there is nothing to relaunch (no stored command,
   * or no such preview) — the UI shows the message verbatim; 502 = the relaunch itself failed
   * (never started listening, runner unreachable). Relaunching and stopping CHANGE the card's work,
   * so both wear requireCardWork: 404 for a card the caller cannot see, 403 on a read-only share.
   */
  app.post<{ Params: { id: string; port: string } }>(
    "/api/cards/:id/previews/:port/restart",
    { preHandler: requireCardWork },
    async (req, reply) => {
      const port = Number(req.params.port);
      try {
        return await reply.send(await restartPreview(req.params.id, port));
      } catch (err) {
        const message = (err as Error).message;
        const conflict = /no preview registered|no stored start command|card not found|invalid preview port/.test(message);
        return await reply.code(conflict ? 409 : 502).send({ error: message });
      }
    },
  );

  /** STOP a preview: tree-kill its dedicated session and remove the chip. Stopping twice is a 409. */
  app.delete<{ Params: { id: string; port: string } }>(
    "/api/cards/:id/previews/:port",
    { preHandler: requireCardWork },
    async (req, reply) => {
      const port = Number(req.params.port);
      try {
        return await reply.send(await stopPreview(req.params.id, port));
      } catch (err) {
        const message = (err as Error).message;
        const known = /no preview registered|card not found|invalid preview port/.test(message);
        return await reply.code(known ? 409 : 502).send({ error: message });
      }
    },
  );

  // The proxy lives in its own encapsulated scope so the catch-all body parser (the proxy forwards
  // bytes, it does not interpret them) cannot leak into the API routes.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => { done(null, body); });

    // Session, path and access were settled by requirePreviewAccess; the target is parsed again
    // (pure, cheap) only to have it typed here — the 400 below cannot fire after that preHandler.
    const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const target = parsePreviewTarget(req.raw.url ?? "");
      if (!target) {
        await reply.code(400).send({ error: "invalid preview path" });
        return;
      }
      // `/preview/5173` (no trailing slash) would make the app's relative URLs resolve against
      // `/preview/` — redirect once so the browser's base is `/preview/5173/`.
      if (!(req.raw.url ?? "").startsWith(`/preview/${target.port}/`)) {
        await reply.redirect(`/preview/${target.port}/`, 302);
        return;
      }
      // What a dead port answers with. For a NAVIGATION (a person in a tab) it is the
      // "Preview parado" screen — with the Restart button when the port belongs to a registered,
      // relaunchable preview; assets and API calls keep the structured JSON error. Resolved BEFORE
      // hijacking, because the relay's close handler is synchronous.
      let fallback = badGatewayResponse(target.port);
      if (wantsHtmlInterstitial(req.raw.method, req.raw.headers.accept)) {
        const found = await findCardPreviewByPort(target.port).catch(() => undefined);
        fallback = stoppedPreviewPage(target.port, {
          cardId: found?.card.id,
          label: found?.preview.label,
          restartable: Boolean(found?.preview.command && found?.preview.cwd),
        });
      }
      const body = Buffer.isBuffer(req.body) ? req.body : undefined;
      const method = req.raw.method ?? "GET";
      const headFor = (path: string, length: number): string =>
        buildProxyHead({
          kind: "http",
          method,
          path,
          port: target.port,
          headers: req.raw.headers,
          clientIp: req.ip,
          bodyLength: length,
        });
      reply.hijack();
      relayHttp(req.raw.socket, {
        port: target.port,
        method,
        path: target.path,
        head: headFor(target.path, body?.length ?? 0),
        body,
        fallback,
        // The internal hop carries no body — it only ever re-issues a GET/HEAD navigation.
        rehead: (path) => headFor(path, 0),
      });
    };

    scope.route({
      method: [...PROXY_METHODS],
      url: "/preview/:port",
      preHandler: requirePreviewAccess,
      handler,
    });
    scope.route({
      method: [...PROXY_METHODS],
      url: "/preview/:port/*",
      preHandler: requirePreviewAccess,
      handler,
    });
  });
}
