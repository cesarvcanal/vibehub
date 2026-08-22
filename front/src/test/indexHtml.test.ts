import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shell document.
 *
 * `index.html` is the one file no component test can reach, and it carries the single line that
 * decides whether a phone is usable at all: the viewport. Without `maximum-scale=1` iOS Safari
 * zooms the page in whenever a field is focused — and it does NOT zoom back out when the keyboard
 * closes, which is why the owner ended every message by pinching the page back to size.
 */
const html = readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");

describe("index.html viewport", () => {
  const viewport = /<meta\s+name="viewport"\s+content="([^"]+)"/.exec(html.replace(/\s+/g, " "))?.[1] ?? "";

  it("declares exactly one viewport meta", () => {
    expect(html.match(/name="viewport"/g)).toHaveLength(1);
  });

  it("pins the scale, so a focused input cannot zoom the page", () => {
    expect(viewport).toContain("maximum-scale=1");
  });

  it("still fits the device width and covers the notch", () => {
    expect(viewport).toContain("width=device-width");
    expect(viewport).toContain("initial-scale=1");
    // `viewport-fit=cover` is what `100dvh` measures against on an iPhone.
    expect(viewport).toContain("viewport-fit=cover");
  });
});
