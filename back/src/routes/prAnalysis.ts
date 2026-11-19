import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import { canAccessProject, canWorkOnProject } from "../auth/access.js";
import { requestUser, requireSession } from "../auth/session.js";
import { analysisPeople, listProjectPulls, RepoAccessError, startAnalysis } from "../services/review/analysis.js";
import { joinPrRoom, type PrLiveEvent } from "../services/review/prClaims.js";
import { logger } from "../utils/logger.js";
import { NOT_FOUND, sendError } from "./httpError.js";

/** GitHub failing to answer is not the caller's fault: the list is not there to give. */
const GITHUB_FAILED = [/^GitHub returned/, 502] as const;
const SETTING_UP_ELSEWHERE = [/^pr_em_montagem/, 409] as const;
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;

async function requireProjectAccess(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
  await requireSession(req, reply);
  if (reply.sent) return;
  if (!(await canAccessProject(await requestUser(req), req.params.id))) await reply.code(404).send({ error: "project not found" });
}

function parseLiveFrame(raw: string): { type: "claim" | "release"; prNumber: number } | null {
  try {
    const { type, prNumber } = JSON.parse(raw) as { type?: unknown; prNumber?: unknown };
    if (type !== "claim" && type !== "release") return null;
    if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) return null;
    return { type, prNumber };
  } catch {
    return null;
  }
}

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

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/prs/live",
    { websocket: true, preHandler: requireProjectAccess },
    (socket: WebSocket, req) => {
      const send = (event: PrLiveEvent) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      };
      const seated = (async () => {
        const user = (await requestUser(req))!;
        return { user, canWork: await canWorkOnProject(user, req.params.id), seat: joinPrRoom(req.params.id, user, send) };
      })();
      seated.catch((err: unknown) => {
        logger.warn({ project: req.params.id, detail: (err as Error).message }, "PR live channel could not seat the viewer");
        socket.close(INTERNAL_ERROR);
      });
      socket.on("message", (data) => void seated.then(({ user, canWork, seat }) => {
        const frame = parseLiveFrame(String(data));
        if (!frame) return socket.close(POLICY_VIOLATION, "invalid frame");
        if (frame.type === "release") return seat.release(frame.prNumber);
        if (!canWork) return send({ type: "error", code: "read_only" });
        const holder = seat.claim(frame.prNumber);
        if (holder.userId !== user.id) send({ type: "claim-refused", prNumber: frame.prNumber, username: holder.username });
      }, () => undefined));
      socket.on("close", () => void seated.then(({ seat }) => seat.leave(), () => undefined));
    },
  );

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
        return await sendError(reply, err, { rules: [GITHUB_FAILED, SETTING_UP_ELSEWHERE, NOT_FOUND] });
      }
    },
  );
}
