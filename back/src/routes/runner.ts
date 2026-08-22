import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import pty from "node-pty";
import { requireSession } from "../auth/session.js";
import { provisionRunner, runnerStatus, startRunner } from "../runtime/runner.js";
import { hostExecutor, shQuote } from "../runtime/host.js";
import { config } from "../config/env.js";
import { bridgePty } from "./session.js";
import { getSettings } from "../services/settings/settings.js";
import { isFreshInstall } from "../auth/users.js";
import * as github from "../services/github/client.js";
import { logger } from "../utils/logger.js";

/**
 * RUNNER routes plus the setup state the wizard is driven by.
 *
 * Provisioning is long (apt, npm, a browser download) so it streams: the POST kicks it off and
 * returns, while `WS /api/runner/logs` carries the output. Subscribers that connect late still see
 * the tail, because the last run's log is buffered.
 */

const LOG_BUFFER_LIMIT = 400;

let provisioning: Promise<void> | null = null;
let logBuffer: string[] = [];
const subscribers = new Set<WebSocket>();

function broadcast(chunk: string): void {
  logBuffer.push(chunk);
  if (logBuffer.length > LOG_BUFFER_LIMIT) logBuffer = logBuffer.slice(-LOG_BUFFER_LIMIT);
  for (const socket of subscribers) {
    // A dead subscriber must never take provisioning down with it.
    try { socket.send(chunk); } catch { subscribers.delete(socket); }
  }
}

export async function runnerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/runner", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send({ ...(await runnerStatus()), provisioning: provisioning !== null, terminal: true });
  });

  /**
   * A shell INSIDE the runner container itself — not a card. This is where you run `claude` and
   * `/login` once per account, `gh auth login`, or poke at /work when something looks off. The
   * command is fixed: container name from config, shell picked with `command -v` (a failing `exec`
   * would take the shell down with it — the `||` would never run).
   */
  app.get("/api/runner/terminal", { websocket: true, preHandler: requireSession }, (socket) => {
    const pick = "if command -v bash >/dev/null 2>&1; then exec bash; fi; exec sh";
    const line = `docker exec -it ${shQuote(config.runner.container)} env LANG=C.UTF-8 LC_ALL=C.UTF-8 sh -c ${shQuote(pick)}`;
    const { file, args } = hostExecutor().ptyCommand(line);
    const term = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color" },
    });
    logger.info({ container: config.runner.container }, "runner shell attached");
    bridgePty(socket, term, "runner-shell");
  });

  app.post("/api/runner/provision", { preHandler: requireSession }, async (_req, reply) => {
    if (provisioning) return await reply.send({ ok: true, alreadyRunning: true });
    const settings = await getSettings();
    logBuffer = [];
    provisioning = provisionRunner({
      git: settings.git,
      autonomous: settings.autonomous,
      onChunk: broadcast,
    })
      .then(() => { broadcast("\n[vibehub] runner ready\n"); })
      .catch((err: unknown) => {
        const message = (err as Error).message;
        logger.error({ err: message }, "runner provisioning failed");
        broadcast(`\n[vibehub] provisioning failed: ${message}\n`);
      })
      .finally(() => { provisioning = null; });
    return await reply.send({ ok: true });
  });

  app.post("/api/runner/start", { preHandler: requireSession }, async (_req, reply) => {
    try {
      await startRunner();
      return await reply.send(await runnerStatus());
    } catch (err) {
      return await reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get("/api/runner/logs", { websocket: true, preHandler: requireSession }, (socket) => {
    subscribers.add(socket);
    if (logBuffer.length) socket.send(logBuffer.join(""));
    socket.on("close", () => subscribers.delete(socket));
    socket.on("error", () => subscribers.delete(socket));
  });

  /**
   * SETUP STATE — public, because the wizard has to render before anyone can authenticate. It says
   * which steps are done and nothing else: no secrets, no hostnames, no user list.
   */
  app.get("/api/setup/state", async (_req, reply) => {
    const fresh = await isFreshInstall();
    const settings = fresh ? null : await getSettings();
    const runner = fresh ? null : await runnerStatus();
    // "GitHub done" = at least one account connected. The wizard step is optional either way.
    const githubConnected = fresh ? false : (await github.state()).connections.length > 0;
    return await reply.send({
      fresh,
      completed: Boolean(settings?.setupCompletedAt),
      steps: {
        owner: !fresh,
        runner: Boolean(runner?.running),
        claude: Boolean(runner?.claudeInstalled),
        github: githubConnected,
      },
      runner: runner ?? { running: false, exists: false, claudeInstalled: false, dockerReachable: false },
    });
  });
}

export function resetRunnerRoutesForTesting(): void {
  provisioning = null;
  logBuffer = [];
  subscribers.clear();
}
