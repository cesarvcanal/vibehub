import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LivingEngine,
  PARTICLE_COUNT,
  TALK_INTENSITY,
  defaultSettings,
  makeSchedule,
  scheduleDuration,
  speechEnvelope,
  tuningText,
  type LivingInput,
  type LivingMode,
} from "./engine";
import { micVoice } from "./levels";
import { LIVING_PATHS } from "./paths";

const SIZE = 620;
const DT = 1 / 60;
const QUIET: LivingInput = { listen: 0, talk: 0, reduce: false };
const DEG = Math.PI / 180;

/** Deterministic particle field (mulberry32). */
function seeded(seed = 7): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function engine(mode: LivingMode = "listen"): LivingEngine {
  const e = new LivingEngine({ mode, random: seeded() });
  e.setSize(SIZE, SIZE);
  return e;
}

function run(e: LivingEngine, seconds: number, input: LivingInput = QUIET, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    e.step(DT, input);
    each?.();
  }
}

function positions(e: LivingEngine): Float32Array {
  const out = new Float32Array(PARTICLE_COUNT * 2);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    out[i * 2] = e.frame[i * 7];
    out[i * 2 + 1] = e.frame[i * 7 + 1];
  }
  return out;
}

/** Mean signed change of each particle's bearing around the centre (rad). >0 = clockwise on screen. */
function meanTurn(before: Float32Array, after: Float32Array): number {
  const c = SIZE / 2;
  let sum = 0;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const a = Math.atan2(before[i * 2 + 1] - c, before[i * 2] - c);
    const b = Math.atan2(after[i * 2 + 1] - c, after[i * 2] - c);
    sum += Math.atan2(Math.sin(b - a), Math.cos(b - a));
  }
  return sum / PARTICLE_COUNT;
}

function meanRadius(e: LivingEngine): number {
  const c = SIZE / 2;
  let sum = 0;
  for (let i = 0; i < PARTICLE_COUNT; i++) sum += Math.hypot(e.frame[i * 7] - c, e.frame[i * 7 + 1] - c);
  return sum / PARTICLE_COUNT;
}

/** Turn per frame across a whole transition, frame by frame. */
function turnsDuring(e: LivingEngine, seconds: number): number[] {
  const turns: number[] = [];
  let prev = positions(e);
  run(e, seconds, QUIET, () => {
    const now = positions(e);
    turns.push(meanTurn(prev, now));
    prev = now;
  });
  return turns;
}

const fwdSeconds = () => scheduleDuration(makeSchedule(defaultSettings(), "fwd"));
const retSeconds = () => scheduleDuration(makeSchedule(defaultSettings(), "ret"));

describe("V37 source of truth", () => {
  it("the three ribbons are exactly the approved file's paths", () => {
    const html = readFileSync(resolve(__dirname, "../../../../../docs/voice/multiverso-v37-approved.html"), "utf8");
    expect(html.length).toBe(82623);
    const source = JSON.parse(html.match(/const paths=(\[.*?\]\]\]);/s)![1]);
    expect(LIVING_PATHS.map((p) => p.length)).toEqual([620, 620, 620]);
    expect(LIVING_PATHS).toEqual(source);
  });

  it("keeps the approved defaults and timeline", () => {
    const s = defaultSettings();
    expect(s).toMatchObject({ thickness: 100, flowSpeed: 112, listenSpin: 13, talkSpin: 13, switchTurn: 30, spinEase: 1200, speechMorphMs: 410 });
    expect(fwdSeconds()).toBeCloseTo(0.69 + 0.225 + 0.925, 5);
    expect(retSeconds()).toBeCloseTo(1.11, 5);
    expect(tuningText(s)).toContain("Finalizar silhueta (finish): SIM, início 540ms, duração 150ms");
  });
});

