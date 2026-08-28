import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import pty from "node-pty";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { requireOwner, sessionUserId } from "../auth/session.js";
import { requireCardAccess } from "../auth/access.js";
import * as registry from "../services/board/registry.js";
import * as workspace from "../services/board/workspace.js";
import * as browser from "../services/browser/browser.js";
import * as outbox from "../services/board/outbox.js";
import { logger } from "../utils/logger.js";

/**
 * SESSION routes — everything that touches a live card: opening it in the runner, the xterm
 * websocket, the extra shell, image upload, pause/restart, the live browser and its VNC bridge.
 *
 * The websocket is the product's hot path. It attaches with `tmux new-session -A`, a COMPLETE
 * attach-or-create carrying the same environment the open would give the session, so a card that
 * has been opened before connects instantly and the /open call becomes background work.
 */

/** A `ws` WebSocket, under which lives the raw TCP socket (`_socket`). */
interface RawSocketHolder {
  _socket?: { setNoDelay?: (on: boolean) => void };
}

/**
 * Turns Nagle's algorithm off (TCP_NODELAY) on the TCP socket under the WebSocket.
 *
 * Echoing ONE keystroke is a tiny packet (a byte plus the WS frame). With Nagle on it can sit in
 * the server for up to ~40ms (Nagle × delayed-ACK) before leaving for the browser — which is
 * exactly the lag you feel while typing in an interactive terminal. Node leaves Nagle ON by default
 * on HTTP server sockets, so the terminal path has to ask for NODELAY explicitly.
 *
 * Idempotent, and safe on a socket with no `_socket` (adapters and tests). Returns true if applied.
 */
export function disableNagle(socket: unknown): boolean {
  const raw = (socket as RawSocketHolder | null)?._socket;
  if (!raw || typeof raw.setNoDelay !== "function") return false;
  try {
    raw.setNoDelay(true);
    return true;
  } catch {
    return false; // the socket is already closing
  }
}

/**
 * How long after a terminal attaches the outbox is flushed. Claude Code has to boot and draw its
 * prompt before a `send-keys` means anything; three seconds is the gap between "the session exists"
 * and "the agent is listening".
 */
export const OUTBOX_ATTACH_DELAY_MS = 3_000;

/** Terminal geometry the runner will accept: an integer between 10 and 500. */
export function isValidTermSize(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 10 && n <= 500;
}

/**
 * How often a card's `humanActiveAt` is actually written while someone types. Keystrokes arrive many
 * per second; persisting each would hammer the board store. The window a maestro reads
 * (HUMAN_ACTIVE_WINDOW_MS, minutes) is far larger, so stamping at most this often loses nothing.
 */
export const HUMAN_ACTIVE_THROTTLE_MS = 5_000;

/** Last time each card's human-active stamp was written — the throttle gate. Module-scoped. */
const lastHumanStamp = new Map<string, number>();

/**
 * Should we WRITE the stamp for this card now? true when the throttle window has passed since the
 * last write (updating the gate as a side effect). Keeps the disk-write rate bounded no matter how
 * fast the user types, across every connection to the same card. PURE-ish (mutates the gate map).
 */
export function shouldStampHumanActive(cardId: string, now: number = Date.now()): boolean {
  const last = lastHumanStamp.get(cardId) ?? 0;
  if (now - last < HUMAN_ACTIVE_THROTTLE_MS) return false;
  lastHumanStamp.set(cardId, now);
  return true;
}

/** Clears the throttle gate — tests only. */
export function resetHumanStampThrottleForTesting(): void {
  lastHumanStamp.clear();
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

/**
 * Wires a pty to a websocket: output out, keystrokes and resizes in, both sides closing together.
 *
 * `onInput` (when given) is called with each DATA frame the browser sends — a human typing. The card
 * terminal uses it to stamp `humanActiveAt`; resize frames never trigger it (a layout change is not
 * a person typing).
 */
export function bridgePty(socket: WebSocket, term: IPty, label: string, onInput?: (data: string) => void): void {
  disableNagle(socket);
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
    else {
      term.write(frame.data);
      // A person typed. Best-effort: a bad listener must never take the terminal down.
      if (onInput) { try { onInput(frame.data); } catch { /* ignore */ } }
    }
  });

  const teardown = (): void => {
    clearInterval(keepalive);
    try { term.kill(); } catch { /* already gone */ }
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
}

/**
 * true = this card has NO workspace in the runner yet (never opened, and the background prepare
 * fired at its creation has not landed). Attaching a terminal to it would let `tmux new-session -A`
 * create the session anyway — tmux quietly falls back to another directory when `-c` does not
 * exist — and Claude would come up outside the card's worktree, or not at all. PURE.
 */
