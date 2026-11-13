import { findUser } from "../../auth/users.js";
import { getCard, type Card } from "../board/registry.js";
import { deliver, parsePrUrl, type DeliverOpts, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";
import { canMergeReview, isReviewClosed, type Review } from "./model.js";
import { mergeReviewedPr, type ReviewMergeOutcome } from "./merge.js";
import { activeReviewFor, getReview, reviewByReviewerCard } from "./store.js";

/**
 * A card's `vibehub_deliver` — the usual deliver, with the PR REVIEW rule on top, which the generic
 * deliver does not need to know about:
 *
 *  - no active review, or no `authorized`: it is the usual `deliver` (push → PR → gate → merge);
 *  - with an active review and `authorized`: first the PUSH (only that, `pushOnly`) — that is how the author
 *    delivers the fix, and it happens whoever asked for it. After that, the merge belongs to the review: only
 *    whoever has a role in it (`canMergeReview`), on their account, only with the review ready and of this PR, and through the SAME path as the
 *    panel's button (`mergeReviewedPr`: merge-only pinned to the approved commit, their own GitHub connection, the
 *    review closing as merged). Whoever gave the order is the card's ACTOR (who sent the latest
 *    message) — and only when it is the card ITSELF being delivered (`from` = the card): another card's AI
 *    delivering this one does not carry the order of whoever spoke to it. For anybody else, another
 *    card, or a review that is not ready, `review_active` saying who merges, where and how far along the
 *    review is. A refusal of the merge itself arrives with the real reason (conflict, CI, connection).
 *  - on the REVIEWER's card (`reviewOf`) with `authorized`: there is never a push (it does not push to the
 *    branch it reviews), but the same order from whoever has a role in the review merges for it, by the same path.
 */
export async function deliverCard(
  cardId: string, opts: DeliverCardOpts = {},
): Promise<DeliverResult> {
  if (opts.authorized === true) {
    const card = await getCard(cardId);
    if (card?.reviewOf) return await mergeFromReviewerCard(card, opts);
  }
  const review = opts.authorized === true ? await activeReviewFor(cardId) : undefined;
  if (!review) return await deliver(cardId, opts);

  // The delivery belongs to the PR under review: another base would open a new, loose PR that nobody reviewed.
  const target = opts.branch ?? review.base;
  if (target !== review.base) {
    return {
      merged: false, reason: "review_active", branch: target, cardBranch: review.prBranch,
      output: `o PR #${review.prNumber} pra ${review.base} está em revisão: entregar pra ${target} fica para depois do merge dele. Nada foi feito.`,
    };
  }
  // The documentation goes along: the author who pushes the fix also explains in the diff what changed.
  const pushed = await deliver(cardId, { branch: review.base, by: opts.by, docs: opts.docs, pushOnly: true });
  if (pushed.reason !== "pushed") return pushed;
  // The push can take minutes: the review may have moved in the meantime (become ready, closed).
  const now = await getReview(review.id);
  if (!now || isReviewClosed(now.phase)) return await deliver(cardId, opts);
  const card = await getCard(cardId);
  const ownCard = opts.from === cardId;
  const orderedBy = ownCard ? mergeOrderedBy(now, card) : undefined;
  const samePr = parsePrUrl(pushed.prUrl ?? "")?.number === now.prNumber;
  if (!orderedBy || !samePr || now.phase !== "ready") {
    logger.info(
      { audit: true, action: "maestro.deliver", card: cardId, merged: false, reason: "review_active", phase: now.phase, ownCard, by: opts.by },
      "deliver pushed but did not merge: the card's PR is under review",
    );
    return {
      ...pushed, reason: "review_active",
      output: `revisão do PR #${now.prNumber} ${reviewStage(now)}: ${await whoMerges(now)}. O push foi feito: o PR já tem estes commits.`,
    };
  }
  return mergeResult(await mergeReviewedPr(now.id, orderedBy), pushed, now);
}

type DeliverCardOpts = Pick<DeliverOpts, "branch" | "authorized" | "by" | "docs"> & { from?: string };

/**
 * The reviewer's card told to merge: no push (the branch is the one of the PR under review), only the merge
 * of the ready review through the button's path, on the account of whoever gave the order. An already closed
 * review falls into the usual deliver, which refuses the reviewer's card (`locked`).
 */
async function mergeFromReviewerCard(card: Card, opts: DeliverCardOpts): Promise<DeliverResult> {
  const review = await reviewByReviewerCard(card.id);
  if (!review || isReviewClosed(review.phase)) return await deliver(card.id, opts);
  const target = opts.branch ?? review.base;
  const prepared: DeliverResult = { prUrl: review.prUrl, merged: false, reason: "review_active", branch: target, cardBranch: review.prBranch };
  if (target !== review.base) {
    return { ...prepared, output: `o PR #${review.prNumber} em revisão vai pra ${review.base}, não pra ${target}. Nada foi feito.` };
  }
  const ownCard = opts.from === card.id;
  const orderedBy = ownCard ? mergeOrderedBy(review, card) : undefined;
  if (!orderedBy || review.phase !== "ready") {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.id, merged: false, reason: "review_active", phase: review.phase, ownCard, reviewer: true, by: opts.by },
      "reviewer card did not merge: no order from a review role, or the review is not ready",
    );
    return { ...prepared, output: `revisão do PR #${review.prNumber} ${reviewStage(review)}: ${await whoMerges(review)}. Nada foi feito.` };
  }
  return mergeResult(await mergeReviewedPr(review.id, orderedBy), prepared, review);
}

