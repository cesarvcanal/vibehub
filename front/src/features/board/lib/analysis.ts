import type { BadgeTone } from "@/components/ui/badge";
import { ANALYSIS_DIMENSIONS, type AnalysisDimension, type CardAnalysisResponse } from "@/api/types";
import type { SdkRow } from "@/features/board/lib/sdkChat";

export const cardAnalysisKey = (cardId: string) => ["card-analysis", cardId] as const;

const ANALYSIS_REPORT_TOOL = "vibehub_analysis_report";

export interface AnalysisPill {
  key: string;
  vars?: Record<string, number>;
  tone: BadgeTone;
}

export type AnalysisQueryState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "success"; data: CardAnalysisResponse };

export function analysisPill(analysisQuery: AnalysisQueryState, opts: { cardWorking: boolean }): AnalysisPill {
  if (analysisQuery.status === "pending") return { key: "common.loading", tone: "muted" };
  if (analysisQuery.status === "error") return { key: "analysis.pill.readFailed", tone: "critical" };
  const read = analysisQuery.data;
  if (!read.analysis) {
    return opts.cardWorking ? { key: "analysis.pill.running", tone: "info" } : { key: "analysis.pill.noReport", tone: "warn" };
  }
  const { analysis, verdict, health } = read;
  if (analysis.stage === "fleet_unavailable") return { key: "analysis.pill.fleetUnavailable", tone: "critical" };
  if (analysis.stage === "analysed") return { key: "analysis.pill.fixing", vars: { n: analysis.findings.length }, tone: "info" };
  if (verdict === "apt") {
    const fixedCount = analysis.findings.filter((finding) => finding.status === "fixed").length;
    return { key: "analysis.pill.apt", vars: { n: fixedCount }, tone: "ok" };
  }
  const openBlockingCount = analysis.findings.filter((finding) => finding.severity === "blocking" && finding.status === "open").length;
  if (openBlockingCount > 0) return { key: "analysis.pill.notApt", vars: { n: openBlockingCount }, tone: "critical" };
  const hasUnverifiedFindings = (key: AnalysisDimension) => (analysis.dimensions.find((dimension) => dimension.key === key)?.unverifiedCount ?? 0) > 0;
  const dimensionsNotFullyChecked = ANALYSIS_DIMENSIONS.filter((key) => health[key] === "not_run" || hasUnverifiedFindings(key));
  return { key: "analysis.pill.notAptUnverified", vars: { n: dimensionsNotFullyChecked.length }, tone: "critical" };
}

export function countFinishedAnalysisReports(rows: SdkRow[]): number {
  const finishedReportCalls = rows.filter(
    (row) => row.kind === "tool" && row.name.endsWith(ANALYSIS_REPORT_TOOL) && row.result !== undefined && !row.result.isError,
  );
  return finishedReportCalls.length;
}
