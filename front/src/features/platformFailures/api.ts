import { get, post } from "@/lib/api";
import type { PlatformFailure, PlatformFailureInvestigation } from "@/api/types";

export const PLATFORM_FAILURES_KEY = ["platform-failures"] as const;
export const PLATFORM_FAILURES_POLL_MS = 30_000;

export const platformFailuresApi = {
  list: () => get<{ failures: PlatformFailure[] }>("/platform-failures").then((response) => response.failures),
  investigate: (failureId: string) => post<PlatformFailureInvestigation>(`/platform-failures/${failureId}/investigate`),
  dismiss: (failureId: string) => post<{ failure: PlatformFailure }>(`/platform-failures/${failureId}/dismiss`),
};
