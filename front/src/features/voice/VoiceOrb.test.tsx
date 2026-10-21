import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VoiceOrb, followLevel, orbLook, prefersReducedMotion } from "./VoiceOrb";
import { orbMode } from "./VoiceModePage";
import { LiveVoiceSession } from "./liveVoice";

afterEach(() => vi.restoreAllMocks());

describe("orbLook / followLevel", () => {
  it("sound drives only listening and speaking; muted and error wash the colour out", () => {
    expect(orbLook("listening").hears).toBe(true);
    expect(orbLook("speaking").hears).toBe(true);
    for (const m of ["idle", "connecting", "muted", "error"] as const) expect(orbLook(m).hears).toBe(false);
    expect(orbLook("muted").dim).toBeGreaterThan(0.5);
    expect(orbLook("error").dim).toBeGreaterThan(orbLook("muted").dim);
    expect(orbLook("speaking").energy).toBeGreaterThan(orbLook("listening").energy);
  });

  it("rises fast, falls slow, stays within 0..1", () => {
    const up = followLevel(0, 1);
    const down = 1 - followLevel(1, 0);
    expect(up).toBeGreaterThan(down);
    expect(followLevel(0.5, 5)).toBeLessThanOrEqual(1);
    expect(followLevel(0.5, -3)).toBeGreaterThanOrEqual(0);
    let v = 0;
    for (let i = 0; i < 60; i++) v = followLevel(v, 0.8);
    expect(v).toBeCloseTo(0.8, 2);
  });
});

describe("VoiceOrb", () => {
  it("falls back to a CSS orb without WebGL, and carries its mode", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<VoiceOrb level={0.5} mode="listening" />);
    const orb = screen.getByTestId("voice-orb");
    expect(orb).toHaveAttribute("data-mode", "listening");
    expect(orb).toHaveAttribute("aria-hidden", "true");
    expect(orb.querySelector("canvas")).toBeNull();
    expect(screen.getByTestId("voice-orb-fallback")).toBeInTheDocument();
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
