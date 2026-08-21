import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import pty from "node-pty";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { requireSession } from "../auth/session.js";
import * as registry from "../services/board/registry.js";
import * as workspace from "../services/board/workspace.js";
import * as browser from "../services/browser/browser.js";
import { logger } from "../utils/logger.js";

/**
 * SESSION routes — everything that touches a live card: opening it in the runner, the xterm
 * websocket, the extra shell, image upload, pause/restart, the live browser and its VNC bridge.
 *
 * The websocket is the product's hot path. It attaches with `tmux new-session -A`, a COMPLETE
 * attach-or-create carrying the same environment the open would give the session, so a card that
 * has been opened before connects instantly and the /open call becomes background work.
 */

/** Terminal geometry the runner will accept: an integer between 10 and 500. */
export function isValidTermSize(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 10 && n <= 500;
}

/** Frames from the browser: either raw keystrokes or a resize instruction. */
export function parseTerminalFrame(raw: string): { type: "resize"; cols: number; rows: number } | { type: "data"; data: string } {
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { type?: string; cols?: number; rows?: number };
      if (parsed.type === "resize" && isValidTermSize(parsed.cols) && isValidTermSize(parsed.rows)) {
        return { type: "resize", cols: parsed.cols, rows: parsed.rows };
      }
    } catch {
      // Not JSON after all — the user typed a `{`. Fall through and treat it as input.
    }
  }
  return { type: "data", data: raw };
}

const KEEPALIVE_MS = 25_000;

/** Wires a pty to a websocket: output out, keystrokes and resizes in, both sides closing together. */
function bridgePty(socket: WebSocket, term: IPty, label: string): void {
  const keepalive = setInterval(() => {
    // Proxies drop an idle websocket; a protocol ping keeps the terminal alive while you read.
    try { socket.ping?.(); } catch { /* the close handler cleans up */ }
  }, KEEPALIVE_MS);

  term.onData((data) => {
    try { socket.send(data); } catch { /* the socket is going away; onExit tidies up */ }
  });
  term.onExit(({ exitCode }) => {
    clearInterval(keepalive);
    try { socket.close(); } catch { /* already closed */ }
    logger.debug({ label, exitCode }, "terminal process exited");
  });

  socket.on("message", (raw: Buffer) => {
    const frame = parseTerminalFrame(raw.toString());
    if (frame.type === "resize") term.resize(frame.cols, frame.rows);
    else term.write(frame.data);
  });

  const teardown = (): void => {
    clearInterval(keepalive);
    try { term.kill(); } catch { /* already gone */ }
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------------------------------------- lifecycle */

  app.post<{ Params: { id: string } }>("/api/cards/:id/open", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ card: await workspace.openCard(req.params.id) });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/cards/:id/pause", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ card: await workspace.pauseCard(req.params.id) });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/cards/:id/restart", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ card: await workspace.restartCard(req.params.id) });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  app.post("/api/cards/restart-all", { preHandler: requireSession }, async (_req, reply) => {
    try {
      return await reply.send(await workspace.restartAllCards());
    } catch (err) {
      return await reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * Deleting a card tears down its runner side first (session, then worktree) and only then drops
   * it from the board — the other order would leave an orphan session nothing points at.
   */
  app.delete<{ Params: { id: string } }>("/api/cards/:id", { preHandler: requireSession }, async (req, reply) => {
    const card = await registry.getCard(req.params.id);
    if (!card) return await reply.code(404).send({ error: "card not found" });
    try {
      await workspace.dropCardWorkspace(card);
    } catch (err) {
      // Best-effort: a runner that is down must not make a card undeletable.
      logger.warn({ err: (err as Error).message, card: card.worktreeSlug }, "could not clean the card workspace");
    }
    await registry.removeCard(card.id);
    return await reply.send({ ok: true });
  });

  app.post<{ Params: { id: string }; Body: { name?: string; content?: string } }>(
    "/api/cards/:id/upload", { preHandler: requireSession },
    async (req, reply) => {
      const { name = "image.png", content = "" } = req.body ?? {};
      try {
        return await reply.send(await workspace.uploadCardImage(req.params.id, name, content));
      } catch (err) {
        const message = (err as Error).message;
        return await reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
      }
    },
  );

  /* ---------------------------------------------------------------- browser */

  app.post<{ Params: { id: string } }>("/api/cards/:id/browser", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ ports: await browser.openCardBrowser(req.params.id) });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/cards/:id/browser", { preHandler: requireSession }, async (req, reply) => {
    try {
      await browser.closeCardBrowser(req.params.id);
      return await reply.send({ ok: true });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  /* ------------------------------------------------------------- websockets */

  app.get<{ Params: { id: string }; Querystring: { shell?: string } }>(
    "/api/cards/:id/terminal",
    { websocket: true, preHandler: requireSession },
    async (socket: WebSocket, req) => {
      const card = await registry.getCard(req.params.id);
      const project = card ? await registry.getProject(card.projectId) : undefined;
      if (!card || !project) {
        socket.send("\r\n[vibehub] this card no longer exists\r\n");
        socket.close();
        return;
      }
      const shell = req.query?.shell === "1";
      const { file, args } = workspace.cardTerminalCommand(project, card, { shell });
      const term = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color" },
      });
      logger.info({ card: card.worktreeSlug, shell }, "terminal attached");
      bridgePty(socket, term, card.worktreeSlug);

      // Writing into a paused or finished card revives it — the same rule a status hook follows,
      // applied here because the websocket is how a human actually shows up.
      if (!shell && (card.column === "paused" || card.column === "done")) {
        socket.once("message", () => {
          void registry.applyCardStatus(card.id, "working");
        });
      }
    },
  );

  /**
   * VNC bridge for the card's live browser. Unlike the terminal this is a RAW byte relay (RFB is a
   * binary protocol), so it uses a plain child process and binary frames rather than a pty.
   */
  app.get<{ Params: { id: string } }>(
    "/api/cards/:id/vnc",
    { websocket: true, preHandler: requireSession },
    async (socket: WebSocket, req) => {
      let bridge: Awaited<ReturnType<typeof browser.cardVncBridge>>;
      try {
        bridge = await browser.cardVncBridge(req.params.id);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "could not start the card browser");
        socket.close();
        return;
      }
      const child = spawn(bridge.command.file, bridge.command.args, { stdio: ["pipe", "pipe", "ignore"] });
      child.stdout.on("data", (chunk: Buffer) => {
        try { socket.send(chunk); } catch { child.kill(); }
      });
      child.on("close", () => { try { socket.close(); } catch { /* already closed */ } });
      socket.on("message", (raw: Buffer) => { child.stdin.write(raw); });
      const teardown = (): void => { try { child.kill(); } catch { /* already gone */ } };
      socket.on("close", teardown);
      socket.on("error", teardown);
    },
  );
}
