import type { PublicUser } from "../../auth/users.js";
import { getCard, updateCard, type Card, type CardPr } from "../board/registry.js";
import { deliver, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";
import { analysisVerdict, type AnalysisReport } from "./analysisModel.js";
import { getAnalysis } from "./analysisStore.js";
import { ownGithubConnection } from "./merge.js";

export type AnalysisMergeOutcome =
  | { kind: "merged"; result: DeliverResult }
  | { kind: "refused"; status: 400 | 404 | 409; reason: string; error: string; result?: DeliverResult };

export function analysedPr(card: Card, analysis: AnalysisReport): CardPr | undefined {
  return card.prs?.find((pr) => pr.url === analysis.prUrl);
}

export function isAnalysisMergeable(analysis: AnalysisReport, pr: CardPr): boolean {
  return analysisVerdict(analysis) === "apt" && pr.mergedAt === undefined;
}

const mergingCardIds = new Set<string>();

export async function mergeAnalysedPr(cardId: string, user: PublicUser): Promise<AnalysisMergeOutcome> {
  if (mergingCardIds.has(cardId)) return { kind: "refused", status: 409, reason: "merging", error: "merge já em andamento" };
  mergingCardIds.add(cardId);
  try {
    return await mergeClaimedAnalysis(cardId, user);
  } finally {
    mergingCardIds.delete(cardId);
  }
}

async function mergeClaimedAnalysis(cardId: string, user: PublicUser): Promise<AnalysisMergeOutcome> {
  const [card, analysis] = await Promise.all([getCard(cardId), getAnalysis(cardId)]);
  if (!card) return { kind: "refused", status: 404, reason: "not_found", error: "card not found" };
  const pr = analysis && analysedPr(card, analysis);
  if (pr?.mergedAt !== undefined) {
    return { kind: "refused", status: 409, reason: "already_merged", error: `o PR #${pr.number} já foi mergeado` };
  }
  if (!analysis || !pr || !isAnalysisMergeable(analysis, pr)) {
    return {
      kind: "refused", status: 409, reason: "not_apt",
      error: "a análise não está apta: o merge só sai com ela concluída, sem bloqueante aberto, sem dúvida sem resposta e com todas as dimensões verificadas",
    };
  }
  const connectionId = await ownGithubConnection(user, card);
  if (!connectionId) {
    return {
      kind: "refused", status: 400, reason: "merger_sem_github",
      error: "merger_sem_github: quem mergeia não tem uma conexão GitHub própria no vibehub",
    };
  }
  const result = await deliver(cardId, { authorized: true, branch: pr.base, connectionId, by: user.username });
  logger.info(
    { audit: true, action: "analysis.merge", card: card.worktreeSlug, pr: pr.number, merged: result.merged, reason: result.reason, by: user.username },
    result.merged ? "analysed PR merged from the analysis panel" : "analysed PR merge did not happen",
  );
  if (!result.merged) {
    return { kind: "refused", status: 409, reason: result.reason, error: result.output ?? `merge não feito: ${result.reason}`, result };
  }
  await updateCard(cardId, { column: "done" });
  return { kind: "merged", result };
}
