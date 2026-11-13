import type { FastifyInstance, FastifyReply } from "fastify";
import { requireSession, requestUser } from "../auth/session.js";
import { requireCardAccess, requireCardWork } from "../auth/access.js";
import { getUserGit, linkedAccountSlug } from "../auth/userGit.js";
import type { PublicUser } from "../auth/users.js";
import * as registry from "../services/board/registry.js";
import {
  cancelReview, decideQuestion, decideSuggestions, retryReview, reviewForRead,
} from "../services/review/orchestrator.js";
import { reachingCard, startReviewChecked } from "../services/review/start.js";
import { mergeReviewedPr } from "../services/review/merge.js";
import { isBusy } from "../services/maestro/maestro.js";
import { activeReviewFor, getReview, listReviewsFollowedBy, listReviewsForCards, newest } from "../services/review/store.js";
import { canMergeReview, isReviewClosed, type Review } from "../services/review/model.js";
import { sendError, type ErrorStatusRule } from "./httpError.js";

/**
 * PR REVIEW — the orchestrator's HTTP surface and the ONLY merge path of a reviewed PR.
 *
 *  - who picks the roles: `GET /api/cards/:id/people` (a member may call it too: `GET /api/users` is the owner's);
 *  - who starts: whoever has `work` on the author's card; the reviewer needs their own GitHub connection
 *    (`revisor_sem_github`), like the merger;
 *  - who decides a question/stuck item: the human reviewer (or an owner);
 *  - who retries: reviewer, merge owner or owner; who cancels: those and the author;
 *  - who MERGES: whoever has a role in the review (`canMergeReview`), only in `ready`, only if the PR head is still the reviewed commit,
 *    and with THEIR GitHub connection (never the card actor's nor the project's, except an owner with no connection).
 *
 * The state rules (phases, rounds, relays) live in the orchestrator; here live who may call what and the
 * translation of errors into HTTP. No AI gets here: the merge is a person's click, or the server's
 * automatic merge when the review becomes ready with nothing standing (orchestrator `autoMerge`).
 */

type Decision = "block" | "drop" | "keep" | "accept_risk";
const DECISIONS: ReadonlySet<string> = new Set<Decision>(["block", "drop", "keep", "accept_risk"]);

interface StartBody {
  prNumber?: unknown;
  reviewerUserId?: unknown;
  authorUserId?: unknown;
  coauthorUserId?: unknown;
  mergerUserId?: unknown;
}

/**
 * `canReview` = has a linked Claude account, the built-in one ("default") included (the reviewer's session,
 * and that of an attached PR's fix card, run on it). `githubLogin` = the login of their OWN GitHub connection, when they have one: it is
 * how the dialog finds the author of an attached PR (whoever opened it on GitHub).
 */
interface Person { id: string; username: string; canReview: boolean; githubLogin?: string }

/** The card's people for the roles window (see {@link Person}). */
async function cardPeople(card: registry.Card): Promise<Person[]> {
  return await Promise.all(
    (await reachingCard(card)).map(async (u) => {
      const person: Person = { id: u.id, username: u.username, canReview: !!(await linkedAccountSlug(u.id)) };
      const own = (await getUserGit(u.id))?.githubConnectionId;
      const login = own ? (await registry.getGithubConnection(own))?.login : undefined;
      if (login) person.githubLogin = login;
      return person;
    }),
  );
}

/** A PR's review in a list: the active one, or the latest of any phase. */
function prReview(list: Review[], prNumber: number): Review | undefined {
  const ofPr = list.filter((r) => r.prNumber === prNumber);
  return newest(ofPr.filter((r) => !isReviewClosed(r.phase))) ?? newest(ofPr);
}

/**
 * Whether each side's AI is in a turn RIGHT NOW (`isBusy`: the hooks' status, or the native chat's turn).
 * The phase only changes when a tool lands; this changes the instant the AI starts or stops working, and
 * it is what lets the panel say "IA trabalhando" with the review still in `ready`. A card that is gone =
 * stopped.
 */
async function sidesWorking(r: Review): Promise<{ author: boolean; reviewer: boolean }> {
  const [author, reviewer] = await Promise.all([registry.getCard(r.cardId), registry.getCard(r.reviewerCardId)]);
  return { author: !!author && isBusy(author), reviewer: !!reviewer && isBusy(reviewer) };
}

