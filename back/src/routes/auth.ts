import type { FastifyInstance } from "fastify";
import { createUser, verifyCredentials, isFreshInstall, listUsers, changePassword } from "../auth/users.js";
import { setSessionCookie, clearSessionCookie, requireSession, sessionUserId } from "../auth/session.js";
import { logger } from "../utils/logger.js";

/**
 * AUTH — sign in, sign out, who am I, and the one-time owner creation that only works while the
 * install has no users at all. There is no sign-up: an install has the accounts its owner creates.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
    const { username = "", password = "" } = req.body ?? {};
    const user = await verifyCredentials(username, password);
    if (!user) {
      // One message for both failures: which half was wrong is not the caller's business.
      logger.warn({ audit: true, action: "auth.login.failed", username }, "failed sign-in");
      return await reply.code(401).send({ error: "invalid username or password" });
    }
    await setSessionCookie(reply, user.id);
    logger.info({ audit: true, action: "auth.login", user: user.username }, "signed in");
    return await reply.send({ user: { id: user.id, username: user.username } });
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return await reply.send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: requireSession }, async (req, reply) => {
    const userId = await sessionUserId(req);
    const user = (await listUsers()).find((u) => u.id === userId);
    if (!user) {
      // Session signed correctly but the user is gone (deleted install, restored backup).
      clearSessionCookie(reply);
      return await reply.code(401).send({ error: "not authenticated" });
    }
    return await reply.send({ user });
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/setup/owner", async (req, reply) => {
    if (!(await isFreshInstall())) {
      return await reply.code(409).send({ error: "this install already has an owner — sign in instead" });
    }
    const { username = "", password = "" } = req.body ?? {};
    try {
      const user = await createUser(username, password);
      await setSessionCookie(reply, user.id);
      logger.info({ audit: true, action: "setup.owner", user: user.username }, "owner account created");
      return await reply.send({ user: { id: user.id, username: user.username } });
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { password?: string } }>("/api/auth/password", { preHandler: requireSession }, async (req, reply) => {
    const userId = await sessionUserId(req);
    if (!userId) return await reply.code(401).send({ error: "not authenticated" });
    try {
      await changePassword(userId, req.body?.password ?? "");
      return await reply.send({ ok: true });
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });
}
