import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import * as github from "../services/github/client.js";
import { getSettings, updateSettings } from "../services/settings/settings.js";

/** GitHub connection, repository picker and branch list. */
export async function githubRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/github", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await github.state());
  });

  app.post<{ Body: { token?: string } }>("/api/github/token", { preHandler: requireSession }, async (req, reply) => {
    try {
      const identity = await github.connect(req.body?.token ?? "");
      // Convenience, not policy: a fresh install has a placeholder git identity, and the account we
      // just connected is almost certainly the right one. Never overwrite a real choice.
      const settings = await getSettings();
      if (settings.git.email === "vibehub@localhost" && identity.email) {
        await updateSettings({ git: { name: identity.name ?? identity.login, email: identity.email } });
      }
      return await reply.send({ connected: true, login: identity.login, scopes: identity.scopes });
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/github", { preHandler: requireSession }, async (_req, reply) => {
    await github.disconnect();
    return await reply.send({ ok: true });
  });

  app.get<{ Querystring: { q?: string } }>("/api/github/repos", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ repos: await github.listRepos(req.query?.q ?? "") });
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { owner: string; repo: string } }>(
    "/api/github/repos/:owner/:repo/branches",
    { preHandler: requireSession },
    async (req, reply) => {
      try {
        return await reply.send({ branches: await github.listBranches(req.params.owner, req.params.repo) });
      } catch (err) {
        return await reply.code(400).send({ error: (err as Error).message });
      }
    },
  );
}
