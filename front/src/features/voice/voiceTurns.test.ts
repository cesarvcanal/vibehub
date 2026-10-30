import { describe, expect, it } from "vitest";
import { TURN_GAP_MS, TURN_IDLE_MS, TurnSegmenter, newCallId } from "./voiceTurns";

describe("TurnSegmenter", () => {
  it("joins fragments into one growing turn with a stable id", () => {
    const seg = new TurnSegmenter("call1");
    seg.push("user", "Qual o ", 0, 0, 200);
    const vid = seg.turns[0]!.vid;
    seg.push("user", "status?", 100, 210, 400);
    expect(seg.turns).toEqual([{ vid, role: "user", text: "Qual o status?", at: 0, final: false }]);
  });

  it("a pause on the model's timeline closes the turn; the next words open another", () => {
    const seg = new TurnSegmenter("call1");
    seg.push("user", "um", 0, 0, 100);
    const closed = seg.push("user", "dois", 50, 100 + TURN_GAP_MS + 1, 2_000);
    expect(closed.map((t) => [t.text, t.final])).toEqual([["um", true]]);
    expect(seg.turns.map((t) => t.text)).toEqual(["um", "dois"]);
  });

  it("without timing it falls back to the wall clock", () => {
    const seg = new TurnSegmenter("call1");
    seg.push("assistant", "a", 0);
    expect(seg.push("assistant", "b", TURN_GAP_MS + 1)).toHaveLength(1);
  });

  it("the other side speaking closes a turn at once: the reply ends the question, barge-in cuts the reply", () => {
    const seg = new TurnSegmenter("call1");
    seg.push("user", "oi", 0);
    expect(seg.push("assistant", "olá, tudo", 10).map((t) => [t.role, t.text])).toEqual([["user", "oi"]]);
    expect(seg.push("user", "espera", 20).map((t) => [t.role, t.text])).toEqual([["assistant", "olá, tudo"]]);
    expect(seg.turns.map((t) => [t.role, t.final])).toEqual([["user", true], ["assistant", true], ["user", false]]);
  });

  it("idle turns close on tick; flush closes everything; snapshots taken earlier never change", () => {
    const seg = new TurnSegmenter("call1");
    seg.push("assistant", "olá", 10);
    const before = seg.turns.slice();
    expect(seg.tick(TURN_IDLE_MS - 1)).toEqual([]);
    expect(seg.tick(TURN_IDLE_MS + 20).map((t) => t.role)).toEqual(["assistant"]);
    expect(before[0]!.final).toBe(false);
    seg.push("user", "tchau", 5_000);
    expect(seg.flush().map((t) => t.text)).toEqual(["tchau"]);
    expect(seg.flush()).toEqual([]);
  });

  it("ignores empty fragments", () => {
    const seg = new TurnSegmenter("call1");
    expect(seg.push("user", "", 0)).toEqual([]);
    expect(seg.turns).toEqual([]);
  });

  it("call ids differ and are valid turn-id prefixes", () => {
    const a = newCallId();
    expect(a).not.toBe(newCallId());
    expect(`${a}-u1`).toMatch(/^[A-Za-z0-9_-]{6,80}$/);
  });
});
