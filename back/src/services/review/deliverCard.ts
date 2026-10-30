import { findUser } from "../../auth/users.js";
import { getCard } from "../board/registry.js";
import { deliver, parsePrUrl, type DeliverOpts, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";
import type { Review } from "./model.js";
import { mergeReviewedPr } from "./merge.js";
import { activeReviewFor } from "./store.js";

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
 *    mensagem). Para qualquer outra pessoa, ou revisão que não está pronta, `review_active` dizendo
 *    quem mergeia, onde e em que pé a revisão está.
 */
export async function deliverCard(cardId: string, opts: Pick<DeliverOpts, "branch" | "authorized" | "by"> = {}): Promise<DeliverResult> {
  const review = opts.authorized === true ? await activeReviewFor(cardId) : undefined;
  if (!review) return await deliver(cardId, opts);

  const pushed = await deliver(cardId, { branch: opts.branch, by: opts.by, pushOnly: true });
  if (pushed.reason !== "pushed") return pushed;
  const card = await getCard(cardId);
  const merger = (await findUser(review.mergerUserId))?.username ?? review.mergerUserId;
  const ordered = card?.actorUserId === review.mergerUserId;
  const samePr = parsePrUrl(pushed.prUrl ?? "")?.number === review.prNumber;
  if (!ordered || !samePr || review.phase !== "ready") {
    logger.info(
      { audit: true, action: "maestro.deliver", card: cardId, merged: false, reason: "review_active", phase: review.phase, by: opts.by },
      "deliver pushed but did not merge: the card's PR is under review",
    );
    const who = `o merge é de ${merger}, pelo botão "Mergear na ${review.base}" no painel da revisão, ou por este deliver ` +
      `quando a ordem vier de ${merger} com a revisão pronta`;
    return {
      ...pushed, reason: "review_active",
      output: `revisão do PR #${review.prNumber} ${reviewStage(review)}: ${who}. O push foi feito: o PR já tem estes commits.`,
    };
  }

  const outcome = await mergeReviewedPr(review.id, review.mergerUserId);
  if (outcome.kind === "merged") return { ...pushed, merged: true, reason: "merged", headBranch: outcome.result.headBranch };
  if (outcome.reason === "head_moved") {
    const round = outcome.review?.round ?? review.round + 1;
    return {
      ...pushed, reason: "head_moved",
      output: `o push trouxe commits que o revisor ainda não viu: a revisão voltou pra rodada ${round} e o merge sai quando ela ficar pronta de novo`,
    };
  }
  return { ...pushed, reason: outcome.reason === "gate" ? "gate" : "review_active", output: outcome.error };
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
