import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_FAILURE_KINDS, reportPlatformFailureFromAgent } from "../services/platformFailures/agentReport.js";
import { reportFailureInvestigation } from "../services/platformFailures/investigation.js";
import { INVESTIGATION_VERDICTS } from "../services/platformFailures/types.js";
import { ok, fail } from "./toolResult.js";

export function registerPlatformFailureTools(server: McpServer): void {
  server.registerTool(
    "vibehub_report_platform_failure",
    {
      description:
        "Report a failure or an INCONSISTENCY of VIBEHUB ITSELF (not of the project you are working on) so the owner can " +
        "approve a fix. Investigate first: check the source of truth (the vibehub route, file or state behind what is " +
        "shown) and report what you checked. Kinds: a vibehub_* tool that errored or answered something inconsistent " +
        "(tool_error); the runner/container failing (runner_failure); an instruction or tool description that " +
        "contradicts another rule or the real behaviour (inconsistent_instruction); slowness you MEASURED " +
        "(measured_slowness, with measuredMs); something vibehub SHOWS that does not match its source — a stale number, " +
        "a swapped state, a screen that contradicts what vibehub promises (inconsistency); the USER describing in the " +
        "chat a problem of vibehub itself (user_report) — always report it, even when you could not reproduce it, with " +
        "what you could not confirm in `hypothesis`. Do NOT report: something the user did (interrupting, stopping, " +
        "sending a message) that ended cleanly; errors of the project's own code; a push the person's GitHub account " +
        "cannot make; a logged-out Claude account. Never put data, names or code of the project's " +
        "business in the report — only how vibehub behaved. The report shows up as a notice inside the affected card; " +
        "nothing is fixed without the owner's approval. Answer: recorded=true, or recorded=false with reason " +
        "`dismissed` (the owner already judged this as expected behaviour) or `cap` (too many open failures). " +
        "Tell the user, in one line, what this answered, never promise a fix, and carry on with your task. " +
        "`card` is YOUR OWN card id ($VIBEHUB_CARD_ID).",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        kind: z.enum(AGENT_FAILURE_KINDS).describe(
          "tool_error | runner_failure | inconsistent_instruction | measured_slowness | inconsistency | user_report",
        ),
        component: z.string().min(1).max(80).describe("the vibehub tool or part: e.g. vibehub_deliver, runner, preview"),
        symptom: z.string().min(1).max(200).describe("one line: what vibehub did wrong"),
        evidence: z.string().min(1).max(2000).describe("the error, tool input and answer, command output — no business data"),
        explanation: z.string().min(1).max(600).describe(
          "for the person using vibehub, who is not technical, in the language of the conversation: what happened and " +
          "what it means for them — no file, function, stack trace or id, and no \"this card\" (the same text shows on " +
          "every card the failure reaches)",
        ),
        reproduction: z.string().max(1000).optional().describe("steps that reproduce it, if known"),
        hypothesis: z.string().max(500).optional().describe("your guess at the cause — it is labelled as a hypothesis"),
        measuredMs: z.number().int().positive().optional().describe("measured_slowness: the measured duration in ms"),
      },
    },
    async (input) => {
      try {
        return ok(await reportPlatformFailureFromAgent(input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "vibehub_failure_investigation_report",
    {
      description:
        "PLATFORM-FAILURE INVESTIGATION: record the conclusion of the failure THIS card investigates, which the owner " +
        "reads in the \"Falhas do vibehub\" panel as an analysis. Only the investigation card may call it (`card` = YOUR " +
        "OWN $VIBEHUB_CARD_ID). Call it once you know the answer and BEFORE concluding the card, with or without a PR; " +
        "calling again replaces the previous conclusion. Write for the owner, who did not read the code, in the language " +
        "of the conversation: no file, function or stack trace, and nothing of the business of other projects. " +
        "Refused when this card is not investigating a platform failure. Returns the failure with the stored report.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        verdict: z.enum(INVESTIGATION_VERDICTS).describe(
          "vibehub_bug = a defect of vibehub, reproduced | not_a_bug = expected behaviour, a project or provider problem | " +
          "inconclusive = the evidence does not decide",
        ),
        conclusion: z.string().min(1).max(600).describe("one or two sentences: what the investigation found"),
        howItHappened: z.string().min(1).max(1200).describe("the sequence that led to the error: who did what, what vibehub did, where it went wrong"),
        cause: z.string().min(1).max(800).describe("why it happened, proven; what is not proven is said as likely"),
        resolution: z.string().min(1).max(800).describe("what fixes it: the PR opened here, or what the owner or the project must change"),
        pendingDecision: z.string().min(1).max(600).optional().describe("a decision only the owner can make, as a question; absent when there is none"),
      },
    },
    async ({ card, ...report }) => {
      try {
        return ok(await reportFailureInvestigation(card, report));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