/** Whoever gave the order to the card (the actor, who sent the latest message), if they have a role in the review; the merge goes out on their account. */
function mergeOrderedBy(review: Review, card: Card | undefined): string | undefined {
  return canMergeReview(review, card?.actorUserId) ? card?.actorUserId : undefined;
}

async function whoMerges(review: Review): Promise<string> {
  const merger = (await findUser(review.mergerUserId))?.username ?? review.mergerUserId;
  return `o merge é de quem tem papel na revisão (responsável: ${merger}; também revisor, autor e coautor), pelo botão ` +
    `"Mergear na ${review.base}" no painel da revisão, ou por este deliver feito pelo próprio card (from = o id dele, no ` +
    `card do autor ou no do revisor) quando a ordem vier de uma dessas pessoas com a revisão pronta`;
}

/** The outcome of the review's merge as the deliver's answer, on top of what had already been done (`base`). */
function mergeResult(outcome: ReviewMergeOutcome, base: DeliverResult, review: Review): DeliverResult {
  if (outcome.kind === "merged") return { ...base, merged: true, reason: "merged", headBranch: outcome.result.headBranch };
  if (outcome.reason === "head_moved") {
    const round = outcome.review?.round ?? review.round + 1;
    return {
      ...base, reason: "head_moved",
      output: `o PR tem commits que o revisor ainda não viu: a revisão voltou pra rodada ${round} e o merge sai quando ela ficar pronta de novo`,
    };
  }
  return { ...base, reason: refusalReason(outcome), output: outcome.error };
}

/**
 * The reason for a refused merge, so the AI tells the truth: the deliver's own when it ran (red CI,
 * conflict), "a revisão está ativa" when it was not ready or another merge is going out, and merge
 * failure for the rest (the owner's GitHub connection, permission, error).
 */
function refusalReason(outcome: Extract<ReviewMergeOutcome, { kind: "refused" }>): DeliverResult["reason"] {
  if (outcome.result) return outcome.result.reason;
  if (outcome.reason === "gate" || outcome.reason === "gate_running") return "gate";
  if (outcome.reason === "not_ready" || outcome.reason === "merging") return "review_active";
  return "merge_failed";
}

/** Where the review is, in the words a merge refusal needs. PURE. */
function reviewStage(r: Review): string {
  switch (r.phase) {
    case "reviewing":
      return r.lastSubmitRound === r.round ? "esperando o revisor humano decidir as dúvidas" : "com o revisor conferindo";
    case "fixing":
      return "com o autor corrigindo bloqueante em aberto";
    case "impasse":
      return "em impasse (precisa de uma pessoa no painel)";
    default:
      return "pronta para o merge";
  }
}