describe("sound", () => {
  it("listening follows only the microphone, replying only the assistant", () => {
    const e = engine("listen");
    run(e, 0.6, { listen: 0, talk: 1, reduce: false });
    expect(e.voice).toBeLessThan(0.01);
    run(e, 0.6, { listen: 0.8, talk: 0, reduce: false });
    expect(e.voice).toBeCloseTo(0.8, 2);

    e.change("talk");
    run(e, 0.6, { listen: 1, talk: 0, reduce: false });
    expect(e.voice).toBeLessThan(0.01);
    run(e, 0.6, { listen: 0, talk: 0.5, reduce: false });
    expect(e.voice).toBeCloseTo(0.5, 2);

    e.change("logo");
    run(e, 0.6, { listen: 1, talk: 1, reduce: false });
    expect(e.voice).toBeLessThan(0.01);
  });

  it("without the assistant's audio, a soft envelope stands in — bounded by V37's intensity", () => {
    const e = engine("talk");
    let peak = 0;
    run(e, 3, { listen: 1, talk: null, reduce: false }, () => (peak = Math.max(peak, e.voice)));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(TALK_INTENSITY);
    for (let t = 0; t < 5; t += 0.01) expect(speechEnvelope(t)).toBeLessThanOrEqual(1);
  });

  it("maps the lab's microphone like V37", () => {
    expect(micVoice(0.1)).toBeCloseTo(0.5);
    expect(micVoice(1)).toBe(1);
    expect(micVoice(-1)).toBe(0);
  });

  /** How far the particles sit from where they would with a silent assistant, px (mean). */
  function talkDisplacement(level: number, talkResponse: number, reduce = false): number {
    const silent = engine("talk");
    const speaking = engine("talk");
    silent.settings.talkResponse = talkResponse;
    speaking.settings.talkResponse = talkResponse;
    let sum = 0;
    let frames = 0;
    // Same field, same clock: the only difference is the assistant's level.
    for (let i = 0; i < 90; i++) {
      silent.step(DT, { listen: 0, talk: 0, reduce });
      speaking.step(DT, { listen: 0, talk: level, reduce });
      if (i < 30) continue;
      const a = positions(silent);
      const b = positions(speaking);
      let d = 0;
      for (let k = 0; k < PARTICLE_COUNT; k++) d += Math.hypot(a[k * 2]! - b[k * 2]!, a[k * 2 + 1]! - b[k * 2 + 1]!);
      sum += d / PARTICLE_COUNT;
      frames++;
    }
    return sum / frames;
  }

  it("REPLYING VISIBLY MOVES WITH THE ASSISTANT'S VOICE (the 'blue barely moves' bug)", () => {
    // V37 as approved (talkResponse 0): a real voice moved the blue sphere about a pixel on a 620 px
    // stage — read as a still sphere. Now a normal voice moves it several times more.
    const v37 = talkDisplacement(0.7, 0);
    const now = talkDisplacement(0.7, 100);
    expect(v37).toBeLessThan(2.5);
    expect(now).toBeGreaterThan(v37 * 3);
    expect(now).toBeGreaterThan(6);
    // Louder → more; silence → nothing extra.
    expect(talkDisplacement(1, 100)).toBeGreaterThan(talkDisplacement(0.3, 100));
    expect(talkDisplacement(0, 100)).toBeLessThan(0.01);
  });

  it("reduced motion keeps only a gentle breath while replying", () => {
    const calm = talkDisplacement(0.7, 100, true);
    expect(calm).toBeGreaterThan(0);
    expect(calm).toBeLessThan(talkDisplacement(0.7, 100));
  });

  it("replying stays blue and different from listening: brighter and larger with the voice", () => {
    const e = engine("talk");
    run(e, 1, { listen: 0, talk: 0.8, reduce: false });
    const [r, g, b] = e.meanColor();
    expect(b).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(r);
  });

  it("louder mic opens the listening sphere further", () => {
    const quiet = engine("listen");
    run(quiet, 1);
    const loud = engine("listen");
    run(loud, 1, { listen: 1, talk: 0, reduce: false });
    expect(meanRadius(loud)).toBeGreaterThan(meanRadius(quiet) * 1.03);
  });
});

describe("listening ⇄ replying", () => {
  it("counter-clockwise listening, clockwise replying, with an impulse that settles", () => {
    const e = engine("listen");
    run(e, 0.5);
    expect(e.sphereOmega).toBeCloseTo(-13 * DEG, 3);
    expect(meanTurn(positions(e), (run(e, DT), positions(e)))).toBeLessThan(0);

    e.change("talk");
    let peak = 0;
    run(e, 0.3, QUIET, () => (peak = Math.max(peak, e.sphereOmega)));
    expect(peak).toBeCloseTo(43 * DEG, 1);
    run(e, 1.2);
    expect(e.sphereOmega).toBeCloseTo(13 * DEG, 3);
    expect(meanTurn(positions(e), (run(e, DT), positions(e)))).toBeGreaterThan(0);
  });

  it("the replying sphere is more open than the listening one", () => {
    const e = engine("listen");
    run(e, 1);
    const listening = meanRadius(e);
    e.change("talk");
    run(e, 1.5);
    expect(meanRadius(e)).toBeGreaterThan(listening * 1.1);
  });

  it("colour goes straight to the destination, never through a third state", () => {
    const e = engine("listen");
    run(e, 1);
    const from = e.meanColor();
    e.change("talk");
    const seen: [number, number, number][] = [];
    run(e, 0.6, QUIET, () => seen.push(e.meanColor()));
    const to = e.meanColor();
    // Lilac (B 255, R > G) to blue (G > R).
    expect(from[0]).toBeGreaterThan(from[1]);
    expect(to[1]).toBeGreaterThan(to[0]);
    for (const c of seen)
      for (let ch = 0; ch < 3; ch++) {
        expect(c[ch]).toBeGreaterThanOrEqual(Math.min(from[ch], to[ch]) - 6);
        expect(c[ch]).toBeLessThanOrEqual(Math.max(from[ch], to[ch]) + 6);
      }
  });
});

