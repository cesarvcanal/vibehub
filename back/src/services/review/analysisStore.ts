import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import type { AnalysisReport } from "./analysisModel.js";

interface AnalysesDoc {
  analyses: AnalysisReport[];
}

const store = new JsonStore<AnalysesDoc>(
  dataPath("analyses.json"),
  () => ({ analyses: [] }),
  (raw) => {
    const doc = (raw ?? {}) as Partial<AnalysesDoc>;
    return { analyses: Array.isArray(doc.analyses) ? doc.analyses : [] };
  },
);

export async function getAnalysis(cardId: string): Promise<AnalysisReport | undefined> {
  const found = (await store.load()).analyses.find((analysis) => analysis.cardId === cardId);
  return found && structuredClone(found);
}

export async function saveAnalysis(report: AnalysisReport): Promise<void> {
  await store.mutate((doc) => {
    const otherCardsAnalyses = doc.analyses.filter((analysis) => analysis.cardId !== report.cardId);
    doc.analyses = [...otherCardsAnalyses, structuredClone(report)];
  });
}
