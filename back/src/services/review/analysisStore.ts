import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import type { AnalysisMergeRefusal, AnalysisReport } from "./analysisModel.js";

interface AnalysesDoc {
  analyses: AnalysisReport[];
  mergeRefusals: AnalysisMergeRefusal[];
}

const store = new JsonStore<AnalysesDoc>(
  dataPath("analyses.json"),
  () => ({ analyses: [], mergeRefusals: [] }),
  (raw) => {
    const doc = (raw ?? {}) as Partial<AnalysesDoc>;
    return {
      analyses: Array.isArray(doc.analyses) ? doc.analyses : [],
      mergeRefusals: Array.isArray(doc.mergeRefusals) ? doc.mergeRefusals : [],
    };
  },
);

export async function getAnalysis(cardId: string): Promise<AnalysisReport | undefined> {
  const found = (await store.load()).analyses.find((analysis) => analysis.cardId === cardId);
  return found && structuredClone(found);
}

export async function saveAnalysis(
  report: AnalysisReport,
  assertCanReplace: (saved: AnalysisReport | undefined) => void,
): Promise<void> {
  await store.mutate((doc) => {
    assertCanReplace(doc.analyses.find((analysis) => analysis.cardId === report.cardId));
    const otherCardsAnalyses = doc.analyses.filter((analysis) => analysis.cardId !== report.cardId);
    doc.analyses = [...otherCardsAnalyses, structuredClone(report)];
  });
}

export async function getAnalysisMergeRefusal(cardId: string): Promise<AnalysisMergeRefusal | undefined> {
  const found = (await store.load()).mergeRefusals.find((refusal) => refusal.cardId === cardId);
  return found && structuredClone(found);
}

export async function saveAnalysisMergeRefusal(cardId: string, refusal: AnalysisMergeRefusal | undefined): Promise<void> {
  await store.mutate((doc) => {
    const otherCardsRefusals = doc.mergeRefusals.filter((saved) => saved.cardId !== cardId);
    doc.mergeRefusals = refusal ? [...otherCardsRefusals, structuredClone(refusal)] : otherCardsRefusals;
  });
}
