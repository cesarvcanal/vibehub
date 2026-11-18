import { describe, it, expect } from "vitest";
import { findUnseenFailureIds } from "./unseenFailures";

describe("falhas ainda não anunciadas", () => {
  it("anuncia só as abertas que este navegador ainda não viu", () => {
    const failures = [
      { id: "a", status: "open" as const },
      { id: "b", status: "open" as const },
      { id: "c", status: "investigating" as const },
    ];
    expect(findUnseenFailureIds(failures, new Set(["a"]))).toEqual(["b"]);
  });
});
