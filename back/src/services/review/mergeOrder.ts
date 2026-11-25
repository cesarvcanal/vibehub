import {
  claimMergeOrder, deleteMergeOrderAt, getCard, getGithubConnection, getProject, listCardsWithMergeOrder, releaseMergeOrder, saveMergeOrder,
  updateCard, type Card, type MergeOrder,
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
  for (const card of await listCardsWithMergeOrder()) {
    await runMergeOrder(card.id, now).catch(async (err: unknown) => {
      logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "merge order step failed — released for the next tick");
      if (card.mergeOrder) await releaseMergeOrder(card.id, card.mergeOrder.sha);
    });
  }
}

async function runMergeOrder(cardId: string, now: number): Promise<void> {
  const order = await claimMergeOrder(cardId, now);
  if (!order) return;
  const card = await getCard(cardId);
  if (!card) return;
  const shortSha = order.sha.slice(0, 7);
  if (card.column === "done") {
    await dropMergeOrder(card, order, "card_done", `O card foi concluído: a ordem de merge guardada do commit ${shortSha} caiu sem merge.`);
    return;
  }
  if (now - order.orderedAt >= MERGE_ORDER_TTL_MS) {
    await dropMergeOrder(card, order, "expired",
      `A ordem de merge guardada caiu: passaram 6 h sem merge do commit ${shortSha}. O CI do PR não ficou verde a tempo, ou a ` +
      "leitura do PR no GitHub falhou em todas as tentativas. Nada foi mergeado; confira o CI do PR e entregue de novo.");
    return;
  }
  if (!(await getGithubConnection(order.connectionId))) {
    await dropMergeOrder(card, order, "connection_gone",
      `A ordem de merge guardada caiu: a conexão GitHub de quem mandou foi removida do vibehub. Nada foi mergeado; entregue de ` +
      "novo com uma conta GitHub conectada.");
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
    await deleteMergeOrderAt(cardId, order.sha);
    const concluded = await concludeMergedCard(cardId);
    await notifyMergeOrder(card, order, "merged", "done",
      `Mergeado: o CI do PR ficou verde e a ordem de merge guardada saiu em ${order.target} (commit ${shortSha}). ${concluded}`.trim());
    return;
  }
  const why = result.reason === "head_moved"
    ? `o PR recebeu commit novo depois da ordem (${result.output ?? "outro commit"}). A ordem voltou para você: entregue de novo para mergear o commit novo.`
    : `${result.reason}: ${result.output ?? "sem detalhe"}`;
  await dropMergeOrder(card, order, result.reason, `A ordem de merge guardada caiu sem merge do commit ${shortSha}. ${why}`);
}

function deliverMergeOrder(card: Card, order: MergeOrder): Promise<DeliverResult> {
  const opts: DeliverOpts & { by: string } = {
    authorized: true, mergeOnly: true, expectedHeadSha: order.sha, branch: order.target,
    connectionId: order.connectionId, by: order.orderedBy, queueWhileCiRuns: true,
  };
  return card.pushBranch === undefined ? deliver(card.id, opts) : deliverOwnAnalysis(card, opts);
}

async function dropMergeOrder(card: Card, order: MergeOrder, outcome: string, text: string): Promise<void> {
  await deleteMergeOrderAt(card.id, order.sha);
  await notifyMergeOrder(card, order, outcome, "error", text);
}

async function notifyMergeOrder(card: Card, order: MergeOrder, outcome: string, type: "done" | "error", text: string): Promise<void> {
  logger.info({ audit: true, action: "maestro.merge_order", card: card.worktreeSlug, sha: order.sha, outcome, by: order.orderedBy }, "merge order ended");
  await recordMessage({
    cardId: card.id, type, text, severity: type === "done" ? "info" : "warning", idempotencyKey: `merge-order:${order.sha}:${outcome}`,
  });
}

const MERGE_ORDER_TICKS_BEFORE_GIVING_UP = 3;
const CI_WATCH_COMMAND_TIMEOUT_MS = 5 * 60_000;
const CI_WATCH_LIMIT_MINUTES = 60;

export function buildMergeQueuedOutput(result: DeliverResult): string {
  const { queuedSha, prUrl } = result;
  if (!queuedSha || !prUrl) throw new Error("a queued merge needs the commit and the PR");
  const shortSha = queuedSha.slice(0, 7);
  const tickMinutes = MERGE_ORDER_TICK_MS / 60_000;
  const ttlHours = MERGE_ORDER_TTL_MS / 3_600_000;
  const minutesBeforeGivingUp = MERGE_ORDER_TICKS_BEFORE_GIVING_UP * tickMinutes;
  return `O CI do PR ainda está rodando: a ordem de merge ficou guardada no servidor, presa ao commit ${shortSha}. O servidor ` +
    `confere a cada ${tickMinutes} min, mergeia quando o CI ficar verde (até ${ttlHours} h) e conclui o card. Não encerre o turno: ` +
    "a ordem só está cumprida com o PR mergeado. Diga ao usuário que está esperando o CI e acompanhe: " +
    `\`gh pr checks ${prUrl} --watch --interval 30\` (Bash com timeout de ${CI_WATCH_COMMAND_TIMEOUT_MS} ms; repita se o tempo ` +
    `acabar) e, com o CI terminado, \`gh pr view ${prUrl} --json state,mergeable\` a cada ~20 s até MERGED. Não chame o ` +
    "vibehub_deliver de novo enquanto a ordem está guardada: o merge é do servidor. CI vermelho ou PR CONFLICTING: a ordem cai; " +
    "conte ao usuário, corrija (a falha deste PR, ou traga a base) e entregue o commit novo. " +
    `CI verde e PR ainda OPEN ${minutesBeforeGivingUp} min depois, ou CI ainda rodando depois de ${CI_WATCH_LIMIT_MINUTES} min: ` +
    "conte ao usuário que o merge guardado não saiu ainda, que o aviso do servidor chega neste card, e só então encerre.";
}

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