describe("living mark", () => {
  function steadyLogo(from: LivingMode = "listen"): LivingEngine {
    const e = engine(from);
    run(e, 1);
    e.change("logo");
    run(e, fwdSeconds() + 0.1);
    return e;
  }

  it("forms the three ribbons: every particle ends on its own ribbon", () => {
    const e = steadyLogo();
    expect(e.transition).toBe("steady");
    const scale = (SIZE * 0.845) / 939;
    // Half the ribbon width plus its slow transverse sway (V37: 0.5 + 0.042 of the band).
    const band = SIZE * 0.1 * (0.5 + 0.042) + 1;
    for (let i = 0; i < PARTICLE_COUNT; i += 7) {
      const x = e.frame[i * 7], y = e.frame[i * 7 + 1];
      const ribbon = LIVING_PATHS[i % 3];
      let best = Infinity;
      for (const [px, py] of ribbon) best = Math.min(best, Math.hypot(SIZE / 2 + (px - 530) * scale - x, SIZE / 2 + (py - 454) * scale - y));
      expect(best).toBeLessThan(band);
    }
  });

  it("never shrinks into a smaller sphere on the way in", () => {
    const e = engine("listen");
    run(e, 1);
    const start = meanRadius(e);
    e.change("logo");
    let lowest = Infinity;
    run(e, fwdSeconds(), QUIET, () => (lowest = Math.min(lowest, meanRadius(e))));
    expect(lowest).toBeGreaterThan(start * 0.9);
  });

  it("the way in starts turning the way the source sphere was turning", () => {
    for (const [from, sign] of [["listen", -1], ["talk", 1]] as const) {
      const e = engine(from);
      run(e, 1.5);
      e.change("logo");
      const turns = turnsDuring(e, 0.12);
      expect(Math.sign(turns.reduce((a, b) => a + b, 0))).toBe(sign);
    }
  });

  it("the way back converges in the destination's direction, frame by frame — no counterflow", () => {
    for (const [to, sign] of [["listen", -1], ["talk", 1]] as const) {
      for (const from of ["listen", "talk"] as const) {
        const e = steadyLogo(from);
        e.change(to);
        expect(e.transition).toBe("ret");
        const turns = turnsDuring(e, retSeconds() + 0.05);
        expect(e.transition).toBe("none");
        for (const turn of turns) expect(turn * sign).toBeGreaterThan(-1e-4);
      }
    }
  });

  it("consecutive activations behave the same", () => {
    const e = engine("listen");
    run(e, 1);
    const curves: number[][] = [];
    for (let round = 0; round < 2; round++) {
      e.change("logo");
      const radii: number[] = [];
      run(e, fwdSeconds(), QUIET, () => radii.push(meanRadius(e)));
      curves.push(radii);
      e.change("listen");
      run(e, retSeconds() + 1);
    }
    curves[0].forEach((r, i) => expect(Math.abs(r - curves[1][i]) / r).toBeLessThan(0.03));
  });

  it("returning to the mode it already has does nothing", () => {
    const e = steadyLogo();
    e.change("logo");
    expect(e.transition).toBe("steady");
    const l = engine("listen");
    l.change("listen");
    expect(l.transition).toBe("none");
  });

  it("reduced motion freezes the ribbons in place", () => {
    const e = steadyLogo();
    run(e, 0.2, { ...QUIET, reduce: true });
    const a = positions(e);
    run(e, 0.5, { ...QUIET, reduce: true });
    const b = positions(e);
    for (let i = 0; i < a.length; i += 97) expect(b[i]).toBeCloseTo(a[i], 3);
  });

  it("starting on the mark draws the mark right away", () => {
    const e = engine("logo");
    run(e, DT);
    expect(e.transition).toBe("none");
    expect(e.logoBlend).toBe(1);
  });
});
