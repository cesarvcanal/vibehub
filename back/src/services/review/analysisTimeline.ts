import type { DeliverReason, DeliverResult } from "../maestro/deliver.js";
import type { AnalysisReport, AnalysisStepInput, AnalysisTimelineEntry } from "./analysisModel.js";
import { requireOpenAnalysisCardPr } from "./analysisReport.js";
import { appendAnalysisTimeline } from "./analysisStore.js";

const DELIVERY_REASONS_THAT_WENT_THROUGH: readonly DeliverReason[] = ["pushed", "unauthorized", "merged", "merge_queued", "review_active"];

function assertStepFollowsReport(saved: AnalysisReport | undefined, step: AnalysisStepInput): AnalysisReport {
  if (!saved) throw new Error("grave antes o relatório analysed (passo 3): os passos da correção seguem os achados dele");
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
  await requireOpenAnalysisCardPr(cardId);
  return await appendAnalysisTimeline(cardId, "skipRepeated", (saved): AnalysisTimelineEntry => {
    const report = assertStepFollowsReport(saved, step);
    return { ...normalizeStep(step), cardId, analysedSha: report.analysedSha, at: Date.now() };
  });
}

export async function recordAnalysisDelivery(cardId: string, result: DeliverResult): Promise<void> {
  const stopped = !DELIVERY_REASONS_THAT_WENT_THROUGH.includes(result.reason);
  await appendAnalysisTimeline(cardId, "keepRepeated", (saved) => saved && {
    kind: "delivered",
    reason: result.reason,
    stopped,
    ...(result.prUrl ? { prUrl: result.prUrl } : {}),
    ...(stopped && result.output ? { output: result.output } : {}),
    cardId,
    analysedSha: saved.analysedSha,
    at: Date.now(),
  });
}
