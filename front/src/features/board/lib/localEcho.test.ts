import { describe, expect, it } from "vitest";
import {
  LOCAL_ECHO_QUIET_MS,
  LocalEcho,
  isPredictableKey,
  predictionEraseSequence,
  shouldPredict,
} from "@/features/board/lib/localEcho";

describe("isPredictableKey", () => {
  it("accepts a single printable character", () => {
    expect(isPredictableKey("a")).toBe(true);
    expect(isPredictableKey("Z")).toBe(true);
    expect(isPredictableKey(" ")).toBe(true);
    expect(isPredictableKey("/")).toBe(true);
  });

  it("refuses the keys that change the flow rather than echoing", () => {
    expect(isPredictableKey("\r")).toBe(false); // Enter submits
    expect(isPredictableKey("\t")).toBe(false); // Tab completes
    expect(isPredictableKey("\x03")).toBe(false); // Ctrl-C
    expect(isPredictableKey("\x7f")).toBe(false); // backspace
  });

  it("refuses anything that is not exactly one character — arrows and pastes come as strings", () => {
    expect(isPredictableKey("\x1b[A")).toBe(false);
    expect(isPredictableKey("pasted text")).toBe(false);
    expect(isPredictableKey("")).toBe(false);
  });
});

describe("shouldPredict", () => {
  it("stays silent while the server is mid-repaint", () => {
    expect(shouldPredict("a", { enabled: true, msSinceServerOutput: 5 })).toBe(false);
  });

  it("predicts once the server has gone quiet", () => {
    expect(shouldPredict("a", { enabled: true, msSinceServerOutput: LOCAL_ECHO_QUIET_MS })).toBe(true);
  });

  it("never predicts when it is switched off, however quiet things are", () => {
    expect(shouldPredict("a", { enabled: false, msSinceServerOutput: 10_000 })).toBe(false);
  });

  it("honours a custom quiet window", () => {
    expect(shouldPredict("a", { enabled: true, msSinceServerOutput: 100, quietMs: 500 })).toBe(false);
    expect(shouldPredict("a", { enabled: true, msSinceServerOutput: 600, quietMs: 500 })).toBe(true);
  });
});

describe("predictionEraseSequence", () => {
  it("steps back one column per prediction and clears to end of line", () => {
    expect(predictionEraseSequence(3)).toBe("\b\b\b\x1b[K");
  });

  it("erases nothing when nothing was predicted", () => {
    expect(predictionEraseSequence(0)).toBe("");
    expect(predictionEraseSequence(-2)).toBe("");
  });
});

/** A clock a test can wind forward, plus the writes the terminal received. */
function harness(options: { enabled?: boolean; quietMs?: number } = {}) {
  let now = 1_000;
  const written: string[] = [];
  const echo = new LocalEcho({
    term: { write: (s) => written.push(s) },
    now: () => now,
    ...options,
  });
  return {
    echo,
    written,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("LocalEcho", () => {
  it("does not predict straight after opening — the prompt is still being painted", () => {
    const { echo, written } = harness();
    expect(echo.key("a")).toBe(false);
    expect(written).toEqual([]);
  });

  it("paints a keystroke once the server has been quiet long enough", () => {
    const { echo, written, advance } = harness();
    advance(LOCAL_ECHO_QUIET_MS);
    expect(echo.key("h")).toBe(true);
    expect(written).toEqual(["h"]);
    expect(echo.pendingCount).toBe(1);
  });

  it("reconciles: server output erases exactly what was predicted, before the truth is written", () => {
    const { echo, written, advance } = harness();
    advance(LOCAL_ECHO_QUIET_MS);
    echo.key("h");
    echo.key("i");
    expect(echo.pendingCount).toBe(2);

    echo.serverOutput();
    expect(written).toEqual(["h", "i", "\b\b\x1b[K"]);
    expect(echo.pendingCount).toBe(0);
  });

  it("writes no erase sequence when there was nothing to reconcile", () => {
    const { echo, written, advance } = harness();
    advance(LOCAL_ECHO_QUIET_MS);
    echo.serverOutput();
    expect(written).toEqual([]);
  });

  it("goes quiet again as soon as the server speaks, and only predicts after the window", () => {
    const { echo, advance } = harness();
    advance(LOCAL_ECHO_QUIET_MS);
    echo.serverOutput(); // a repaint burst just landed
    expect(echo.key("a")).toBe(false);
    advance(LOCAL_ECHO_QUIET_MS - 1);
    expect(echo.key("a")).toBe(false);
    advance(1);
    expect(echo.key("a")).toBe(true);
  });

  it("never predicts Enter, so a submitted line is never painted twice", () => {
    const { echo, written, advance } = harness();
    advance(LOCAL_ECHO_QUIET_MS);
    expect(echo.key("\r")).toBe(false);
    expect(written).toEqual([]);
  });

  it("declines everything when disabled — the path is identical to having no echo at all", () => {
    const { echo, written, advance } = harness({ enabled: false });
    advance(10_000);
    expect(echo.key("a")).toBe(false);
    expect(written).toEqual([]);
  });

  it("drops pending predictions on reset, so a reattach cannot erase the new session's output", () => {
    const { echo, written, advance } = harness();
    advance(LOCAL_ECHO_QUIET_MS);
    echo.key("a");
    echo.reset();
    expect(echo.pendingCount).toBe(0);
    echo.serverOutput();
    expect(written).toEqual(["a"]);
  });
});
