import { describe, it, expect, beforeEach } from "vitest";
import { findUnseenFailureIds, readSeenFailureIds } from "./unseenFailures";

beforeEach(() => sessionStorage.clear());

describe("falhas ainda não anunciadas", () => {
  it("anuncia só as abertas que este navegador ainda não viu", () => {
    const failures = [
      { id: "a", status: "open" as const },
      { id: "b", status: "open" as const },
      { id: "c", status: "investigating" as const },
    ];
    expect(findUnseenFailureIds(failures, new Set(["a"]))).toEqual(["b"]);
  });

  it.each([
    ["uma lista com itens que não são id", JSON.stringify([1, "a", null]), ["a"]],
    ["um objeto no lugar da lista", JSON.stringify({ a: 1 }), []],
    ["um texto que não é JSON", "{quebrado", []],
  ])("o que outra versão deixou guardado (%s) só vale pelos ids em texto", (_case, storedValue, expectedIds) => {
    sessionStorage.setItem("vibehub.platformFailures.seen", storedValue);
    expect([...readSeenFailureIds()]).toEqual(expectedIds);
  });
});
