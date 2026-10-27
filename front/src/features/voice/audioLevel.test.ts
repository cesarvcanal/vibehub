import { describe, expect, it } from "vitest";
import { AI_TUNING, EventEnvelope, LevelMeter, MIC_TUNING, follow, rmsOf, toDb, visualLevel } from "./audioLevel";

/**
 * Real volume vs visual intensity: the measurement is plain RMS/dBFS; the orb gets that through a
 * gate, a window, a soft curve and an envelope. These pin the calibration the call relies on.
 */

function sine(amplitude: number, n = 1024): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((i / n) * Math.PI * 2 * 8);
  return out;
}

describe("measurement", () => {
  it("RMS of a sine is amplitude/√2; dBFS follows", () => {
    expect(rmsOf(sine(0.5))).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(toDb(1)).toBe(0);
    expect(toDb(0)).toBe(-120);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });
});

describe("visual intensity", () => {
  it("a quiet room is zero (gate), normal speech fills most of it, loud speech tops at 1", () => {
    expect(visualLevel(0.0008, AI_TUNING)).toBe(0); // ≈ −62 dBFS: under the gate
    const speech = visualLevel(0.05, AI_TUNING); // ≈ −26 dBFS: a real voice on the track
    expect(speech).toBeGreaterThan(0.6);
    expect(speech).toBeLessThan(1);
    expect(visualLevel(0.5, AI_TUNING)).toBe(1);
  });

  it("is monotonic and the curve lifts quiet syllables", () => {
    const levels = [0.003, 0.01, 0.03, 0.1].map((r) => visualLevel(r, MIC_TUNING));
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThan(levels[i - 1]!);
    const linear = visualLevel(0.01, { ...MIC_TUNING, curve: 1 });
    expect(visualLevel(0.01, MIC_TUNING)).toBeGreaterThan(linear);
  });

  it("the envelope attacks fast and releases slower", () => {
    const up = follow(0, 1, 30, AI_TUNING);
    const down = 1 - follow(1, 0, 30, AI_TUNING);
    expect(up).toBeGreaterThan(down);
    expect(follow(0.4, 0.4, 100, AI_TUNING)).toBeCloseTo(0.4);
  });
});

/** A Web Audio analyser stand-in that hands out whatever samples the test sets. */
function fakeContext(samples: { current: Float32Array<ArrayBufferLike> }) {
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 1,
    getFloatTimeDomainData(buf: Float32Array) {
      buf.set(samples.current.subarray(0, buf.length));
    },
  };
  const source = { connected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; } };
  const ctx = { createMediaStreamSource: () => source, createAnalyser: () => analyser };
  return { ctx: ctx as unknown as AudioContext, source };
}

describe("LevelMeter", () => {
  it("follows the signal frame by frame and reports real and visual levels apart", () => {
    const samples = { current: sine(0) };
    const { ctx, source } = fakeContext(samples);
    const meter = new LevelMeter(ctx, {} as MediaStream, AI_TUNING);
    expect(source.connected).toBe(true);
    let t = 0;
    let r = meter.read((t += 16));
    expect(r.visual).toBe(0);
    samples.current = sine(0.08);
    for (let i = 0; i < 10; i++) r = meter.read((t += 16));
    expect(r.rms).toBeCloseTo(0.08 / Math.SQRT2, 3);
    expect(r.db).toBeLessThan(-20);
    expect(r.visual).toBeGreaterThan(0.6);
    meter.dispose();
    expect(source.connected).toBe(false);
  });

  it("exact digital zeros for a while mean the graph is not hearing the stream", () => {
    const samples = { current: new Float32Array(1024) };
    const { ctx } = fakeContext(samples);
    const meter = new LevelMeter(ctx, {} as MediaStream, AI_TUNING);
    meter.read(0);
    expect(meter.read(800).deadMs).toBe(800);
    samples.current = sine(0.0001); // dither: alive, though silent
    expect(meter.read(820).deadMs).toBe(0);
  });
});

describe("EventEnvelope", () => {
  it("pulses on each spoken fragment and decays to silence", () => {
    const env = new EventEnvelope();
    expect(env.read(0)).toBe(0);
    env.pulse(12);
    expect(env.read(16)).toBeGreaterThan(0.4);
    let last = 1;
    for (let t = 32; t < 3000; t += 16) last = env.read(t);
    expect(last).toBeLessThan(0.01);
  });
});
