import { getCard, getProject, saveMergeOrder, updateCard, type Card } from "../board/registry.js";
import { cardConnectionId, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";

export const MERGE_ORDER_TTL_MS = 6 * 60 * 60_000;

export const MERGE_QUEUED_OUTPUT =
  "O CI do PR ainda está rodando: a ordem de merge ficou guardada no servidor, presa a este commit, e o merge sai " +
  "sozinho quando o CI ficar verde (até 6 h). O aviso chega neste card. Não chame de novo nem fique esperando.";

export async function saveOrderFromDelivery(card: Card, result: DeliverResult, orderedBy: string): Promise<void> {
  if (result.reason !== "merge_queued") {
    if (card.mergeOrder) await saveMergeOrder(card.id, undefined);
    return;
  }
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");
  const connectionId = await cardConnectionId(card, project);
  if (!connectionId) throw new Error("the card has no GitHub connection to merge with later");
  if (!result.queuedSha || !result.prUrl) throw new Error("a queued merge needs the commit and the PR");
  await saveMergeOrder(card.id, {
    sha: result.queuedSha, target: result.branch, prUrl: result.prUrl, orderedBy, connectionId, orderedAt: Date.now(),
  });
  logger.info(
    { audit: true, action: "maestro.merge_order", card: card.worktreeSlug, sha: result.queuedSha, target: result.branch, by: orderedBy },
    "merge order kept until the PR's CI is green",
  );
}

export async function concludeMergedCard(cardId: string): Promise<string> {
  try {
    const card = await getCard(cardId);
    if (!card || card.column === "done") return "";
    await updateCard(cardId, { column: "done" });
    logger.info({ audit: true, action: "maestro.deliver", card: card.worktreeSlug }, "card that merged its own PR moved to done");
    return "Mergeado pelo próprio card: ele foi para Concluído.";
  } catch (err) {
    return `O card NÃO foi para Concluído (${(err as Error).message}): conclua com vibehub_move_cards.`;
  }
}
