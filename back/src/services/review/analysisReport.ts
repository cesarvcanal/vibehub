import { getCard, updateCard } from "../board/registry.js";
import { recordMessage } from "../events/cardEvents.js";
import type { AnalysisFinding, AnalysisReport, AnalysisStage, DimensionRun } from "./analysisModel.js";
import { saveAnalysis } from "./analysisStore.js";

export interface AnalysisReportInput {
  headSha: string;
  stage: AnalysisStage;
  summary: string;
  dimensions: DimensionRun[];
  findings: AnalysisFinding[];
  refutedCount: number;
  unavailableReason?: string;
}

function stageMessage(report: AnalysisReport): string {
  switch (report.stage) {
    case "analysed":
      return `Análise do PR #${report.prNumber}: ${report.findings.length} achados confirmados, ${report.refutedCount} derrubados na verificação.`;
    case "done":
      return `Análise do PR #${report.prNumber} concluída: ${report.summary}`;
    case "fleet_unavailable":
      return `A análise do PR #${report.prNumber} não rodou a frota de agentes: ${report.unavailableReason ?? report.summary}`;
  }
}

export async function recordAnalysisReport(cardId: string, input: AnalysisReportInput): Promise<AnalysisReport> {
  const card = await getCard(cardId);
  if (!card) throw new Error(`card não encontrado: ${cardId}`);
  const analysedPr = card.pushBranch === undefined ? undefined : card.prs?.[0];
  if (!analysedPr) throw new Error("este card não é um card de análise: passe em `card` o $VIBEHUB_CARD_ID do card que analisa a PR");
  const report: AnalysisReport = {
    cardId,
    prUrl: analysedPr.url,
    prNumber: analysedPr.number,
    analysedSha: input.headSha,
    stage: input.stage,
    summary: input.summary,
    dimensions: input.dimensions,
    findings: input.findings,
    refutedCount: input.refutedCount,
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    updatedAt: Date.now(),
  };
  await saveAnalysis(report);
  if (report.stage === "fleet_unavailable") await updateCard(cardId, { column: "done" });
  await recordMessage({
    cardId,
    type: "info",
    severity: report.stage === "fleet_unavailable" ? "warning" : "info",
    text: stageMessage(report),
    idempotencyKey: `analysis-${report.stage}-${report.analysedSha}`,
  });
  return report;
}
