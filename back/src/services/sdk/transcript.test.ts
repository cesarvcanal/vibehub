import { describe, it, expect } from "vitest";
import {
  buildLatestTranscriptScript,
  mergeTranscriptReplay,
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

describe("mergeTranscriptReplay (one timeline, nothing lost, nothing twice)", () => {
  const at = (s: string) => Date.parse(s);
  const transcript = [
    line({ type: "user", uuid: "u1", timestamp: "2026-08-31T10:00:00Z", message: { content: "arruma o login" } }),
    line({
      type: "assistant", uuid: "a1", timestamp: "2026-08-31T10:00:05Z",
      message: { content: [{ type: "text", text: "Feito." }] },
    }),
  ].join("\n");

  it("with no history, the whole transcript replays (the pre-native era)", () => {
    const out = mergeTranscriptReplay(transcript, []);
    expect(out.map((e) => e.type)).toEqual(["user", "assistant_text"]);
    expect(out.every((e) => e.source === undefined)).toBe(true);
  });

  it("keeps the TERMINAL conversation the history never saw — the 'não puxou nada' bug", () => {
    // Native chat used at 10:01; then the person talked to the TUI at 10:05 with no chat open.
    // The old cutoff dropped everything after 10:01 — the terminal conversation vanished forever.
    const history = [
      { type: "user" as const, text: "pergunta no chat nativo", at: at("2026-08-31T10:01:00Z") },
      { type: "assistant_text" as const, text: "resposta do driver", at: at("2026-08-31T10:01:10Z") },
    ];
    const withGap = [
      transcript,
      line({ type: "user", uuid: "u2", timestamp: "2026-08-31T10:05:00Z", message: { content: "ok boa como a gnt segue?" } }),
      line({
        type: "assistant", uuid: "a2", timestamp: "2026-08-31T10:05:30Z",
        message: { content: [{ type: "text", text: "Seguimos assim…" }] },
      }),
    ].join("\n");
    const out = mergeTranscriptReplay(withGap, history);
    expect(out.map((e) => ("text" in e ? e.text : e.type))).toEqual([
      "arruma o login",
      "Feito.",
      "pergunta no chat nativo",
      "resposta do driver",
      "ok boa como a gnt segue?",
      "Seguimos assim…",
    ]);
    // The gap era is stamped as the terminal's, so the front can say where the conversation went.
    expect(out[4]).toMatchObject({ source: "terminal" });
    expect(out[5]).toMatchObject({ source: "terminal" });
    expect(out[0].source).toBeUndefined();
  });

  it("does not draw the driver's own turns twice (the transcript carries them again)", () => {
    // The SDK logs its session into the same directory: the driver's words come back through the
    // newest transcript with the SAME text and the SAME tool-use ids.
    const history = [
      { type: "user" as const, text: "roda os testes", at: at("2026-08-31T10:01:00Z") },
      { type: "tool_use" as const, id: "toolu_9", name: "Bash", input: { command: "npm test" }, at: at("2026-08-31T10:01:05Z") },
      { type: "assistant_text" as const, text: "Tudo verde.", at: at("2026-08-31T10:01:10Z") },
    ];
    const forked = [
      line({ type: "user", uuid: "u5", timestamp: "2026-08-31T10:01:00Z", message: { content: "roda os testes" } }),
      line({
        type: "assistant", uuid: "a5", timestamp: "2026-08-31T10:01:05Z",
        message: { content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } }] },
      }),
      line({
        type: "assistant", uuid: "a6", timestamp: "2026-08-31T10:01:10Z",
        message: { content: [{ type: "text", text: "Tudo verde." }] },
      }),
    ].join("\n");
    const out = mergeTranscriptReplay(forked, history);
    expect(out).toEqual(history);
  });

  it("skips exactly by transcript id what a live mirror already persisted (tid)", () => {
    const history = [
      { type: "user" as const, text: "arruma o login", at: at("2026-08-31T10:00:00Z"), tid: "u1", source: "terminal" as const },
    ];
    const out = mergeTranscriptReplay(transcript, history);
    expect(out.map((e) => ("text" in e ? e.text : e.type))).toEqual(["arruma o login", "Feito."]);
    expect(out[0]).toBe(history[0]); // the history's version wins — it knows who sent it
  });

  it("dedupes repeated identical texts as a multiset — one copy each, extras replay", () => {
    const history = [{ type: "user" as const, text: "sobe", at: at("2026-08-31T10:00:00Z") }];
    const repeated = [
      line({ type: "user", uuid: "r1", timestamp: "2026-08-31T10:00:00Z", message: { content: "sobe" } }),
      line({ type: "user", uuid: "r2", timestamp: "2026-08-31T10:02:00Z", message: { content: "sobe" } }),
    ].join("\n");
    const out = mergeTranscriptReplay(repeated, history);
    expect(out.map((e) => ("text" in e ? `${e.text}@${e.at}` : e.type))).toEqual([
      `sobe@${at("2026-08-31T10:00:00Z")}`,
      `sobe@${at("2026-08-31T10:02:00Z")}`,
    ]);
  });
});
