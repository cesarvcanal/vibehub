import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { AccountUsageBars } from "@/features/board/components/AccountUsageBars";
import { setLanguage } from "@/i18n";
import type { AccountUsage } from "@/features/board/api";

/**
 * The three bars, as rendered. What is pinned here is what an operator READS off them: a width that
 * matches the number, a colour that matches the danger, a countdown, and — when there is no number
 * at all — a sentence that says what to do instead of an empty row.
 */

afterEach(() => setLanguage("en"));

const NOW = Date.parse("2026-08-22T12:00:00Z");

function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    available: true,
    fiveHour: { utilization: 31, resetsAt: "2026-08-22T13:01:00Z" },
    sevenDay: { utilization: 72, resetsAt: null },
    sevenDayOpus: { utilization: 95, resetsAt: null },
    fetchedAt: NOW,
    ...over,
  };
}

describe("AccountUsageBars", () => {
  it("draws one bar per window, each filled to its own percentage", () => {
    renderApp(<AccountUsageBars slug="tech" usage={usage()} now={NOW} />);

    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "5h session", "Week", "Week — top model",
    ]);
    expect(bars.map((b) => (b.firstElementChild as HTMLElement).style.width)).toEqual([
      "31%", "72%", "95%",
    ]);
  });

  it("colours each bar by how close it is to the wall", () => {
    renderApp(<AccountUsageBars slug="tech" usage={usage()} now={NOW} />);
    const fills = screen.getAllByRole("progressbar").map((b) => (b.firstElementChild as HTMLElement).className);
    expect(fills[0]).toContain("bg-emerald-500");
    expect(fills[1]).toContain("bg-amber-500");
    expect(fills[2]).toContain("bg-destructive");
  });

  it("counts down to the reset", () => {
    renderApp(<AccountUsageBars slug="tech" usage={usage()} now={NOW} />);
    expect(screen.getByText("resets in 1h 01m")).toBeInTheDocument();
  });

  it("admits when the numbers are old rather than passing them off as current", () => {
    renderApp(
      <AccountUsageBars slug="tech" usage={usage({ stale: true, fetchedAt: NOW - 7 * 60_000 })} now={NOW} />,
    );
    expect(screen.getByText("data from 7 min ago")).toBeInTheDocument();
  });

  it("says how to fix an account that never logged in, naming its profile directory", () => {
    renderApp(
      <AccountUsageBars slug="tech" usage={{ available: false, error: "no_credentials", fetchedAt: NOW }} now={NOW} />,
    );
    const text = screen.getByText(/no interactive login on the runner/i);
    expect(text).toHaveTextContent("/root/.claude-profiles/tech");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("names the DEFAULT profile's own directory", () => {
    renderApp(
      <AccountUsageBars slug="default" usage={{ available: false, error: "no_credentials", fetchedAt: NOW }} now={NOW} />,
    );
    expect(screen.getByText(/no interactive login/i)).toHaveTextContent("/root/.claude");
  });

  it("blames the endpoint, not the plan, while rate-limited", () => {
    renderApp(
      <AccountUsageBars
        slug="tech"
        usage={{ available: false, error: "rate_limited", retryAt: NOW + 120_000, fetchedAt: NOW }}
        now={NOW}
      />,
    );
    expect(screen.getByText("usage API limit — trying again in 2 min")).toBeInTheDocument();
  });

  it("says it is still reading while nothing has arrived", () => {
    renderApp(<AccountUsageBars slug="tech" usage={undefined} now={NOW} />);
    expect(screen.getByText("reading usage…")).toBeInTheDocument();
  });

  it("speaks pt-BR", () => {
    setLanguage("pt-BR");
    renderApp(<AccountUsageBars slug="tech" usage={usage()} now={NOW} />);
    expect(screen.getByRole("progressbar", { name: "Sessão 5h" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Semana — modelo forte" })).toBeInTheDocument();
    expect(screen.getByText("reinicia em 1h 01m")).toBeInTheDocument();
  });
});
