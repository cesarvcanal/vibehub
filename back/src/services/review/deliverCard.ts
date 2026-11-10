import { findUser } from "../../auth/users.js";
import { getCard, type Card } from "../board/registry.js";
import { deliver, parsePrUrl, type DeliverOpts, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";
import { canMergeReview, type Review } from "./model.js";
import { mergeReviewedPr, type ReviewMergeOutcome } from "./merge.js";
import { activeReviewFor, getReview, reviewByReviewerCard } from "./store.js";

/**
 * O `vibehub_deliver` de um card — o deliver de sempre, com a regra da REVISÃO DE PR por cima, que o
 * deliver genérico não precisa conhecer:
 *
 *  - sem revisão ativa, ou sem `authorized`: é o `deliver` de sempre (push → PR → gate → merge);
 *  - com revisão ativa e `authorized`: primeiro o PUSH (só ele, `pushOnly`) — é assim que o autor
 *    entrega a correção, e acontece quem quer que tenha pedido. Depois, o merge é da revisão: só
 *    quem tem papel nela (`canMergeReview`), na conta dela, só com a revisão pronta e deste PR, e pelo MESMO caminho do botão do
 *    painel (`mergeReviewedPr`: só-merge preso ao commit aprovado, conexão GitHub própria dele, a
 *    revisão fechando como mergeada). Quem deu a ordem é o ATOR do card (quem mandou a última
 *    mensagem) — e só quando é o PRÓPRIO card que se entrega (`from` = o card): a IA de outro card
 *    entregando este não carrega a ordem de quem falou com ele. Para qualquer outra pessoa, outro
 *    card, ou revisão que não está pronta, `review_active` dizendo quem mergeia, onde e em que pé a
 *    revisão está. Uma recusa do próprio merge chega com o motivo real (conflito, CI, conexão).
 *  - no card do REVISOR (`reviewOf`) com `authorized`: nunca há push (ele não empurra na branch que
 *    revisa), mas a mesma ordem de quem tem papel na revisão mergeia por ele, pelo mesmo caminho.
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

  // A entrega é do PR em revisão: outra base abriria um PR novo, solto, que ninguém revisou.
  const target = opts.branch ?? review.base;
  if (target !== review.base) {
    return {
      merged: false, reason: "review_active", branch: target, cardBranch: review.prBranch,
      output: `o PR #${review.prNumber} pra ${review.base} está em revisão: entregar pra ${target} fica para depois do merge dele. Nada foi feito.`,
    };
  }
  // A documentação vai junto: o autor que empurra a correção também explica no diff o que mudou.
  const pushed = await deliver(cardId, { branch: review.base, by: opts.by, docs: opts.docs, pushOnly: true });
  if (pushed.reason !== "pushed") return pushed;
  // O push leva até minutos: a revisão pode ter andado nesse meio (ficado pronta, fechado).
  const now = await getReview(review.id);
  if (!now || now.phase === "merged" || now.phase === "cancelled") return await deliver(cardId, opts);
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
 * O card do revisor mandado mergear: sem push (a branch é a do PR em revisão), só o merge da revisão
 * pronta pelo caminho do botão, na conta de quem deu a ordem. Revisão já encerrada cai no deliver de
 * sempre, que recusa o card do revisor (`locked`).
 */
async function mergeFromReviewerCard(card: Card, opts: DeliverCardOpts): Promise<DeliverResult> {
  const review = await reviewByReviewerCard(card.id);
  if (!review || review.phase === "merged" || review.phase === "cancelled") return await deliver(card.id, opts);
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

/** Quem deu a ordem ao card (o ator, quem mandou a última mensagem), se tem papel na revisão; o merge sai na conta dele. */
function mergeOrderedBy(review: Review, card: Card | undefined): string | undefined {
  return canMergeReview(review, card?.actorUserId) ? card?.actorUserId : undefined;
}

async function whoMerges(review: Review): Promise<string> {
  const merger = (await findUser(review.mergerUserId))?.username ?? review.mergerUserId;
  return `o merge é de quem tem papel na revisão (responsável: ${merger}; também revisor, autor e coautor), pelo botão ` +
    `"Mergear na ${review.base}" no painel da revisão, ou por este deliver feito pelo próprio card (from = o id dele, no ` +
    `card do autor ou no do revisor) quando a ordem vier de uma dessas pessoas com a revisão pronta`;
}

/** O desfecho do merge da revisão como resposta do deliver, sobre o que já tinha sido feito (`base`). */
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
 * O motivo de um merge recusado, para a IA contar a verdade: o do próprio deliver quando ele rodou
 * (CI vermelho, conflito), "a revisão está ativa" quando ela não estava pronta ou outro merge está
 * saindo, e falha de merge no resto (conexão GitHub do responsável, permissão, erro).
 */
function refusalReason(outcome: Extract<ReviewMergeOutcome, { kind: "refused" }>): DeliverResult["reason"] {
  if (outcome.result) return outcome.result.reason;
  if (outcome.reason === "gate" || outcome.reason === "gate_running") return "gate";
  if (outcome.reason === "not_ready" || outcome.reason === "merging") return "review_active";
  return "merge_failed";
}

/** Onde a revisão está, nas palavras que a recusa de um merge precisa. PURE. */
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
