import type { Finding, FindingSeverity } from "./model.js";

export const ANALYSIS_DIMENSIONS = ["correctness", "security", "performance", "contracts", "tests", "repoRules"] as const;
export type AnalysisDimension = (typeof ANALYSIS_DIMENSIONS)[number];

export const ANALYSIS_STAGES = ["analysed", "done", "fleet_unavailable"] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

export const ANALYSIS_SEVERITIES = ["blocking", "improvement", "suggestion", "question"] as const satisfies readonly FindingSeverity[];
export type AnalysisSeverity = (typeof ANALYSIS_SEVERITIES)[number];

export const DIMENSION_RUN_STATUSES = ["ran", "skipped", "not_run"] as const;

export type AnalysisFinding = Pick<Finding, "id" | "title" | "problem" | "file" | "line" | "proof" | "fix"> & {
  severity: AnalysisSeverity;
  dimension: AnalysisDimension;
} & ({ status: "open" } | { status: "fixed"; commit: string });

export interface DimensionRun {
  key: AnalysisDimension;
  status: (typeof DIMENSION_RUN_STATUSES)[number];
  reason?: string;
  unverifiedCount?: number;
}

export interface AnalysisReport {
  cardId: string;
  prUrl: string;
  prNumber: number;
  analysedSha: string;
  stage: AnalysisStage;
  summary: string;
  dimensions: DimensionRun[];
  findings: AnalysisFinding[];
  refutedCount: number;
  unavailableReason?: string;
  updatedAt: number;
}

export type DimensionHealth = "ok" | "attention" | "problem" | "not_run" | "skipped";

function isDimensionAccountedFor(run: DimensionRun | undefined): run is DimensionRun {
  return run !== undefined && run.status !== "not_run";
}

function hasUnverifiedFindings(run: DimensionRun): boolean {
  return (run.unverifiedCount ?? 0) > 0;
}

export function dimensionHealth(report: AnalysisReport, key: AnalysisDimension): DimensionHealth {
  const run = report.dimensions.find((dimension) => dimension.key === key);
  const openFindings = report.findings.filter((finding) => finding.dimension === key && finding.status === "open");
  if (openFindings.some((finding) => finding.severity === "blocking")) return "problem";
  if (!isDimensionAccountedFor(run)) return "not_run";
  if (run.status === "skipped") return "skipped";
  const hasOpenImprovementOrQuestion = openFindings.some((finding) => finding.severity === "question" || finding.severity === "improvement");
  return hasOpenImprovementOrQuestion || hasUnverifiedFindings(run) ? "attention" : "ok";
}

export function uncheckedDimensions(report: AnalysisReport): AnalysisDimension[] {
  return ANALYSIS_DIMENSIONS.filter((key) => {
    const run = report.dimensions.find((dimension) => dimension.key === key);
    return !isDimensionAccountedFor(run) || hasUnverifiedFindings(run);
  });
}

export type AnalysisVerdict = "apt" | "not_apt" | "pending";

export function analysisVerdict(report: AnalysisReport): AnalysisVerdict {
  if (report.stage === "fleet_unavailable") return "not_apt";
  if (report.stage !== "done") return "pending";
  const openFindings = report.findings.filter((finding) => finding.status === "open");
  const hasOpenBlocking = openFindings.some((finding) => finding.severity === "blocking");
  const hasOpenQuestion = openFindings.some((finding) => finding.severity === "question");
  return hasOpenBlocking || hasOpenQuestion || uncheckedDimensions(report).length > 0 ? "not_apt" : "apt";
}
