import { describe, expect, it } from "vitest";
import {
  MENU_MARGIN,
  MENU_WIDTH,
  clampMenuPoint,
} from "@/features/board/lib/contextMenu";

/**
 * The whole point of a point-anchored menu is that a card needs no visible trigger; the whole risk
 * is that nothing stops it from opening off-screen. These are the corners you would otherwise only
 * find by right-clicking the last card in the rightmost column.
 */

const VIEWPORT = { width: 1200, height: 800 };
const MENU = { width: MENU_WIDTH, height: 100 };

describe("clampMenuPoint", () => {
  it("opens at the click when there is room, down and to the right", () => {
    expect(clampMenuPoint({ x: 300, y: 200 }, VIEWPORT, MENU)).toEqual({ left: 300, top: 200 });
  });

  it("pushes left rather than letting the panel hang off the right edge", () => {
    const { left } = clampMenuPoint({ x: 1190, y: 100 }, VIEWPORT, MENU);
    expect(left).toBe(VIEWPORT.width - MENU_WIDTH - MENU_MARGIN);
    expect(left + MENU_WIDTH).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("flips upward when the panel would not fit below — the click becomes its bottom edge", () => {
    const { top } = clampMenuPoint({ x: 100, y: 780 }, VIEWPORT, MENU);
    expect(top).toBe(780 - MENU.height);
    expect(top + MENU.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it("does not flip when there is room below, even near the middle", () => {
    expect(clampMenuPoint({ x: 100, y: 400 }, VIEWPORT, MENU).top).toBe(400);
  });

  it("flips upward even in a tight viewport, as long as the margin still fits", () => {
    // 120px tall, 100px menu: flipped, the top lands at 10 — clear of the 8px margin.
    const { top } = clampMenuPoint({ x: 10, y: 110 }, { width: 1200, height: 120 }, MENU);
    expect(top).toBe(10);
    expect(top + MENU.height).toBeLessThanOrEqual(120);
  });

  it("falls back to the margin when the panel is taller than the viewport itself", () => {
    // Nowhere fits: neither direction can hold a 100px panel in 100px of screen.
    const { top } = clampMenuPoint({ x: 10, y: 60 }, { width: 1200, height: 100 }, MENU);
    expect(top).toBe(MENU_MARGIN);
  });

  it("keeps the margin when the panel is wider than the viewport, rather than going negative", () => {
    const { left, top } = clampMenuPoint({ x: 50, y: 50 }, { width: 200, height: 100 }, MENU);
    expect(left).toBe(MENU_MARGIN);
    expect(top).toBe(MENU_MARGIN);
  });

  it("never places the panel above or left of the margin", () => {
    const { left, top } = clampMenuPoint({ x: 0, y: 0 }, VIEWPORT, MENU);
    expect(left).toBe(MENU_MARGIN);
    expect(top).toBe(MENU_MARGIN);
  });

  it("grows the flip threshold with the number of items", () => {
    // A three-item menu fits below y=600; a fifteen-item one does not and flips.
    const short = clampMenuPoint({ x: 100, y: 600 }, VIEWPORT, { width: MENU_WIDTH, height: 100 });
    const tall = clampMenuPoint({ x: 100, y: 600 }, VIEWPORT, { width: MENU_WIDTH, height: 460 });
    expect(short.top).toBe(600);
    expect(tall.top).toBe(140);
  });
});
