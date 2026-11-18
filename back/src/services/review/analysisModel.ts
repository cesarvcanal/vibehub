import type { Finding, FindingSeverity } from "./model.js";

export type AnalysisDimension = "correctness" | "security" | "performance" | "contracts" | "tests" | "repoRules";
export const ANALYSIS_DIMENSIONS: readonly AnalysisDimension[] = ["correctness", "security", "performance", "contracts", "tests", "repoRules"];

export type AnalysisStage = "analysed" | "done" | "fleet_unavailable";
export const ANALYSIS_STAGES: readonly AnalysisStage[] = ["analysed", "done", "fleet_unavailable"];

export type AnalysisSeverity = Exclude<FindingSeverity, "refuted">;

export type AnalysisFinding = Pick<Finding, "id" | "title" | "problem" | "file" | "line" | "proof" | "fix" | "commit"> & {
  severity: AnalysisSeverity;
  dimension: AnalysisDimension;
  status: "open" | "fixed";
};

export interface DimensionRun {
  key: AnalysisDimension;
  status: "ran" | "skipped" | "not_run";
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

export function dimensionHealth(report: AnalysisReport, key: AnalysisDimension): DimensionHealth {
  const run = report.dimensions.find((dimension) => dimension.key === key);
  const openFindings = report.findings.filter((finding) => finding.dimension === key && finding.status === "open");
  if (openFindings.some((finding) => finding.severity === "blocking")) return "problem";
  if (!run || run.status === "not_run") return "not_run";
  if (run.status === "skipped") return "skipped";
  const hasOpenImprovementOrQuestion = openFindings.some((finding) => finding.severity === "question" || finding.severity === "improvement");
  const hasUnverifiedFindings = (run.unverifiedCount ?? 0) > 0;
  return hasOpenImprovementOrQuestion || hasUnverifiedFindings ? "attention" : "ok";
}

export type AnalysisVerdict = "apt" | "not_apt" | "pending";

export function analysisVerdict(report: AnalysisReport): AnalysisVerdict {
  if (report.stage === "fleet_unavailable") return "not_apt";
  if (report.stage !== "done") return "pending";
  const healthByDimension = ANALYSIS_DIMENSIONS.map((key) => dimensionHealth(report, key));
  const blocked = healthByDimension.some((health) => health === "problem" || health === "not_run");
  const hasUnverifiedFindings = report.dimensions.some((dimension) => (dimension.unverifiedCount ?? 0) > 0);
  return blocked || hasUnverifiedFindings ? "not_apt" : "apt";
}
