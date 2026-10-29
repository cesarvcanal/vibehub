import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireSession, requireOwner, requestUser, tokenMatches } from "../auth/session.js";
import { creatorAccountSlug, usersOnClaudeAccount } from "../auth/userGit.js";
import { findUser } from "../auth/users.js";
import { requireCardAccess, requireCardWork, visibleCards, visibleProjects } from "../auth/access.js";
import * as registry from "../services/board/registry.js";
import {
  applySessionChange, pauseCard, prepareCard, resumeCard,
} from "../services/board/workspace.js";
import { reportCardStatus } from "../services/board/status.js";
import { purgeRemovedCards } from "../services/board/purge.js";
import { runnerToken } from "../runtime/runner.js";
import { listReviewsForCards } from "../services/review/store.js";
import type { Review } from "../services/review/model.js";
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

/** The PR review summary a board card carries: what the sidebar's "↳ PR #N · estado" line reads. */
type BoardCard = registry.Card & { review?: Pick<Review, "id" | "prNumber" | "phase" | "round"> };

/**
 * Each card with the summary of its most recent review that was not cancelled (a merged one stays:
 * the line reads "mergeado"). ONE read of the review store for the whole batch, never one per card —
 * and the same rule for a listing and for a single card (`GET /api/cards/:id`), so a deep link does
 * not show "sem revisão" for a PR the list already shows under review.
 */
async function withReviewSummary(cards: registry.Card[]): Promise<BoardCard[]> {
  const latest = new Map<string, Review>();
  for (const r of await listReviewsForCards(cards.map((c) => c.id))) {
    if (r.phase === "cancelled") continue;
    const seen = latest.get(r.cardId);
    if (!seen || r.createdAt >= seen.createdAt) latest.set(r.cardId, r);
  }
  return cards.map((c) => {
    const r = latest.get(c.id);
    return r ? { ...c, review: { id: r.id, prNumber: r.prNumber, phase: r.phase, round: r.round } } : c;
  });
}

/**
 * A card listing as the board shows it. REVIEWER cards (`reviewOf`) are left out — a review shows up
 * as a line under the author's card, not as a card of its own.
 */
async function boardCards(cards: registry.Card[]): Promise<BoardCard[]> {
  return await withReviewSummary(cards.filter((c) => !c.reviewOf));
}

/**
 * What a MEMBER with a `work` share may change through PATCH /api/cards/:id — exactly what the card
 * screen offers them: rename, move, pick the model and its intelligence. The other fields decide what the INSTALL runs
 * and where it pushes — the Claude account (accounts are the owner's), the branch and its base, an
 * imported session, the native-chat opt-in — and a share hands over a piece of work, not that.
 */
const MEMBER_CARD_FIELDS: ReadonlySet<string> = new Set<keyof registry.UpdateCardInput>([
  "title", "column", "position", "model", "effort",
]);

