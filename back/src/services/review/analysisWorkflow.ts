import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PR_ANALYSIS_WORKFLOW_PATH = "/root/.vibehub-sdk/workflows/pr-analysis.js";

const WORKFLOW_SOURCE_FILE = join(dirname(fileURLToPath(import.meta.url)), "prAnalysis.workflow.js");

const workflowSourceCache: { source?: string } = {};

export function prAnalysisWorkflowSource(): string {
  workflowSourceCache.source ??= readFileSync(WORKFLOW_SOURCE_FILE, "utf8");
  return workflowSourceCache.source;
}
