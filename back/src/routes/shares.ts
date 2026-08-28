import type { FastifyInstance } from "fastify";
import { requireOwner } from "../auth/session.js";
import { findUser, listUsers } from "../auth/users.js";
import * as registry from "../services/board/registry.js";
import type { ShareKind } from "../services/board/registry.js";
import { logger } from "../utils/logger.js";

/**
 * SHARING — handing a card (or a whole project) to somebody who is not the owner.
 *
 * Only the owner shares, and only with a MEMBER: sharing with another owner would be a no-op (they
 * already see everything) and is refused rather than silently stored, because a share that changes
 * nothing is a lie the UI would go on showing.
 *
 * A share is `{ kind, targetId, userId, level }` and PUT-like: sharing the same thing with the same
 * person again just sets the level, so the dialog sends what it wants instead of diffing first.
 *
 * The responses carry the username alongside the share — the screen shows people, not ids.
 */

interface ShareBody { userId?: string; level?: string }

async function decorate(shares: registry.Share[]): Promise<
  { userId: string; username: string; level: string; kind: ShareKind; targetId: string; createdAt: number }[]
> {
  const users = await listUsers();
  return shares.map((s) => ({
    ...s,
    username: users.find((u) => u.id === s.userId)?.username ?? "(removed)",
  }));
}

function fail(err: unknown): { code: number; body: { error: string } } {
  const message = (err as Error).message ?? "invalid request";
  return { code: /not found/i.test(message) ? 404 : 400, body: { error: message } };
}

export async function sharesRoutes(app: FastifyInstance): Promise<void> {
  for (const [kind, path] of [["card", "cards"], ["project", "projects"]] as const) {
    app.get<{ Params: { id: string } }>(
      `/api/${path}/:id/shares`, { preHandler: requireOwner },
      async (req, reply) => {
        return await reply.send({ shares: await decorate(await registry.sharesForTarget(kind, req.params.id)) });
      },
    );

    app.post<{ Params: { id: string }; Body: ShareBody }>(
      `/api/${path}/:id/shares`, { preHandler: requireOwner },
      async (req, reply) => {
        const userId = String(req.body?.userId ?? "");
        try {
          const user = await findUser(userId);
          if (!user) return await reply.code(404).send({ error: "user not found" });
          if (user.role === "owner") {
            return await reply.code(400).send({ error: "an owner already sees everything — nothing to share" });
          }
          const share = await registry.shareWith({
            kind, targetId: req.params.id, userId, level: req.body?.level ?? "work",
          });
          logger.info(
            { audit: true, action: "share.add", kind, target: req.params.id, user: user.username, level: share.level },
            "shared",
          );
          return await reply.send({ share: (await decorate([share]))[0] });
        } catch (err) {
          const { code, body } = fail(err);
          return await reply.code(code).send(body);
        }
      },
    );

    app.delete<{ Params: { id: string; userId: string } }>(
      `/api/${path}/:id/shares/:userId`, { preHandler: requireOwner },
      async (req, reply) => {
        const removed = await registry.unshare(kind, req.params.id, req.params.userId);
        if (removed) {
          logger.info({ audit: true, action: "share.remove", kind, target: req.params.id, user: req.params.userId },
            "unshared");
        }
        return await reply.send({ ok: true, removed });
      },
    );
  }
}
