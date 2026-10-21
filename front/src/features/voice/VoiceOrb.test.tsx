import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VoiceOrb, orbRadius, prefersReducedMotion } from "./VoiceOrb";
import { orbMode } from "./VoiceModePage";
import { LiveVoiceSession } from "./liveVoice";

afterEach(() => vi.restoreAllMocks());

describe("orbRadius", () => {
  it("reduced motion: a plain circle that only swells with the level", () => {
    expect(orbRadius(100, 0, 0, 0, false)).toBe(100);
    expect(orbRadius(100, 1.3, 42, 0, false)).toBe(100);
    expect(orbRadius(100, 0, 0, 1, false)).toBeCloseTo(112);
  });

  it("flowing: the edge moves over time, more with sound, and stays near the base", () => {
    const at = (t: number, level: number) => [0, 1, 2, 3].map((th) => orbRadius(100, th, t, level, true));
    expect(at(0, 0)).not.toEqual(at(1, 0));
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(spread(at(0.5, 1))).toBeGreaterThan(0);
    for (const r of [...at(0, 0), ...at(3, 1)]) expect(r).toBeGreaterThan(85), expect(r).toBeLessThan(125);
  });
});

describe("VoiceOrb", () => {
  it("falls back to a CSS orb without a 2D canvas, and carries its mode", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<VoiceOrb level={0.5} mode="listening" />);
    const orb = screen.getByTestId("voice-orb");
    expect(orb).toHaveAttribute("data-mode", "listening");
    expect(orb).toHaveAttribute("aria-hidden", "true");
    expect(orb.querySelector("canvas")).toBeNull();
  });

  it("reads the reduced-motion preference", () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q })) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe("orbMode", () => {
  const idle = LiveVoiceSession.idleSnapshot;
  it("follows the session: idle, connecting, listening, muted, speaking, error", () => {
    expect(orbMode(idle, 0)).toBe("idle");
    expect(orbMode({ ...idle, state: "connecting" }, 0)).toBe("connecting");
    expect(orbMode({ ...idle, state: "live" }, 0)).toBe("listening");
    expect(orbMode({ ...idle, state: "live", muted: true }, 0)).toBe("muted");
    expect(orbMode({ ...idle, state: "live", diag: { ...idle.diag, lastOutputAt: 900 } }, 1000)).toBe("speaking");
    expect(orbMode({ ...idle, state: "error" }, 0)).toBe("error");
  });
});
