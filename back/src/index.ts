import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));

  await app.register(authRoutes);
  await app.register(settingsRoutes);
  await app.register(githubRoutes);
  await app.register(runnerRoutes);
  await app.register(boardRoutes);

  const staticDir = process.env.VIBEHUB_STATIC_DIR
    ? resolve(process.env.VIBEHUB_STATIC_DIR)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

  // In production the API also serves the built UI, so one container is the whole product. In dev
  // the Vite server owns the UI and this directory simply does not exist.
  try {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api")) return await reply.code(404).send({ error: "not found" });
      // Client-side routing: any non-API path renders the app.
      return await reply.sendFile("index.html");
    });
  } catch {
    logger.info({ staticDir }, "no built UI found — API only (this is normal in development)");
  }

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
