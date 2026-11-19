import type { PrSettingUpRefusal } from "@/api/types";

/**
 * Who holds the PR when starting its analysis was refused because somebody else is setting it up
 * (`POST /projects/:id/prs/:number/analysis` → 409 `pr_em_montagem`). Null = any other failure. PURE.
 */
export function prSettingUpHolder(err: unknown): string | null {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status !== 409) return null;
  const data = response.data as Partial<Record<keyof PrSettingUpRefusal, unknown>> | null | undefined;
  if (typeof data !== "object" || data === null) return null;
  const { error, username } = data;
  if (typeof error !== "string" || !error.startsWith("pr_em_montagem:")) return null;
  return typeof username === "string" ? username : null;
}