/** `not found` (and an unknown finding) is a 404; each route adds its own 409 codes after it. */
const REVIEW_NOT_FOUND: ErrorStatusRule = [/not found|achado desconhecido/i, 404];

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/cards/:id/people", { preHandler: requireCardAccess }, async (req, reply) => {
    const card = await registry.getCard(req.params.id);
    if (!card) return await reply.code(404).send({ error: "card not found" });
    return await reply.send({ people: await cardPeople(card) });
  });

  /**
   * The card's review: the active one, or the latest (of any phase) — the panel shows the history. With
   * `?pr=N`, that PR's, among the ones the card follows (its own as author or of a PR it attached):
   * it is what each PR line and its panel read. Along with it,
   * `working`: whether the author's and the reviewer's AIs are working right now (absent when there is no review);
   * `merging`: whether a merge of it is running right now on the server — false after a deploy that killed
   * the merge midway, which is how the panel stops waiting for an answer that is not coming.
   * An open review is checked on GitHub at most once a minute: it is what makes a merge done directly on
   * GitHub show up on the panel by itself. In `ready` with no merge running the check comes BEFORE the
   * answer, so `merging: false` never goes out together with a stale `ready` (`reviewForRead`).
   */
  app.get<{ Params: { id: string }; Querystring: { pr?: string } }>("/api/cards/:id/review", { preHandler: requireCardAccess }, async (req, reply) => {
    const pr = req.query?.pr === undefined ? undefined : Number(req.query.pr);
    if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) return await reply.code(400).send({ error: "pr inválido" });
    const found = pr === undefined
      ? (await activeReviewFor(req.params.id)) ?? newest(await listReviewsForCards([req.params.id]))
      : prReview(await listReviewsFollowedBy([req.params.id]), pr);
    if (!found) return await reply.send({ review: null });
    const { review, merging } = await reviewForRead(found);
    return await reply.send({ review, working: await sidesWorking(review), merging });
  });

  app.post<{ Params: { id: string }; Body: StartBody }>(
    "/api/cards/:id/review", { preHandler: requireCardWork },
    async (req, reply) => {
      const user = (await requestUser(req))!;
      const body = req.body ?? {};
      const prNumber = typeof body.prNumber === "number" ? body.prNumber : Number.NaN;
      if (!Number.isInteger(prNumber) || prNumber <= 0) return await reply.code(400).send({ error: "prNumber inválido" });
      const coauthorUserId = str(body.coauthorUserId) || undefined;
      if (body.coauthorUserId !== undefined && body.coauthorUserId !== null && !coauthorUserId) {
        return await reply.code(400).send({ error: "coauthorUserId inválido" });
      }
      const card = await registry.getCard(req.params.id);
      if (!card) return await reply.code(404).send({ error: "card not found" });
      try {
        const review = await startReviewChecked({
          card,
          prNumber,
          requester: user,
          roles: {
            reviewerUserId: str(body.reviewerUserId),
            authorUserId: str(body.authorUserId),
            mergerUserId: str(body.mergerUserId),
            ...(coauthorUserId ? { coauthorUserId } : {}),
          },
        });
        return await reply.send({ review });
      } catch (err) {
        // The refusal codes of startReviewChecked/startReview (revisor_igual_autor, sem_pr…) are the
        // requester's fault and fall through to the 400.
        return await sendError(reply, err, { rules: [REVIEW_NOT_FOUND] });
      }
    },
  );

  /* ------------------------------------------------------------- per review */

  /** The review and the caller, or the error response already sent (404 without a review, 403 outside the roles). */
  async function reviewFor(
    id: string, user: PublicUser | null, allowed: (r: Review, u: PublicUser) => boolean, reply: FastifyReply,
  ): Promise<{ review: Review; user: PublicUser } | null> {
    const review = await getReview(id);
    if (!review) {
      await reply.code(404).send({ error: "review not found" });
      return null;
    }
    if (!user || !allowed(review, user)) {
      await reply.code(403).send({ error: "você não tem esse papel nesta revisão" });
      return null;
    }
    return { review, user };
  }
  const isOwner = (u: PublicUser) => u.role === "owner";

  app.post<{ Params: { id: string }; Body: { findingId?: unknown; decision?: unknown } }>(
    "/api/reviews/:id/decide", { preHandler: requireSession },
    async (req, reply) => {
      const found = await reviewFor(req.params.id, await requestUser(req), (r, u) => u.id === r.reviewerUserId || isOwner(u), reply);
      if (!found) return;
      const findingId = str(req.body?.findingId);
      const decision = str(req.body?.decision);
      if (!findingId) return await reply.code(400).send({ error: "findingId obrigatório" });
      if (!DECISIONS.has(decision)) return await reply.code(400).send({ error: "decision deve ser block, drop, keep ou accept_risk" });
      try {
        return await reply.send({ review: await decideQuestion(found.review.id, findingId, decision as Decision, found.user.username) });
      } catch (err) {
        return await sendError(reply, err, { rules: [REVIEW_NOT_FOUND, [/não há decisão pendente/, 409]] });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/reviews/:id/retry", { preHandler: requireSession }, async (req, reply) => {
    const found = await reviewFor(
      req.params.id, await requestUser(req),
      (r, u) => [r.reviewerUserId, r.mergerUserId, r.coauthorUserId].includes(u.id) || isOwner(u), reply,
    );
    if (!found) return;
    try {
      return await reply.send({ review: await retryReview(found.review.id, found.user.username) });
    } catch (err) {
      return await sendError(reply, err, { rules: [REVIEW_NOT_FOUND, [/nada_a_tentar/, 409]] });
    }
  });

  /**
   * What to do with suggestions, chosen on the panel: `apply` (the author applies; `findingIds` is the old
   * name) and `skip` ("não fazer", leaves the list). Who may: reviewer, author, merger or owner.
   */
  app.post<{ Params: { id: string }; Body: { findingIds?: unknown; apply?: unknown; skip?: unknown } }>(
    "/api/reviews/:id/suggestions", { preHandler: requireSession },
    async (req, reply) => {
      const found = await reviewFor(
        req.params.id, await requestUser(req),
        (r, u) => [r.reviewerUserId, r.authorUserId, r.coauthorUserId, r.mergerUserId].includes(u.id) || isOwner(u), reply,
      );
      if (!found) return;
      const ids = (v: unknown): string[] | null =>
        v === undefined ? [] : Array.isArray(v) && v.every((id) => typeof id === "string") ? (v as string[]) : null;
      const apply = ids(req.body?.apply ?? req.body?.findingIds);
      const skip = ids(req.body?.skip);
      if (!apply || !skip) {
        return await reply.code(400).send({ error: "apply e skip devem ser listas de ids de sugestões" });
      }
      try {
        return await reply.send({ review: await decideSuggestions(found.review.id, { apply, skip }, found.user.username) });
      } catch (err) {
        // ja_pedida: another person (or another tab) already sent the same suggestion to the author — a conflict, not an invalid request.
        return await sendError(reply, err, { rules: [REVIEW_NOT_FOUND, [/revisao_encerrada|envio_falhou|ja_pedida/, 409]] });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/reviews/:id/cancel", { preHandler: requireSession }, async (req, reply) => {
    const found = await reviewFor(
      req.params.id, await requestUser(req),
      (r, u) => [r.reviewerUserId, r.authorUserId, r.coauthorUserId, r.mergerUserId].includes(u.id) || isOwner(u), reply,
    );
    if (!found) return;
    try {
      return await reply.send({ review: await cancelReview(found.review.id, found.user.username) });
    } catch (err) {
      return await sendError(reply, err, { rules: [REVIEW_NOT_FOUND, [/revisao_encerrada/, 409]] });
    }
  });

  /**
   * THE MERGE. Whoever has a role in the review (`canMergeReview`: owner, reviewer, author, co-author — the
   * install owner without a role, not), only in `ready`, and pinned to the commit the reviewer approved: the
   * deliver runs in merge-only mode (no push) and refuses with `head_moved` when the PR moved — then the
   * review goes back to the next round, or to impasse on the last one. The deliver gets the GitHub connection
   * of whoever clicked (`ownGithubConnection`); without one, 400 `merger_sem_github` and nothing runs. A refusal
   * from GitHub (403) comes back as it came, with no other credential. The rules live in `mergeReviewedPr`
   * (services/review/merge.ts): the `vibehub_deliver` of whoever has a role goes through the same path.
   */
  app.post<{ Params: { id: string } }>("/api/reviews/:id/merge", { preHandler: requireSession }, async (req, reply) => {
    const found = await reviewFor(req.params.id, await requestUser(req), (r, u) => canMergeReview(r, u.id), reply);
    if (!found) return;
    const outcome = await mergeReviewedPr(found.review.id, found.user.id);
    if (outcome.kind === "merged") return await reply.send({ review: outcome.review, result: outcome.result });
    const { kind: _refused, status, ...body } = outcome;
    return await reply.code(status).send(body);
  });
}
