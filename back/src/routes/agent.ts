import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import * as registry from "../services/board/registry.js";
import { cardWorkPaths } from "../services/board/workspace.js";
import { setAccountToken, removeAccountToken, accountsTokenStatus } from "../services/accounts/token.js";
import { applyMcpsEverywhere, setMcpSecretById } from "../services/mcp/mcp.js";
import { brainView, setBrainText, resetBrain, applyBrainEverywhere } from "../services/brain/brain.js";
import { importSessions, type ImportInput } from "../services/import/import.js";

/**
 * AGENT CONFIGURATION — the things that shape how Claude runs inside the runner rather than what the
 * board looks like: account tokens, MCP servers, the shared brain, and adopting sessions that
 * already exist elsewhere.
 */

function fail(err: unknown): { code: number; body: { error: string } } {
  const message = (err as Error).message ?? "invalid request";
  if (/not found/i.test(message)) return { code: 404, body: { error: message } };
  // "the runner is not provisioned / not running / unreachable" is an environment problem, not a
  // malformed request — the UI shows those differently.
  if (/runner/i.test(message)) return { code: 502, body: { error: message } };
  return { code: 400, body: { error: message } };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------- Claude accounts */

  app.get("/api/accounts/tokens", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await accountsTokenStatus());
  });

  app.post<{ Params: { slug: string }; Body: { token?: string } }>(
    "/api/accounts/:slug/token", { preHandler: requireSession },
    async (req, reply) => {
      try {
        return await reply.send(await setAccountToken(req.params.slug, req.body?.token ?? ""));
      } catch (err) {
        const { code, body } = fail(err);
        return await reply.code(code).send(body);
      }
    },
  );

  app.delete<{ Params: { slug: string } }>(
    "/api/accounts/:slug/token", { preHandler: requireSession },
    async (req, reply) => {
      try {
        return await reply.send(await removeAccountToken(req.params.slug));
      } catch (err) {
        const { code, body } = fail(err);
        return await reply.code(code).send(body);
      }
    },
  );

  /* ------------------------------------------------------------ MCP servers */

  app.post<{ Params: { id: string }; Body: { key?: string; value?: string } }>(
    "/api/mcps/:id/secret", { preHandler: requireSession },
    async (req, reply) => {
      try {
        await setMcpSecretById(req.params.id, req.body?.key ?? "", req.body?.value ?? "");
        return await reply.send({ ok: true });
      } catch (err) {
        const { code, body } = fail(err);
        return await reply.code(code).send(body);
      }
    },
  );

  app.post("/api/mcps/apply", { preHandler: requireSession }, async (_req, reply) => {
    try {
      return await reply.send({ ok: true, ...(await applyMcpsEverywhere()) });
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  /* ------------------------------------------------------------------ brain */

  app.get("/api/brain", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await brainView());
  });

  app.post<{ Body: { text?: string } }>("/api/brain", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send(await setBrainText(req.body?.text ?? ""));
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  app.delete("/api/brain", { preHandler: requireSession }, async (_req, reply) => {
    await resetBrain();
    return await reply.send(await brainView());
  });

  app.post("/api/brain/apply", { preHandler: requireSession }, async (_req, reply) => {
    try {
      return await reply.send({ ok: true, ...(await applyBrainEverywhere()) });
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  /* ----------------------------------------------------------------- import */

  /**
   * Adopts Claude sessions that already exist (staged transcripts in the runner) as cards. The
   * working directory of a card is derived by the workspace module and handed in — the importer
   * must not reach into the clone/worktree lifecycle itself, and the two paths must never drift.
   */
  app.post<{ Body: ImportInput }>("/api/import", { preHandler: requireSession }, async (req, reply) => {
    try {
      const result = await importSessions(
        req.body ?? { items: [] },
        (project, card) => cardWorkPaths(project, card).cwd,
      );
      return await reply.send(result);
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  /** The board's own view of what a card maps to in the runner — handy for debugging an import. */
  app.get<{ Params: { id: string } }>("/api/cards/:id/paths", { preHandler: requireSession }, async (req, reply) => {
    const card = await registry.getCard(req.params.id);
    const project = card ? await registry.getProject(card.projectId) : undefined;
    if (!card || !project) return await reply.code(404).send({ error: "card not found" });
    return await reply.send(cardWorkPaths(project, card));
  });
}
