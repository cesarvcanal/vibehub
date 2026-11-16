import type { FastifyInstance } from "fastify";
import { canAccessProject, canWorkOnProject } from "../auth/access.js";
import { requestUser, requireSession } from "../auth/session.js";
import { analysisPeople, listProjectPulls, RepoAccessError, startAnalysis } from "../services/review/analysis.js";
import { NOT_FOUND, sendError } from "./httpError.js";

/** GitHub failing to answer is not the caller's fault: the list is not there to give. */
const GITHUB_FAILED = [/^GitHub returned/, 502] as const;

/**
 * PR ANALYSIS — the project's open PRs and the button that analyses one (`services/review/analysis.ts`).
 * Whoever reaches the project sees the list; starting an analysis creates a card, so it takes `work` on
 * the project (the owner, or a project share with `work`). A project the user does not reach is a 404,
 * as everywhere else.
 */
export async function prAnalysisRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/projects/:id/prs", { preHandler: requireSession }, async (req, reply) => {
    const user = await requestUser(req);
    if (!(await canAccessProject(user, req.params.id))) return await reply.code(404).send({ error: "project not found" });
    try {
      return await reply.send({ pulls: await listProjectPulls(req.params.id, user!) });
    } catch (err) {
      // The asker's GitHub account does not see the repository: theirs to fix (ask for access), not GitHub's.
      if (err instanceof RepoAccessError) return await reply.code(403).send({ error: err.message, login: err.login, repo: err.repo });
      return await sendError(reply, err, { rules: [GITHUB_FAILED, NOT_FOUND] });
    }
  });

  /** Who can be the reviewer or the co-author of an analysis here: whoever works on the project. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/analysis-people", { preHandler: requireSession }, async (req, reply) => {
    const user = await requestUser(req);
    if (!(await canAccessProject(user, req.params.id))) return await reply.code(404).send({ error: "project not found" });
    try {
      return await reply.send({ people: await analysisPeople(req.params.id) });
    } catch (err) {
      return await sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string; number: string }; Body: { reviewerUserId?: unknown; coauthorUserId?: unknown } }>(
    "/api/projects/:id/prs/:number/analysis", { preHandler: requireSession },
    async (req, reply) => {
      const user = await requestUser(req);
      if (!(await canAccessProject(user, req.params.id))) return await reply.code(404).send({ error: "project not found" });
      if (!(await canWorkOnProject(user, req.params.id))) {
        return await reply.code(403).send({ error: "this project is shared with you read-only" });
      }
      const prNumber = Number(req.params.number);
      if (!Number.isInteger(prNumber) || prNumber <= 0) return await reply.code(400).send({ error: "número de PR inválido" });
      const { reviewerUserId, coauthorUserId } = req.body ?? {};
      if (typeof reviewerUserId !== "string" || !reviewerUserId) return await reply.code(400).send({ error: "revisor obrigatório" });
      if (coauthorUserId !== undefined && (typeof coauthorUserId !== "string" || !coauthorUserId)) {
        return await reply.code(400).send({ error: "coautor inválido" });
      }
      try {
        // The prompt's delivery runs on in the background (see `startAnalysis`): the answer is the card.
        const { card, created } = await startAnalysis({
          projectId: req.params.id, prNumber, requester: user!, reviewerUserId, ...(coauthorUserId ? { coauthorUserId } : {}),
        });
        return await reply.send({ card, created });
      } catch (err) {
        return await sendError(reply, err, { rules: [GITHUB_FAILED, NOT_FOUND] });
      }
    },
  );
}
