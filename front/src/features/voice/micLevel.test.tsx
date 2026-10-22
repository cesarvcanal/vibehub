import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { LEVEL_INTERVAL_MS, SIGNAL_THRESHOLD, displayLevel, rmsLevel, useMicLevel } from "./micLevel";
import { FakeStream } from "./fakeWebRtc";

/** 8-bit time-domain samples of a sine of `amplitude` (0..1) — a synthetic voice for the meter. */
export function sine(amplitude: number, length = 1024): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.round(128 + 127 * amplitude * Math.sin((2 * Math.PI * i) / 48));
  return out;
}

/** A Web Audio stand-in whose analyser returns whatever `samples` holds at each read. */
export function fakeAudioContext(samples: { current: Uint8Array }) {
  const closed = { value: false };
  const disconnected = { value: false };
  const make = () =>
    ({
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => { disconnected.value = true; } }),
      createAnalyser: () => ({
        fftSize: 2048,
        getByteTimeDomainData: (buf: Uint8Array) => buf.set(samples.current.subarray(0, buf.length)),
      }),
      resume: async () => undefined,
      close: async () => { closed.value = true; },
    }) as unknown as AudioContext;
  return { make, closed, disconnected };
}

afterEach(() => vi.useRealTimers());

describe("rmsLevel / displayLevel", () => {
  it("is 0 for silence and ~amplitude/√2 for a sine", () => {
    expect(rmsLevel(new Uint8Array(512).fill(128))).toBe(0);
    expect(rmsLevel(sine(0.5))).toBeCloseTo(0.5 / Math.SQRT2, 1);
    expect(rmsLevel(new Uint8Array(0))).toBe(0);
  });

  it("speech-level RMS fills a good part of the meter, capped at 1", () => {
    expect(displayLevel(0)).toBe(0);
    expect(displayLevel(0.05)).toBeGreaterThan(0.4);
    expect(displayLevel(5)).toBe(1);
  });
});

describe("useMicLevel", () => {
  it("follows a synthetic stream: silence, then a tone above the signal threshold", () => {
    vi.useFakeTimers();
    const samples: { current: Uint8Array } = { current: new Uint8Array(1024).fill(128) };
    const ctx = fakeAudioContext(samples);
    const stream = new FakeStream() as unknown as MediaStream;
    const { result } = renderHook(() => useMicLevel(stream, ctx.make));

    act(() => { vi.advanceTimersByTime(LEVEL_INTERVAL_MS); });
    expect(result.current).toBe(0);

    samples.current = sine(0.3);
    act(() => { vi.advanceTimersByTime(LEVEL_INTERVAL_MS); });
    expect(result.current!).toBeGreaterThan(SIGNAL_THRESHOLD);
  });

  it("no stream → no level; unmount releases the AudioContext", () => {
    const ctx = fakeAudioContext({ current: sine(0.3) });
    expect(renderHook(() => useMicLevel(null, ctx.make)).result.current).toBeNull();

    const { unmount } = renderHook(() => useMicLevel(new FakeStream() as unknown as MediaStream, ctx.make));
    unmount();
    expect(ctx.closed.value).toBe(true);
    expect(ctx.disconnected.value).toBe(true);
  });

  it("a browser without Web Audio is null, not a crash", () => {
    const { result } = renderHook(() =>
      useMicLevel(new FakeStream() as unknown as MediaStream, () => { throw new Error("no AudioContext"); }),
    );
    expect(result.current).toBeNull();
  });
});
