import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ParticlesBackground } from "@/components/ParticlesBackground";

/** jsdom has no 2d context, so the component would bail out before drawing anything. */
function stubCanvas() {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
  };
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return { ctx, spy };
}

/** Pin the reduced-motion answer for this render. */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

function stubRaf() {
  const raf = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return raf;
}

describe("ParticlesBackground", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a canvas that never eats clicks and sits behind the page", () => {
    stubCanvas();
    stubReducedMotion(false);
    stubRaf();

    render(<ParticlesBackground fixed dim={0.5} />);

    const canvas = screen.getByTestId("particles-background");
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas).toHaveClass("pointer-events-none", "fixed", "-z-10");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
  });

  it("stays absolute inside its container when not fixed", () => {
    stubCanvas();
    stubReducedMotion(false);
    stubRaf();

    render(<ParticlesBackground />);

    const canvas = screen.getByTestId("particles-background");
    expect(canvas).toHaveClass("absolute");
    expect(canvas).not.toHaveClass("fixed");
  });

  it("animates when motion is welcome", () => {
    const { ctx } = stubCanvas();
    stubReducedMotion(false);
    const raf = stubRaf();

    render(<ParticlesBackground fixed dim={0.5} />);

    expect(raf).toHaveBeenCalled();
    expect(ctx.setTransform).toHaveBeenCalled();
  });

  it("paints one static frame and schedules nothing under prefers-reduced-motion", () => {
    const { ctx } = stubCanvas();
    stubReducedMotion(true);
    const raf = stubRaf();

    render(<ParticlesBackground fixed dim={0.5} />);

    expect(raf).not.toHaveBeenCalled();
    // It still drew: a single frame, not an empty canvas.
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.arc).toHaveBeenCalled();
  });

  it("stops the loop when it goes away", () => {
    stubCanvas();
    stubReducedMotion(false);
    stubRaf();
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);

    const { unmount } = render(<ParticlesBackground fixed />);
    unmount();

    expect(cancel).toHaveBeenCalled();
  });
});
