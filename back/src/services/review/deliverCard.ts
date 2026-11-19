import { findUser } from "../../auth/users.js";
import { getCard, type Card } from "../board/registry.js";
import { deliver, parsePrUrl, type DeliverOpts, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";
import { canMergeReview, cardsToConclude, isReviewClosed, type Review } from "./model.js";
import { mergeReviewedPr, type ReviewMergeOutcome } from "./merge.js";
import { recordReviewOrders } from "./orchestrator.js";
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
 *
 * On either card, the MERGER's order is also RECORDED on the running review ({@link recordOrder}): the merge
 * authorisation and, with `concludeWhenMerged`, the conclusion of that card — a review that is not ready yet
 * then merges and concludes with nobody coming back to it. A `concludeWhenMerged` that could not be recorded
 * says so in the answer: the AI concludes by hand after the merge instead of promising it.
 */
export async function deliverCard(
  cardId: string, opts: DeliverCardOpts = {},
): Promise<DeliverResult> {
  const { result, concludeRecorded } = await deliverUnderReview(cardId, opts);
  return opts.concludeWhenMerged && !concludeRecorded ? withOutput(result, CONCLUDE_NOT_RECORDED) : result;
}

type DeliverCardOpts = Pick<DeliverOpts, "branch" | "authorized" | "by" | "docs"> & {
  from?: string;
  /** "…e concluir o card": with the card's PR under review, recorded on it, and the card goes to done once merged. */
  concludeWhenMerged?: boolean;
};

/** What the deliver did, and whether the order to conclude the delivered card is now on the review. */
interface Delivered {
  result: DeliverResult;
  concludeRecorded: boolean;
}

const CONCLUDE_NOT_RECORDED =
  "A ordem de concluir o card NÃO foi registrada: ela só fica na revisão quando a PR deste card está em revisão, " +
  "com authorized e from = o próprio card, e a ordem vem de quem mergeia. Depois do merge, conclua o card com vibehub_move_cards.";

const AUTO_MERGE_TERMS =
  "sai sozinho quando ela ficar pronta sem bloqueante nem dúvida, com Approve no GitHub e CI verde; " +
  "se o merge automático falhar, fica para o botão do responsável";

const plain = (result: DeliverResult): Delivered => ({ result, concludeRecorded: false });

function withOutput(result: DeliverResult, extra: string): DeliverResult {
  return extra ? { ...result, output: [result.output, extra].filter(Boolean).join(" ") } : result;
}

async function deliverUnderReview(cardId: string, opts: DeliverCardOpts): Promise<Delivered> {
  if (opts.authorized === true) {
    const card = await getCard(cardId);
    if (card?.reviewOf) return await mergeFromReviewerCard(card, opts);
    if (card?.pushBranch !== undefined && opts.from !== cardId) return plain(await deliverAnalysisWithoutMerge(cardId, opts));
  }
  const review = opts.authorized === true ? await activeReviewFor(cardId) : undefined;
  if (!review) return plain(await deliver(cardId, opts));

  // The delivery belongs to the PR under review: another base would open a new, loose PR that nobody reviewed.
  const target = opts.branch ?? review.base;
  if (target !== review.base) {
    return plain({
      merged: false, reason: "review_active", branch: target, cardBranch: review.prBranch,
      output: `o PR #${review.prNumber} pra ${review.base} está em revisão: entregar pra ${target} fica para depois do merge dele. Nada foi feito.`,
    });
  }
  // The documentation goes along: the author who pushes the fix also explains in the diff what changed.
  const pushed = await deliver(cardId, { branch: review.base, by: opts.by, docs: opts.docs, pushOnly: true });
  if (pushed.reason !== "pushed") return plain(pushed);
  // The push can take minutes: the review may have moved in the meantime (become ready, closed).
  const now = await getReview(review.id);
  if (!now || isReviewClosed(now.phase)) return plain(await deliver(cardId, opts));
  const card = await getCard(cardId);
  const ownCard = opts.from === cardId;
  const orderedBy = ownCard ? mergeOrderedBy(now, card) : undefined;
  const samePr = parsePrUrl(pushed.prUrl ?? "")?.number === now.prNumber;
  const recorded = orderedBy && samePr ? await recordOrder(now, cardId, orderedBy, opts.concludeWhenMerged) : NOTHING_RECORDED;
  if (!orderedBy || !samePr || now.phase !== "ready") {
    logger.info(
      { audit: true, action: "maestro.deliver", card: cardId, merged: false, reason: "review_active", phase: now.phase, ownCard, by: opts.by },
      "deliver pushed but did not merge: the card's PR is under review",
    );
    const output = `revisão do PR #${now.prNumber} ${reviewStage(now)}: ${await whoMerges(now)}. O push foi feito: o PR já tem estes commits.`;
    return { result: withOutput({ ...pushed, reason: "review_active", output }, recorded.text), concludeRecorded: recorded.concludeRecorded };
  }
  return { result: mergeAnswer(await mergeReviewedPr(now.id, orderedBy), pushed, now, recorded), concludeRecorded: recorded.concludeRecorded };
}

const ANALYSIS_ORDER_FROM_ELSEWHERE =
  "o merge de um card de análise só sai pela ordem dada no chat dele: o próprio card chama o vibehub_deliver com " +
  "from = o id dele. A ordem veio de outro card, então o PR foi atualizado e nada foi mergeado.";

async function deliverAnalysisWithoutMerge(cardId: string, opts: DeliverCardOpts): Promise<DeliverResult> {
  const result = await deliver(cardId, { ...opts, authorized: false });
  return result.reason === "unauthorized" ? { ...result, output: ANALYSIS_ORDER_FROM_ELSEWHERE } : result;
}

/**
 * The reviewer's card told to merge: no push (the branch is the one of the PR under review), only the merge
 * of the ready review through the button's path, on the account of whoever gave the order. An already closed
 * review falls into the usual deliver, which refuses the reviewer's card (`locked`).
 */
async function mergeFromReviewerCard(card: Card, opts: DeliverCardOpts): Promise<Delivered> {
  const review = await reviewByReviewerCard(card.id);
  if (!review || isReviewClosed(review.phase)) return plain(await deliver(card.id, opts));
  const target = opts.branch ?? review.base;
  const prepared: DeliverResult = { prUrl: review.prUrl, merged: false, reason: "review_active", branch: target, cardBranch: review.prBranch };
  if (target !== review.base) {
    return plain({ ...prepared, output: `o PR #${review.prNumber} em revisão vai pra ${review.base}, não pra ${target}. Nada foi feito.` });
  }
  const ownCard = opts.from === card.id;
  const orderedBy = ownCard ? mergeOrderedBy(review, card) : undefined;
  const recorded = orderedBy ? await recordOrder(review, card.id, orderedBy, opts.concludeWhenMerged) : NOTHING_RECORDED;
  if (!orderedBy || review.phase !== "ready") {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.id, merged: false, reason: "review_active", phase: review.phase, ownCard, reviewer: true, by: opts.by },
      "reviewer card did not merge: no order from a review role, or the review is not ready",
    );
    const output = `revisão do PR #${review.prNumber} ${reviewStage(review)}: ${await whoMerges(review)}. ${recorded.text || "Nada foi feito."}`;
    return { result: { ...prepared, output }, concludeRecorded: recorded.concludeRecorded };
  }
  return { result: mergeAnswer(await mergeReviewedPr(review.id, orderedBy), prepared, review, recorded), concludeRecorded: recorded.concludeRecorded };
}

