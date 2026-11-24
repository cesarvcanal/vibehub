import {
  claimMergeOrder, getCard, getProject, listCardsWithMergeOrder, releaseMergeOrder, saveMergeOrder, updateCard, type Card, type MergeOrder,
} from "../board/registry.js";
import { cardConnectionId, deliver, type DeliverOpts, type DeliverResult } from "../maestro/deliver.js";
import { recordMessage } from "../events/cardEvents.js";
import { logger } from "../../utils/logger.js";
import { deliverOwnAnalysis } from "./analysisMerge.js";
import { activeReviewFor } from "./store.js";

export const MERGE_ORDER_TTL_MS = 6 * 60 * 60_000;
const MERGE_ORDER_TICK_MS = 60_000;

export function startMergeOrders(): void {
  const timer = setInterval(() => {
    runMergeOrders().catch((err: unknown) => {
      logger.warn({ detail: (err as Error).message }, "merge orders could not be read — the next tick reads them again");
    });
  }, MERGE_ORDER_TICK_MS);
  timer.unref();
}

export async function runMergeOrders(now: number = Date.now()): Promise<void> {
  for (const card of await listCardsWithMergeOrder()) await runMergeOrder(card.id, now);
}

async function runMergeOrder(cardId: string, now: number): Promise<void> {
  const order = await claimMergeOrder(cardId, now);
  if (!order) return;
  const card = await getCard(cardId);
  if (!card) return;
  if (card.column === "done") {
    await saveMergeOrder(cardId, undefined);
    return;
  }
  const sha7 = order.sha.slice(0, 7);
  if (now - order.orderedAt >= MERGE_ORDER_TTL_MS) {
    await dropMergeOrder(card, order, "expired",
      `A ordem de merge guardada caiu: o CI do PR não terminou em 6 h no commit ${sha7}. Nada foi mergeado; confira o CI e entregue de novo.`);
    return;
  }
  if (card.pushBranch === undefined && (await activeReviewFor(card.id))) {
    await dropMergeOrder(card, order, "review_active",
      "A ordem de merge guardada caiu: o PR entrou em revisão, e o merge agora é do responsável pela revisão, no painel dela.");
    return;
  }
  const result = await deliverMergeOrder(card, order).catch((err: unknown) => {
    logger.warn({ card: card.worktreeSlug, sha: order.sha, detail: (err as Error).message }, "merge order could not read the PR — trying again next tick");
    return null;
  });
  if (!result || result.reason === "merge_queued") {
    await releaseMergeOrder(cardId, order.sha);
    return;
  }
  if (result.merged) {
    await saveMergeOrder(cardId, undefined);
    const concluded = await concludeMergedCard(cardId);
    await notifyMergeOrder(card, order, "merged", "done",
      `Mergeado: o CI do PR ficou verde e a ordem de merge guardada saiu em ${order.target} (commit ${sha7}). ${concluded}`.trim());
    return;
  }
  const why = result.reason === "head_moved"
    ? `o PR recebeu commit novo depois da ordem (${result.output ?? "outro commit"}). A ordem voltou para você: entregue de novo para mergear o commit novo.`
    : `${result.reason}: ${result.output ?? "sem detalhe"}`;
  await dropMergeOrder(card, order, result.reason, `A ordem de merge guardada caiu sem merge do commit ${sha7}. ${why}`);
}

function deliverMergeOrder(card: Card, order: MergeOrder): Promise<DeliverResult> {
  const opts: DeliverOpts & { by: string } = {
    authorized: true, mergeOnly: true, expectedHeadSha: order.sha, branch: order.target,
    connectionId: order.connectionId, by: order.orderedBy, queueWhileCiRuns: true,
  };
  return card.pushBranch === undefined ? deliver(card.id, opts) : deliverOwnAnalysis(card, opts);
}

async function dropMergeOrder(card: Card, order: MergeOrder, outcome: string, text: string): Promise<void> {
  await saveMergeOrder(card.id, undefined);
  await notifyMergeOrder(card, order, outcome, "error", text);
}

async function notifyMergeOrder(card: Card, order: MergeOrder, outcome: string, type: "done" | "error", text: string): Promise<void> {
  logger.info({ audit: true, action: "maestro.merge_order", card: card.worktreeSlug, sha: order.sha, outcome, by: order.orderedBy }, "merge order ended");
  await recordMessage({
    cardId: card.id, type, text, severity: type === "done" ? "info" : "warning", idempotencyKey: `merge-order:${order.sha}:${outcome}`,
  });
}

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