/** The fields of a card patch a member may not send (empty = the patch is theirs to make). PURE. */
function fieldsRefusedToMember(patch: registry.UpdateCardInput): string[] {
  return Object.keys(patch).filter((key) => !MEMBER_CARD_FIELDS.has(key));
}

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- projects */

  // The listings are the only board routes a member may call: they answer with what has been
  // shared with that person (today: nothing), never with the whole install.
  app.get("/api/projects", { preHandler: requireSession }, async (req, reply) => {
    const projects = await visibleProjects(await requestUser(req), await registry.listProjects());
    return await reply.send({ projects });
  });

  app.post<{ Body: registry.CreateProjectInput }>("/api/projects", { preHandler: requireOwner }, async (req, reply) => {
    try {
      return await reply.send({ project: await registry.createProject(req.body ?? ({} as registry.CreateProjectInput)) });
    } catch (err) {
      const { code, body } = badRequest(err);
      return await reply.code(code).send(body);
    }
  });

  app.patch<{ Params: { id: string }; Body: registry.UpdateProjectInput }>(
    "/api/projects/:id", { preHandler: requireOwner },
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
    "/api/projects/:id/order", { preHandler: requireOwner },
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
   * Deleting a project cascades to its cards — and to EVERYTHING those cards own.
   *
   * The cascade used to stop at `board.json`: the cards vanished from the board and their sessions,
   * worktrees, conversations, uploads and browsers stayed in the runner (the response handed the
   * removed cards back "so the session layer could tear them down", and nothing ever did). Deleting
   * the project was therefore the way AROUND the card purge. It now runs the same purge per card.
   *
   * Fire-and-forget on purpose: each card is a handful of docker execs, and a project with thirty
   * of them must not hold an HTTP request open for minutes. The cards are already off the board
   * (same mutation as the project), so nothing can write into them while the purge runs; what fails
   * is logged and collected by the orphan sweep.
   */
  app.delete<{ Params: { id: string } }>("/api/projects/:id", { preHandler: requireOwner }, async (req, reply) => {
    try {
      const by = (await requestUser(req))?.username;
      const removed = await registry.removeProject(req.params.id);
      logger.info({ audit: true, action: "project.remove", project: removed.project.id, cards: removed.cards.length },
        "project removed");
      if (removed.cards.length > 0) {
        void purgeRemovedCards(removed.cards, removed.project, by).then((reports) => {
          const incomplete = reports.filter((r) => r.incomplete.length > 0);
          logger.info(
            { audit: true, action: "project.remove.purged", project: removed.project.id,
              cards: reports.length, incomplete: incomplete.length },
            "cards of the deleted project purged",
          );
        });
      }
      return await reply.send({ ok: true, cards: removed.cards });
    } catch (err) {
      const { code, body } = badRequest(err);
      return await reply.code(code).send(body);
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/cards", { preHandler: requireSession }, async (req, reply) => {
    const cards = await visibleCards(await requestUser(req), await registry.listCards(req.params.id));
    return await reply.send({ cards: await boardCards(cards) });
  });

  /* ------------------------------------------------------------------- cards */

  app.get("/api/cards", { preHandler: requireSession }, async (req, reply) => {
    const cards = await visibleCards(await requestUser(req), await registry.listAllCards());
    return await reply.send({ cards: await boardCards(cards) });
  });

  app.post<{ Body: registry.CreateCardInput & registry.UpdateCardInput }>(
    "/api/cards", { preHandler: requireOwner },
    async (req, reply) => {
      const { projectId, title, ...patch } = req.body ?? ({} as registry.CreateCardInput & registry.UpdateCardInput);
      try {
        // Optional fields (account, model, branch, imported session) are checked by the same
        // validation an edit uses, inside the creation itself: a refused one creates nothing.
        // No account picked = the CREATOR's, so a card does not land on somebody else's profile.
        if (patch.accountSlug === undefined) {
          const mine = await creatorAccountSlug((await requestUser(req))?.id);
          if (mine) patch.accountSlug = mine;
        }
        const created = await registry.createCard({ projectId, title }, patch);
        // PRE-PROVISIONING, in the background and AFTER the patch (the account, the model and the
        // branch are what the script is built from): the clone, the worktree and the tmux session
        // start being built the moment the card exists, while the user is still reading the board.
        // Without it the whole cost — a full `git clone` on a project's first card — is paid inside
        // the /open the click fires, which is a request that can sit there for minutes with nothing
        // on screen but "preparing".
        //
        // Fire-and-forget ON PURPOSE: creating a card must answer immediately and must never fail
        // because the runner is down. Whatever it does not finish, the open redoes (same idempotent
        // script, same lock — the click QUEUES behind this instead of racing it).
        void prepareCard(created.id, "card.create").catch((err: unknown) => {
          logger.warn(
            { card: created.worktreeSlug, detail: (err as Error).message },
            "pre-provisioning of the new card failed (best-effort) — the first open will do it",
          );
        });
        return await reply.send({ card: created });
      } catch (err) {
        const { code, body } = badRequest(err);
        return await reply.code(code).send(body);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/cards/:id", { preHandler: requireCardAccess }, async (req, reply) => {
    const card = await registry.getCard(req.params.id);
    if (!card) return await reply.code(404).send({ error: "card not found" });
    // Not through `boardCards`: a reviewer card is still reachable by its id (the panel opens its session).
    return await reply.send({ card: (await withReviewSummary([card]))[0] });
  });

  /**
   * Editing a card — including the DRAG between columns, which is the only way most moves happen.
   *
   * A column is not just a label: `paused` means "this card is not running". So moving INTO it
   * really pauses (and, when the runner says the session is not working, kills it right there), and
   * moving a paused card back into a live column really resumes it. Without that, dragging a card
   * to Paused only repainted it while its Claude went on burning the plan, and dragging it back left
   * a card that looked alive with no session behind it.
   */
  app.patch<{ Params: { id: string }; Body: registry.UpdateCardInput }>(
    "/api/cards/:id", { preHandler: requireCardWork },
    async (req, reply) => {
      // requireCardWork answered "may touch this card"; WHICH fields is a second question, and the
      // whole patch is refused (nothing applied) when it reaches past what a share hands over.
      if ((await requestUser(req))?.role !== "owner") {
        const refused = fieldsRefusedToMember(req.body ?? {});
        if (refused.length > 0) {
          return await reply.code(403).send({ error: `only the owner can change: ${refused.join(", ")}` });
        }
      }
      // SNAPSHOT before the write. `getCard` hands back the LIVE cached record and `updateCard`
      // mutates that very object, so a "before" that is not copied is really the "after": both
      // things that compare the two — which column the card came from, and whether the model or the
      // account changed — would always answer "nothing moved".
      const live = await registry.getCard(req.params.id);
      const before = live ? { ...live } : undefined;
      const move = before ? registry.cardMoveEffect(before, req.body ?? {}) : "none";
      try {
        const card = await registry.updateCard(req.params.id, req.body ?? {});
        // The model and the account only reach Claude when the process starts, so a switch has to be
        // carried into the live session (applySessionChange) instead of just being recorded.
        // `session` tells the screen which of the two happened.
        const session = await applySessionChange(before, card);
        if (move === "pause") {
          // The pause decides for itself whether it takes effect now or waits for Claude to finish;
          // either way the card comes back with the truth in it.
          return await reply.send({ card: await pauseCard(card.id, "drag to Paused"), session });
        }
        if (move === "resume") {
          // Recreating the session takes a round trip to the runner. The move itself already
          // happened, so answer now and let the poll pick the session up — a drag must never sit
          // there waiting on Docker.
          void resumeCard(card.id, "drag out of Paused").catch((err: unknown) => {
            logger.warn(
              { card: card.worktreeSlug, detail: (err as Error).message },
              "could not resume the card dragged out of Paused (opening it will do it)",
            );
          });
        }
        return await reply.send({ card, session });
      } catch (err) {
        const { code, body } = badRequest(err);
        return await reply.code(code).send(body);
      }
    },
  );

  /* ---------------------------------------------------------------- accounts */

  app.get("/api/accounts", { preHandler: requireOwner }, async (_req, reply) => {
    const [accounts, config] = await Promise.all([registry.listAccounts(), registry.getConfig()]);
    return await reply.send({ accounts, defaultLabel: config.defaultAccountLabel ?? null });
  });

  app.post<{ Body: { name?: string } }>("/api/accounts", { preHandler: requireOwner }, async (req, reply) => {
    try {
      return await reply.send({ account: await registry.createAccount({ name: req.body?.name ?? "" }) });
    } catch (err) {
      const { code, body } = badRequest(err);
      return await reply.code(code).send(body);
    }
  });

  app.delete<{ Params: { slug: string } }>("/api/accounts/:slug", { preHandler: requireOwner }, async (req, reply) => {
    try {
      // A person tied to the account would have their next card born on a profile that is gone.
      const holders = await usersOnClaudeAccount(req.params.slug);
      if (holders.length > 0) {
        const names = (await Promise.all(holders.map((id) => findUser(id)))).map((u, i) => u?.username ?? holders[i]);
        throw new Error(`account '${req.params.slug}' is the Claude account of ${names.join(", ")} — unassign it first`);
      }
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
    const card = await reportCardStatus(String(body.card ?? ""), status);
    return await reply.send({ ok: true, applied: Boolean(card) });
  });
}
