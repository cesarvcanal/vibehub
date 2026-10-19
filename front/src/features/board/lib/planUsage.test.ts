import { afterEach, describe, expect, it } from "vitest";
import type { AccountUsage } from "@/features/board/api";
import {
  alertSentence,
  peakWindow,
  planAlert,
  planWindows,
  usageColor,
  usageHue,
  usageTone,
  weeklyWindow,
  type RateLimitInfo,
} from "@/features/board/lib/planUsage";
import { resetLanguage, setLanguage } from "@/i18n";

const NOW = Date.parse("2026-10-19T15:00:00Z");
const IN_2H = Date.parse("2026-10-19T17:00:00Z");

const usage = (five: number, week: number): AccountUsage => ({
  available: true,
  fiveHour: { utilization: five, resetsAt: new Date(IN_2H).toISOString() },
  sevenDay: { utilization: week, resetsAt: "2026-10-22T00:00:00Z" },
  fetchedAt: NOW,
});

afterEach(() => resetLanguage());

describe("usageTone", () => {
  it("climbs yellow at 70, orange at 85, red at 95", () => {
    expect([0, 69.9, 70, 84.9, 85, 94.9, 95, 100].map((n) => usageTone(n))).toEqual([
      "ok", "ok", "yellow", "yellow", "orange", "orange", "red", "red",
    ]);
  });

  it("a blown limit is red whatever the number; no number is ok", () => {
    expect(usageTone(10, true)).toBe("red");
    expect(usageTone(undefined)).toBe("ok");
    expect(usageTone(Number.NaN)).toBe("ok");
  });
});

describe("planWindows", () => {
  it("lists the polled windows in reading order", () => {
    const windows = planWindows(usage(7, 36), {}, NOW);
    expect(windows.map((w) => [w.key, w.utilization, w.resetsAt])).toEqual([
      ["five_hour", 7, IN_2H],
      ["seven_day", 36, Date.parse("2026-10-22T00:00:00Z")],
    ]);
  });

  it("the live reading wins where it has a number, and adds windows only it knows", () => {
    const live: Record<string, RateLimitInfo> = {
      five_hour: { status: "allowed_warning", window: "five_hour", utilization: 91, resetsAt: IN_2H },
      seven_day_sonnet: { status: "allowed", window: "seven_day_sonnet", utilization: 12 },
    };
    const windows = planWindows(usage(80, 36), live, NOW);
    expect(windows.map((w) => [w.key, w.utilization])).toEqual([
      ["five_hour", 91],
      ["seven_day", 36],
      ["seven_day_sonnet", 12],
    ]);
  });

  it("ignores a live reading whose window has already reset", () => {
    const live = { five_hour: { status: "allowed_warning" as const, window: "five_hour", utilization: 99, resetsAt: NOW - 1 } };
    expect(planWindows(usage(5, 1), live, NOW)[0]!.utilization).toBe(5);
  });

  it("is empty without a reading", () => {
    expect(planWindows(undefined, {}, NOW)).toEqual([]);
    expect(planWindows({ available: false, error: "no_credentials", fetchedAt: 0 }, {}, NOW)).toEqual([]);
  });
});

describe("peakWindow", () => {
  it("is the fullest window", () => {
    expect(peakWindow(planWindows(usage(7, 36), {}, NOW))?.key).toBe("seven_day");
    expect(peakWindow([])).toBeNull();
  });
});

describe("planAlert", () => {
  it("stays quiet below 70%", () => {
    expect(planAlert(planWindows(usage(69, 40), {}, NOW), {}, NOW)).toBeNull();
  });

  it("picks the gravest tone, then the fullest window", () => {
    expect(planAlert(planWindows(usage(72, 88), {}, NOW), {}, NOW)).toMatchObject({ window: "seven_day", tone: "orange" });
    expect(planAlert(planWindows(usage(96, 88), {}, NOW), {}, NOW)).toMatchObject({ window: "five_hour", tone: "red", rejected: false });
  });

  it("a blown limit comes first, red and blocking", () => {
    const live = { seven_day: { status: "rejected" as const, window: "seven_day", resetsAt: IN_2H } };
    expect(planAlert(planWindows(usage(90, 50), live, NOW), live, NOW)).toEqual({
      window: "seven_day", tone: "red", rejected: true, utilization: null, resetsAt: IN_2H,
    });
  });

  it("a CLI warning without a number is still a (yellow) warning", () => {
    const live = { five_hour: { status: "allowed_warning" as const, window: "five_hour" } };
    expect(planAlert([], live, NOW)).toMatchObject({ window: "five_hour", tone: "yellow", utilization: null });
  });
});

describe("alertSentence", () => {
  it("says how much, of which limit, and when it comes back", () => {
    setLanguage("pt-BR");
    const used = alertSentence({ window: "five_hour", tone: "orange", rejected: false, utilization: 91.4, resetsAt: IN_2H }, NOW);
    expect(used).toMatch(/^91% do limite da sessão já foi usado — renova em 2h 00m \(.+\)$/);
    const blown = alertSentence({ window: "seven_day", tone: "red", rejected: true, utilization: null, resetsAt: null }, NOW);
    expect(blown).toBe("O limite semanal acabou");
  });

  it("counts a long wait in days", () => {
    setLanguage("en");
    const sentence = alertSentence({ window: "seven_day", tone: "yellow", rejected: false, utilization: 71, resetsAt: NOW + 26 * 3_600_000 + 5 }, NOW);
    expect(sentence).toMatch(/^71% of the weekly limit used — resets in 1d 02h \(/);
  });

  it("speaks English too", () => {
    setLanguage("en");
    expect(alertSentence({ window: "five_hour", tone: "yellow", rejected: false, utilization: 75, resetsAt: null }, NOW))
      .toBe("75% of the session limit used");
  });
});

describe("weeklyWindow", () => {
  it("is the weekly window even when the session is fuller", () => {
    expect(weeklyWindow(planWindows(usage(92, 40), {}, NOW))).toMatchObject({ key: "seven_day", utilization: 40 });
    expect(weeklyWindow(planWindows({ available: true, fiveHour: { utilization: 3, resetsAt: null }, fetchedAt: 0 }, {}, NOW))).toBeNull();
  });
});

describe("usageHue", () => {
  it("stays green up to 50% and warms continuously to red at 100%", () => {
    expect(usageHue(0)).toBe(142);
    expect(usageHue(50)).toBe(142);
    const hues = [60, 70, 85, 95, 100].map(usageHue);
    expect(hues).toEqual([...hues].sort((a, b) => b - a));
    expect(usageHue(70)).toBe(50); // amarelo
    expect(usageHue(85)).toBe(28); // laranja
    expect(usageHue(95)).toBe(4); // vermelho
    expect(usageHue(100)).toBe(0);
  });

  it("clamps and survives a bad number", () => {
    expect(usageHue(140)).toBe(0);
    expect(usageHue(Number.NaN)).toBe(142);
    expect(usageColor(100, 0.5)).toBe("hsl(0 80% 50% / 0.5)");
  });
});
