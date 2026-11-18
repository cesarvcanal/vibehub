import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PR_ANALYSIS_WORKFLOW_PATH = "/root/.vibehub-sdk/workflows/pr-analysis.js";

const WORKFLOW_SOURCE_FILE = join(dirname(fileURLToPath(import.meta.url)), "prAnalysis.workflow.js");

export function prAnalysisWorkflowSource(): string {
  return readFileSync(WORKFLOW_SOURCE_FILE, "utf8");
}
