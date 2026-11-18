import { getCard, updateCard } from "../board/registry.js";
import { recordMessage } from "../events/cardEvents.js";
import type { AnalysisDimension, AnalysisFinding, AnalysisReport, AnalysisStage, DimensionRun } from "./analysisModel.js";
import { getAnalysis, saveAnalysis } from "./analysisStore.js";

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

function findDroppedFromSavedReport(saved: AnalysisReport, input: AnalysisReportInput): string[] {
  const droppedFindingIds = saved.findings
    .filter((savedFinding) => !input.findings.some((finding) => finding.id === savedFinding.id))
    .map((savedFinding) => `achado ${savedFinding.id}`);
  const unverifiedCountOf = (dimensions: DimensionRun[], key: AnalysisDimension) =>
    dimensions.find((dimension) => dimension.key === key)?.unverifiedCount ?? 0;
  const droppedUnverified = saved.dimensions
    .filter((savedDimension) => unverifiedCountOf(input.dimensions, savedDimension.key) < (savedDimension.unverifiedCount ?? 0))
    .map((savedDimension) => `unverifiedCount de ${savedDimension.key}`);
  return [...droppedFindingIds, ...droppedUnverified];
}

export async function recordAnalysisReport(cardId: string, input: AnalysisReportInput): Promise<AnalysisReport> {
  const card = await getCard(cardId);
  if (!card) throw new Error(`card não encontrado: ${cardId}`);
  const analysedPr = card.pushBranch === undefined ? undefined : card.prs?.[0];
  if (!analysedPr) throw new Error("este card não é um card de análise: passe em `card` o $VIBEHUB_CARD_ID do card que analisa a PR");
  if (card.column === "done") throw new Error("este card de análise já foi concluído: pare; um novo pedido da PR abre outro card");
  const savedReport = input.stage === "done" ? await getAnalysis(cardId) : undefined;
  if (savedReport) {
    const droppedFromSaved = findDroppedFromSavedReport(savedReport, input);
    if (droppedFromSaved.length > 0) {
      throw new Error(
        `o relatório done perde o que o relatório ${savedReport.stage} gravou: ${droppedFromSaved.join(", ")}; ` +
          "reenvie as mesmas dimensions e os mesmos findings, mudando só status e commit",
      );
    }
  }
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
