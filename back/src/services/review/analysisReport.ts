import { getCard, openAnalysisCards, updateCard, type Card } from "../board/registry.js";
import { recordMessage } from "../events/cardEvents.js";
import { ANALYSIS_DIMENSIONS, type AnalysisFinding, type AnalysisReport, type AnalysisStage, type DimensionRun } from "./analysisModel.js";
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

function findChangedFromSavedReport(saved: AnalysisReport, input: AnalysisReportInput): string[] {
  const changedFindings = saved.findings
    .filter((savedFinding) => {
      const resentFinding = input.findings.find((finding) => finding.id === savedFinding.id);
      return resentFinding?.severity !== savedFinding.severity || resentFinding.dimension !== savedFinding.dimension;
    })
    .map((savedFinding) => `achado ${savedFinding.id}`);
  const changedDimensions = ANALYSIS_DIMENSIONS
    .filter((key) => {
      const savedDimension = saved.dimensions.find((dimension) => dimension.key === key);
      const resentDimension = input.dimensions.find((dimension) => dimension.key === key);
      return resentDimension?.status !== savedDimension?.status || resentDimension?.unverifiedCount !== savedDimension?.unverifiedCount;
    })
    .map((key) => `dimensão ${key}`);
  return [...changedFindings, ...changedDimensions];
}

export async function findActiveAnalysisCard(cards: Card[], prUrl: string): Promise<Card | undefined> {
  for (const openCard of openAnalysisCards(cards, prUrl)) {
    const fleetDidNotRun = (await getAnalysis(openCard.id))?.stage === "fleet_unavailable";
    if (!fleetDidNotRun) return openCard;
  }
  return undefined;
}

export async function recordAnalysisReport(cardId: string, input: AnalysisReportInput): Promise<AnalysisReport> {
  const card = await getCard(cardId);
  if (!card) throw new Error(`card não encontrado: ${cardId}`);
  const analysedPr = card.pushBranch === undefined ? undefined : card.prs?.[0];
  if (!analysedPr) throw new Error("este card não é um card de análise: passe em `card` o $VIBEHUB_CARD_ID do card que analisa a PR");
  if (card.column === "done") throw new Error("este card de análise já foi concluído: pare; um novo pedido da PR abre outro card");
  const savedReport = await getAnalysis(cardId);
  const headSha = input.headSha.toLowerCase();
  if (savedReport?.stage === "fleet_unavailable") {
    await updateCard(cardId, { column: "done" });
    throw new Error("a frota não rodou neste card: pare; um novo pedido da PR abre outro card");
  }
  if (savedReport?.stage === "done" && input.stage !== "done") {
    throw new Error("o relatório done já está gravado neste card: a análise está concluída, pare");
  }
  if (input.stage === "fleet_unavailable" && savedReport) {
    throw new Error("a frota já rodou e o relatório analysed está gravado: siga do passo 4, sem fleet_unavailable");
  }
  if (input.stage === "analysed" && savedReport) {
    throw new Error("o relatório analysed já foi gravado neste card: siga do passo 4 com os findings dele");
  }
  if (input.stage === "done") {
    if (!savedReport) throw new Error("grave antes o relatório analysed (passo 3): o done só confirma o que a frota achou");
    if (headSha !== savedReport.analysedSha) {
      throw new Error(`o done leva o mesmo headSha do analysed (${savedReport.analysedSha}, o sha do passo 1), não o das correções`);
    }
    const changedFromSaved = findChangedFromSavedReport(savedReport, input);
    if (changedFromSaved.length > 0) {
      throw new Error(
        `o relatório done muda o que o relatório ${savedReport.stage} gravou: ${changedFromSaved.join(", ")}; ` +
          "reenvie as mesmas dimensions e os mesmos findings (mesma severity e dimensão), mudando só status e commit",
      );
    }
  }
  const report: AnalysisReport = {
    cardId,
    prUrl: analysedPr.url,
    prNumber: analysedPr.number,
    analysedSha: headSha,
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
