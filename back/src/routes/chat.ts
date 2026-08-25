import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { requireSession } from "../auth/session.js";
import { sendToTerminal } from "../services/maestro/maestro.js";
import { chatSource, sendChatKey, parseChatEvents, CHAT_KEYS } from "../services/chat/chat.js";
import { logger } from "../utils/logger.js";

/**
 * CHAT routes — the card's session read as a conversation and written to as one.
 *
 * The websocket carries EVENTS (one JSON object per frame), not bytes: the server does the
 * transcript parsing once, so the browser never sees a partial line, a tool result or a subagent's
 * turns. Sending reuses the maestro's send-keys path, which types into the very same tmux session
 * the terminal pane is attached to — there is only ever one conversation.
 */

/** Frames larger than this are a transcript pathology, not a message. */
const MAX_LINE_BYTES = 2 * 1024 * 1024;

const KEEPALIVE_MS = 25_000;

/** The websocket user, for the audit line. */
function actorOf(req: FastifyRequest): string | undefined {
  return (req as FastifyRequest & { userId?: string }).userId;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Live transcript of one card. Opens with the last turns and then streams what is appended.
   *
   * A dropped socket is the browser's problem to retry (same policy as the terminal), so there is
   * no reconnect here: the client reopens and gets its history again, deduped by event id.
   */
  app.get<{ Params: { id: string } }>(
    "/api/cards/:id/chat",
    { websocket: true, preHandler: requireSession },
    async (socket: WebSocket, req) => {
      let source: Awaited<ReturnType<typeof chatSource>>;
      try {
        source = await chatSource(req.params.id);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "could not open a card chat");
        socket.close();
        return;
      }

      const child = spawn(source.command.file, source.command.args, { stdio: ["pipe", "pipe", "ignore"] });
      const keepalive = setInterval(() => {
        try { socket.ping?.(); } catch { /* the close handler cleans up */ }
      }, KEEPALIVE_MS);

      // `tail` hands over whatever the pipe happens to hold, so a line can arrive in two chunks —
      // parsing per chunk would drop every message that straddles a boundary. Only COMPLETE lines
      // are parsed; the remainder waits for the rest of itself.
      let pending = "";
      child.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        if (pending.length > MAX_LINE_BYTES) pending = ""; // a line that long is not a message
        for (const line of lines) {
          for (const event of parseChatEvents(line)) {
            try { socket.send(JSON.stringify(event)); } catch { /* going away; close tidies up */ }
          }
        }
      });

      const teardown = (): void => {
        clearInterval(keepalive);
        try { child.kill(); } catch { /* already gone */ }
      };
      child.on("close", () => {
        clearInterval(keepalive);
        try { socket.close(); } catch { /* already closed */ }
      });
      socket.on("close", teardown);
      socket.on("error", teardown);
      logger.debug({ card: source.cardId }, "chat attached");
    },
  );

  /** Sends a message: types it at the session's prompt and presses Enter. */
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/api/cards/:id/chat",
    { preHandler: requireSession },
    async (req, reply) => {
      const text = String(req.body?.text ?? "");
      try {
        // The user's OWN send — never gate on human-active (their typing is what marks it active).
        await sendToTerminal(req.params.id, text, { by: actorOf(req), guardInteractiveMenu: true });
        return await reply.send({ ok: true });
      } catch (err) {
        const message = (err as Error).message;
        // "no live session" is not a server fault and not a missing card: it is a card that has to
        // be opened first, and the UI says exactly that.
        const code = /not found/i.test(message) ? 404 : /no live session|empty text|awaiting choice/i.test(message) ? 409 : 502;
        return await reply.code(code).send({ error: message });
      }
    },
  );

  /** Presses one whitelisted key (Stop = Escape) in the session. */
  app.post<{ Params: { id: string }; Body: { key?: string } }>(
    "/api/cards/:id/chat/key",
    { preHandler: requireSession },
    async (req, reply) => {
      const key = String(req.body?.key ?? "");
      if (!CHAT_KEYS[key]) return await reply.code(400).send({ error: `unknown key: '${key}'` });
      try {
        return await reply.send(await sendChatKey(req.params.id, key));
      } catch (err) {
        const message = (err as Error).message;
        const code = /not found/i.test(message) ? 404 : /no live session/i.test(message) ? 409 : 502;
        return await reply.code(code).send({ error: message });
      }
    },
  );
}
