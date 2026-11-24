export type PlatformFailureSource = "backend_error" | "slow_turn" | "stalled_turn" | "agent_report" | "screen_error";
export type PlatformFailureStatus = "open" | "investigating" | "resolved" | "concluded_without_fix" | "dismissed";

export const FAILURE_TRIGGERS = ["system", "person", "unknown"] as const;
export type FailureTrigger = (typeof FAILURE_TRIGGERS)[number];

export interface FailureNarrative {
  context: string;
  whatHappened: string;
  cause: string;
  trigger: FailureTrigger;
  triggerReason: string;
}

export const INVESTIGATION_VERDICTS = ["vibehub_bug", "not_a_bug", "inconclusive"] as const;
export type InvestigationVerdict = (typeof INVESTIGATION_VERDICTS)[number];

export interface FailureInvestigationReportInput {
  verdict: InvestigationVerdict;
  conclusion: string;
  howItHappened: string;
  cause: string;
  resolution: string;
  pendingDecision?: string;
}

export interface FailureInvestigationReport extends FailureInvestigationReportInput {
  reportedAt: number;
}

export type FailureNarrativeUnavailableReason = "no_api_key" | "request_failed";

export interface PlatformFailureReport {
  source: PlatformFailureSource;
  component: string;
  symptom: string;
  evidence: string;
  reproduction?: string;
  hypothesis?: string;
  explanation?: string;
  cardId?: string;
}

export interface PlatformFailure {
  id: string;
  signature: string;
  source: PlatformFailureSource;
  status: PlatformFailureStatus;
  component: string;
  symptom: string;
  evidence: string;
  reproduction?: string;
  hypothesis?: string;
  explanation?: string;
  originCardId?: string;
  occurrences: number;
  affectedCardIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  investigationCardId?: string;
  resolvedAt?: number;
  dismissedAt?: number;
  narrative?: FailureNarrative;
  narrativeUnavailable?: FailureNarrativeUnavailableReason;
  investigationReport?: FailureInvestigationReport;
  previousInvestigationReport?: FailureInvestigationReport;
}

export interface UserStopMark {
  cardId: string;
  cardWorktreeSlug: string;
  at: number;
}
