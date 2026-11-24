import type { DeliverResult } from "../maestro/deliver.js";
import type { AnalysisReport, AnalysisStepInput, AnalysisTimelineEntry } from "./analysisModel.js";
import { findOpenAnalysisCardPr } from "./analysisReport.js";
import { appendAnalysisTimeline } from "./analysisStore.js";

function assertStepFollowsReport(saved: AnalysisReport | undefined, step: AnalysisStepInput): AnalysisReport {
  if (!saved) throw new Error("grave antes o relatório analysed (passo 3): os passos da correção seguem os achados dele");
  if (saved.stage === "fleet_unavailable") throw new Error("a frota não rodou neste card: não há correção a registrar, pare");
  if (step.kind === "recheck") return saved;
  const knownIds = saved.findings.map((finding) => finding.id);
  if (!knownIds.includes(step.findingId)) {
    throw new Error(`o achado ${step.findingId} não está no relatório gravado; os achados são: ${knownIds.join(", ") || "nenhum"}`);
  }
  return saved;
}

function normalizeStep(step: AnalysisStepInput): AnalysisStepInput {
  return step.kind === "fixed" ? { ...step, commit: step.commit.toLowerCase() } : step;
}

export async function recordAnalysisStep(cardId: string, step: AnalysisStepInput): Promise<AnalysisTimelineEntry> {
  await findOpenAnalysisCardPr(cardId);
  const entry = await appendAnalysisTimeline(cardId, (saved) => {
    const report = assertStepFollowsReport(saved, step);
    return { ...normalizeStep(step), cardId, analysedSha: report.analysedSha, at: Date.now() };
  });
  if (!entry) throw new Error(`a linha do tempo do card ${cardId} não gravou o passo`);
  return entry;
}

export async function recordAnalysisDelivery(cardId: string, result: DeliverResult): Promise<void> {
  await appendAnalysisTimeline(cardId, (saved) => saved && {
    kind: "delivered",
    reason: result.reason,
    ...(result.prUrl ? { prUrl: result.prUrl } : {}),
    ...(result.output ? { output: result.output } : {}),
    cardId,
    analysedSha: saved.analysedSha,
    at: Date.now(),
  });
}
