import { describe, expect, it } from "vitest";
import { gapToPosition, isBelowMidpoint } from "@/features/board/components/ProjectSidebar";

describe("isBelowMidpoint", () => {
  it("is the bottom half that means 'drop after this row'", () => {
    expect(isBelowMidpoint(30, 0, 40)).toBe(true);
    expect(isBelowMidpoint(10, 0, 40)).toBe(false);
  });

  it("counts the exact midpoint as below, so there is no dead zone", () => {
    expect(isBelowMidpoint(20, 0, 40)).toBe(true);
  });

  it("works away from the top of the page", () => {
    expect(isBelowMidpoint(510, 500, 40)).toBe(false);
    expect(isBelowMidpoint(530, 500, 40)).toBe(true);
  });
});

describe("gapToPosition", () => {
  it("accounts for the moved row being taken out first", () => {
    // Moving row 0 into the gap after row 2: once row 0 is removed, that gap is index 2.
    expect(gapToPosition(3, 0)).toBe(2);
  });

  it("leaves a gap above the moved row alone", () => {
    expect(gapToPosition(1, 3)).toBe(1);
  });

  it("is a no-op on either side of the row itself", () => {
    expect(gapToPosition(2, 2)).toBe(2);
    expect(gapToPosition(3, 2)).toBe(2);
  });
});
