import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LivingOrb } from "./LivingOrb";
import type { LivingEngine } from "./engine";

/** A 2D context that accepts every call — jsdom has none. */
function fakeContext(): CanvasRenderingContext2D {
  return new Proxy({}, { get: (_t, key) => (key === "canvas" ? undefined : () => undefined), set: () => true }) as never;
}

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeContext() as never);
});
afterEach(() => vi.restoreAllMocks());

/** Runs the pending animation frames `n` times, 1/60 s apart. */
function tick(n: number): void {
  let time = 0;
  for (let i = 0; i < n; i++) {
    const pending = frames;
    frames = [];
    time += 1000 / 60;
    for (const cb of pending) cb(time);
  }
}

describe("LivingOrb", () => {
  it("animates, follows the mode prop and the right sound for each mode", () => {
    let engine: LivingEngine | null = null;
    const onEngine = (e: LivingEngine | null) => (engine = e);
    const { rerender } = render(<LivingOrb mode="logo" listenLevel={1} talkLevel={1} onEngine={onEngine} />);
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-mode", "logo");
    tick(30);
    expect(engine!.mode).toBe("logo");
    expect(engine!.voice).toBeLessThan(0.01);

    rerender(<LivingOrb mode="listen" listenLevel={0.9} talkLevel={0} onEngine={onEngine} />);
    expect(engine!.mode).toBe("listen");
    expect(engine!.transition).toBe("ret");
    tick(40);
    expect(engine!.voice).toBeGreaterThan(0.8);

    // The assistant replies: its level drives the sphere, the mic is ignored.
    rerender(<LivingOrb mode="talk" listenLevel={1} talkLevel={0.2} onEngine={onEngine} />);
    tick(40);
    expect(engine!.mode).toBe("talk");
    expect(engine!.voice).toBeCloseTo(0.2, 2);
  });

  it("stops its loop and lets go of the engine on unmount", () => {
    let engine: LivingEngine | null = null;
    const { unmount } = render(<LivingOrb mode="listen" listenLevel={0} talkLevel={null} onEngine={(e) => (engine = e)} />);
    tick(2);
    expect(engine).not.toBeNull();
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(engine).toBeNull();
  });

  it("without a 2D canvas it renders the stage and never starts a loop", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    render(<LivingOrb mode="talk" listenLevel={0} talkLevel={null} />);
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("aria-hidden", "true");
    expect(frames).toHaveLength(0);
  });
});
