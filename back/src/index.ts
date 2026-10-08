import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { config, fastifyTrustProxy, trustProxyBootWarning } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { authRoutes } from "./routes/auth.js";
import { usersRoutes } from "./routes/users.js";
import { sharesRoutes } from "./routes/shares.js";
import { settingsRoutes } from "./routes/settings.js";
import { githubRoutes } from "./routes/github.js";
import { runnerRoutes } from "./routes/runner.js";
import { boardRoutes } from "./routes/board.js";
import { sessionRoutes } from "./routes/session.js";
import { agentRoutes } from "./routes/agent.js";
import { mcpRoutes } from "./routes/mcp.js";
import { credentialsRoutes } from "./routes/credentials.js";
import { cardSessionRoutes } from "./routes/cardSession.js";
import { chatRoutes } from "./routes/chat.js";
import { accountLoginRoutes } from "./routes/accountLogin.js";
import { previewRoutes, installPreviewUpgrade } from "./routes/preview.js";
import { trackSessionSockets } from "./auth/sessionSockets.js";
import { cardSdkRoutes } from "./routes/cardSdk.js";
import { startPauseReconciler, sweepCardUploads, sweepIdleCards } from "./services/board/workspace.js";
import { sweepOrphanCardData } from "./services/board/purge.js";
import { sweepDoneCards, DONE_SWEEP_INTERVAL_MS } from "./services/board/retention.js";
import { startOutboxFlusher } from "./services/board/outbox.js";
import { startRunnerReaper } from "./services/reaper/reaper.js";
import { shutdownAllDrivers } from "./services/sdk/manager.js";
import { resumeInterruptedTurns } from "./services/sdk/resume.js";

/**
 * The vibehub server: one process serving the API, the websocket terminals, and (in production) the
 * built UI. No database — state is JSON files plus an encrypted vault under VIBEHUB_DATA_DIR.
 */
export async function buildServer() {
  const app = Fastify({
    logger: false,
    // Terminal frames and image uploads: the default 1 MB body limit is too small for a paste.
    bodyLimit: 16 * 1024 * 1024,
    // Behind a gateway, `req.ip` must be the client it forwarded for — the sign-in ceilings are
    // keyed on it (routes/auth.ts). False by default: a direct install trusts no header.
    trustProxy: fastifyTrustProxy(config.trustProxy),
  });

  await app.register(cookie);
  await app.register(cors, { origin: true, credentials: true });
  // Terminals and the VNC bridge. perMessageDeflate is OFF on purpose: a terminal sends MANY tiny
  // frames (one keystroke, one echo) and per-message compression only adds latency and CPU at that
  // size — there is nothing to compress in a single byte. It is also the `ws` default, but stated
  // here so it cannot come back by accident. TCP_NODELAY for the same path is set in the route.
  await app.register(websocket, {
    options: { maxPayload: 16 * 1024 * 1024, perMessageDeflate: false },
  });

  app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));

  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(sharesRoutes);
  await app.register(settingsRoutes);
  await app.register(githubRoutes);
  await app.register(runnerRoutes);
  await app.register(boardRoutes);
  await app.register(sessionRoutes);
  await app.register(agentRoutes);
  await app.register(mcpRoutes);
  await app.register(credentialsRoutes);
  await app.register(cardSessionRoutes);
  await app.register(chatRoutes);
  await app.register(accountLoginRoutes);
  await app.register(previewRoutes);

  // Preview websockets (vite HMR) ride the same `upgrade` event @fastify/websocket owns; the
  // interceptor wraps its listener once everything is registered. The open-socket registry comes
  // AFTER it, as a listener of its own, so it sees every upgrade — tunnels included — and a revoked
  // session can end the sockets it already opened (auth/sessionSockets.ts).
  app.addHook("onReady", async () => {
    installPreviewUpgrade(app.server);
    trackSessionSockets(app.server);
  });
  await app.register(cardSdkRoutes);

  const staticDir = process.env.VIBEHUB_STATIC_DIR
    ? resolve(process.env.VIBEHUB_STATIC_DIR)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

  // In production the API also serves the built UI, so one container is the whole product. In dev
  // the Vite server owns the UI and this directory simply does not exist. Check for it explicitly:
  // @fastify/static accepts a missing root without complaining, and every non-API request would
  // then 404 through sendFile with no explanation of why.
  const hasBuiltUi = existsSync(join(staticDir, "index.html"));
  if (hasBuiltUi) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
  } else {
    logger.info({ staticDir }, "no built UI found — serving the API only (normal in development)");
  }

  // Paths that are API surface, so an unknown one answers JSON instead of quietly rendering the UI.
  // `/mcp` lives outside `/api` because MCP clients expect a root-level endpoint — without this, a
  // build that lost the route would hand an MCP client a page of HTML and a 200.
  const isApiPath = (url: string): boolean => url.startsWith("/api") || url.startsWith("/mcp");

  app.setNotFoundHandler(async (req, reply) => {
    if (isApiPath(req.url) || !hasBuiltUi) {
      return await reply.code(404).send({ error: "not found" });
    }
    // Client-side routing: any other path renders the app and lets the router decide.
    return await reply.sendFile("index.html");
  });

  return app;
}

