import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config/env.js";
import { hostExecutor, shQuote } from "../../runtime/host.js";

export const PR_ANALYSIS_WORKFLOW_PATH = "/root/.vibehub-workflows/pr-analysis.js";

const WORKFLOW_SOURCE_FILE = join(dirname(fileURLToPath(import.meta.url)), "prAnalysis.workflow.js");
const WORKFLOW_SOURCE_DELIM = "VIBEHUB_PR_ANALYSIS_WORKFLOW_SRC";
const WORKFLOW_PLANT_DELIM = "VIBEHUB_PR_ANALYSIS_WORKFLOW_PLANT";

const workflowSourceCache: { source?: string } = {};

export function readPrAnalysisWorkflowSource(): string {
  workflowSourceCache.source ??= readFileSync(WORKFLOW_SOURCE_FILE, "utf8");
  return workflowSourceCache.source;
}

export function buildPlantPrAnalysisWorkflowScript(containerName: string, source: string): string {
  const inner = [
    "set -e",
    "umask 077",
    `mkdir -p ${shQuote(dirname(PR_ANALYSIS_WORKFLOW_PATH))}`,
    `tmp="$(mktemp ${shQuote(`${PR_ANALYSIS_WORKFLOW_PATH}.XXXXXX`)})"`,
    `cat > "$tmp" <<'${WORKFLOW_SOURCE_DELIM}'`,
    source,
    WORKFLOW_SOURCE_DELIM,
    `mv -f "$tmp" ${shQuote(PR_ANALYSIS_WORKFLOW_PATH)}`,
  ].join("\n");
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${WORKFLOW_PLANT_DELIM}'`,
    inner,
    WORKFLOW_PLANT_DELIM,
  ].join("\n");
}

export async function plantPrAnalysisWorkflow(): Promise<void> {
  await hostExecutor().runScript(buildPlantPrAnalysisWorkflowScript(config.runner.container, readPrAnalysisWorkflowSource()));
}
