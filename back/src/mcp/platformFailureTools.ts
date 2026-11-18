import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_FAILURE_KINDS, reportPlatformFailureFromAgent } from "../services/platformFailures/agentReport.js";
import { ok, fail } from "./toolResult.js";

export function registerPlatformFailureTools(server: McpServer): void {
  server.registerTool(
    "vibehub_report_platform_failure",
    {
      description:
        "Report a failure of VIBEHUB ITSELF (not of the project you are working on) so the owner can approve a fix. " +
        "Report only with concrete evidence, for: a vibehub_* tool that errored or answered something inconsistent " +
        "(tool_error); the runner/container failing (runner_failure); an instruction or tool description that " +
        "contradicts another rule or the real behaviour (inconsistent_instruction); slowness you MEASURED " +
        "(measured_slowness, with measuredMs). Do NOT report: something the user did (interrupting, stopping, " +
        "sending a message) that ended cleanly; errors of the project's own code; the expected 403 of a plain " +
        "git push in the runner; a logged-out Claude account. Never put data, names or code of the project's " +
        "business in the report — only how vibehub behaved. Nothing is fixed without the owner's approval. " +
        "`card` is YOUR OWN card id ($VIBEHUB_CARD_ID).",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        kind: z.enum(AGENT_FAILURE_KINDS).describe("tool_error | runner_failure | inconsistent_instruction | measured_slowness"),
        component: z.string().min(1).max(80).describe("the vibehub tool or part: e.g. vibehub_deliver, runner, preview"),
        symptom: z.string().min(1).max(200).describe("one line: what vibehub did wrong"),
        evidence: z.string().min(1).max(2000).describe("the error, tool input and answer, command output — no business data"),
        reproduction: z.string().max(1000).optional().describe("steps that reproduce it, if known"),
        hypothesis: z.string().max(500).optional().describe("your guess at the cause — it is labelled as a hypothesis"),
        measuredMs: z.number().int().positive().optional().describe("measured_slowness: the measured duration in ms"),
      },
    },
    async (input) => {
      try {
        return ok(await reportPlatformFailureFromAgent(input));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
