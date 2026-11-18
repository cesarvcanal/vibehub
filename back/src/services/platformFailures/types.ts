export type PlatformFailureSource = "backend_error" | "slow_turn" | "agent_report";
export type PlatformFailureStatus = "open" | "investigating" | "resolved" | "concluded_without_fix" | "dismissed";

export interface PlatformFailureReport {
  source: PlatformFailureSource;
  component: string;
  symptom: string;
  evidence: string;
  reproduction?: string;
  hypothesis?: string;
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
  occurrences: number;
  affectedCardIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  investigationCardId?: string;
  resolvedAt?: number;
  dismissedAt?: number;
}

export interface UserStopMark {
  cardId: string;
  cardLabel: string;
  at: number;
}
