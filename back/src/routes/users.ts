import type { FastifyInstance } from "fastify";
import { requireOwner, requireSession, sessionUserId, clearSessionCookie } from "../auth/session.js";
import { getUserGit, setUserGit, removeUserGit, type UserGitIdentity } from "../auth/userGit.js";
import { listGithubConnections } from "../services/board/registry.js";
import { reapplyIdentityForUser } from "../services/board/workspace.js";
import { createUser, listUsers, changePassword, removeUser, setRole, assertRole } from "../auth/users.js";
import { removeSharesForUser } from "../services/board/registry.js";
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
/** Body shared by the owner's PATCH and the self-service one (the latter ignores role/password). */
interface UserPatchBody {
  password?: string;
  role?: string;
  githubConnectionId?: string | null;
  gitName?: string | null;
  gitEmail?: string | null;
}

/** The identity as it leaves the server: no secret in it (the token lives in the vault). PURE. */
function publicGit(git: UserGitIdentity): Omit<UserGitIdentity, "userId"> {
  const { githubConnectionId, gitName, gitEmail } = git;
  return { githubConnectionId, gitName, gitEmail };
}

/**
 * Applies the git fields of a patch, if it carries any. A DANGLING connection id would make every
 * push of that person fail with a credential that is not in the vault — the same guard
 * `Project.githubConnectionId` already has, which is why it is checked before anything is stored.
 */
async function applyGitPatch(
  userId: string, body: UserPatchBody,
): Promise<{ touched: boolean; identity: UserGitIdentity | null }> {
  const { githubConnectionId, gitName, gitEmail } = body;
  const touched = githubConnectionId !== undefined || gitName !== undefined || gitEmail !== undefined;
  if (!touched) return { touched: false, identity: await getUserGit(userId) };
  if (githubConnectionId !== undefined && githubConnectionId !== null) {
    const connections = await listGithubConnections();
    if (!connections.some((c) => c.id === githubConnectionId)) {
      throw new Error(`GitHub connection '${githubConnectionId}' does not exist`);
    }
  }
  const identity = await setUserGit(userId, { githubConnectionId, gitName, gitEmail });
  // The cards this person is ALREADY working pick it up now, not on their next open. Fire and
  // forget: a wedged runner must not fail the save the screen is waiting on.
  void reapplyIdentityForUser(userId).catch(() => undefined);
  return { touched: true, identity };
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", { preHandler: requireOwner }, async (_req, reply) => {
    // The identity rides WITH the user: the screen that edits it IS the user list, and a second
    // round-trip per row would be the same data arriving later.
    const users = await listUsers();
    const git = await Promise.all(users.map((u) => getUserGit(u.id)));
    return await reply.send({ users: users.map((u, i) => (git[i] ? { ...u, git: publicGit(git[i]!) } : u)) });
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
  app.patch<{ Params: { id: string }; Body: UserPatchBody }>(
    "/api/users/:id", { preHandler: requireOwner },
    async (req, reply) => {
      const { password, role } = req.body ?? {};
      try {
        if (role !== undefined) await setRole(req.params.id, assertRole(role));
        if (password !== undefined) await changePassword(req.params.id, password);
        const git = await applyGitPatch(req.params.id, req.body ?? {});
        const user = (await listUsers()).find((u) => u.id === req.params.id);
        if (!user) return await reply.code(404).send({ error: "user not found" });
        logger.info(
          {
            audit: true, action: "user.update", user: user.username, role: user.role,
            password: password !== undefined, git: git.touched,
          },
          "user updated",
        );
        return await reply.send({ user, git: git.identity ? publicGit(git.identity) : undefined });
      } catch (err) {
        const message = (err as Error).message;
        return await reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
      }
    },
  );

  /**
   * MY OWN git identity — the second door into the same record. A PAT expires, and if only the owner
   * could store it, every rotation would be the owner's task, whose workaround is handing them the
   * token. Role and password are NOT here: those stay the owner's.
   */
  app.get("/api/me/git", { preHandler: requireSession }, async (req, reply) => {
    const me = await sessionUserId(req);
    if (!me) return await reply.code(401).send({ error: "not authenticated" });
    const git = await getUserGit(me);
    return await reply.send({ git: git ? publicGit(git) : undefined });
  });

  app.patch<{ Body: UserPatchBody }>("/api/me/git", { preHandler: requireSession }, async (req, reply) => {
    const me = await sessionUserId(req);
    if (!me) return await reply.code(401).send({ error: "not authenticated" });
    try {
      const git = await applyGitPatch(me, req.body ?? {});
      logger.info({ audit: true, action: "user.git.self", user: me, git: git.touched }, "own git identity updated");
      return await reply.send({ git: git.identity ? publicGit(git.identity) : undefined });
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", { preHandler: requireOwner }, async (req, reply) => {
    // Removing YOURSELF is not a mistake worth blocking (a second owner may be taking over), but it
    // does end the session that just did it — otherwise the browser keeps a cookie signed for an
    // account that no longer exists and every request 401s from somewhere unhelpful.
    const me = await sessionUserId(req);
    try {
      const removed = await removeUser(req.params.id);
      // Their shares go with them: a share pointing at a user that no longer exists is access
      // nobody can see and nobody can revoke, and a recycled id would inherit it.
      await removeSharesForUser(removed.id);
      // And their git identity: a record keyed by an id nobody holds is dead weight, and a recycled
      // id would inherit somebody else's GitHub connection.
      await removeUserGit(removed.id);
      if (me === removed.id) clearSessionCookie(reply);
      logger.info({ audit: true, action: "user.remove", user: removed.username }, "user removed");
      return await reply.send({ ok: true, user: removed });
    } catch (err) {
      const message = (err as Error).message;
      return await reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  });
}
