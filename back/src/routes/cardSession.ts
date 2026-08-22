import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { sessionInfo } from "../services/maestro/maestro.js";

/**
 * What a card's session is REALLY using — the model from the last assistant turn and the effective
 * account. The pills in the card bar show this instead of "default", because "default" tells you
 * nothing and the person wants to see what is in use.
 */
export async function cardSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/cards/:id/session", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send(await sessionInfo(req.params.id));
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 502).send({ error: message });
    }
  });
}
