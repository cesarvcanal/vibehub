import type { FastifyInstance } from "fastify";
import { requireOwner, sessionUserId, clearSessionCookie } from "../auth/session.js";
import { createUser, listUsers, changePassword, removeUser, setRole, assertRole } from "../auth/users.js";
import { logger } from "../utils/logger.js";

/**
 * ACCESS — the install's people. Owner-only, all of it: creating an account, resetting somebody's
 * password, changing a role, removing a person.
 *
 * There is still no sign-up and no invitation email. The owner types a username and a password and
 * hands them over — this is a self-hosted tool for a handful of people, and a mail server (or an
 * invite-token lifecycle) would be more machinery than the problem has.
 *
 * The last owner cannot be demoted or removed (enforced in `auth/users.ts`): an install with no
 * owner is an install nobody can administer.
 */
export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", { preHandler: requireOwner }, async (_req, reply) => {
    return await reply.send({ users: await listUsers() });
  });

  app.post<{ Body: { username?: string; password?: string; role?: string } }>(
    "/api/users", { preHandler: requireOwner },
    async (req, reply) => {
      const { username = "", password = "", role = "member" } = req.body ?? {};
      try {
        const user = await createUser(username, password, assertRole(role));
        logger.info({ audit: true, action: "user.create", user: user.username, role: user.role }, "user created");
        return await reply.send({ user: { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt } });
      } catch (err) {
        return await reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  /** Reset a password, change a role, or both. Either field may be absent. */
  app.patch<{ Params: { id: string }; Body: { password?: string; role?: string } }>(
    "/api/users/:id", { preHandler: requireOwner },
    async (req, reply) => {
      const { password, role } = req.body ?? {};
      try {
        if (role !== undefined) await setRole(req.params.id, assertRole(role));
        if (password !== undefined) await changePassword(req.params.id, password);
        const user = (await listUsers()).find((u) => u.id === req.params.id);
        if (!user) return await reply.code(404).send({ error: "user not found" });
        logger.info(
          { audit: true, action: "user.update", user: user.username, role: user.role, password: password !== undefined },
          "user updated",
        );
        return await reply.send({ user });
      } catch (err) {
        const message = (err as Error).message;
        return await reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/users/:id", { preHandler: requireOwner }, async (req, reply) => {
    // Removing YOURSELF is not a mistake worth blocking (a second owner may be taking over), but it
    // does end the session that just did it — otherwise the browser keeps a cookie signed for an
    // account that no longer exists and every request 401s from somewhere unhelpful.
    const me = await sessionUserId(req);
    try {
      const removed = await removeUser(req.params.id);
      if (me === removed.id) clearSessionCookie(reply);
      logger.info({ audit: true, action: "user.remove", user: removed.username }, "user removed");
      return await reply.send({ ok: true, user: removed });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  });
}
