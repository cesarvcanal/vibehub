import type { PlatformFailure } from "@/api/types";

const SEEN_FAILURES_STORAGE_KEY = "vibehub.platformFailures.seen";

export function findUnseenFailureIds(failures: ReadonlyArray<Pick<PlatformFailure, "id" | "status">>, seenIds: ReadonlySet<string>): string[] {
  return failures.filter((failure) => failure.status === "open" && !seenIds.has(failure.id)).map((failure) => failure.id);
}

export function readSeenFailureIds(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_FAILURES_STORAGE_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function saveSeenFailureIds(seenIds: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(SEEN_FAILURES_STORAGE_KEY, JSON.stringify([...seenIds]));
  } catch {
    return;
  }
}
