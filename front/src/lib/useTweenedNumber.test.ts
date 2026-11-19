import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTweenedNumber } from "./useTweenedNumber";

const DURATION_MS = 700;

function stubReducedMotion(reduce: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useTweenedNumber", () => {
  it("parte do valor inicial, passa pelos intermediários e chega ao alvo no fim da duração", () => {
    stubReducedMotion(false);
    const { result, rerender } = renderHook(({ target }) => useTweenedNumber(target, DURATION_MS), { initialProps: { target: 29 } });
    expect(result.current).toBe(29);

    rerender({ target: 40 });
    act(() => vi.advanceTimersByTime(DURATION_MS / 3));
    expect(result.current).toBeGreaterThan(29);
    expect(result.current).toBeLessThan(40);

    act(() => vi.advanceTimersByTime(DURATION_MS));
    expect(result.current).toBe(40);
  });

  it("com valor inicial diferente do alvo, desliza já na montagem", () => {
    stubReducedMotion(false);
    const { result } = renderHook(() => useTweenedNumber(42, DURATION_MS, 0));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(DURATION_MS + 50));
    expect(result.current).toBe(42);
  });

  it("alvo novo no meio da transição segue do ponto onde o número está, sem voltar ao começo", () => {
    stubReducedMotion(false);
    const { result, rerender } = renderHook(({ target }) => useTweenedNumber(target, DURATION_MS), { initialProps: { target: 0 } });
    rerender({ target: 100 });
    act(() => vi.advanceTimersByTime(DURATION_MS / 2));
    const midway = result.current;
    expect(midway).toBeGreaterThan(0);

    rerender({ target: 50 });
    act(() => vi.advanceTimersByTime(16));
    expect(Math.abs(result.current - midway)).toBeLessThan(10);
    act(() => vi.advanceTimersByTime(DURATION_MS + 50));
    expect(result.current).toBe(50);
  });

  it("com prefers-reduced-motion o número vai direto ao alvo, sem quadro intermediário", () => {
    stubReducedMotion(true);
    const { result, rerender } = renderHook(({ target }) => useTweenedNumber(target, DURATION_MS, 0), { initialProps: { target: 29 } });
    expect(result.current).toBe(29);
    rerender({ target: 30 });
    expect(result.current).toBe(30);
  });
});
