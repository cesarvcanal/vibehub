import { findUser } from "../../auth/users.js";
import { getCard } from "../board/registry.js";
import { deliver, parsePrUrl, type DeliverOpts, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";
import type { Review } from "./model.js";
import { mergeReviewedPr, type ReviewMergeOutcome } from "./merge.js";
import { activeReviewFor, getReview } from "./store.js";

/**
 * O `vibehub_deliver` de um card — o deliver de sempre, com a regra da REVISÃO DE PR por cima, que o
 * deliver genérico não precisa conhecer:
 *
 *  - sem revisão ativa, ou sem `authorized`: é o `deliver` de sempre (push → PR → gate → merge);
 *  - com revisão ativa e `authorized`: primeiro o PUSH (só ele, `pushOnly`) — é assim que o autor
 *    entrega a correção, e acontece quem quer que tenha pedido. Depois, o merge é da revisão: só o
 *    responsável pelo merge, só com a revisão pronta e deste PR, e pelo MESMO caminho do botão do
 *    painel (`mergeReviewedPr`: só-merge preso ao commit aprovado, conexão GitHub própria dele, a
 *    revisão fechando como mergeada). Quem deu a ordem é o ATOR do card (quem mandou a última
 *    mensagem) — e só quando é o PRÓPRIO card que se entrega (`from` = o card): a IA de outro card
 *    entregando este não carrega a ordem de quem falou com ele. Para qualquer outra pessoa, outro
 *    card, ou revisão que não está pronta, `review_active` dizendo quem mergeia, onde e em que pé a
 *    revisão está. Uma recusa do próprio merge chega com o motivo real (conflito, CI, conexão).
 */
export async function deliverCard(
  cardId: string, opts: Pick<DeliverOpts, "branch" | "authorized" | "by"> & { from?: string } = {},
): Promise<DeliverResult> {
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
  const pushed = await deliver(cardId, { branch: review.base, by: opts.by, pushOnly: true });
  if (pushed.reason !== "pushed") return pushed;
  // O push leva até minutos: a revisão pode ter andado nesse meio (ficado pronta, fechado).
  const now = await getReview(review.id);
  if (!now || now.phase === "merged" || now.phase === "cancelled") return await deliver(cardId, opts);
  const card = await getCard(cardId);
  const merger = (await findUser(now.mergerUserId))?.username ?? now.mergerUserId;
  const ownCard = opts.from === cardId;
  const ordered = ownCard && card?.actorUserId === now.mergerUserId;
  const samePr = parsePrUrl(pushed.prUrl ?? "")?.number === now.prNumber;
  if (!ordered || !samePr || now.phase !== "ready") {
    logger.info(
      { audit: true, action: "maestro.deliver", card: cardId, merged: false, reason: "review_active", phase: now.phase, ownCard, by: opts.by },
      "deliver pushed but did not merge: the card's PR is under review",
    );
    const who = `o merge é de ${merger}, pelo botão "Mergear na ${now.base}" no painel da revisão, ou por este deliver ` +
      `feito pelo próprio card (from = o id dele) quando a ordem vier de ${merger} com a revisão pronta`;
    return {
      ...pushed, reason: "review_active",
      output: `revisão do PR #${now.prNumber} ${reviewStage(now)}: ${who}. O push foi feito: o PR já tem estes commits.`,
    };
  }

  const outcome = await mergeReviewedPr(now.id, now.mergerUserId);
  if (outcome.kind === "merged") return { ...pushed, merged: true, reason: "merged", headBranch: outcome.result.headBranch };
  if (outcome.reason === "head_moved") {
    const round = outcome.review?.round ?? now.round + 1;
    return {
      ...pushed, reason: "head_moved",
      output: `o push trouxe commits que o revisor ainda não viu: a revisão voltou pra rodada ${round} e o merge sai quando ela ficar pronta de novo`,
    };
  }
  return { ...pushed, reason: refusalReason(outcome), output: outcome.error };
}

/**
 * O motivo de um merge recusado, para a IA contar a verdade: o do próprio deliver quando ele rodou
 * (CI vermelho, conflito), "a revisão está ativa" quando ela não estava pronta ou outro merge está
 * saindo, e falha de merge no resto (conexão GitHub do responsável, permissão, erro).
 */
function refusalReason(outcome: Extract<ReviewMergeOutcome, { kind: "refused" }>): DeliverResult["reason"] {
  if (outcome.result) return outcome.result.reason;
  if (outcome.reason === "gate") return "gate";
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
