import { describe, it, expect } from "vitest";
import {
  buildLatestTranscriptScript,
  parseLatestTranscript,
  resumeTargetFor,
  transcriptToSdkHistory,
} from "./transcript.js";

/**
 * THE BUG THIS FILE PINS: flipping "Chat nativo (beta)" on a card mid-conversation made the
 * conversation vanish — the SDK chat opened empty AND started a session with no memory. The bridge
 * replays the TUI transcript into the native chat and resumes the newest session id.
 */

const TUI_ID = "0d1b3864-4870-4141-8451-79d73de0bd96";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("buildLatestTranscriptScript", () => {
  it("probes the newest .jsonl: basename (the session id) first, then the tail", () => {
    const script = buildLatestTranscriptScript("vibehub-runner", "/root/.claude/projects/-work-x");
    expect(script).toContain("docker exec 'vibehub-runner'");
    expect(script).toContain("ls -1t");
    expect(script).toContain('basename "$f" .jsonl');
    expect(script).toContain("'/root/.claude/projects/-work-x'");
  });

  it("refuses a directory that is not a safe absolute path", () => {
    expect(() => buildLatestTranscriptScript("c", "../etc")).toThrow();
  });
});

describe("parseLatestTranscript", () => {
  it("splits the session id from the tail", () => {
    const out = parseLatestTranscript(`${TUI_ID}\n{"type":"user"}\n{"type":"assistant"}\n`);
    expect(out.sessionId).toBe(TUI_ID);
    expect(out.jsonl).toBe('{"type":"user"}\n{"type":"assistant"}\n');
  });

  it("an empty probe (no transcript yet) is null, not an error", () => {
    expect(parseLatestTranscript("")).toEqual({ sessionId: null, jsonl: "" });
    expect(parseLatestTranscript("  \n")).toEqual({ sessionId: null, jsonl: "" });
  });

  it("a first line that is not a session id yields no resume target", () => {
    const out = parseLatestTranscript(`garbage\n{"type":"user"}\n`);
    expect(out.sessionId).toBeNull();
    expect(out.jsonl).toBe('{"type":"user"}\n');
  });
});

describe("transcriptToSdkHistory", () => {
  const jsonl = [
    line({ type: "user", uuid: "u1", timestamp: "2026-08-31T10:00:00Z", message: { content: "arruma o login" } }),
    line({
      type: "assistant", uuid: "a1", timestamp: "2026-08-31T10:00:05Z",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
    }),
    line({
      type: "assistant", uuid: "a2", timestamp: "2026-08-31T10:00:20Z",
      message: { content: [{ type: "text", text: "Feito, testes verdes." }] },
    }),
  ].join("\n");

  it("converts the TUI conversation into replayable SDK frames, in order", () => {
    const events = transcriptToSdkHistory(jsonl);
    expect(events.map((e) => e.type)).toEqual(["user", "tool_use", "assistant_text"]);
    expect(events[0]).toMatchObject({ type: "user", text: "arruma o login" });
    expect(events[2]).toMatchObject({ type: "assistant_text", text: "Feito, testes verdes." });
  });

  it("keeps only what happened BEFORE the SDK history's own start (no double drawing)", () => {
    const cutoff = Date.parse("2026-08-31T10:00:10Z");
    const events = transcriptToSdkHistory(jsonl, cutoff);
    expect(events.map((e) => e.type)).toEqual(["user", "tool_use"]);
  });

  it("drops lines without a timestamp instead of guessing their place", () => {
    const events = transcriptToSdkHistory(line({ type: "user", uuid: "u9", message: { content: "sem hora" } }));
    expect(events).toEqual([]);
  });
});

describe("resumeTargetFor", () => {
  it("the newest transcript wins — it is the current state of the card's one conversation", () => {
    expect(resumeTargetFor({ resumeSessionId: "old-sdk-id" }, TUI_ID)).toBe(TUI_ID);
  });

  it("falls back to the persisted key when the probe found nothing", () => {
    expect(resumeTargetFor({ resumeSessionId: "old-sdk-id" }, null)).toBe("old-sdk-id");
    expect(resumeTargetFor({}, null)).toBeUndefined();
  });
});
