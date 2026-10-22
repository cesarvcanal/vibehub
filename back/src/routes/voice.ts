import type { FastifyInstance } from "fastify";
import { requireSession, sessionUserId } from "../auth/session.js";
import { createLiveSession, voiceLiveStatus, SDP_MAX_BYTES, VoiceLiveError } from "../services/voice/live.js";

/**
 * VOICE MODE (POC) — see services/voice/live.ts. Any signed-in person may talk: the session is a
 * plain conversation, touches no card and no runner, and the key never leaves the server.
 */
export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  /** Booleans only: is the mode on, and can the server reach a key. */
  app.get("/api/voice/live", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await voiceLiveStatus());
  });

  /** `{ sdp }` (the browser's offer) → `{ sessionId, sdp }` (GPT-Live's answer). */
  app.post<{ Body: { sdp?: unknown } }>(
    "/api/voice/live/sessions",
    { preHandler: requireSession, bodyLimit: SDP_MAX_BYTES + 4096 },
    async (req, reply) => {
      // The browser cancelled (stop while connecting, tab closed): drop the upstream call too.
      const gone = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) gone.abort();
      });
      try {
        const user = (await sessionUserId(req)) ?? "unknown";
        const answer = await createLiveSession(req.body?.sdp, { user, signal: gone.signal });
        return await reply.code(201).send(answer);
      } catch (err) {
        if (err instanceof VoiceLiveError) return await reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );
}
