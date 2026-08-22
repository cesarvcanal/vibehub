import { afterEach, describe, expect, it } from "vitest";
import {
  CRITICAL_AT,
  WARN_AT,
  formatPercent,
  formatResetIn,
  minutesSince,
  minutesUntil,
  pillPercent,
  usageBarClass,
  usageErrorText,
  usageLevel,
  usageRows,
} from "@/features/board/lib/usage";
import { setLanguage } from "@/i18n";
import type { AccountUsage } from "@/features/board/api";

/**
 * The rules behind the bars. Colour thresholds and a countdown are exactly the kind of thing that
 * "looks right" while being off by one — and being off by one here is the difference between "use
 * this account" and "this account dies in four minutes".
 */

afterEach(() => setLanguage("en"));

const NOW = Date.parse("2026-08-22T12:00:00Z");

function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    available: true,
    fiveHour: { utilization: 31, resetsAt: "2026-08-22T13:01:00Z" },
    sevenDay: { utilization: 12, resetsAt: null },
    sevenDayOpus: { utilization: 74, resetsAt: null },
    fetchedAt: NOW,
    ...over,
  };
}

describe("thresholds", () => {
  it("is ok below 70, warn from 70, critical from 90 — the boundaries included", () => {
    expect(usageLevel(0)).toBe("ok");
    expect(usageLevel(WARN_AT - 0.1)).toBe("ok");
    expect(usageLevel(WARN_AT)).toBe("warn");
    expect(usageLevel(CRITICAL_AT - 0.1)).toBe("warn");
    expect(usageLevel(CRITICAL_AT)).toBe("critical");
    expect(usageLevel(100)).toBe("critical");
  });

  it("paints semantic colours, never the accent", () => {
    expect(usageBarClass(usageLevel(10))).toBe("bg-emerald-500");
    expect(usageBarClass(usageLevel(75))).toBe("bg-amber-500");
    expect(usageBarClass(usageLevel(95))).toBe("bg-destructive");
    // The accent means "this is the current one" — a different sentence from "this is nearly full".
    for (const u of [10, 75, 95]) expect(usageBarClass(usageLevel(u))).not.toContain("accent");
  });

  it("rounds the percentage and clamps a nonsense value", () => {
    expect(formatPercent(31.4)).toBe("31%");
    expect(formatPercent(99.6)).toBe("100%");
    expect(formatPercent(140)).toBe("100%");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});

describe("the countdown", () => {
  it("reads as a clock: hours zero-pad the minutes, minutes alone do not", () => {
    expect(formatResetIn("2026-08-22T13:01:00Z", NOW)).toBe("1h 01m");
    expect(formatResetIn("2026-08-22T14:30:00Z", NOW)).toBe("2h 30m");
    expect(formatResetIn("2026-08-22T12:45:00Z", NOW)).toBe("45m");
    expect(formatResetIn("2026-08-22T12:00:30Z", NOW)).toBe("<1m");
  });

  it("has nothing to count once the window has passed, or when there is no date", () => {
    expect(formatResetIn("2026-08-22T11:59:00Z", NOW)).toBeNull();
    expect(formatResetIn(null, NOW)).toBeNull();
    expect(formatResetIn("not a date", NOW)).toBeNull();
  });

  it("counts whole minutes since a reading, and at least one until a retry", () => {
    expect(minutesSince(NOW - 5 * 60_000, NOW)).toBe(5);
    expect(minutesSince(NOW + 10_000, NOW)).toBe(0);
    expect(minutesUntil(NOW + 61_000, NOW)).toBe(2);
    expect(minutesUntil(undefined, NOW)).toBe(1);
  });
});

describe("what the UI shows", () => {
  it("lists the windows it actually got, in reading order", () => {
    expect(usageRows(usage()).map((r) => r.label)).toEqual(["5h session", "Week", "Week — top model"]);
    expect(usageRows(usage({ sevenDayOpus: undefined })).map((r) => r.key)).toEqual(["fiveHour", "sevenDay"]);
  });

  it("puts the 5-hour window on the pill — the one that stops a card mid-turn", () => {
    expect(pillPercent(usage())).toBe("31%");
    expect(pillPercent(usage({ available: false, fiveHour: undefined }))).toBeNull();
    expect(pillPercent(undefined)).toBeNull();
  });
});

describe("the sentence for an account with no numbers", () => {
  it("tells the operator the command that fixes a profile that never logged in", () => {
    const text = usageErrorText(
      { available: false, error: "no_credentials", fetchedAt: NOW },
      "/root/.claude-profiles/tech",
      NOW,
    );
    expect(text).toContain("/root/.claude-profiles/tech");
    expect(text).toMatch(/login/i);
  });

  it("says nothing about the plan when it is OUR endpoint being throttled", () => {
    const text = usageErrorText(
      { available: false, error: "rate_limited", retryAt: NOW + 4 * 60_000, fetchedAt: NOW },
      "/root/.claude",
      NOW,
    );
    // A 429 there is about the caller, not the account — the copy must not imply a plan limit.
    expect(text).toMatch(/4 min/);
    expect(text).not.toMatch(/plan|limite do plano/i);
  });

  it("speaks pt-BR when that is the language", () => {
    setLanguage("pt-BR");
    expect(
      usageErrorText({ available: false, error: "no_credentials", fetchedAt: NOW }, "/root/.claude", NOW),
    ).toMatch(/Conta sem login interativo no runner/);
    expect(
      usageErrorText({ available: false, error: "rate_limited", retryAt: NOW + 60_000, fetchedAt: NOW }, "/root/.claude", NOW),
    ).toMatch(/limite da API de uso/);
  });
});
