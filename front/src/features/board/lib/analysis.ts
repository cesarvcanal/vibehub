import type { BadgeTone } from "@/components/ui/badge";
import type { AnalysisVerdict, CardAnalysisResponse } from "@/api/types";
import type { CardStateKind } from "@/features/board/lib/board";

export const cardAnalysisKey = (cardId: string) => ["card-analysis", cardId] as const;
export const cardAnalysisConversationKey = (cardId: string) => ["card-analysis-conversation", cardId] as const;

const ANALYSIS_REPORT_TOOL = "vibehub_analysis_report";

export interface AnalysisPill {
  key: string;
  vars?: Record<string, number>;
  tone: BadgeTone;
  icon?: "merging";
}

export type AnalysisQueryState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "success"; data: CardAnalysisResponse };

export type AnalysisProgress = "working" | "workingAfterReport" | "needsMe" | "stopped";

type CardActivity = "working" | "needsMe" | "stopped" | "filedByPerson";

const CARD_ACTIVITY: Record<CardStateKind, CardActivity> = {
  working: "working",
  needs_me: "needsMe",
  blocked: "stopped",
  ready: "stopped",
  your_turn: "stopped",
  idle: "stopped",
  hibernated: "stopped",
  paused: "filedByPerson",
  done: "filedByPerson",
};

export function analysisProgress(verdict: AnalysisVerdict, cardState: CardStateKind): AnalysisProgress | null {
  const activity = CARD_ACTIVITY[cardState];
  if (activity === "filedByPerson") return null;
  if (verdict === "pending") return activity;
  if (activity === "working") return "workingAfterReport";
  if (activity === "needsMe") return "needsMe";
  return null;
}

export function analysisPill(analysisQuery: AnalysisQueryState, opts: { cardWorking: boolean }): AnalysisPill {
  if (analysisQuery.status === "pending") return { key: "common.loading", tone: "muted" };
  if (analysisQuery.status === "error") return { key: "analysis.pill.readFailed", tone: "critical" };
  const read = analysisQuery.data;
  if (!read.analysis) {
    return opts.cardWorking ? { key: "analysis.pill.running", tone: "info" } : { key: "analysis.pill.noReport", tone: "warn" };
  }
  const { analysis, verdict } = read;
  if (analysis.stage === "fleet_unavailable") return { key: "analysis.pill.fleetUnavailable", tone: "critical" };
  if (analysis.stage === "analysed") return { key: "analysis.pill.fixing", vars: { n: analysis.findings.length }, tone: "info" };
  if (verdict === "apt" && read.merging) return { key: "analysis.pill.merging", tone: "ok", icon: "merging" };
  if (verdict === "apt" && read.lastMergeRefusal) return { key: "analysis.pill.mergeRefused", tone: "critical" };
  if (verdict === "apt") {
    const fixedCount = analysis.findings.filter((finding) => finding.status === "fixed").length;
    return { key: "analysis.pill.apt", vars: { n: fixedCount }, tone: "ok" };
  }
  const openFindings = analysis.findings.filter((finding) => finding.status === "open");
  const openBlockingCount = openFindings.filter((finding) => finding.severity === "blocking").length;
  if (openBlockingCount > 0) return { key: "analysis.pill.notApt", vars: { n: openBlockingCount }, tone: "critical" };
  const openQuestionCount = openFindings.filter((finding) => finding.severity === "question").length;
  if (openQuestionCount > 0) return { key: "analysis.pill.notAptQuestions", vars: { n: openQuestionCount }, tone: "critical" };
  return { key: "analysis.pill.notAptUnverified", vars: { n: read.uncheckedDimensions.length }, tone: "critical" };
}

export function isAnalysisReportTool(toolName: string): boolean {
  return toolName.endsWith(ANALYSIS_REPORT_TOOL);
}