/** What {@link recordOrder} left on the review: the words for the answer, and whether the card's conclusion is there. */
interface RecordedOrder {
  text: string;
  concludeRecorded: boolean;
}

const NOTHING_RECORDED: RecordedOrder = { text: "", concludeRecorded: false };

/**
 * The order of the review's MERGER, given to a card while its review runs, recorded on the review
 * (`recordReviewOrders`): merge at the end and, with `concludeWhenMerged`, conclude THIS card. Ordering the
 * merge for the end, or the conclusion, is the merger's alone, as when asking for the review
 * (`startReviewChecked`, merge_autorizado_de_outro); merging a ready review right now stays open to every
 * role ({@link mergeOrderedBy}). Writes only what is not on the review yet; the text says what this order
 * added and what was already there, so the AI tells the user it does not have to come back.
 */
async function recordOrder(review: Review, cardId: string, orderedBy: string, concludeWhenMerged: boolean | undefined): Promise<RecordedOrder> {
  if (orderedBy !== review.mergerUserId) return NOTHING_RECORDED;
  const concludeAsked = concludeWhenMerged === true;
  const missing = !review.mergeAuthorized || (concludeAsked && !cardsToConclude(review).includes(cardId));
  const after = missing ? await recordReviewOrders(review.id, { mergeAuthorized: true, concludeWhenMerged: concludeAsked }, cardId) : review;
  return {
    text: recordedOrdersText(review, after, cardId, concludeAsked),
    concludeRecorded: concludeAsked && cardsToConclude(after).includes(cardId),
  };
}

/** What this order added to the review (`before` → `after`) and what it already held. PURE. */
function recordedOrdersText(before: Review, after: Review, cardId: string, concludeAsked: boolean): string {
  const parts: string[] = [];
  if (before.mergeAuthorized) parts.push("o merge no fim já estava autorizado");
  else if (after.mergeAuthorized) parts.push(`merge autorizado: ${AUTO_MERGE_TERMS}`);
  if (concludeAsked) {
    if (cardsToConclude(before).includes(cardId)) parts.push("a conclusão deste card já estava registrada");
    else if (cardsToConclude(after).includes(cardId)) parts.push("mergeada, este card vai para Concluído");
  }
  return parts.length ? `Na revisão: ${parts.join("; ")}.` : "";
}

/** The merge's answer; when it did not go out, with what the order left recorded for later. */
function mergeAnswer(outcome: ReviewMergeOutcome, base: DeliverResult, review: Review, recorded: RecordedOrder): DeliverResult {
  const answer = mergeResult(outcome, base, review);
  return answer.merged ? answer : withOutput(answer, recorded.text);
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
