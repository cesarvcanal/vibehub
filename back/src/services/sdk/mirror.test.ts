import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MIRROR_DEDUPE_MAX,
  createMirrorState,
  mirrorNewEvents,
  noteDriverEvent,
} from "./mirror.js";
import { recordOrigin, resetProvenanceCache } from "../chat/provenance.js";
import { config } from "../../config/env.js";

/**
 * THE BUG THIS FILE PINS: with the native chat OPEN, the person switched to the Terminal tab and
 * kept the conversation there — and the native chat never showed a word of it (the "não puxou
 * nada" incident). The mirror follows the card's transcript while a native chat is connected and
 * lifts the NEW lines into the chat; these tests pin what passes and what is deduped.
 */

const CARD = "56fc53c6-ff44-484c-b2c3-e5576b6760e7";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const T0 = Date.parse("2026-08-31T21:30:00Z");

function userLine(uuid: string, iso: string, text: string): string {
  return line({ type: "user", uuid, timestamp: iso, message: { content: text } });
}

function assistantLine(uuid: string, iso: string, text: string): string {
  return line({ type: "assistant", uuid, timestamp: iso, message: { content: [{ type: "text", text }] } });
}

let dir = "";
let savedDataDir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-mirror-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  resetProvenanceCache();
});
afterEach(async () => {
  config.dataDir = savedDataDir;
  resetProvenanceCache();
  await rm(dir, { recursive: true, force: true });
});

describe("mirrorNewEvents", () => {
  it("lifts NEW transcript lines as terminal-stamped history events, with their tid and time", () => {
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(state, [
      userLine("u1", "2026-08-31T21:31:00Z", "ok boa como a gnt segue?"),
      assistantLine("a1", "2026-08-31T21:31:30Z", "Seguimos assim…"),
    ].join("\n"), CARD);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "user", text: "ok boa como a gnt segue?", source: "terminal", tid: "u1" });
    expect(out[1]).toMatchObject({ type: "assistant_text", text: "Seguimos assim…", source: "terminal", tid: "a1#t" });
    expect(out[0]!.at).toBe(Date.parse("2026-08-31T21:31:00Z"));
  });

  it("drops the follow loop's initial tail — everything at or before the cutoff was replayed", () => {
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(state, [
      userLine("old", "2026-08-31T21:29:00Z", "mensagem antiga"),
      userLine("new", "2026-08-31T21:31:00Z", "mensagem nova"),
    ].join("\n"), CARD);
    expect(out.map((e) => ("text" in e ? e.text : e.type))).toEqual(["mensagem nova"]);
  });

  it("each transcript id passes exactly once (tail -F re-prints when the newest file changes)", () => {
    const state = createMirrorState(T0);
    const chunk = userLine("u1", "2026-08-31T21:31:00Z", "oi");
    expect(mirrorNewEvents(state, chunk, CARD)).toHaveLength(1);
    expect(mirrorNewEvents(state, chunk, CARD)).toHaveLength(0);
  });

  it("pre-seeded ids (the connect replay's tids) never come around again", () => {
    const state = createMirrorState(T0, ["u1"]);
    expect(mirrorNewEvents(state, userLine("u1", "2026-08-31T21:31:00Z", "oi"), CARD)).toHaveLength(0);
  });

  it("what the DRIVER already said on stdout is not mirrored back from the transcript", () => {
    const state = createMirrorState(T0);
    noteDriverEvent(state, { type: "user", text: "roda os testes" });
    noteDriverEvent(state, { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } });
    noteDriverEvent(state, { type: "assistant_text", text: "Tudo verde." });
    const out = mirrorNewEvents(state, [
      userLine("u5", "2026-08-31T21:31:00Z", "roda os testes"),
      line({
        type: "assistant", uuid: "a5", timestamp: "2026-08-31T21:31:05Z",
        message: { content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } }] },
      }),
      assistantLine("a6", "2026-08-31T21:31:10Z", "Tudo verde."),
      assistantLine("a7", "2026-08-31T21:31:20Z", "E uma frase só da TUI."),
    ].join("\n"), CARD);
    expect(out.map((e) => ("text" in e ? e.text : e.type))).toEqual(["E uma frase só da TUI."]);
  });

  it("attaches provenance to a mirrored user message when the log knows the sender", () => {
    const at = Date.parse("2026-08-31T21:31:00Z");
    recordOrigin(CARD, "mensagem do alex", { kind: "user", name: "alex" }, at);
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(state, userLine("u1", "2026-08-31T21:31:00Z", "mensagem do alex"), CARD);
    expect(out[0]).toMatchObject({ type: "user", from: { kind: "user", name: "alex" } });
  });

  it("system notes are not part of the conversation being mirrored", () => {
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(
      state,
      userLine("s1", "2026-08-31T21:31:00Z", "[SYSTEM NOTIFICATION - NOT USER INPUT] <task-notification><summary>done</summary></task-notification>"),
      CARD,
    );
    expect(out).toHaveLength(0);
  });
});

describe("noteDriverEvent", () => {
  it("keeps the dedupe memory bounded — the oldest keys fall off", () => {
    const state = createMirrorState(T0);
    for (let i = 0; i < MIRROR_DEDUPE_MAX + 10; i += 1) {
      noteDriverEvent(state, { type: "assistant_text", text: `frase ${i}` });
    }
    expect(state.driverKeys.size).toBe(MIRROR_DEDUPE_MAX);
    expect(state.driverKeys.has("assistant_text:frase 0")).toBe(false);
    expect(state.driverKeys.has(`assistant_text:frase ${MIRROR_DEDUPE_MAX + 9}`)).toBe(true);
  });

  it("ignores events that have no dedupe key (ready, session, results)", () => {
    const state = createMirrorState(T0);
    noteDriverEvent(state, { type: "ready" } as never);
    expect(state.driverKeys.size).toBe(0);
  });
});
