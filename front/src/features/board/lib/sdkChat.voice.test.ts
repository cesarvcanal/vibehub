import { describe, expect, it } from "vitest";
import { INITIAL_SDK_STATE, applySdkEvent, mergeLiveVoiceTurns, type SdkChatState, type SdkEvent } from "./sdkChat";

/** Spoken turns in the chat's state: one source of truth for the thread, never doubled. */

function apply(events: SdkEvent[], from: SdkChatState = INITIAL_SDK_STATE): SdkChatState {
  return events.reduce(applySdkEvent, from);
}

describe("voice_turn", () => {
  it("draws a spoken turn in place, among the typed messages", () => {
    const state = apply([
      { type: "user", text: "digitado", at: 1 },
      { type: "voice_turn", vid: "vc1-u1", role: "user", text: "falado", at: 2, from: { kind: "owner", name: "operator" } },
      { type: "assistant_text", text: "resposta do agente" },
    ]);
    expect(state.rows.map((r) => r.kind)).toEqual(["user", "voice", "assistant"]);
    expect(state.rows[1]).toMatchObject({ kind: "voice", vid: "vc1-u1", role: "user", text: "falado", at: 2, from: { name: "operator" } });
  });

  it("is idempotent by vid: the replay and the live echo of one turn are one row, updated in place", () => {
    const once = apply([
      { type: "voice_turn", vid: "vc1-a1", role: "assistant", text: "parcial" },
      { type: "user", text: "depois" },
      { type: "voice_turn", vid: "vc1-a1", role: "assistant", text: "parcial e final" },
    ]);
    const voice = once.rows.filter((r) => r.kind === "voice");
    expect(voice).toHaveLength(1);
    expect(voice[0]).toMatchObject({ text: "parcial e final" });
    expect(once.rows[0]!.kind).toBe("voice");
  });

  it("ignores a malformed turn and does not start a turn spinner", () => {
    const state = apply([
      { type: "voice_turn", vid: "vc1-x1", role: "system", text: "x" },
      { type: "voice_turn", role: "user", text: "sem id" },
      { type: "voice_turn", vid: "vc1-x2", role: "user", text: "" },
      { type: "voice_turn", vid: "vc1-ok", role: "user", text: "ok" },
    ]);
    expect(state.rows).toHaveLength(1);
    expect(state.turnActive).toBe(false);
    expect(state.awaiting).toBe(false);
  });
});

describe("mergeLiveVoiceTurns", () => {
  const saved = apply([{ type: "voice_turn", vid: "vc1-u1", role: "user", text: "já salvo" }]).rows;

  it("adds the call's turns the server has not echoed, at the end, marked live/saving", () => {
    const rows = mergeLiveVoiceTurns(saved, [
      { vid: "vc1-u1", role: "user", text: "já salvo", at: 1, final: true, save: "saved" },
      { vid: "vc1-a2", role: "assistant", text: "respondendo", at: 2, final: false },
    ]);
    expect(rows.map((r) => (r.kind === "voice" ? [r.vid, r.live ?? false] : r.kind))).toEqual([
      ["vc1-u1", false],
      ["vc1-a2", true],
    ]);
  });

  it("returns the same array when there is nothing to add (no re-render of the thread)", () => {
    expect(mergeLiveVoiceTurns(saved, [])).toBe(saved);
    expect(mergeLiveVoiceTurns(saved, [{ vid: "vc1-u1", role: "user", text: "já salvo", at: 1, final: true }])).toBe(saved);
    expect(mergeLiveVoiceTurns(saved, [{ vid: "vc1-b", role: "user", text: "  ", at: 1, final: false }])).toBe(saved);
  });
});
