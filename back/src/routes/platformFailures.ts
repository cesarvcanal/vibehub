import type { FastifyInstance, FastifyReply } from "fastify";
import { requestUser, requireOwner, requireSession } from "../auth/session.js";
import {
  PlatformFailureNotFoundError, PlatformFailureStateError, dismissPlatformFailure,
} from "../services/platformFailures/platformFailures.js";
import { listPlatformFailuresAwaitingOwner, startPlatformFailureInvestigation } from "../services/platformFailures/investigation.js";
import { InvalidScreenErrorReport, parseScreenErrorReport, recordScreenError } from "../services/platformFailures/screenError.js";

async function sendPlatformFailureError(reply: FastifyReply, err: unknown) {
  if (err instanceof PlatformFailureNotFoundError) return await reply.code(404).send({ error: err.message });
  if (err instanceof PlatformFailureStateError || err instanceof InvalidScreenErrorReport) return await reply.code(400).send({ error: err.message });
  throw err;
}

export async function platformFailureRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/platform-failures", { preHandler: requireOwner }, async (_req, reply) => {
    return await reply.send({ failures: await listPlatformFailuresAwaitingOwner() });
  });

  app.post<{ Params: { id: string } }>("/api/platform-failures/:id/investigate", { preHandler: requireOwner }, async (req, reply) => {
    try {
      const owner = await requestUser(req);
      if (!owner) throw new Error("requireOwner let a request through without a user");
      return await reply.send(await startPlatformFailureInvestigation(req.params.id, owner));
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

  app.post("/api/platform-failures/screen-errors", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ recorded: await recordScreenError(parseScreenErrorReport(req.body)) });
    } catch (err) {
      return await sendPlatformFailureError(reply, err);
    }
  });
}
