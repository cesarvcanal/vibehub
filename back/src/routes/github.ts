import type { FastifyInstance } from "fastify";
import { requireOwner } from "../auth/session.js";
import * as github from "../services/github/client.js";
import { getSettings, updateSettings } from "../services/settings/settings.js";
import { NOT_FOUND, sendError, type ErrorStatusRule } from "./httpError.js";

/** A registry refusal ("in use by N project(s)") is a conflict, not a bad request. */
const GITHUB_ERROR_RULES: ErrorStatusRule[] = [[/in use by/i, 409], NOT_FOUND];

/**
 * GITHUB — the accounts vibehub can clone as, plus the repository and branch pickers that read
 * through one of them. There is no OAuth: a connection is a PASTED token (fine-grained PAT with
 * Contents read/write, or a classic token with `repo`).
 */
export async function githubRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/github", { preHandler: requireOwner }, async (_req, reply) => {
    return await reply.send(await github.state());
  });

  /** Adds an account. The token is checked against GitHub before anything is stored. */
  app.post<{ Body: { label?: string; token?: string } }>(
    "/api/github/connections", { preHandler: requireOwner },
    async (req, reply) => {
      try {
        const { connection, identity } = await github.connect(req.body?.label ?? "", req.body?.token ?? "");
        await seedGitIdentity(identity);
        return await reply.code(201).send({ connection });
      } catch (err) {
        return await sendError(reply, err, { rules: GITHUB_ERROR_RULES });
      }
    },
  );

  /** Removes one account. 409 while a project still points at it. */
  app.delete<{ Params: { id: string } }>(
    "/api/github/connections/:id", { preHandler: requireOwner },
    async (req, reply) => {
      try {
        await github.removeConnection(req.params.id);
        return await reply.send({ ok: true });
      } catch (err) {
        return await sendError(reply, err, { rules: GITHUB_ERROR_RULES });
      }
    },
  );

  /**
   * BACKWARD COMPATIBILITY with the setup wizard: create the first connection, or replace the token
   * of the one that exists. Still the whole GitHub step of a fresh install.
   */
  app.post<{ Body: { token?: string; label?: string } }>("/api/github/token", { preHandler: requireOwner }, async (req, reply) => {
    try {
      const { connection, identity } = await github.connectOrReplaceFirst(req.body?.token ?? "", req.body?.label);
      await seedGitIdentity(identity);
      return await reply.send({ connected: true, id: connection.id, login: identity.login, scopes: identity.scopes });
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Forgets every account. */
  app.delete("/api/github", { preHandler: requireOwner }, async (_req, reply) => {
    await github.disconnect();
    return await reply.send({ ok: true });
  });

  app.get<{ Querystring: { q?: string; connection?: string } }>("/api/github/repos", { preHandler: requireOwner }, async (req, reply) => {
    try {
      const repos = await github.listRepos(req.query?.connection ?? "", req.query?.q ?? "");
      return await reply.send({ repos });
    } catch (err) {
      return await sendError(reply, err, { rules: GITHUB_ERROR_RULES });
    }
  });

  app.get<{ Params: { owner: string; repo: string }; Querystring: { connection?: string } }>(
    "/api/github/repos/:owner/:repo/branches",
    { preHandler: requireOwner },
    async (req, reply) => {
      try {
        return await reply.send(await github.listBranches(req.query?.connection ?? "", req.params.owner, req.params.repo));
      } catch (err) {
        return await sendError(reply, err, { rules: GITHUB_ERROR_RULES });
      }
    },
  );
}

/**
 * Convenience, not policy: a fresh install has a placeholder git identity, and the account we just
 * connected is almost certainly the right one. Never overwrite a real choice.
 */
async function seedGitIdentity(identity: github.GithubIdentity): Promise<void> {
  const settings = await getSettings();
  if (settings.git.email === "vibehub@localhost" && identity.email) {
    await updateSettings({ git: { name: identity.name ?? identity.login, email: identity.email } });
  }
}
