import type { PlatformFailureNotice } from "@/api/types";

const SNOOZED_NOTICES_STORAGE_KEY = "vibehub.platformFailures.snoozed";
const SNOOZED_NOTICES_KEPT = 200;

export function buildSnoozeKey(cardId: string, notice: Pick<PlatformFailureNotice, "id" | "status">): string {
  return `${cardId}:${notice.id}:${notice.status}`;
}

export function readSnoozedNoticeKeys(): Set<string> {
  try {
    const storedValue: unknown = JSON.parse(localStorage.getItem(SNOOZED_NOTICES_STORAGE_KEY) ?? "[]");
    const storedKeys = Array.isArray(storedValue) ? storedValue : [];
    return new Set(storedKeys.filter((storedKey): storedKey is string => typeof storedKey === "string"));
  } catch {
    return new Set();
  }
}

export function saveSnoozedNoticeKeys(snoozedKeys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(SNOOZED_NOTICES_STORAGE_KEY, JSON.stringify([...snoozedKeys].slice(-SNOOZED_NOTICES_KEPT)));
  } catch {
    return;
  }
}

export function pickVisibleNotices(notices: readonly PlatformFailureNotice[], snoozedKeys: ReadonlySet<string>, cardId: string): PlatformFailureNotice[] {
  return notices
    .filter((notice) => !snoozedKeys.has(buildSnoozeKey(cardId, notice)))
    .sort((left, right) => right.firstSeenAt - left.firstSeenAt);
}
