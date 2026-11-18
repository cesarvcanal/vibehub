import { redactSecrets } from "../../utils/redactSecrets.js";
import * as registry from "../board/registry.js";
import { getSettings } from "../settings/settings.js";
import { PlatformFailureStateError, recordPlatformFailure } from "./platformFailures.js";

export const AGENT_FAILURE_KINDS = ["tool_error", "runner_failure", "inconsistent_instruction", "measured_slowness"] as const;
export type AgentFailureKind = (typeof AGENT_FAILURE_KINDS)[number];

export interface AgentFailureInput {
  card: string;
  kind: AgentFailureKind;
  component: string;
  symptom: string;
  evidence: string;
  reproduction?: string;
  hypothesis?: string;
  measuredMs?: number;
}

export async function reportPlatformFailureFromAgent(input: AgentFailureInput) {
  if (!(await getSettings()).selfProjectId) {
    throw new PlatformFailureStateError("no vibehub project configured — the owner turns this on in Settings (vibehub project)");
  }
  if (!(await registry.getCard(input.card))) throw new PlatformFailureStateError(`card ${input.card} not found — pass your own $VIBEHUB_CARD_ID`);
  if (input.kind === "measured_slowness" && input.measuredMs === undefined) {
    throw new PlatformFailureStateError("measured_slowness needs measuredMs: slowness without a measurement is not reported");
  }
  const measuredEvidence = input.measuredMs !== undefined ? `\nmedido: ${input.measuredMs} ms` : "";
  const recordedFailure = await recordPlatformFailure({
    source: "agent_report",
    component: input.component,
    symptom: redactSecrets(`${input.kind}: ${input.symptom}`),
    evidence: redactSecrets(`${input.evidence}${measuredEvidence}`),
    ...(input.reproduction ? { reproduction: redactSecrets(input.reproduction) } : {}),
    ...(input.hypothesis ? { hypothesis: redactSecrets(input.hypothesis) } : {}),
    cardId: input.card,
  });
  if (!recordedFailure) return { recorded: false as const, reason: "dismissed_or_cap" as const };
  return { recorded: true as const, failureId: recordedFailure.id, occurrences: recordedFailure.occurrences };
}
