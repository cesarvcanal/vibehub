import { afterEach, describe, expect, it } from "vitest";
import { groupChatRows, mergeEvent, parseChatFrame, readCardMode, writeCardMode, readPending, writePending, type ChatEvent } from "@/features/board/lib/chat";

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

describe("groupChatRows", () => {
  const tool = (id: string, name = "Bash") => event({ id, kind: "tool", tool: name, text: id });

  it("leaves messages alone", () => {
    const rows = groupChatRows([event({ id: "1", kind: "user" }), event({ id: "2", kind: "assistant" })]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event"]);
  });

  it("folds a RUN of tool calls into one block", () => {
    const rows = groupChatRows([
      event({ id: "a", kind: "assistant" }),
      tool("t1"),
      tool("t2"),
      tool("t3"),
      event({ id: "b", kind: "assistant" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "tools", "event"]);
    const block = rows[1] as { kind: "tools"; events: unknown[] };
    expect(block.events).toHaveLength(3);
  });

  it("does not fold a run below the threshold — a fold that hides one Read buys nothing", () => {
    const rows = groupChatRows([tool("t1"), tool("t2")]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event"]);
  });

  it("keeps the block's identity as the turn adds to it, so an opened block stays open", () => {
    const first = groupChatRows([tool("t1"), tool("t2"), tool("t3")]);
    const grown = groupChatRows([tool("t1"), tool("t2"), tool("t3"), tool("t4")]);
    expect(grown[0]!.id).toBe(first[0]!.id);
  });

  it("folds each run separately — a message between them breaks the block", () => {
    const rows = groupChatRows([
      tool("t1"), tool("t2"), tool("t3"),
      event({ id: "m", kind: "assistant" }),
      tool("t4"), tool("t5"), tool("t6"),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "event", "tools"]);
  });

  it("is pure about an empty list", () => {
    expect(groupChatRows([])).toEqual([]);
  });
});

describe("the remembered mode", () => {
  it("opens in CHAT until somebody chooses otherwise — reading is what opening a card is for", () => {
    expect(readCardMode("c1")).toBe("chat");
  });

  it("remembers per card", () => {
    writeCardMode("c1", "terminal");
    expect(readCardMode("c1")).toBe("terminal");
    expect(readCardMode("c2")).toBe("chat");
  });

  it("ignores a stored value that is not one of ours", () => {
    localStorage.setItem("vibehub.cardMode.c1", "telepathy");
    expect(readCardMode("c1")).toBe("chat");
  });

  it("still takes an explicit fallback, for a caller that knows better", () => {
    expect(readCardMode("c9", "terminal")).toBe("terminal");
  });
});

describe("durable pending messages", () => {
  it("round-trips per card and clears the key when empty", () => {
    expect(readPending("c1")).toEqual([]);
    writePending("c1", [{ id: "a", text: "arruma o dre" }]);
    expect(readPending("c1")).toEqual([{ id: "a", text: "arruma o dre" }]);
    expect(readPending("c2")).toEqual([]); // per card
    writePending("c1", []);
    expect(localStorage.getItem("vibehub.chatPending.c1")).toBeNull();
  });

  it("survives garbage in the store instead of throwing", () => {
    localStorage.setItem("vibehub.chatPending.c1", "{not json");
    expect(readPending("c1")).toEqual([]);
    localStorage.setItem("vibehub.chatPending.c1", JSON.stringify([{ id: "a" }, { text: "x" }, { id: "b", text: "ok" }]));
    expect(readPending("c1")).toEqual([{ id: "b", text: "ok" }]); // only well-formed entries survive
  });
});
