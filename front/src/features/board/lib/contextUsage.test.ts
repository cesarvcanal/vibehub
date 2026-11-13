import { describe, it, expect } from "vitest";
import { CONTEXT_DANGER_AT, CONTEXT_WARN_AT, contextHue, contextZone, parseContextUsage } from "./contextUsage";

describe("contextZone — as três faixas", () => {
  it.each([
    [0, "smart"],
    [29.9, "smart"],
    [CONTEXT_WARN_AT, "warn"],
    [59.9, "warn"],
    [CONTEXT_DANGER_AT, "danger"],
    [100, "danger"],
    [Number.NaN, "smart"],
  ] as const)("%s%% → %s", (pct, zone) => {
    expect(contextZone(pct)).toBe(zone);
  });
});

describe("contextHue — a cor desliza, não pula", () => {
  it("verde firme no começo, amarelo na fronteira dos 30%, vermelho nos 60%", () => {
    expect(contextHue(0)).toBe(142);
    expect(contextHue(15)).toBe(142);
    expect(contextHue(30)).toBe(48);
    expect(contextHue(60)).toBe(6);
    expect(contextHue(100)).toBe(0);
  });

  it("só esfria nunca: o matiz desce sem degrau de um ponto para o outro", () => {
    let prev = contextHue(0);
    for (let p = 1; p <= 100; p++) {
      const h = contextHue(p);
      expect(h).toBeLessThanOrEqual(prev);
      // A visible step would be a big jump between two neighbouring points.
      expect(prev - h).toBeLessThan(10);
      prev = h;
    }
  });

  it("entre as âncoras o tom é intermediário (25% já avisa que o amarelo vem aí)", () => {
    const h = contextHue(25);
    expect(h).toBeLessThan(142);
    expect(h).toBeGreaterThan(48);
  });

  it("fora de 0..100 prende nas pontas", () => {
    expect(contextHue(-5)).toBe(142);
    expect(contextHue(250)).toBe(0);
  });
});

describe("parseContextUsage", () => {
  it("aceita a leitura do back", () => {
    expect(parseContextUsage({ usedTokens: 84_000, maxTokens: 200_000, percent: 42, model: "claude-opus-5-5" }))
      .toEqual({ usedTokens: 84_000, maxTokens: 200_000, percent: 42, model: "claude-opus-5-5" });
  });


  it.each([
    {},
    { usedTokens: 10 },
    { usedTokens: 10, maxTokens: 0 },
    { usedTokens: -1, maxTokens: 10 },
    { usedTokens: "1", maxTokens: 10, percent: 10 },
    { usedTokens: 50_000, maxTokens: 200_000 },
    { usedTokens: 1, maxTokens: 2, percent: 140 },
    { usedTokens: 1, maxTokens: 2, percent: Number.NaN },
  ])("leitura torta não vira medidor: %j", (raw) => {
    expect(parseContextUsage(raw)).toBeNull();
  });
});
