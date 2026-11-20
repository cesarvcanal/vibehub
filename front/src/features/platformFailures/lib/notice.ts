import type { PlatformFailureNotice, PlatformFailureSource, PlatformFailureStatus } from "@/api/types";

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

function parseNoticeDetails(value: unknown): PlatformFailureNotice["details"] | null {
  if (!isRecord(value)) return null;
  const { symptom, component, evidence } = value;
  if (typeof symptom !== "string" || typeof component !== "string" || typeof evidence !== "string") return null;
  const reproduction = readOptionalText(value, "reproduction");
  const hypothesis = readOptionalText(value, "hypothesis");
  return { symptom, component, evidence, ...(reproduction ? { reproduction } : {}), ...(hypothesis ? { hypothesis } : {}) };
}

export function parsePlatformFailureNotice(value: unknown): PlatformFailureNotice | null {
  if (!isRecord(value)) return null;
  const { id, source, status, occurrences, firstSeenAt } = value;
  if (typeof id !== "string" || id === "") return null;
  if (!SOURCES.includes(source as PlatformFailureSource) || !STATUSES.includes(status as PlatformFailureStatus)) return null;
  if (typeof occurrences !== "number" || typeof firstSeenAt !== "number") return null;
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
    ...(details ? { details } : {}),
  };
}

export function isActiveFailureStatus(status: PlatformFailureStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}
