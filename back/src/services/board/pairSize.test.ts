import { describe, it, expect, beforeEach } from "vitest";
import {
  clampDim, resolveCanonicalDim, dimControlFrame,
  tmuxWindowFixArgs, tmuxWindowFollowArgs,
  joinCard, resizeCard, leaveCard, cardDim, cardClientCount, resetPairSizes,
  type Dim, type PairMember,
} from "./pairSize.js";

/**
 * PAIRING ON ONE TERMINAL: two browsers on the same card share ONE canonical dimension (the first
 * defines it; 2+ clients freeze it; solo again re-fits; empty resets). These tests cover the pure
 * decision and the in-memory registry — "everybody renders the same size" is what kills the dotted
 * filler tmux would otherwise paint.
 */

beforeEach(() => resetPairSizes());

/** Stub member that records the (dim, locked) notifications it received. */
function member(): PairMember & { notices: Array<{ dim: Dim; locked: boolean }> } {
  const notices: Array<{ dim: Dim; locked: boolean }> = [];
  return { notices, notify: (dim, locked) => notices.push({ dim, locked }) };
}

describe("clampDim — integers in 10..500", () => {
  it("accepts what is in range", () => {
    expect(clampDim(80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(clampDim(10, 500)).toEqual({ cols: 10, rows: 500 });
  });
  it("rejects out of range, fractional, non-numeric and missing → null", () => {
    expect(clampDim(9, 24)).toBeNull();
    expect(clampDim(80, 501)).toBeNull();
    expect(clampDim(80.5, 24)).toBeNull();
    expect(clampDim("80", "24")).toBeNull();
    expect(clampDim(0, 0)).toBeNull();
    expect(clampDim(-5, 24)).toBeNull();
    expect(clampDim(undefined, undefined)).toBeNull();
    expect(clampDim(Number.NaN, 24)).toBeNull();
  });
});

describe("resolveCanonicalDim — the pure decision", () => {
  it("0/1 client: a valid fit defines it; an invalid fit keeps the current one", () => {
    expect(resolveCanonicalDim(0, null, { cols: 100, rows: 30 })).toEqual({ cols: 100, rows: 30 });
    expect(resolveCanonicalDim(1, { cols: 80, rows: 24 }, { cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(resolveCanonicalDim(1, { cols: 80, rows: 24 }, null)).toEqual({ cols: 80, rows: 24 });
  });
  it("2+ clients: FROZEN at the current one, the new fit ignored (the cure for the dotted area)", () => {
    expect(resolveCanonicalDim(2, { cols: 80, rows: 24 }, { cols: 120, rows: 40 })).toEqual({ cols: 80, rows: 24 });
    expect(resolveCanonicalDim(3, { cols: 80, rows: 24 }, { cols: 200, rows: 50 })).toEqual({ cols: 80, rows: 24 });
  });
});

describe("dimControlFrame — the control envelope sent to the browser", () => {
  it("JSON with __ctl=dim plus cols/rows/locked", () => {
    expect(JSON.parse(dimControlFrame(80, 24, true))).toEqual({ __ctl: "dim", cols: 80, rows: 24, locked: true });
    expect(JSON.parse(dimControlFrame(120, 40, false))).toEqual({ __ctl: "dim", cols: 120, rows: 40, locked: false });
  });
  it("starts with the prefix the front-end uses to tell it from terminal output", () => {
    expect(dimControlFrame(80, 24, true).startsWith('{"__ctl"')).toBe(true);
  });
});

describe("tmuxWindowFixArgs / tmuxWindowFollowArgs — the tmux command of the attach", () => {
  it("fix: window-size manual + resize-window to the canonical dimension, on the right session", () => {
    expect(tmuxWindowFixArgs("vibehub-runner", "card-a1b2c3d4", { cols: 100, rows: 30 })).toEqual([
      "docker", "exec", "vibehub-runner",
      "tmux", "set-option", "-t", "card-a1b2c3d4", "window-size", "manual", ";",
      "resize-window", "-t", "card-a1b2c3d4", "-x", "100", "-y", "30",
    ]);
  });
  it("follow: unfreezes (window-size latest) when a single client is left", () => {
    expect(tmuxWindowFollowArgs("c", "card-x-sh")).toEqual([
      "docker", "exec", "c", "tmux", "set-option", "-t", "card-x-sh", "window-size", "latest",
    ]);
  });
});

describe("per-card registry — join/resize/leave", () => {
  it("the first client DEFINES the dimension from its fit; solo is never frozen", () => {
    const a = member();
    expect(joinCard("card1", a, { cols: 100, rows: 30 })).toEqual({ dim: { cols: 100, rows: 30 }, locked: false });
    expect(cardDim("card1")).toEqual({ cols: 100, rows: 30 });
    expect(cardClientCount("card1")).toBe(1);
    expect(a.notices).toHaveLength(0); // a solo client gets no freeze notice
  });

  it("first client with no valid fit: the dimension stays null until a resize defines it", () => {
    const a = member();
    expect(joinCard("card1", a, null)).toEqual({ dim: null, locked: false });
    expect(resizeCard("card1", { cols: 90, rows: 25 })).toEqual({ dim: { cols: 90, rows: 25 }, locked: false });
  });

  it("the SECOND client inherits the first's dimension (its own fit IGNORED) and freezes; the first is told", () => {
    const a = member();
    const b = member();
    joinCard("card1", a, { cols: 100, rows: 30 });
    const r = joinCard("card1", b, { cols: 200, rows: 50 }); // bigger screen — ignored
    expect(r).toEqual({ dim: { cols: 100, rows: 30 }, locked: true });
    expect(cardDim("card1")).toEqual({ cols: 100, rows: 30 });
    expect(a.notices).toEqual([{ dim: { cols: 100, rows: 30 }, locked: true }]);
    // the one that just joined is not notified by joinCard (the route pins it from the result)
    expect(b.notices).toHaveLength(0);
  });

  it("a resize from a FROZEN client does not move the dimension (the canonical one comes back)", () => {
    const a = member();
    const b = member();
    joinCard("card1", a, { cols: 100, rows: 30 });
    joinCard("card1", b, { cols: 200, rows: 50 });
    expect(resizeCard("card1", { cols: 300, rows: 60 })).toEqual({ dim: { cols: 100, rows: 30 }, locked: true });
    expect(cardDim("card1")).toEqual({ cols: 100, rows: 30 });
  });

  it("an invalid resize (0/negative) is ignored — the canonical one stays", () => {
    const a = member();
    joinCard("card1", a, { cols: 100, rows: 30 });
    expect(resizeCard("card1", clampDim(0, 0))).toEqual({ dim: { cols: 100, rows: 30 }, locked: false });
    expect(resizeCard("card1", clampDim(-1, 24))).toEqual({ dim: { cols: 100, rows: 30 }, locked: false });
  });

  it("2→1: one leaves, the survivor unfreezes and is told (locked=false); the size holds until a refit", () => {
    const a = member();
    const b = member();
    joinCard("card1", a, { cols: 100, rows: 30 });
    joinCard("card1", b, { cols: 200, rows: 50 });
    a.notices.length = 0;
    expect(leaveCard("card1", b)).toEqual({ remaining: 1, unlocked: true });
    expect(a.notices).toEqual([{ dim: { cols: 100, rows: 30 }, locked: false }]);
    // solo now: the refit redefines the dimension
    expect(resizeCard("card1", { cols: 140, rows: 42 })).toEqual({ dim: { cols: 140, rows: 42 }, locked: false });
  });

  it("the last to leave CLEARS the card (the next first client defines it again)", () => {
    const a = member();
    joinCard("card1", a, { cols: 100, rows: 30 });
    expect(leaveCard("card1", a)).toEqual({ remaining: 0, unlocked: false });
    expect(cardClientCount("card1")).toBe(0);
    expect(cardDim("card1")).toBeNull();
    const c = member();
    expect(joinCard("card1", c, { cols: 70, rows: 20 })).toEqual({ dim: { cols: 70, rows: 20 }, locked: false });
  });

  it("3 clients: one leaving does NOT unfreeze (still 2+)", () => {
    const [a, b, c] = [member(), member(), member()];
    joinCard("card1", a, { cols: 100, rows: 30 });
    joinCard("card1", b, { cols: 200, rows: 50 });
    joinCard("card1", c, { cols: 300, rows: 60 });
    expect(leaveCard("card1", c)).toEqual({ remaining: 2, unlocked: false });
    expect(resizeCard("card1", { cols: 400, rows: 70 })).toEqual({ dim: { cols: 100, rows: 30 }, locked: true });
  });

  it("different cards (and the :sh variant) never mix", () => {
    const a = member();
    const b = member();
    joinCard("card1", a, { cols: 100, rows: 30 });
    joinCard("card1:sh", b, { cols: 60, rows: 20 });
    expect(cardDim("card1")).toEqual({ cols: 100, rows: 30 });
    expect(cardDim("card1:sh")).toEqual({ cols: 60, rows: 20 });
    expect(cardClientCount("card1")).toBe(1);
    expect(cardClientCount("card1:sh")).toBe(1);
  });

  it("resizing a card nobody joined just echoes the fit back", () => {
    expect(resizeCard("ghost", { cols: 90, rows: 30 })).toEqual({ dim: { cols: 90, rows: 30 }, locked: false });
  });

  it("leaving an unknown card/member does not blow up", () => {
    expect(leaveCard("ghost", member())).toEqual({ remaining: 0, unlocked: false });
  });

  it("the same member joining twice is counted once (a Set, not a list)", () => {
    const a = member();
    joinCard("card1", a, { cols: 100, rows: 30 });
    joinCard("card1", a, { cols: 200, rows: 50 });
    expect(cardClientCount("card1")).toBe(1);
    // still solo, so the second fit was allowed to redefine the dimension
    expect(cardDim("card1")).toEqual({ cols: 200, rows: 50 });
  });
});
