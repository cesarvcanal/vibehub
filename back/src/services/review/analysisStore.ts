import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import type { AnalysisMergeGate, AnalysisMergeRefusal, AnalysisReport, AnalysisTimelineEntry } from "./analysisModel.js";

interface AnalysesDoc {
  analyses: AnalysisReport[];
  mergeRefusals: AnalysisMergeRefusal[];
  mergeGates: AnalysisMergeGate[];
  timeline: AnalysisTimelineEntry[];
}

const store = new JsonStore<AnalysesDoc>(
  dataPath("analyses.json"),
  () => ({ analyses: [], mergeRefusals: [], mergeGates: [], timeline: [] }),
  (raw) => {
    const doc = (raw ?? {}) as Partial<AnalysesDoc>;
    return {
      analyses: Array.isArray(doc.analyses) ? doc.analyses : [],
      mergeRefusals: Array.isArray(doc.mergeRefusals) ? doc.mergeRefusals : [],
      mergeGates: Array.isArray(doc.mergeGates) ? doc.mergeGates : [],
      timeline: Array.isArray(doc.timeline) ? doc.timeline : [],
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
  timelineEntry: AnalysisTimelineEntry,
): Promise<void> {
  await store.mutate((doc) => {
    assertCanReplace(doc.analyses.find((analysis) => analysis.cardId === report.cardId));
    const otherCardsAnalyses = doc.analyses.filter((analysis) => analysis.cardId !== report.cardId);
    doc.analyses = [...otherCardsAnalyses, structuredClone(report)];
    appendUnlessRepeated(doc, timelineEntry);
  });
}

function withoutInstant({ at: _at, ...event }: AnalysisTimelineEntry): string {
  return JSON.stringify(event);
}

function appendUnlessRepeated(doc: AnalysesDoc, entry: AnalysisTimelineEntry): void {
  const lastOfCard = doc.timeline.findLast((saved) => saved.cardId === entry.cardId);
  if (lastOfCard && withoutInstant(lastOfCard) === withoutInstant(entry)) return;
  doc.timeline.push(structuredClone(entry));
}

export async function listAnalysisTimeline(cardId: string): Promise<AnalysisTimelineEntry[]> {
  return structuredClone((await store.load()).timeline.filter((entry) => entry.cardId === cardId));
}

export async function appendAnalysisTimeline<Entry extends AnalysisTimelineEntry | undefined>(
  cardId: string,
  buildEntry: (saved: AnalysisReport | undefined) => Entry,
): Promise<Entry> {
  return await store.mutate((doc) => {
    const entry = buildEntry(doc.analyses.find((analysis) => analysis.cardId === cardId));
    if (entry) appendUnlessRepeated(doc, entry);
    return entry;
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

export async function getAnalysisMergeGate(cardId: string): Promise<AnalysisMergeGate | undefined> {
  const found = (await store.load()).mergeGates.find((gate) => gate.cardId === cardId);
  return found && structuredClone(found);
}

export async function saveAnalysisMergeGate(gate: AnalysisMergeGate): Promise<boolean> {
  return await store.mutate((doc) => {
    const analysis = doc.analyses.find((saved) => saved.cardId === gate.cardId);
    if (analysis?.analysedSha !== gate.analysedSha) return false;
    doc.mergeGates = [...doc.mergeGates.filter((saved) => saved.cardId !== gate.cardId), structuredClone(gate)];
    return true;
  });
}
