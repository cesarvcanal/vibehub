import type { AnalysisFinding, AnalysisReport, AnalysisTimelineEntry } from "@/api/types";
import type { AnalysisTimelineRow } from "@/features/review/types/analysisTimeline";

const SHORT_SHA_LENGTH = 7;

const DELIVERY_REASONS_WITH_TEXT = new Set(["pushed", "gate", "no_ci", "unauthorized", "merge_queued", "merged", "conflict", "review_active"]);

const DELIVERY_REASONS_THAT_WENT_THROUGH = new Set(["pushed", "unauthorized", "merged", "merge_queued", "review_active"]);

type RowText = Pick<AnalysisTimelineRow, "textKey" | "vars" | "detail">;

function deliveryText(reason: string, output: string | undefined): RowText {
  const textKey = DELIVERY_REASONS_WITH_TEXT.has(reason) ? `analysis.timeline.delivered.${reason}` : "analysis.timeline.delivered.unknown";
  const vars = { reason };
  const showsOutput = output !== undefined && !DELIVERY_REASONS_THAT_WENT_THROUGH.has(reason);
  return showsOutput ? { textKey, vars, detail: output } : { textKey, vars };
}

function needsAttention(entry: AnalysisTimelineEntry): boolean {
  if (entry.kind === "delivered") return !DELIVERY_REASONS_THAT_WENT_THROUGH.has(entry.reason);
  return entry.kind === "recheck" && entry.outcome === "found";
}

function rowText(entry: AnalysisTimelineEntry, findingTitle: (findingId: string) => string): RowText {
  switch (entry.kind) {
    case "fixing":
      return { textKey: "analysis.timeline.fixing", vars: { id: entry.findingId, title: findingTitle(entry.findingId) } };
    case "fixed":
      return {
        textKey: "analysis.timeline.fixed",
        vars: { id: entry.findingId, title: findingTitle(entry.findingId), commit: entry.commit.slice(0, SHORT_SHA_LENGTH) },
      };
    case "recheck":
      return entry.outcome === "clean"
        ? { textKey: "analysis.timeline.recheckClean", vars: {} }
        : { textKey: "analysis.timeline.recheckFound", vars: {}, ...(entry.note ? { detail: entry.note } : {}) };
    case "delivered":
      return deliveryText(entry.reason, entry.output);
    case "report":
      return entry.stage === "done"
        ? { textKey: "analysis.timeline.done", vars: { fixed: entry.fixed, decided: entry.decided, open: entry.open } }
        : { textKey: `analysis.timeline.report.${entry.stage}`, vars: { n: entry.open } };
  }
}

function findCurrentFixingIndex(entries: AnalysisTimelineEntry[]): number {
  const lastFixingIndex = entries.findLastIndex((entry) => entry.kind === "fixing");
  const lastFixing = entries[lastFixingIndex];
  if (lastFixing?.kind !== "fixing") return -1;
  const fixedAfter = entries.slice(lastFixingIndex + 1).some((entry) => entry.kind === "fixed" && entry.findingId === lastFixing.findingId);
  return fixedAfter ? -1 : lastFixingIndex;
}

export function analysisTimelineRows(
  entries: AnalysisTimelineEntry[], findings: AnalysisFinding[], opts: { cardWorking: boolean },
): AnalysisTimelineRow[] {
  const titleById = new Map(findings.map((finding) => [finding.id, finding.title]));
  const findingTitle = (findingId: string) => titleById.get(findingId) ?? "";
  const currentIndex = opts.cardWorking ? findCurrentFixingIndex(entries) : -1;
  return entries.map((entry, index) => ({
    id: `${entry.at}-${index}`, at: entry.at, kind: entry.kind, current: index === currentIndex, needsAttention: needsAttention(entry),
    ...rowText(entry, findingTitle),
  }));
}

export function hasFixingStarted(rows: AnalysisTimelineRow[]): boolean {
  return rows.some((row) => row.kind !== "report" || row.textKey === "analysis.timeline.done");
}

export function openQuestionFindings(report: Pick<AnalysisReport, "stage" | "findings">): AnalysisFinding[] {
  if (report.stage !== "done") return [];
  return report.findings.filter((finding) => finding.severity === "question" && finding.status === "open");
}
