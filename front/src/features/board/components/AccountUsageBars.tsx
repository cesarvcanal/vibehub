import * as React from "react";
import type { AccountUsage } from "@/features/board/api";
import { profilePathFor } from "@/features/board/api";
import {
  formatPercent,
  formatResetIn,
  minutesSince,
  usageBarClass,
  usageErrorText,
  usageLevel,
  usageRows,
  usageTextClass,
} from "@/features/board/lib/usage";
import { useT } from "@/i18n";

/**
 * HOW MUCH OF THE PLAN IS GONE, for one account.
 *
 * Three bars, because there are three limits and hitting any of them stops the work: the 5-hour
 * session, the 7-day window, and the 7-day window of the strongest model. Each carries its
 * percentage and a countdown to its reset, so the answer to "can I open a card on this account" is
 * a glance instead of a card that dies halfway through a turn.
 *
 * The colours are SEMANTIC (green / amber / red), never the accent — the accent means "this is the
 * current one", which is a different sentence from "this is nearly full".
 */

/** A clock that ticks once a MINUTE. The countdowns are in minutes; a per-second timer would only
 * re-render the board sixty times for nothing. */
export function useMinuteTick(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** One bar: label, the track, the percentage, and when the window comes back. */
function UsageBar({
  label,
  utilization,
  resetsAt,
  now,
}: {
  label: string;
  utilization: number;
  resetsAt: string | null;
  now: number;
}) {
  const t = useT();
  const level = usageLevel(utilization);
  const resetIn = formatResetIn(resetsAt, now);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={`shrink-0 font-mono tabular-nums ${usageTextClass(level)}`}>
          {formatPercent(utilization)}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(utilization)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-[width] ${usageBarClass(level)}`}
          style={{ width: `${Math.min(100, Math.max(0, utilization))}%` }}
        />
      </div>
      {resetIn ? (
        <div className="text-[10px] leading-none text-muted-foreground">
          {t("usage.resetsIn", { time: resetIn })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The whole block for one account: the three bars, or the one sentence that says why there are
 * none. `slug` is what turns the sentence into an instruction — it names the profile directory the
 * operator has to log into.
 */
export function AccountUsageBars({
  slug,
  usage,
  now,
  compact = false,
}: {
  slug: string;
  usage: AccountUsage | undefined;
  /** Injected rather than read here, so every row on screen counts down from the same instant. */
  now: number;
  /** Drops the reset countdowns — used where the block sits inside a tooltip. */
  compact?: boolean;
}) {
  const t = useT();
  if (!usage) {
    return <p className="text-[11px] text-muted-foreground">{t("usage.loading")}</p>;
  }
  if (!usage.available) {
    return <p className="text-[11px] leading-snug text-muted-foreground">{usageErrorText(usage, profilePathFor(slug), now)}</p>;
  }
  const rows = usageRows(usage);
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <UsageBar
          key={row.key}
          label={row.label}
          utilization={row.window.utilization}
          resetsAt={compact ? null : row.window.resetsAt}
          now={now}
        />
      ))}
      {/* Stale numbers still beat no numbers — but they have to say how old they are, or the
          operator plans against a reading from twenty minutes ago without knowing it. */}
      {usage.stale ? (
        <p className="text-[10px] leading-none text-muted-foreground">
          {t("usage.stale", { n: minutesSince(usage.fetchedAt, now) })}
        </p>
      ) : null}
    </div>
  );
}
