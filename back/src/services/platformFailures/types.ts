export const PLATFORM_FAILURE_SOURCES = ["backend_error", "slow_turn", "agent_report"] as const;
export type PlatformFailureSource = (typeof PLATFORM_FAILURE_SOURCES)[number];

export const PLATFORM_FAILURE_STATUSES = ["open", "investigating", "resolved", "concluded_without_fix", "dismissed"] as const;
export type PlatformFailureStatus = (typeof PLATFORM_FAILURE_STATUSES)[number];

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
}

export interface UserStopMark {
  cardId: string;
  at: number;
}
