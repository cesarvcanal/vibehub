import type { FastifyInstance } from "fastify";
import { requireOwner, requestUser } from "../auth/session.js";
import { requireCardWork } from "../auth/access.js";
import {
  listCredentials, createCredential, deleteCredential, type CreateCredentialInput,
} from "../services/credentials/credentials.js";
import { listCaptures, saveCapture, dismissCapture } from "../services/credentials/capture.js";

/**
 * COFRE routes.
 *
 * Credential CRUD is INSTALL-level (owner only) — one company's own logins. The value goes in and
 * never comes back: the list is names, types and timestamps only. Capture endpoints are CARD-level
 * (a person watching that card's browser) — they surface pending captures and turn one into a saved
 * credential, all WITHOUT the password ever reaching the client. SAVING one creates a credential, so
 * it is owner-only like the CRUD above; listing and dismissing stay with whoever works on the card.
 */

/**
 * Does this pending capture belong to the card in the URL? The preHandler vouched for the CARD, not
 * for an id in the body — without this, a capture seen by another card's browser was one guess away.
 */
function isCardCapture(cardId: string, captureId: string): boolean {
  return listCaptures(cardId).some((c) => c.id === captureId);
}
export async function credentialsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/credentials", { preHandler: requireOwner }, async (_req, reply) => {
    return await reply.send({ credentials: await listCredentials() });
  });

  app.post<{ Body: CreateCredentialInput }>("/api/credentials", { preHandler: requireOwner }, async (req, reply) => {
    try {
      const by = (await requestUser(req))?.id;
      const credential = await createCredential(req.body ?? ({} as CreateCredentialInput), by);
      return await reply.send({ credential });
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/credentials/:id", { preHandler: requireOwner }, async (req, reply) => {
    const by = (await requestUser(req))?.id;
    const removed = await deleteCredential(req.params.id, by);
    if (!removed) return await reply.code(404).send({ error: "credential not found" });
    return await reply.send({ ok: true });
  });

  /* ---------------------------------------------------------------- captures */

  app.get<{ Params: { id: string } }>(
    "/api/cards/:id/captures",
    { preHandler: requireCardWork },
    async (req, reply) => {
      return await reply.send({ captures: listCaptures(req.params.id) });
    },
  );

  app.post<{ Params: { id: string }; Body: { captureId?: string; name?: string } }>(
    "/api/cards/:id/captures/save",
    { preHandler: requireOwner },
    async (req, reply) => {
      const captureId = String(req.body?.captureId ?? "");
      if (!isCardCapture(req.params.id, captureId)) {
        return await reply.code(404).send({ error: "this capture is no longer available" });
      }
      try {
        const by = (await requestUser(req))?.id;
        const credential = await saveCapture(captureId, req.body?.name, by);
        return await reply.send({ credential });
      } catch (err) {
        return await reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { captureId?: string } }>(
    "/api/cards/:id/captures/dismiss",
    { preHandler: requireCardWork },
    async (req, reply) => {
      const captureId = String(req.body?.captureId ?? "");
      const ok = isCardCapture(req.params.id, captureId) && dismissCapture(captureId);
      return await reply.send({ ok });
    },
  );
}
