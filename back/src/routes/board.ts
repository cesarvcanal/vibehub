import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireSession } from "../auth/session.js";
import * as registry from "../services/board/registry.js";
import { restartCard } from "../services/board/workspace.js";
import { runnerToken } from "../runtime/runner.js";
import { logger } from "../utils/logger.js";

/**
 * BOARD — projects, cards, accounts, and the public status callback the runner's Claude hooks fire.
 *
 * Session lifecycle routes (open/pause/restart/upload/browser) live in `routes/session.ts` and the
 * agent's own configuration (tokens, MCP servers, brain) in `routes/agent.ts`; this file is the
 * board's data surface.
 */

function badRequest(err: unknown): { code: number; body: { error: string } } {
  const message = (err as Error).message ?? "invalid request";
  // "not found" from the registry is a 404, everything else is the caller's fault.
  const code = /not found/i.test(message) ? 404 : 400;
  return { code, body: { error: message } };
}

/** Constant-time token comparison — a length-safe wrapper around timingSafeEqual. */
export function tokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- projects */

  app.get("/api/projects", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send({ projects: await registry.listProjects() });
  });

  app.post<{ Body: registry.CreateProjectInput }>("/api/projects", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ project: await registry.createProject(req.body ?? ({} as registry.CreateProjectInput)) });
    } catch (err) {
      const { code, body } = badRequest(err);
      return await reply.code(code).send(body);
    }
  });

  app.patch<{ Params: { id: string }; Body: registry.UpdateProjectInput }>(
    "/api/projects/:id", { preHandler: requireSession },
    async (req, reply) => {
      try {
        return await reply.send({ project: await registry.updateProject(req.params.id, req.body ?? {}) });
      } catch (err) {
        const { code, body } = badRequest(err);
        return await reply.code(code).send(body);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { position?: number } }>(
    "/api/projects/:id/order", { preHandler: requireSession },
    async (req, reply) => {
      const position = Number(req.body?.position);
      if (!Number.isInteger(position) || position < 0) {
        return await reply.code(400).send({ error: "position must be a non-negative integer" });
      }
      try {
        return await reply.send({ projects: await registry.reorderProject(req.params.id, position) });
      } catch (err) {
        const { code, body } = badRequest(err);
        return await reply.code(code).send(body);
      }
    },
  );

  /**
   * Deleting a project cascades to its cards. The tmux sessions and worktrees of those cards are
   * torn down by the session layer, which is why the removed cards come back in the response.
   */
  app.delete<{ Params: { id: string } }>("/api/projects/:id", { preHandler: requireSession }, async (req, reply) => {
    try {
      const removed = await registry.removeProject(req.params.id);
      logger.info({ audit: true, action: "project.remove", project: removed.project.id, cards: removed.cards.length },
        "project removed");
      return await reply.send({ ok: true, cards: removed.cards });
    } catch (err) {
      const { code, body } = badRequest(err);
      return await reply.code(code).send(body);
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/cards", { preHandler: requireSession }, async (req, reply) => {
    return await reply.send({ cards: await registry.listCards(req.params.id) });
  });

  /* ------------------------------------------------------------------- cards */

  app.get("/api/cards", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send({ cards: await registry.listAllCards() });
  });

  app.post<{ Body: registry.CreateCardInput & registry.UpdateCardInput }>(
    "/api/cards", { preHandler: requireSession },
    async (req, reply) => {
      const { projectId, title, ...patch } = req.body ?? ({} as registry.CreateCardInput & registry.UpdateCardInput);
      try {
        const card = await registry.createCard({ projectId, title });
        // Optional fields (account, model, branch, imported session) are applied through the same
        // validation path an edit uses — one place where those values are checked, not two.
        const hasPatch = Object.values(patch).some((v) => v !== undefined);
        return await reply.send({ card: hasPatch ? await registry.updateCard(card.id, patch) : card });
      } catch (err) {
        const { code, body } = badRequest(err);
        return await reply.code(code).send(body);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/cards/:id", { preHandler: requireSession }, async (req, reply) => {
    const card = await registry.getCard(req.params.id);
    if (!card) return await reply.code(404).send({ error: "card not found" });
    return await reply.send({ card });
  });

  app.patch<{ Params: { id: string }; Body: registry.UpdateCardInput }>(
    "/api/cards/:id", { preHandler: requireSession },
    async (req, reply) => {
      try {
        return await reply.send({ card: await registry.updateCard(req.params.id, req.body ?? {}) });
      } catch (err) {
        const { code, body } = badRequest(err);
        return await reply.code(code).send(body);
      }
    },
  );

  /* ---------------------------------------------------------------- accounts */

  app.get("/api/accounts", { preHandler: requireSession }, async (_req, reply) => {
    const [accounts, config] = await Promise.all([registry.listAccounts(), registry.getConfig()]);
    return await reply.send({ accounts, defaultLabel: config.defaultAccountLabel ?? null });
  });

  app.post<{ Body: { name?: string } }>("/api/accounts", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ account: await registry.createAccount({ name: req.body?.name ?? "" }) });
    } catch (err) {
      const { code, body } = badRequest(err);
      return await reply.code(code).send(body);
    }
  });

  app.delete<{ Params: { slug: string } }>("/api/accounts/:slug", { preHandler: requireSession }, async (req, reply) => {
    try {
      return await reply.send({ account: await registry.removeAccount(req.params.slug) });
    } catch (err) {
      const { code, body } = badRequest(err);
      return await reply.code(code).send(body);
    }
  });

  /* ---------------------------------------------------------- status callback */

  /**
   * PUBLIC — the runner's Claude Code hooks POST here on every prompt, stop and permission request.
   * It is authenticated by the service token planted in the runner, not by a session, because the
   * caller is a curl inside a container with no cookie jar.
   *
   * It always answers 200 to a well-authenticated call, even for an unknown card: a hook is fire-
   * and-forget with a 3s timeout, and making it retry or log errors would only add noise inside the
   * agent's terminal.
   */
  app.post<{ Body: { card?: string; status?: string } }>("/api/runner/status", async (req: FastifyRequest, reply) => {
    const provided = req.headers["x-vibehub-token"];
    const expected = await runnerToken();
    if (!tokenMatches(typeof provided === "string" ? provided : undefined, expected)) {
      return await reply.code(401).send({ error: "invalid token" });
    }
    const body = (req.body ?? {}) as { card?: string; status?: string };
    const status = body.status;
    if (status !== "working" && status !== "waiting") {
      return await reply.code(400).send({ error: "status must be 'working' or 'waiting'" });
    }
    // State BEFORE the status is applied: it is what decides whether this is the moment to carry out
    // a PENDING RESTART (a card flagged while the brain/MCPs changed under a working Claude).
    // SNAPSHOT the primitives — `getCard` hands back the LIVE cached card, so applyCardStatus mutates
    // that very object and reading these fields afterwards would always show the post-status state.
    const before = await registry.getCard(String(body.card ?? ""));
    const wasPending = Boolean(before?.restartPendingAt);
    const wasLive = before ? registry.hasLiveSession(before) : false;
    const wasColumn = before?.column;
    const pendingReason = before?.restartReason;
    const card = await registry.applyCardStatus(String(body.card ?? ""), status);
    // A PAUSE BEATS the pending restart: a card whose PENDING PAUSE is due now is going to sleep, so
    // restarting it would be wasted work — applyCardStatus already dropped the flag in that case.
    const pausing = wasColumn ? registry.shouldEndSessionOnStatus(status, wasColumn, wasLive) : false;
    if (card && !pausing && registry.shouldRestartOnStatus(status, wasPending, wasLive)) {
      // PENDING RESTART (brain/MCP): the card was `working` when the brain/MCPs changed; now Claude has
      // finished (status != working), so restart the session to re-read them at startup (`claude -c`
      // resumes the SAME conversation). applyCardStatus has already cleared the flag.
      try {
        await restartCard(card.id);
        logger.info(
          { audit: true, action: "card.restart.pending", card: card.worktreeSlug, reason: pendingReason },
          "pending restart carried out — Claude finished and the session was restarted to re-read the brain/MCPs",
        );
      } catch (err) {
        // The hook is fire-and-forget: a restart that fails must never turn into an error for it.
        logger.warn(
          { card: card.worktreeSlug, detail: (err as Error).message },
          "pending restart failed (best-effort) — the card keeps running with the old brain/MCPs",
        );
      }
    }
    return await reply.send({ ok: true, applied: Boolean(card) });
  });
}
