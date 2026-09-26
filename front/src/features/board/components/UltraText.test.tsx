import * as React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UltraFieldOverlay, UltraText } from "@/features/board/components/UltraText";
import {
  ULTRA_CODE_PALETTE,
  ULTRA_CODE_SHIMMER,
  ULTRA_RAINBOW,
  ULTRA_SHIMMER,
  ultraCycleMs,
  ultraDelayMs,
} from "@/features/board/lib/ultraWords";

describe("UltraText", () => {
  it("paints the reserved words and leaves the rest of the sentence alone", () => {
    render(<p data-testid="line"><UltraText text="faz ultrathink e ultracode nisso" /></p>);
    const words = screen.getAllByTestId("ultra-word");
    expect(words.map((w) => w.getAttribute("data-word"))).toEqual(["ultrathink", "ultracode"]);
    // The sentence itself is untouched: nothing added, nothing dropped.
    expect(screen.getByTestId("line")).toHaveTextContent("faz ultrathink e ultracode nisso");
  });

  it("keeps the case the person typed", () => {
    render(<UltraText text="ULTRATHINK agora" />);
    expect(screen.getByTestId("ultra-word")).toHaveTextContent("ULTRATHINK");
    expect(screen.getByTestId("ultra-word").getAttribute("data-word")).toBe("ultrathink");
  });

  it("gives every letter its own colour and its own step of the sweep", () => {
    render(<UltraText text="ultrathink" />);
    const letters = [...screen.getByTestId("ultra-word").querySelectorAll<HTMLElement>(".vh-ultra-char")];
    expect(letters).toHaveLength("ultrathink".length);
    letters.forEach((letter, i) => {
      expect(letter.style.getPropertyValue("--vh-ultra-base")).toBe(ULTRA_RAINBOW[i % 7]);
      expect(letter.style.getPropertyValue("--vh-ultra-shimmer")).toBe(ULTRA_SHIMMER[i % 7]);
      expect(letter.style.animationDuration).toBe(`${ultraCycleMs("ultrathink".length)}ms`);
      expect(letter.style.animationDelay).toBe(`${ultraDelayMs(i, "ultrathink".length)}ms`);
    });
  });

  /**
   * THE TWO WORDS ARE NOT THE SAME REQUEST, so they must not be the same colours: `ultrathink`
   * buys deeper reasoning, `ultracode` turns the turn into multi-agent orchestration. Painted with
   * one shared rainbow they were indistinguishable on screen.
   */
  it("paints ultracode in its OWN palette, never the rainbow of ultrathink", () => {
    render(<UltraText text="ultracode" />);
    const word = screen.getByTestId("ultra-word");
    expect(word.getAttribute("data-keyword")).toBe("ultracode");
    const letters = [...word.querySelectorAll<HTMLElement>(".vh-ultra-char")];
    letters.forEach((letter, i) => {
      expect(letter.style.getPropertyValue("--vh-ultra-base")).toBe(ULTRA_CODE_PALETTE[i % 7]);
      expect(letter.style.getPropertyValue("--vh-ultra-shimmer")).toBe(ULTRA_CODE_SHIMMER[i % 7]);
    });
    // Same sweep mechanics, different hues — and no hue in common with the other word.
    expect(new Set(ULTRA_CODE_PALETTE).size).toBe(7);
    expect(ULTRA_CODE_PALETTE.some((c) => (ULTRA_RAINBOW as readonly string[]).includes(c))).toBe(false);
  });

  it("two keywords in one line each keep their own palette", () => {
    render(<UltraText text="faz ultrathink e depois ultracode" />);
    const words = screen.getAllByTestId("ultra-word");
    expect(words.map((w) => w.getAttribute("data-keyword"))).toEqual(["ultrathink", "ultracode"]);
    const base = (w: HTMLElement) =>
      (w.querySelector<HTMLElement>(".vh-ultra-char") as HTMLElement).style.getPropertyValue("--vh-ultra-base");
    expect(base(words[0] as HTMLElement)).toBe(ULTRA_RAINBOW[0]);
    expect(base(words[1] as HTMLElement)).toBe(ULTRA_CODE_PALETTE[0]);
  });

  it("renders nothing special when there is no keyword", () => {
    render(<p data-testid="line"><UltraText text="uma mensagem comum" /></p>);
    expect(screen.queryByTestId("ultra-word")).not.toBeInTheDocument();
    expect(screen.getByTestId("line")).toHaveTextContent("uma mensagem comum");
  });
});

/** The overlay needs a real textarea to mirror — this is the composer's shape, in miniature. */
function Field({ text }: { text: string }) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  return (
    <div className="relative">
      <textarea ref={ref} readOnly value={text} />
      <UltraFieldOverlay target={ref} text={text} />
    </div>
  );
}

describe("UltraFieldOverlay", () => {
  it("does not exist at all while the draft has no reserved word", () => {
    render(<Field text="mensagem normal" />);
    expect(screen.queryByTestId("composer-ultra-mirror")).not.toBeInTheDocument();
  });

  it("mirrors the field, hidden from assistive tech and from the pointer", () => {
    render(<Field text="manda ultrathink nisso" />);
    const mirror = screen.getByTestId("composer-ultra-mirror");
    expect(mirror).toHaveAttribute("aria-hidden", "true");
    expect(mirror.className).toContain("pointer-events-none");
    // The whole draft is mirrored, so the coloured letters land on the field's own.
    expect(mirror).toHaveTextContent("manda ultrathink nisso");
    expect(screen.getByTestId("ultra-word")).toHaveTextContent("ultrathink");
  });
});