/**
 * How often the idle sweep runs. Not the threshold — that is `idleHibernateMinutes` in settings and
 * is measured in hours; this is only the resolution at which we notice, and five minutes of extra
 * life on a terminal nobody has touched since lunch costs nothing.
 *
 * It lives in `main()` rather than in `buildServer()` on purpose: tests build the server and must
 * not inherit a timer that kills sessions underneath them.
 */
const IDLE_SWEEP_MS = 5 * 60_000;

function startIdleSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepIdleCards().catch((err: unknown) => {
      // Best-effort by design: a runner that is down means the sweep waits five more minutes.
      logger.warn({ err }, "idle sweep failed — no card was hibernated this pass");
    });
  }, IDLE_SWEEP_MS);
  // The sweep must never be the reason the process stays alive.
  timer.unref?.();
  return timer;
}

/**
 * How often the uploads sweep runs. ONCE A DAY, because what it deletes is six months old: there is
 * no version of this that needs to be prompt, and every pass is a docker exec into the runner.
 */
const UPLOAD_SWEEP_MS = 24 * 60 * 60_000;

/**
 * The attached images that nobody can have wanted for six months (see `UPLOAD_RETENTION_DAYS`).
 * Runs once at boot too: an install that is restarted more often than daily would otherwise never
 * sweep at all.
 */
function startUploadSweep(): NodeJS.Timeout {
  void sweepCardUploads();
  const timer = setInterval(() => void sweepCardUploads(), UPLOAD_SWEEP_MS);
  timer.unref?.();
  return timer;
}

/**
 * How often the orphan sweep runs. ONCE A DAY, like the uploads sweep: what it collects is, by
 * definition, data nobody can reach any more — there is no version of this that needs to be prompt.
 */
const ORPHAN_SWEEP_MS = 24 * 60 * 60_000;

/**
 * The backstop of the card purge (services/board/purge.ts): artifacts of cards that NO LONGER
 * EXIST — a conversation left by a delete that could not reach the runner, and everything the
 * deletes from before the purge existed left behind. Runs once at boot and then daily.
 */
function startOrphanSweep(): NodeJS.Timeout {
  void sweepOrphanCardData();
  const timer = setInterval(() => void sweepOrphanCardData(), ORPHAN_SWEEP_MS);
  timer.unref?.();
  return timer;
}

/**
 * The cards nobody has touched in `done` for a day (see `DONE_RETENTION_DAYS`): purged, not
 * hidden — with their worktree, their branch, their uploads and their conversation. Runs once at
 * boot and then HOURLY (`DONE_SWEEP_INTERVAL_MS`), so the countdown on the card holds; the pass is
 * capped and logged.
 */
