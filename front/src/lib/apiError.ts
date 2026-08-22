import { t, translateApiError } from "@/i18n";

/**
 * Pull the most useful message out of a failed request.
 *
 * vibehub's back-end answers `{ "error": "..." }`, and provisioning routes sometimes add the
 * raw `stderr` of the docker/ssh command that failed — which is exactly what a developer needs
 * to see, so we prefer it over a generic "request failed".
 *
 * The server speaks English. The handful of messages a person actually reads are mapped in
 * `translateApiError`; everything else — a stderr dump, a git error, an unknown string — passes
 * through untouched, because a half-translated stack trace is worse than an English one.
 */
export function apiErrorMessage(err: unknown, fallback?: string): string {
  const e = err as {
    response?: { data?: { error?: string; stderr?: string; stdout?: string } | string };
    message?: string;
  };
  const data = e?.response?.data;
  if (typeof data === "string" && data.trim()) return translateApiError(data.trim());
  if (data && typeof data === "object") {
    const detail = data.error || data.stderr || data.stdout;
    if (detail && detail.trim()) return translateApiError(detail.trim());
  }
  const message = e?.message?.trim();
  if (message && message !== "Network Error") return translateApiError(message);
  return fallback ?? t("error.generic");
}
