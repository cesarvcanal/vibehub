import { describe, expect, it } from "vitest";
import {
  ULTRA_CODE_PALETTE,
  ULTRA_CODE_SHIMMER,
  ULTRA_RAINBOW,
  ULTRA_SHIMMER,
  findUltraWords,
  hasUltraWord,
  ultraColor,
  ultraCycleMs,
  ultraDelayMs,
  ultraKeywords,
} from "@/features/board/lib/ultraWords";

describe("findUltraWords", () => {
  it("finds both keywords, in the order they appear, keeping the case that was typed", () => {
    expect(findUltraWords("primeiro ULTRATHINK e depois UltraCode")).toEqual([
      { word: "ULTRATHINK", keyword: "ultrathink", start: 9, end: 19 },
      { word: "UltraCode", keyword: "ultracode", start: 29, end: 38 },
    ]);
  });

  it("is case-insensitive — the caps are the person's, the keyword is the same request", () => {
    for (const written of ["ultrathink", "ULTRATHINK", "UltraThink", "uLtRaThInK"]) {
      expect(hasUltraWord(`faz ${written} nisso`)).toBe(true);
    }
  });

  it("wants the WHOLE word: a keyword glued to more letters is another word", () => {
    expect(findUltraWords("ultrathinking sobre ultracodes")).toEqual([]);
  });

  /**
   * O BUG DO CÉSAR (produção, 2026-09-28): ele mandou uma mensagem que começava com
   * `/superpowers:systematic-debugging`, escreveu parágrafos de contexto e terminou com
   * `ultracode` — e o painel não escalou nada. A regra antiga descartava a mensagem INTEIRA por
   * causa da primeira letra: "começou com barra, então nada aqui é palavra reservada".
   *
   * O que é comando é o PRIMEIRO TOKEN, não a mensagem. O que vem depois dele são os argumentos —
   * prosa, que o comando expande para dentro do prompt, e onde a palavra reservada vale como
   * valeria em qualquer outra frase. O nome do comando segue de fora: `/ultracode-review` é o nome
   * de um comando, não um pedido de esforço.
   */
  it("o NOME do comando não é palavra reservada — mas o que vem depois dele é prosa", () => {
    expect(findUltraWords("/ultrathink")).toEqual([]);
    expect(findUltraWords("/ultracode-review agora")).toEqual([]);
    expect(findUltraWords("/review ultrathink").map((m) => m.keyword)).toEqual(["ultrathink"]);
  });

  it("o caso real: comando no começo, contexto no meio, palavra reservada no fim", () => {
    const text = [
      "/superpowers:systematic-debugging preciso que voce confira 2 coisas pra mim.",
      "Confere as mensagens em massa e o disco do KVM1, sem deletar nada... ultracode",
    ].join("\n");
    expect(ultraKeywords(text)).toEqual({ ultrathink: false, ultracode: true });
  });

  it("ignores a keyword that is part of a path, a flag or a filename", () => {
    expect(findUltraWords("abre src/ultracode/index.ts")).toEqual([]);
    expect(findUltraWords("roda com --ultrathink")).toEqual([]);
    expect(findUltraWords("o arquivo ultracode.md")).toEqual([]);
    expect(findUltraWords("/work/.uploads/x/ultrathink.png")).toEqual([]);
  });

  it("ignores a keyword being QUOTED — the word discussed, not the word asked for", () => {
    expect(findUltraWords("a palavra `ultracode` é reservada")).toEqual([]);
    expect(findUltraWords('escreve "ultrathink" no começo')).toEqual([]);
    expect(findUltraWords("(ultrathink) entre parênteses")).toEqual([]);
  });

  it("still finds the word next to ordinary punctuation", () => {
    expect(findUltraWords("manda ultrathink, por favor").map((m) => m.word)).toEqual(["ultrathink"]);
    expect(findUltraWords("usa ultracode.").map((m) => m.word)).toEqual(["ultracode"]);
  });

  it("answers the keyword question the driver asks", () => {
    expect(ultraKeywords("só ultrathink")).toEqual({ ultrathink: true, ultracode: false });
    expect(ultraKeywords("só ultracode")).toEqual({ ultrathink: false, ultracode: true });
    expect(ultraKeywords("ultrathink e ultracode")).toEqual({ ultrathink: true, ultracode: true });
    expect(ultraKeywords("nada disso aqui")).toEqual({ ultrathink: false, ultracode: false });
  });

  it("says no fast for text that does not even contain the letters", () => {
    expect(hasUltraWord("uma mensagem qualquer")).toBe(false);
    expect(hasUltraWord("")).toBe(false);
  });
});

describe("the sweep", () => {
  it("gives each letter its own hue, cycling through the seven the TUI uses", () => {
    expect(ultraColor(0)).toBe(ULTRA_RAINBOW[0]);
    expect(ultraColor(6)).toBe(ULTRA_RAINBOW[6]);
    expect(ultraColor(7)).toBe(ULTRA_RAINBOW[0]); // round again
    expect(ultraColor(0, true)).toBe(ULTRA_SHIMMER[0]);
    expect(ultraColor(9, true)).toBe(ULTRA_SHIMMER[2]);
  });

  it("runs one full sweep per (length + 20) steps of 50ms — the CLI's own pacing", () => {
    expect(ultraCycleMs(10)).toBe(1500); // ultrathink
    expect(ultraCycleMs(9)).toBe(1450); // ultracode
  });

  it("delays each letter one step further than the last, always inside one cycle behind", () => {
    const length = 10;
    const cycle = ultraCycleMs(length);
    for (let i = 0; i < length; i += 1) {
      const delay = ultraDelayMs(i, length);
      expect(delay).toBeLessThan(0); // the animation must already be running when the page paints
      expect(delay).toBeGreaterThan(-cycle);
      if (i > 0) expect(delay - ultraDelayMs(i - 1, length)).toBe(50);
    }
  });
});

describe("ultraColor — one palette per keyword", () => {
  it("ultrathink keeps the TUI rainbow and is the default", () => {
    expect(ultraColor(0, false, "ultrathink")).toBe(ULTRA_RAINBOW[0]);
    expect(ultraColor(3)).toBe(ULTRA_RAINBOW[3]);
    expect(ultraColor(3, true)).toBe(ULTRA_SHIMMER[3]);
  });

  it("ultracode gets its own cold ramp, and it rounds the same way", () => {
    expect(ultraColor(0, false, "ultracode")).toBe(ULTRA_CODE_PALETTE[0]);
    expect(ultraColor(7, false, "ultracode")).toBe(ULTRA_CODE_PALETTE[0]);
    expect(ultraColor(2, true, "ultracode")).toBe(ULTRA_CODE_SHIMMER[2]);
    // The whole point: the two words can never come out the same colour.
    expect(ultraColor(0, false, "ultracode")).not.toBe(ultraColor(0, false, "ultrathink"));
  });
});
