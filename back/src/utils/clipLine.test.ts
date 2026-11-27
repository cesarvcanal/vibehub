import { describe, expect, it } from "vitest";
import { clipLine } from "./clipLine.js";

describe("clipLine", () => {
  it("colapsa espaços e quebras numa linha só", () => {
    expect(clipLine("  a\n\n b\t c  ", 10)).toBe("a b c");
  });

  it("acima do teto corta em max-1 e põe …; no teto passa inteiro", () => {
    expect(clipLine("abcdef", 4)).toBe("abc…");
    expect(clipLine("abcd", 4)).toBe("abcd");
  });

  it("o corte nunca parte um emoji ao meio: o texto cortado continua Unicode válido", () => {
    expect(clipLine("abc😀def", 5)).toBe("abc…");
  });

  it("texto ausente é a linha vazia", () => {
    expect(clipLine(undefined, 10)).toBe("");
  });
});
