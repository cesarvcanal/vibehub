import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import pty from "node-pty";
import { requireOwner } from "../auth/session.js";
import { provisionRunner, runnerStatus, startRunner } from "../runtime/runner.js";
import { runnerProcessStats } from "../services/reaper/reaper.js";
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
  app.get("/api/runner", { preHandler: requireOwner }, async (_req, reply) => {
    return await reply.send({
      ...(await runnerStatus()),
      provisioning: provisioning !== null,
      terminal: true,
      // Last reaper sweep: total processes inside the runner + what it collected. A count that
      // keeps climbing between sweeps is the early sign of a NEW leak (the 2026-08-29 incident
      // was ~800 processes and load 55 before anyone noticed). null until the first sweep.
      processes: runnerProcessStats(),
    });
  });

  /**
   * A shell INSIDE the runner container itself — not a card. This is where you run `claude` and
   * `/login` once per account, `gh auth login`, or poke at /work when something looks off. The
   * command is fixed: container name from config, shell picked with `command -v` (a failing `exec`
   * would take the shell down with it — the `||` would never run).
   */
  app.get("/api/runner/terminal", { websocket: true, preHandler: requireOwner }, (socket) => {
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

  app.post("/api/runner/provision", { preHandler: requireOwner }, async (_req, reply) => {
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

  app.post("/api/runner/start", { preHandler: requireOwner }, async (_req, reply) => {
    try {
      await startRunner();
      return await reply.send(await runnerStatus());
    } catch (err) {
      return await reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get("/api/runner/logs", { websocket: true, preHandler: requireOwner }, (socket) => {
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
    // THE WHOLE APP BOOTS THROUGH HERE — the front cannot decide between the wizard, the login and
    // the board before this answers, and it renders a bare loading screen until it does. So it may
    // not sit on anything unbounded: the probes run TOGETHER (not one after the other), the runner
    // status is served from a short cache instead of a fresh `docker exec` per page load, and
    // "GitHub done" is answered from the STORED connections — asking github.com who each token
    // belongs to told this route nothing it uses and put an internet round trip in front of the
    // first paint.
    const [settings, runner, connections] = await Promise.all([
      fresh ? null : getSettings(),
      fresh ? null : runnerStatus({ maxAgeMs: 5_000 }),
      fresh ? [] : github.listConnections(),
    ]);
    // "GitHub done" = at least one account connected. The wizard step is optional either way.
    const githubConnected = connections.length > 0;
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
