import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPANDED_KEY,
  readExpanded,
  toggleExpanded,
  withSelected,
  writeExpanded,
} from "@/features/board/lib/sidebarExpanded";

describe("toggleExpanded", () => {
  it("unfolds a project that was folded", () => {
    expect(toggleExpanded(["a"], "b")).toEqual(["a", "b"]);
  });

  it("folds one that was unfolded, leaving the others alone", () => {
    expect(toggleExpanded(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("does not mutate what it was given", () => {
    const ids = ["a"];
    toggleExpanded(ids, "b");
    expect(ids).toEqual(["a"]);
  });
});

describe("withSelected", () => {
  it("unfolds the selected project without folding anything else", () => {
    expect(withSelected(["a"], "b")).toEqual(["a", "b"]);
  });

  it("leaves the set alone when it is already there", () => {
    const ids = ["a", "b"];
    expect(withSelected(ids, "b")).toBe(ids);
  });

  it("leaves the set alone on the aggregated board, where nothing is selected", () => {
    const ids = ["a"];
    expect(withSelected(ids, null)).toBe(ids);
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips through localStorage", () => {
    writeExpanded(["a", "b"]);
    expect(readExpanded()).toEqual(["a", "b"]);
  });

  it("reads nothing when there is nothing stored", () => {
    expect(readExpanded()).toEqual([]);
  });

  it("survives a value that is not a list of ids", () => {
    localStorage.setItem(EXPANDED_KEY, '{"not":"a list"}');
    expect(readExpanded()).toEqual([]);
    localStorage.setItem(EXPANDED_KEY, "}{ broken");
    expect(readExpanded()).toEqual([]);
  });

  it("drops entries that are not strings rather than handing them to the sidebar", () => {
    localStorage.setItem(EXPANDED_KEY, '["a", 7, null, "b"]');
    expect(readExpanded()).toEqual(["a", "b"]);
  });

  it("survives storage being unavailable — the fold just does not outlive the tab", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readExpanded()).toEqual([]);
    expect(() => writeExpanded(["a"])).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
