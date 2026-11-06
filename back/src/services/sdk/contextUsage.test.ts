import { describe, it, expect } from "vitest";
import { normalizeContextUsage } from "./contextUsage.js";

describe("normalizeContextUsage", () => {
  it("calcula o percentual sobre a janela crua que veio do driver", () => {
    expect(normalizeContextUsage({ usedTokens: 84_000, maxTokens: 200_000, model: "claude-opus-5-5" }))
      .toEqual({ usedTokens: 84_000, maxTokens: 200_000, percent: 42, model: "claude-opus-5-5" });
  });

  it("arredonda tokens e prende o percentual em 0..100 (conversa que passou da janela antes do compact)", () => {
    expect(normalizeContextUsage({ usedTokens: 210_000.4, maxTokens: 200_000 })).toEqual({ usedTokens: 210_000, maxTokens: 200_000, percent: 100 });
  });

  it("zero tokens é leitura válida (sessão recém-aberta)", () => {
    expect(normalizeContextUsage({ usedTokens: 0, maxTokens: 1_000_000 })?.percent).toBe(0);
  });

  it.each([
    null,
    "x",
    {},
    { usedTokens: 10 },
    { usedTokens: 10, maxTokens: 0 },
    { usedTokens: -1, maxTokens: 100 },
    { usedTokens: Number.NaN, maxTokens: 100 },
    { usedTokens: "10", maxTokens: 100 },
  ])("sem janela para medir não há leitura: %j", (raw) => {
    expect(normalizeContextUsage(raw)).toBeNull();
  });
});
