import { describe, expect, it } from "vitest";
import { AI_TAIL_MS, INITIAL_PHASE, INTERRUPT_MS, THINK_AFTER_MS, nextPhase, phaseOrb, type PhaseInput, type PhaseMemory } from "./voicePhase";

/** Drives the machine through a scripted timeline, one 80 ms tick at a time. */
function run(steps: Array<[number, Partial<PhaseInput>]>, start: PhaseMemory = INITIAL_PHASE): PhaseMemory[] {
  let mem = start;
  const out: PhaseMemory[] = [];
  for (const [now, patch] of steps) {
    mem = nextPhase(mem, { state: "live", muted: false, now, lastInputAt: null, lastOutputAt: null, aiLevel: 0, micLevel: 0, ...patch });
    out.push(mem);
  }
  return out;
}

describe("voice phases", () => {
  it("connecting → listening → the person speaks → thinking (logo) → the reply (blue) → listening", () => {
    const seq = run([
      [0, { state: "connecting" }],
      [100, {}],
      [200, { micLevel: 0.5 }],
      [300, { micLevel: 0.4, lastInputAt: 280 }],
      [600, { lastInputAt: 280 }],
      [600 + THINK_AFTER_MS + 50, { lastInputAt: 280 }],
      [1500, { aiLevel: 0.6 }],
      [1600, { aiLevel: 0.5, lastOutputAt: 1590 }],
      [1600 + AI_TAIL_MS + 50, {}],
    ]).map((m) => m.phase);
    expect(seq).toEqual([
      "connecting", "listening", "user_speaking", "user_speaking", "user_speaking", "thinking", "ai_speaking", "ai_speaking", "listening",
    ]);
    expect(seq.map((p) => phaseOrb(p))).toEqual(["logo", "listen", "listen", "listen", "listen", "logo", "talk", "talk", "listen"]);
  });

  it("never shows 'thinking' between two words, nor when nobody said anything", () => {
    const pausing = run([
      [0, { micLevel: 0.5 }],
      [THINK_AFTER_MS - 100, {}],
      [THINK_AFTER_MS + 100, { micLevel: 0.5 }],
    ]).map((m) => m.phase);
    expect(pausing).not.toContain("thinking");
    expect(run([[0, {}], [5_000, {}]]).map((m) => m.phase)).toEqual(["listening", "listening"]);
  });

  it("the gaps between the assistant's words do not flip the sphere back to pink", () => {
    const seq = run([
      [0, { aiLevel: 0.6 }],
      [AI_TAIL_MS - 100, { aiLevel: 0 }],
      [AI_TAIL_MS, { aiLevel: 0.5 }],
    ]).map((m) => m.phase);
    expect(seq).toEqual(["ai_speaking", "ai_speaking", "ai_speaking"]);
  });

  it("the person talking over the reply is a barge-in: 'interrupted', then their turn", () => {
    const seq = run([
      [0, { aiLevel: 0.6 }],
      [100, { aiLevel: 0.5, micLevel: 0.6 }],
      [200, { micLevel: 0.6 }],
      [100 + INTERRUPT_MS + 100, { micLevel: 0.6 }],
    ]).map((m) => m.phase);
    expect(seq).toEqual(["ai_speaking", "interrupted", "interrupted", "user_speaking"]);
    expect(phaseOrb("interrupted")).toBe("listen");
  });

  it("muted: the mic moves nothing; the assistant can still reply", () => {
    const seq = run([
      [0, { muted: true, micLevel: 0.9 }],
      [100, { muted: true, aiLevel: 0.5 }],
    ]).map((m) => m.phase);
    expect(seq).toEqual(["muted", "ai_speaking"]);
  });

  it("the card's agent working on a typed message reads as thinking", () => {
    expect(run([[0, { agentBusy: true }]])[0]!.phase).toBe("thinking");
  });

  it("error and idle end the call's state", () => {
    expect(run([[0, { aiLevel: 1 }], [10, { state: "error" }]]).map((m) => m.phase)).toEqual(["ai_speaking", "error"]);
    const idle = run([[0, {}], [10, { state: "idle" }]]);
    expect(idle[1]).toMatchObject({ phase: "idle", turnOpen: false });
  });
});
