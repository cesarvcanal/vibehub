import { describe, expect, it } from "vitest";
import { defuseUltraWords } from "./ultraWords.js";

describe("defuseUltraWords", () => {
  it("quebra as duas palavras reservadas em qualquer caixa e mantém o resto do texto", () => {
    expect(defuseUltraWords("mantém o ultracode; ULTRATHINK e UltraCode.")).toBe("mantém o ultra-code; ULTRA-THINK e Ultra-Code.");
  });

  it("texto sem palavra reservada sai igual", () => {
    expect(defuseUltraWords("ultraRaised, ultra, ultra-code")).toBe("ultraRaised, ultra, ultra-code");
  });
});
