import {
  FAILURE_NARRATIVE_UNAVAILABLE_REASONS, FAILURE_TRIGGERS, INVESTIGATION_VERDICTS,
  type FailureInvestigationReport, type FailureNarrative, type InvestigationVerdict, type FailureNarrativeUnavailableReason, type FailureTrigger,
  type PlatformFailureNotice, type PlatformFailureSource, type PlatformFailureStatus,
} from "@/api/types";

const SOURCES: readonly PlatformFailureSource[] = ["backend_error", "slow_turn", "stalled_turn", "agent_report", "screen_error"];
const STATUSES: readonly PlatformFailureStatus[] = ["open", "investigating", "resolved", "concluded_without_fix", "dismissed"];
const ACTIVE_STATUSES: readonly PlatformFailureStatus[] = ["open", "investigating", "concluded_without_fix"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalText(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseFailureNarrative(value: unknown): FailureNarrative | null {
  if (!isRecord(value)) return null;
  const context = readOptionalText(value, "context");
  const whatHappened = readOptionalText(value, "whatHappened");
  const cause = readOptionalText(value, "cause");
  const triggerReason = readOptionalText(value, "triggerReason");
  const { trigger } = value;
  if (!context || !whatHappened || !cause || !triggerReason || !FAILURE_TRIGGERS.includes(trigger as FailureTrigger)) return null;
  return { context, whatHappened, cause, trigger: trigger as FailureTrigger, triggerReason };
}

function parseInvestigationReport(value: unknown): FailureInvestigationReport | null {
  if (!isRecord(value)) return null;
  const conclusion = readOptionalText(value, "conclusion");
  const howItHappened = readOptionalText(value, "howItHappened");
  const cause = readOptionalText(value, "cause");
  const resolution = readOptionalText(value, "resolution");
  const pendingDecision = readOptionalText(value, "pendingDecision");
  const { verdict, reportedAt } = value;
  if (!conclusion || !howItHappened || !cause || !resolution || typeof reportedAt !== "number") return null;
  if (!INVESTIGATION_VERDICTS.includes(verdict as InvestigationVerdict)) return null;
  return {
    verdict: verdict as InvestigationVerdict, conclusion, howItHappened, cause, resolution,
    ...(pendingDecision ? { pendingDecision } : {}),
    reportedAt,
  };
}

function parseNoticeDetails(value: unknown): PlatformFailureNotice["details"] | null {
  if (!isRecord(value)) return null;
  const { symptom, component, evidence, narrativeUnavailable } = value;
  if (typeof symptom !== "string" || typeof component !== "string" || typeof evidence !== "string") return null;
  const narrative = value.narrative === undefined ? undefined : parseFailureNarrative(value.narrative);
  if (narrative === null) return null;
  const investigationReport = value.investigationReport === undefined ? undefined : parseInvestigationReport(value.investigationReport);
  if (investigationReport === null) return null;
  const isKnownUnavailableReason = FAILURE_NARRATIVE_UNAVAILABLE_REASONS.includes(narrativeUnavailable as FailureNarrativeUnavailableReason);
  if (narrativeUnavailable !== undefined && !isKnownUnavailableReason) return null;
  const reproduction = readOptionalText(value, "reproduction");
  const hypothesis = readOptionalText(value, "hypothesis");
  return {
    symptom, component, evidence,
    ...(reproduction ? { reproduction } : {}),
    ...(hypothesis ? { hypothesis } : {}),
    ...(narrative ? { narrative } : {}),
    ...(isKnownUnavailableReason ? { narrativeUnavailable: narrativeUnavailable as FailureNarrativeUnavailableReason } : {}),
    ...(investigationReport ? { investigationReport } : {}),
  };
}

export function parsePlatformFailureNotice(value: unknown): PlatformFailureNotice | null {
  if (!isRecord(value)) return null;
  const { id, source, status, occurrences, firstSeenAt, lastSeenAt } = value;
  if (typeof id !== "string" || id === "") return null;
  if (!SOURCES.includes(source as PlatformFailureSource) || !STATUSES.includes(status as PlatformFailureStatus)) return null;
  if (typeof occurrences !== "number" || typeof firstSeenAt !== "number" || typeof lastSeenAt !== "number") return null;
  const explanation = readOptionalText(value, "explanation");
  const details = value.details === undefined ? undefined : parseNoticeDetails(value.details);
  if (details === null) return null;
  return {
    id,
    source: source as PlatformFailureSource,
    status: status as PlatformFailureStatus,
    ...(explanation ? { explanation } : {}),
    occurrences,
    firstSeenAt,
    lastSeenAt,
    ...(details ? { details } : {}),
  };
}

export function isActiveFailureStatus(status: PlatformFailureStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}
