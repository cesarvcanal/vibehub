import type { AccountUsage, UsageError, UsageWindow } from "@/features/board/api";
import { t } from "@/i18n";

/**
 * PLAN USAGE, as pixels and words.
 *
 * The rules live here rather than inside the bar component for the usual reason: "at what point is
 * an account too hot to open a card on" is a decision, and a decision belongs in a tested function.
 * Nothing here touches React or the network.
 */

/** How alarmed the bar is. Three states, because there are three actions: use it, watch it, avoid it. */
export type UsageLevel = "ok" | "warn" | "critical";

/** Below this the account is simply fine. */
export const WARN_AT = 70;

/** At or above this, picking the account is how you hit the wall mid-card. */
export const CRITICAL_AT = 90;

/** The level of a utilization percentage. PURE. */
export function usageLevel(utilization: number): UsageLevel {
  if (!Number.isFinite(utilization)) return "ok";
  if (utilization >= CRITICAL_AT) return "critical";
  if (utilization >= WARN_AT) return "warn";
  return "ok";
}

/**
 * Fill colour of the bar. SEMANTIC, never the accent: the accent means "this is the current thing",
 * and a bar that is 95% full is not saying that. PURE.
 */
export function usageBarClass(level: UsageLevel): string {
  if (level === "critical") return "bg-destructive";
  if (level === "warn") return "bg-amber-500";
  return "bg-emerald-500";
}

/** Same three states as text, for the percentage next to the bar. PURE. */
export function usageTextClass(level: UsageLevel): string {
  if (level === "critical") return "text-destructive";
  if (level === "warn") return "text-amber-500";
  return "text-muted-foreground";
}

/** `31%`. Rounded: a bar is not a billing statement. PURE. */
export function formatPercent(utilization: number): string {
  if (!Number.isFinite(utilization)) return "—";
  return `${Math.round(Math.min(100, Math.max(0, utilization)))}%`;
}

/**
 * How long until a window empties: `1h 01m`, `45m`, `<1m`. Null when there is no date, or the date
 * has passed — a countdown that has run out has nothing to count, and the next poll brings the new
 * window. Minutes are zero-padded ONLY next to hours, so the pair reads as one clock. PURE.
 */
export function formatResetIn(resetsAt: string | null | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const ms = at - now;
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return t("usage.underAMinute");
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** Whole minutes since a reading — what the "data from N min ago" hint counts. PURE. */
export function minutesSince(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / 60_000));
}

/** Whole minutes until the server tries the endpoint again, at least 1. PURE. */
export function minutesUntil(at: number | undefined, now: number): number {
  if (!at) return 1;
  return Math.max(1, Math.ceil((at - now) / 60_000));
}

/**
 * The sentence for an account with no numbers.
 *
 * `no_credentials` is the common one and the only one the operator can fix, so it says the command
 * — a profile set up with a long-lived setup-token never went through `/login`, and the usage
 * endpoint only accepts the token `/login` writes. `rate_limited` deliberately says nothing about
 * the plan: that endpoint throttles by CALLER, so a 429 is about vibehub, not about the account.
 */
export function usageErrorText(usage: AccountUsage, profilePath: string, now: number): string {
  switch (usage.error) {
    case "no_credentials":
      return t("usage.error.noCredentials", { path: profilePath });
    case "rate_limited":
      return t("usage.error.rateLimited", { n: minutesUntil(usage.retryAt, now) });
    case "unauthorized":
      return t("usage.error.unauthorized", { path: profilePath });
    default:
      return t("usage.error.unreachable");
  }
}

/** The three windows in reading order, with the label each bar carries. PURE. */
export function usageRows(usage: AccountUsage): { key: string; label: string; window: UsageWindow }[] {
  const rows: { key: string; label: string; window?: UsageWindow }[] = [
    { key: "fiveHour", label: t("usage.fiveHour"), window: usage.fiveHour },
    { key: "sevenDay", label: t("usage.sevenDay"), window: usage.sevenDay },
    { key: "sevenDayOpus", label: t("usage.sevenDayOpus"), window: usage.sevenDayOpus },
  ];
  return rows.filter((r): r is { key: string; label: string; window: UsageWindow } => Boolean(r.window));
}

/**
 * The number the collapsed pill shows: the 5-hour window, which is the one that actually stops a
 * card mid-turn. Null when there is nothing to show — the pill then renders the account name alone
 * rather than a placeholder. PURE.
 */
export function pillPercent(usage: AccountUsage | undefined): string | null {
  if (!usage?.available || !usage.fiveHour) return null;
  return formatPercent(usage.fiveHour.utilization);
}

/** Convenience for a caller that only has the error kind. PURE. */
export function isUsageError(usage: AccountUsage | undefined): usage is AccountUsage & { error: UsageError } {
  return Boolean(usage?.error);
}
