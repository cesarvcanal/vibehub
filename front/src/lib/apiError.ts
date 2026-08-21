/**
 * Pull the most useful message out of a failed request.
 *
 * vibehub's back-end answers `{ "error": "..." }`, and provisioning routes sometimes add the
 * raw `stderr` of the docker/ssh command that failed — which is exactly what a developer needs
 * to see, so we prefer it over a generic "request failed".
 */
export function apiErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  const e = err as {
    response?: { data?: { error?: string; stderr?: string; stdout?: string } | string };
    message?: string;
  };
  const data = e?.response?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object") {
    const detail = data.error || data.stderr || data.stdout;
    if (detail && detail.trim()) return detail.trim();
  }
  const message = e?.message?.trim();
  if (message && message !== "Network Error") return message;
  return fallback;
}
