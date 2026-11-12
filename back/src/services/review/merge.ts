import { cardLevel } from "../../auth/access.js";
import { getUserGit } from "../../auth/userGit.js";
import { findUser, type PublicUser } from "../../auth/users.js";
import * as registry from "../board/registry.js";
import { resolveIdentity } from "../github/identity.js";
import { getSettings } from "../settings/settings.js";
import { deliver, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";
import { canMergeReview, type Review, type ReviewPhase } from "./model.js";
import { claimMerge, markReviewMerged, mergeGateRunning, releaseMerge, reopenAfterHeadMoved } from "./orchestrator.js";
import { getReview } from "./store.js";

/**
 * THE MERGE OF A REVIEWED PR — a single path, called from three places: the panel's "Mergear" button
 * (`POST /api/reviews/:id/merge`), the authorised `vibehub_deliver` when whoever gave the order to the card
 * is the review's merge owner, and the automatic merge of a ready review with nothing standing (the
 * server, after the reviewer's Approve; the user's decision on 11/05/2026). All three do exactly the same,
 * with the same refusals:
 *
 *  - only whoever has a role in the review (`canMergeReview`: owner, reviewer, author, co-author), only in
 *    `ready`, only with the reviewed commit recorded;
 *  - whoever merges needs `work` on the author's card (checked again here: a share that dropped after the
 *    start takes the merge away too) and their OWN GitHub connection (`ownGithubConnection`);
 *  - one merge at a time per review (`claimMerge`): a second click, or the deliver together with the button,
 *    does not fire a second one — and the GitHub check does not close from outside a merge that is going out;
 *  - the deliver runs in merge-only mode, pinned to the commit the reviewer approved: a PR that moved returns
 *    `head_moved` and the review is reopened (next round, or impasse on the last one); red CI returns
 *    `gate`; once merged, the review closes as with the button (notices, the reviewer's card to `done`).
 *
 * Returns the outcome with the HTTP status the route answers, so the route and the deliver tell the same
 * story. Never merges anything outside this.
 */

export type ReviewMergeOutcome =
  | { kind: "merged"; review: Review; result: DeliverResult }
  | {
    kind: "refused";
    status: 400 | 403 | 404 | 409 | 500;
    error: string;
    reason?: string;
    phase?: ReviewPhase;
    review?: Review;
    result?: DeliverResult;
  };

/**
 * The OWN GitHub connection of whoever has a role that goes out on their account: the merger (the merge) and
 * the reviewer (the `gh pr review` calls of the reviewer's card). Their own, if it still exists; there is no
 * fallback to the project's — the merge has to go through the merger's permission on GitHub (a 403 there is
 * the right answer), and a review on the project's account (which is often the one that opened the PR) is
 * refused by GitHub as a "review of one's own PR" and locks the review every round. The exception is an owner
 * with no connection of their own: they operate with the project's, in the same precedence as a card's
 * identity (project, then the install's first one). Null = refuse.
 */
export async function ownGithubConnection(user: PublicUser, card: registry.Card): Promise<string | null> {
  const [git, connections] = await Promise.all([getUserGit(user.id), registry.listGithubConnections()]);
  const own = git?.githubConnectionId;
  if (own && connections.some((c) => c.id === own)) return own;
  if (user.role !== "owner") return null;
  const project = await registry.getProject(card.projectId);
  if (!project) return null;
  return resolveIdentity({ actor: git, project, settings: await getSettings(), connections }).connectionId ?? null;
}

/**
 * Merges the PR of review `reviewId` on behalf of `userId`, or says why not. See the top of the file.
 * `auto`: it is the automatic merge of a ready review with nothing standing (orchestrator `autoMerge`), not a
 * click — the same locks, but the log and the audit say nobody clicked.
 */
export async function mergeReviewedPr(
  reviewId: string, userId: string, opts: { auto?: boolean } = {},
): Promise<ReviewMergeOutcome> {
  const review = await getReview(reviewId);
  if (!review) return { kind: "refused", status: 404, error: "review not found" };
  const user = await findUser(userId);
  if (!user || !canMergeReview(review, user.id)) {
    return { kind: "refused", status: 403, error: "você não tem esse papel nesta revisão", reason: "not_merger" };
  }
  if (review.phase !== "ready") {
    return {
      kind: "refused", status: 409, reason: "not_ready", phase: review.phase,
      error: `a revisão está em ${review.phase}: o merge só sai em ready`,
    };
  }
  if (!review.reviewedSha) {
    return { kind: "refused", status: 409, reason: "not_ready", phase: review.phase, error: "a revisão não tem o commit revisado" };
  }
  if ((await cardLevel(user, review.cardId)) !== "work") {
    return { kind: "refused", status: 403, error: "quem mergeia precisa de acesso de trabalho ao card do autor" };
  }
  const card = await registry.getCard(review.cardId);
  if (!card) return { kind: "refused", status: 404, error: "card not found" };
  const connectionId = await ownGithubConnection(user, card);
  if (!connectionId) {
    return {
      kind: "refused", status: 400, reason: "merger_sem_github",
      error: "merger_sem_github: quem mergeia não tem uma conexão GitHub própria no vibehub",
    };
  }
  // The merge gate has already run (or is running) on the approved commit since the review became ready: the
  // click does not wait minutes to find out what is already known.
  const gate = review.mergeGate?.sha === review.reviewedSha ? review.mergeGate : undefined;
  if (gate?.state === "running" && mergeGateRunning(review.id)) {
    return {
      kind: "refused", status: 409, reason: "gate_running", phase: review.phase,
      error: "os testes do merge ainda estão rodando no commit aprovado: o merge libera quando terminarem",
    };
  }
  if (gate?.state === "failed") {
    return {
      kind: "refused", status: 409, reason: "gate", phase: review.phase,
      error: `os testes do merge falharam no commit aprovado; o autor recebeu a falha. Depois da correção, "Tentar de novo" roda os testes outra vez.\n\n${gate.output ?? ""}`.trimEnd(),
    };
  }
  if (!claimMerge(review.id)) return { kind: "refused", status: 409, reason: "merging", error: "merge já em andamento" };
  try {
    // Reread with the lock in hand: an earlier request may have finished (merged) between the read and here.
    const now = await getReview(review.id);
    if (now?.phase !== "ready" || now.reviewedSha !== review.reviewedSha) {
      return {
        kind: "refused", status: 409, reason: "not_ready", phase: now?.phase,
        error: `a revisão está em ${now?.phase ?? "?"}: o merge só sai em ready`,
      };
    }
    // The connection goes explicitly: the card's actor (the author) does not change, and a message on the card
    // during the merge does not swap the credential from under it.
    const by = opts.auto ? `${user.username} (merge automático)` : user.username;
    const result = await deliver(review.cardId, {
      authorized: true, mergeOnly: true, expectedHeadSha: review.reviewedSha, branch: review.base, connectionId, by,
      gatePassed: now.mergeGate?.sha === now.reviewedSha && now.mergeGate?.state === "passed",
    });
    logger.info(
      {
        audit: true, action: opts.auto ? "review.automerge" : "review.merge", review: review.id,
        merged: result.merged, reason: result.reason, by: user.username, auto: opts.auto === true,
      },
      result.merged ? "PR review merged by its merger" : "PR review merge did not happen",
    );
    if (result.merged) {
      return { kind: "merged", review: await markReviewMerged(review.id, user.username, { auto: opts.auto }), result };
    }
    if (result.reason === "head_moved") {
      const after = await reopenAfterHeadMoved(review.id, user.username);
      return { kind: "refused", status: 409, reason: "head_moved", error: result.output ?? "o PR andou depois do pronto", review: after, result };
    }
    return {
      kind: "refused", status: 409, reason: result.reason, error: result.output ?? `merge não feito: ${result.reason}`,
      review: (await getReview(review.id)) ?? review, result,
    };
  } catch (err) {
    logger.warn({ review: review.id, detail: (err as Error).message }, "PR review merge failed");
    return { kind: "refused", status: 500, error: (err as Error).message };
  } finally {
    releaseMerge(review.id);
  }
}
