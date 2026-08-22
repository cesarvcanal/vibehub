import { afterEach, describe, expect, it } from "vitest";
import { mergeEvent, parseChatFrame, readCardMode, writeCardMode, type ChatEvent } from "@/features/board/lib/chat";

const event = (over: Partial<ChatEvent> = {}): ChatEvent => ({
  id: "a1",
  kind: "assistant",
  at: 10,
  text: "done",
  ...over,
});

afterEach(() => localStorage.clear());

describe("parseChatFrame", () => {
  it("reads an event", () => {
    expect(parseChatFrame(JSON.stringify(event()))).toEqual(event());
  });

  it("ignores the heartbeat and anything that is not an event", () => {
    expect(parseChatFrame("")).toBeNull();
    expect(parseChatFrame("\n")).toBeNull();
    expect(parseChatFrame("null")).toBeNull();
    expect(parseChatFrame(JSON.stringify({ id: "x", kind: "gossip", text: "hi" }))).toBeNull();
    expect(parseChatFrame(JSON.stringify({ kind: "user", text: "hi" }))).toBeNull();
  });

  it("tolerates a missing timestamp rather than dropping the message", () => {
    expect(parseChatFrame(JSON.stringify({ id: "u1", kind: "user", text: "oi" }))).toEqual({
      id: "u1",
      kind: "user",
      at: 0,
      text: "oi",
      tool: undefined,
    });
  });
});

describe("mergeEvent", () => {
  it("appends what is new and ignores what it already has — the stream replays on every connect", () => {
    const first = mergeEvent([], event({ id: "1" }));
    const second = mergeEvent(first, event({ id: "2" }));
    expect(second.map((e) => e.id)).toEqual(["1", "2"]);
    // Same id again (a reconnect replaying the tail): the SAME array, so React re-renders nothing.
    expect(mergeEvent(second, event({ id: "1", text: "different" }))).toBe(second);
  });

  it("keeps transcript order instead of re-sorting by timestamp", () => {
    // A message and its tool calls share one millisecond; sorting would shuffle them every frame.
    const list = [event({ id: "1", at: 5 }), event({ id: "2", at: 5 })];
    expect(mergeEvent(list, event({ id: "3", at: 1 })).map((e) => e.id)).toEqual(["1", "2", "3"]);
  });
});

describe("the remembered mode", () => {
  it("opens on the terminal until somebody chooses otherwise", () => {
    expect(readCardMode("c1")).toBe("terminal");
  });

  it("remembers per card", () => {
    writeCardMode("c1", "chat");
    expect(readCardMode("c1")).toBe("chat");
    expect(readCardMode("c2")).toBe("terminal");
  });

  it("ignores a stored value that is not one of ours", () => {
    localStorage.setItem("vibehub.cardMode.c1", "telepathy");
    expect(readCardMode("c1")).toBe("terminal");
  });
});