export function needsProvisioning(card: Pick<registry.Card, "openedAt" | "preparedAt">): boolean {
  return !card.openedAt && !card.preparedAt;
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------------------------------------- lifecycle */

  app.post<{ Params: { id: string } }>("/api/cards/:id/open", { preHandler: requireCardAccess }, async (req, reply) => {
    try {
      return await reply.send({ card: await workspace.openCard(req.params.id) });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/cards/:id/pause", { preHandler: requireCardAccess }, async (req, reply) => {
    try {
      return await reply.send({ card: await workspace.pauseCard(req.params.id) });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  /**
   * HIBERNATE: kill the session, leave the card exactly where it is on the board. A card that has
   * nothing to hibernate (never opened, already cold, or `working`) is not an error — the answer is
   * the card as it stands, so the UI can just re-render it.
   */
  app.post<{ Params: { id: string } }>("/api/cards/:id/hibernate", { preHandler: requireCardAccess }, async (req, reply) => {
    try {
      const hibernated = await workspace.hibernateCard(req.params.id);
      const card = hibernated ?? (await registry.getCard(req.params.id));
      if (!card) return await reply.code(404).send({ error: "card not found" });
      return await reply.send({ card });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/cards/:id/restart", { preHandler: requireCardAccess }, async (req, reply) => {
    try {
      return await reply.send({ card: await workspace.restartCard(req.params.id) });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  app.post("/api/cards/restart-all", { preHandler: requireOwner }, async (_req, reply) => {
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
  app.delete<{ Params: { id: string } }>("/api/cards/:id", { preHandler: requireOwner }, async (req, reply) => {
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
    "/api/cards/:id/upload", { preHandler: requireCardAccess },
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

  /* --------------------------------------------------------------- messages */

  /**
   * The composer's Enter. It does NOT type into the websocket any more: the message is handed to
   * the OUTBOX, which delivers it to a RUNNING Claude or keeps it queued until there is one. A
   * card whose agent has exited (the pane fell back to `exec bash`) or whose session does not exist
   * yet used to swallow whatever you sent it — see services/board/outbox.ts.
   */
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/api/cards/:id/messages", { preHandler: requireCardAccess },
    async (req, reply) => {
      try {
        const by = (await sessionUserId(req)) ?? undefined;
        return await reply.send(await outbox.queueMessage(req.params.id, String(req.body?.text ?? ""), by));
      } catch (err) {
        const message = (err as Error).message;
        return await reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
      }
    },
  );

  /** What is still waiting for this card, and whether the agent is up to receive it. */
  app.get<{ Params: { id: string } }>(
    "/api/cards/:id/messages", { preHandler: requireCardAccess },
    async (req, reply) => {
      try {
        return await reply.send(await outbox.outboxStatus(req.params.id));
      } catch (err) {
        const message = (err as Error).message;
        return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
      }
    },
  );

  /** Gives up on a queued message (the ✕ on a pending chip). */
  app.delete<{ Params: { id: string; messageId: string } }>(
    "/api/cards/:id/messages/:messageId", { preHandler: requireCardAccess },
    async (req, reply) => {
      const removed = await outbox.cancelMessage(req.params.id, req.params.messageId);
      if (!removed) return await reply.code(404).send({ error: "message not found" });
      return await reply.send({ ok: true });
    },
  );

  /* ---------------------------------------------------------------- browser */

  app.post<{ Params: { id: string } }>("/api/cards/:id/browser", { preHandler: requireCardAccess }, async (req, reply) => {
    try {
      return await reply.send({ ports: await browser.openCardBrowser(req.params.id) });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/cards/:id/browser", { preHandler: requireCardAccess }, async (req, reply) => {
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
    { websocket: true, preHandler: requireCardAccess },
    async (socket: WebSocket, req) => {
      const card = await registry.getCard(req.params.id);
      const project = card ? await registry.getProject(card.projectId) : undefined;
      if (!card || !project) {
        socket.send("\r\n[vibehub] this card no longer exists\r\n");
        socket.close();
        return;
      }
      const shell = req.query?.shell === "1";
      // SNAPSHOT: `getCard` hands back the live cached record, which the provisioning below mutates
      // in place. The attach command has to be built from the card as it is NOW — a card that never
      // had a conversation must be born with a plain `claude`, never with `claude -c` (which prints
      // "No conversation found to continue" before falling back).
      const snapshot = { ...card };

      // A card whose workspace was never provisioned (never opened, and the background prepare from
      // its creation has not landed yet) has NO worktree in the runner. Attaching now would let
      // `tmux new-session -A` create the session anyway — tmux quietly falls back to another
      // directory when `-c` does not exist — and Claude would start outside the card's worktree, or
      // land on a bare shell. That is the "terminal with no Claude in it" on a brand-new card. So
      // provision FIRST and attach to a workspace that really exists.
      if (needsProvisioning(snapshot)) {
        try {
          socket.send("\r\n[vibehub] preparing this card in the runner…\r\n");
          await workspace.openCard(card.id);
        } catch (err) {
          logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not prepare the card for its terminal");
          socket.send(`\r\n[vibehub] could not prepare this card: ${(err as Error).message}\r\n`);
          socket.close();
          return;
        }
      }

      const { file, args } = workspace.cardTerminalCommand(project, snapshot, { shell });
      const term = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color" },
      });
      logger.info({ card: card.worktreeSlug, shell }, "terminal attached");
      // A human typing here makes the card "human-active": a maestro must not send into it while a
      // person is at the prompt. Throttled to a write every few seconds, and fire-and-forget — a
      // keystroke must never wait on the board store, and an unknown card is a no-op there.
      bridgePty(socket, term, card.worktreeSlug, () => {
        if (shouldStampHumanActive(card.id)) void registry.markCardHumanActive(card.id);
      });

      // A terminal attaching is the moment a dead session comes back: `tmux new-session -A`
      // recreates it with Claude inside, so anything queued for this card can go now. Delayed, and
      // fire-and-forget — the agent needs a moment to reach its prompt, and the socket must not
      // wait on a docker exec either way.
      if (!shell) {
        const flush = setTimeout(() => void outbox.flushCard(card.id), OUTBOX_ATTACH_DELAY_MS);
        socket.on("close", () => clearTimeout(flush));
      }

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
    { websocket: true, preHandler: requireCardAccess },
    async (socket: WebSocket, req) => {
      let bridge: Awaited<ReturnType<typeof browser.cardVncBridge>>;
      try {
        bridge = await browser.cardVncBridge(req.params.id);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "could not start the card browser");
        socket.close();
        return;
      }
      disableNagle(socket);
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
