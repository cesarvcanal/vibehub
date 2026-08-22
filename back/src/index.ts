import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { config } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { authRoutes } from "./routes/auth.js";
import { settingsRoutes } from "./routes/settings.js";
import { githubRoutes } from "./routes/github.js";
import { runnerRoutes } from "./routes/runner.js";
import { boardRoutes } from "./routes/board.js";
import { sessionRoutes } from "./routes/session.js";
import { agentRoutes } from "./routes/agent.js";
import { mcpRoutes } from "./routes/mcp.js";
import { cardSessionRoutes } from "./routes/cardSession.js";
import { chatRoutes } from "./routes/chat.js";
import { accountLoginRoutes } from "./routes/accountLogin.js";

/**
 * The vibehub server: one process serving the API, the websocket terminals, and (in production) the
 * built UI. No database — state is JSON files plus an encrypted vault under VIBEHUB_DATA_DIR.
 */
export async function buildServer() {
  const app = Fastify({
    logger: false,
    // Terminal frames and image uploads: the default 1 MB body limit is too small for a paste.
    bodyLimit: 16 * 1024 * 1024,
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
  await app.register(settingsRoutes);
  await app.register(githubRoutes);
  await app.register(runnerRoutes);
  await app.register(boardRoutes);
  await app.register(sessionRoutes);
  await app.register(agentRoutes);
  await app.register(mcpRoutes);
  await app.register(cardSessionRoutes);
  await app.register(chatRoutes);
  await app.register(accountLoginRoutes);

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

async function main(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { port: config.port, dataDir: config.dataDir, runner: config.runner.kind },
    `vibehub listening on http://${config.host}:${config.port}`,
  );
}

// Only run when executed directly — tests import buildServer().
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    logger.error({ err }, "vibehub failed to start");
    process.exit(1);
  });
}
