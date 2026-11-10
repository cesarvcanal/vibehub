import { describe, expect, it } from "vitest";
import { defuseUltraWords, defusedCommandList } from "./ultraWords.js";

describe("defuseUltraWords", () => {
  it("quebra as duas palavras reservadas em qualquer caixa e mantém o resto do texto", () => {
    expect(defuseUltraWords("mantém o ultracode; ULTRATHINK e UltraCode.")).toBe("mantém o ultra-code; ULTRA-THINK e Ultra-Code.");
  });

  it("só onde o detector reconhece: palavra dentro de outra, caminho, flag e branch ficam como estão", () => {
    for (const text of ["ultracodec", "ultraRaised", "src/ultracode.ts", "ultracode.test.ts", "--ultrathink-x", "card/suporte-ultracode-ab12", "ultracode?"]) {
      expect(defuseUltraWords(text)).toBe(text);
    }
  });
});

describe("defusedCommandList", () => {
  it("avisa que tirou o hífen só quando algum comando mudou", () => {
    expect(defusedCommandList(["npm test"])).toBe("- npm test");
    expect(defusedCommandList(["npm test", "vitest -t ULTRATHINK"])).toBe(
      "- npm test\n- vitest -t ULTRA-THINK\n(palavras reservadas quebradas com hífen nesta lista; o comando original não tem o hífen)",
    );
  });
});
