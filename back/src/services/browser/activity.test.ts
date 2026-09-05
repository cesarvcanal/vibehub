import { beforeEach, describe, expect, it } from "vitest";
import {
  BUSY_WINDOW_MS,
  agentMayDriveBrowser,
  cardBrowserActivity,
  markBrowserBusy,
  markBrowserDown,
  markBrowserLive,
  releaseBrowserControl,
  resetBrowserActivityForTesting,
  takeBrowserControl,
} from "./activity.js";

/**
 * The answer the card bar and the Navegador pane poll. It is the only thing that makes an agent's
 * browsing session visible from outside the pane, and the only place that decides whether the
 * agent may drive — so what it says has to be exactly right at the edges.
 */
beforeEach(() => resetBrowserActivityForTesting());

describe("live", () => {
  it("is false for a card nobody opened, and never invents a holder", () => {
    expect(cardBrowserActivity("c1")).toEqual({
      live: false,
      liveSince: null,
      busy: false,
      control: "agent",
      controlBy: null,
    });
  });

  it("goes up on start and down on stop", () => {
    markBrowserLive("c1", 1_000);
    expect(cardBrowserActivity("c1", 1_500)).toMatchObject({ live: true, liveSince: 1_000 });
    markBrowserDown("c1");
    expect(cardBrowserActivity("c1", 1_500).live).toBe(false);
  });

  it("keeps the ORIGINAL start across an idempotent re-start — reopening the pane is not a new browser", () => {
    markBrowserLive("c1", 1_000);
    markBrowserLive("c1", 9_000);
    expect(cardBrowserActivity("c1", 9_100).liveSince).toBe(1_000);
  });
});

describe("busy", () => {
  it("lights up on input and goes quiet after the window", () => {
    markBrowserLive("c1", 0);
    markBrowserBusy("c1", 1_000);
    expect(cardBrowserActivity("c1", 1_000 + BUSY_WINDOW_MS - 1).busy).toBe(true);
    expect(cardBrowserActivity("c1", 1_000 + BUSY_WINDOW_MS).busy).toBe(false);
  });

  it("cannot resurrect a browser that is already down — a late report from a dying listener", () => {
    markBrowserLive("c1", 0);
    markBrowserDown("c1");
    markBrowserBusy("c1", 10);
    expect(cardBrowserActivity("c1", 20)).toMatchObject({ live: false, busy: false });
  });
});

describe("control", () => {
  it("belongs to the agent until a person takes it", () => {
    markBrowserLive("c1", 0);
    expect(agentMayDriveBrowser("c1")).toBe(true);

    takeBrowserControl("c1", "cesar");
    expect(cardBrowserActivity("c1", 1)).toMatchObject({ control: "human", controlBy: "cesar" });
    expect(agentMayDriveBrowser("c1")).toBe(false);

    releaseBrowserControl("c1", "cesar");
    expect(cardBrowserActivity("c1", 2)).toMatchObject({ control: "agent", controlBy: null });
    expect(agentMayDriveBrowser("c1")).toBe(true);
  });

  it("releases only your OWN hold: a stale pane closing must not yank the wheel from whoever has it", () => {
    takeBrowserControl("c1", "cesar");
    releaseBrowserControl("c1", "mussa");
    expect(cardBrowserActivity("c1").controlBy).toBe("cesar");
    releaseBrowserControl("c1");
    expect(cardBrowserActivity("c1").controlBy).toBe(null);
  });

  it("dies with the browser — nothing stays locked to a Chromium that is gone", () => {
    markBrowserLive("c1", 0);
    takeBrowserControl("c1", "cesar");
    markBrowserDown("c1");
    expect(cardBrowserActivity("c1")).toMatchObject({ live: false, control: "agent", controlBy: null });
    expect(agentMayDriveBrowser("c1")).toBe(true);
  });

  it("is per card: one card being driven says nothing about another", () => {
    takeBrowserControl("c1", "cesar");
    expect(agentMayDriveBrowser("c2")).toBe(true);
  });
});