function startDoneRetentionSweep(): NodeJS.Timeout {
  void sweepDoneCards();
  const timer = setInterval(() => void sweepDoneCards(), DONE_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

async function main(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const app = await buildServer();
  // The outbox backstop. Started HERE and not in buildServer(): tests build servers by the dozen
  // and none of them wants a timer poking at a runner.
  startOutboxFlusher();
  await app.listen({ port: config.port, host: config.host });
  const trustWarning = trustProxyBootWarning(config.trustProxy);
  if (trustWarning) logger.warn(trustWarning);
  startIdleSweep();
  // The uploads sweep, for the same reason and in the same place as the others: a test that boots
  // the app must not inherit a timer that deletes files in the runner.
  startUploadSweep();
  // The orphan sweep, same reasoning: a card that was deleted must not leave its conversation or
  // its files on the server, and a delete that failed halfway is collected here.
  startOrphanSweep();
  // The done-card retention, same reasoning again: a card finished six months ago is deleted with
  // everything that belonged to it, and a test that boots the app must not inherit a timer that
  // deletes cards.
  startDoneRetentionSweep();
  // Pending pauses are normally closed by the Stop hook, but a session can go quiet without ever
  // firing one (Claude parked on the "Resume from summary" menu, on a permission question, or
  // killed). This asks the runner about those cards on a timer and finishes the pause — a card in
  // Paused must not be running. Started HERE and not in buildServer, for the same reason as the
  // idle sweep: tests that boot the app must not inherit background work.
  startPauseReconciler();
  // The runner reaper: the backstop against leaked processes inside the runner (orphaned claude
  // and transcript watchers with ppid 1). The primary fixes are the tree-kill and the follow
  // loop's stdin check — this collects whatever slips through, every ten minutes. Started HERE
  // for the same reason as the others: tests must not inherit a timer that kills processes.
  startRunnerReaper();
  // Turnos do chat nativo interrompidos pelo ÚLTIMO deploy (o back morre, os drivers — filhos dele —
  // morrem juntos): o sweep acha os marcadores duráveis, escreve a linha de sistema no chat do card
  // e retoma o turno automaticamente (uma vez, nunca em loop). Depois do listen, fire-and-forget:
  // aceitar conexões não espera o runner. Ver services/sdk/resume.ts.
  void resumeInterruptedTurns().then((summary) => {
    if (summary.resumed.length > 0 || summary.noted.length > 0) {
      logger.info({ resumed: summary.resumed.length, noted: summary.noted.length }, "sdk boot resume done");
    }
  });
  // Graceful shutdown (melhor esforço): o docker stop de um deploy manda SIGTERM e dá uns segundos.
  // Encerrar o stdin dos drivers é o adeus limpo (EOF = exit do driver, atravessa o docker exec);
  // os marcadores de turno em voo FICAM no disco — são eles que contam ao próximo boot o que este
  // shutdown interrompeu. Nada aqui bloqueia a saída.
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "vibehub shutting down — closing sdk drivers (inflight markers kept)");
    try { shutdownAllDrivers(); } catch { /* best-effort by design */ }
    void app.close().finally(() => process.exit(0));
    // The escape hatch: a socket that will not close must not outlive docker's grace window.
    setTimeout(() => process.exit(0), 5_000).unref?.();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  logger.info(
    { port: config.port, dataDir: config.dataDir, runner: config.runner.kind },
    `vibehub listening on http://${config.host}:${config.port}`,
  );
}

/**
 * Was this module the script node was asked to run? URL against URL: a hand-made `file://${argv1}`
 * never matched on Windows (backslashes, drive letter) nor with a space in the path (%20), and the
 * process then exited without a server and without a word.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}

// Only run when executed directly — tests import buildServer().
if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((err: unknown) => {
    logger.error({ err }, "vibehub failed to start");
    process.exit(1);
  });
}
