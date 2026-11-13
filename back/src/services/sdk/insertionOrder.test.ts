import { describe, expect, it } from "vitest";
import { dropOldest } from "./insertionOrder.js";

describe("dropOldest", () => {
  it("tira as chaves mais antigas (ordem de inserção) até sobrar o teto, em Map e em Set", () => {
    const map = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
    dropOldest(map, 2);
    expect([...map.keys()]).toEqual(["c", "d"]);
    const set = new Set(["a", "b", "c"]);
    dropOldest(set, 1);
    expect([...set]).toEqual(["c"]);
  });

  it("não mexe numa coleção que já cabe, e teto 0 esvazia", () => {
    const map = new Map([["a", 1]]);
    dropOldest(map, 1);
    expect([...map.keys()]).toEqual(["a"]);
    dropOldest(map, 0);
    expect(map.size).toBe(0);
  });

  it("uma chave reinserida conta como nova (delete + set a move para o fim)", () => {
    const set = new Set(["a", "b", "c"]);
    set.delete("a");
    set.add("a");
    dropOldest(set, 2);
    expect([...set]).toEqual(["c", "a"]);
  });
});
