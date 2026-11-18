import type { PlatformFailure } from "@/api/types";

export function findUnseenFailureIds(failures: ReadonlyArray<Pick<PlatformFailure, "id" | "status">>, seenIds: ReadonlySet<string>): string[] {
  return failures.filter((failure) => failure.status === "open" && !seenIds.has(failure.id)).map((failure) => failure.id);
}
