import { describe, expect, it } from "vitest";
import {
  CARD_MAIN_PADDING_PX,
  TERM_MAX,
  TERM_MIN,
  cardViewHeight,
  clampTermSize,
  fitDimensions,
  isValidTermSize,
  resizeFrame,
} from "@/features/board/lib/focusMode";

describe("cardViewHeight", () => {
  it("subtracts the MEASURED header, not a guessed one", () => {
    // The header is not a constant — it wraps on a phone — so the shell publishes its real height
    // and the card view reads it. The fallback only covers the frame before the first measurement.
    expect(cardViewHeight()).toBe(
      `calc(100vh - var(--app-header-h, 64px) - ${CARD_MAIN_PADDING_PX}px)`,
    );
    expect(cardViewHeight(0)).toBe("calc(100vh - var(--app-header-h, 64px) - 0px)");
  });

  it("never produces a negative subtraction", () => {
    expect(cardViewHeight(-20)).toBe("calc(100vh - var(--app-header-h, 64px) - 0px)");
  });
});

describe("terminal sizes", () => {
  it("accepts only whole numbers inside the range the runner validates", () => {
    expect(isValidTermSize(TERM_MIN)).toBe(true);
    expect(isValidTermSize(TERM_MAX)).toBe(true);
    expect(isValidTermSize(TERM_MIN - 1)).toBe(false);
    expect(isValidTermSize(TERM_MAX + 1)).toBe(false);
    expect(isValidTermSize(80.5)).toBe(false);
    expect(isValidTermSize("80")).toBe(false);
  });

  it("clamps into that range and truncates", () => {
    expect(clampTermSize(3)).toBe(TERM_MIN);
    expect(clampTermSize(9_000)).toBe(TERM_MAX);
    expect(clampTermSize(80.9)).toBe(80);
    expect(clampTermSize(Number.NaN)).toBe(TERM_MIN);
  });
});

describe("resizeFrame", () => {
  it("is the frame the terminal bridge parses", () => {
    expect(resizeFrame(120, 30)).toEqual({ type: "resize", cols: 120, rows: 30 });
  });

  it("clamps a measurement the runner would reject rather than sending it", () => {
    expect(resizeFrame(4, 2)).toEqual({ type: "resize", cols: TERM_MIN, rows: TERM_MIN });
  });

  it("sends nothing at all when the element measured as zero", () => {
    // A detached or hidden holder measures 0; resizing the agent's pty to that would wreck it.
    expect(resizeFrame(0, 0)).toBeNull();
    expect(resizeFrame(80, 0)).toBeNull();
    expect(resizeFrame(Number.NaN, 24)).toBeNull();
  });
});

describe("fitDimensions", () => {
  it("floors the division — a partial row is not a row", () => {
    expect(fitDimensions({ width: 800, height: 599 }, { width: 8, height: 20 })).toEqual({
      cols: 100,
      rows: 29,
    });
  });

  it("is why the holder must be clean: padding eaten off the box costs a row", () => {
    const cell = { width: 8, height: 20 };
    const padded = fitDimensions({ width: 800, height: 600 }, cell);
    const clean = fitDimensions({ width: 800 - 16, height: 600 - 16 }, cell);
    expect(padded?.rows).toBe(30);
    expect(clean?.rows).toBe(29);
  });

  it("refuses to answer without a real box or a real cell", () => {
    expect(fitDimensions({ width: 0, height: 600 }, { width: 8, height: 20 })).toBeNull();
    expect(fitDimensions({ width: 800, height: 600 }, { width: 0, height: 20 })).toBeNull();
  });
});
