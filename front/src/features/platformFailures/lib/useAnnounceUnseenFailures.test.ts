import { describe, it, expect, beforeEach } from "vitest";
import { readSeenFailureIds } from "./useAnnounceUnseenFailures";

beforeEach(() => sessionStorage.clear());

describe("ids de falha já anunciados neste navegador", () => {
  it.each([
    ["uma lista com itens que não são id", JSON.stringify([1, "a", null]), ["a"]],
    ["um objeto no lugar da lista", JSON.stringify({ a: 1 }), []],
    ["um texto que não é JSON", "{quebrado", []],
  ])("o que outra versão deixou guardado (%s) só vale pelos ids em texto", (_case, storedValue, expectedIds) => {
    sessionStorage.setItem("vibehub.platformFailures.seen", storedValue);
    expect([...readSeenFailureIds()]).toEqual(expectedIds);
  });
});
