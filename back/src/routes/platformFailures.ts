import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestUser, requireOwner } from "../auth/session.js";
import {
  PlatformFailureNotFoundError, PlatformFailureStateError, dismissPlatformFailure, listPlatformFailuresForOwner,
} from "../services/platformFailures/platformFailures.js";
import { startPlatformFailureInvestigation } from "../services/platformFailures/investigation.js";

async function sendPlatformFailureError(reply: FastifyReply, err: unknown) {
  if (err instanceof PlatformFailureNotFoundError) return await reply.code(404).send({ error: err.message });
  if (err instanceof PlatformFailureStateError) return await reply.code(400).send({ error: err.message });
  throw err;
}

async function requireRequestOwner(req: FastifyRequest) {
  const owner = await requestUser(req);
  if (!owner) throw new Error("requireOwner let a request through without a user");
  return owner;
}

export async function platformFailureRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/platform-failures", { preHandler: requireOwner }, async (_req, reply) => {
    return await reply.send({ failures: await listPlatformFailuresForOwner() });
  });

  app.post<{ Params: { id: string } }>("/api/platform-failures/:id/investigate", { preHandler: requireOwner }, async (req, reply) => {
    try {
      return await reply.send(await startPlatformFailureInvestigation(req.params.id, await requireRequestOwner(req)));
    } catch (err) {
      return await sendPlatformFailureError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/platform-failures/:id/dismiss", { preHandler: requireOwner }, async (req, reply) => {
    try {
      return await reply.send({ failure: await dismissPlatformFailure(req.params.id) });
    } catch (err) {
      return await sendPlatformFailureError(reply, err);
    }
  });
}
