import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import {
  appendHistory,
  onExternalMessage,
  publishExternalMessage,
  readHistory,
  replayableHistoryEvent,
  HISTORY_COMPACT_FACTOR,
  SDK_HISTORY_DIR,
  type HistoryEvent,
} from "./history.js";

/**
 * THE BUG THIS FILE PINS: the native chat's conversation lived only in React state, so a remount
 * (tab switch, reopened card, reload) showed an empty chat even though every message had been
 * delivered — "a mensagem apareceu e depois sumiu". The history log is the durable side of the fix:
 * what one connect records, the next connect replays.
 */

const CARD = "eee498d1-98dd-44b6-97ee-c06a181c3769";

let dir = "";
let savedDataDir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-history-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
});
afterEach(async () => {
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

describe("replayableHistoryEvent", () => {
  it("keeps what the screen must re-draw: user, consolidated text, tools, permission cards", () => {
    expect(replayableHistoryEvent({ type: "user", text: "oi" })).toBe(true);
    expect(replayableHistoryEvent({ type: "assistant_text", text: "resposta" })).toBe(true);
    expect(replayableHistoryEvent({ type: "tool_use", id: "t1", name: "Bash", input: {} })).toBe(true);
    expect(replayableHistoryEvent({ type: "permission_request", id: "p1", tool: "Bash" })).toBe(true);
    expect(
      replayableHistoryEvent({ type: "permission", id: "p1", tool: "Bash", decision: "allow", sensitive: true }),
    ).toBe(true);
  });

  it("drops the connection's own chatter: deltas, ready, session, results, errors", () => {
    expect(replayableHistoryEvent({ type: "assistant_delta", text: "oi" })).toBe(false);
    expect(replayableHistoryEvent({ type: "ready" })).toBe(false);
    expect(replayableHistoryEvent({ type: "session", sessionId: "s" })).toBe(false);
    expect(replayableHistoryEvent({ type: "result", isError: false })).toBe(false);
    expect(replayableHistoryEvent({ type: "error", message: "driver exited (code 1)" })).toBe(false);
    // a permission without an id is the auto-allowed bulk — noise the chat never drew
    expect(
      replayableHistoryEvent({ type: "permission", tool: "Read", decision: "allow", sensitive: false }),
    ).toBe(false);
  });

  it("a MIRRORED terminal event survives the round trip with its stamp, tid and time", async () => {
    const mirrored: HistoryEvent = {
      type: "user",
      text: "ok boa como a gnt segue?",
      at: 1_756_680_000_000,
      source: "terminal",
      tid: "u1",
    };
    await publishExternalMessage(CARD, mirrored);
    expect(await readHistory(CARD)).toEqual([mirrored]);
  });
});

describe("appendHistory / readHistory", () => {
  it("what one connect appends, the next connect reads back in order", async () => {
    await appendHistory(CARD, { type: "user", text: "manda a primeira", at: 1 });
    await appendHistory(CARD, { type: "assistant_text", text: "feito", at: 2 });
    const events = await readHistory(CARD);
    expect(events).toEqual([
      { type: "user", text: "manda a primeira", at: 1 },
      { type: "assistant_text", text: "feito", at: 2 },
    ]);
  });

  it("a card with no history reads as empty, not as an error", async () => {
    expect(await readHistory(CARD)).toEqual([]);
  });

  it("survives a torn last line (crash mid-append) by skipping it", async () => {
    await appendHistory(CARD, { type: "user", text: "inteira" });
    const file = join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, `{"type":"assistant_te`, "utf8");
    expect(await readHistory(CARD)).toEqual([{ type: "user", text: "inteira" }]);
  });

  it("refuses an id that is not id-shaped — the card id names a file, never a path", async () => {
    // append never throws (fire-and-forget path), but nothing may be written outside the dir
    await appendHistory("../../etc/passwd", { type: "user", text: "nope" });
    expect(await readHistory(CARD)).toEqual([]);
    await expect(rm(join(dir, SDK_HISTORY_DIR, "../../etc"), { force: true })).resolves.toBeUndefined();
  });

  it("replays only the last `limit` events and compacts a log that outgrew the window", async () => {
    const limit = 5;
    const total = limit * HISTORY_COMPACT_FACTOR + 3;
    for (let i = 0; i < total; i += 1) {
      await appendHistory(CARD, { type: "user", text: `m${i}` });
    }
    const events = await readHistory(CARD, limit);
    expect(events.map((e) => (e as { text: string }).text)).toEqual(["m18", "m19", "m20", "m21", "m22"]);
    // the compaction rewrote the file down to the replay window
    const file = join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(lines.length).toBe(limit);
    // and a subsequent append lands after the compacted tail
    await appendHistory(CARD, { type: "user", text: "depois" });
    const after = await readHistory(CARD, limit);
    expect((after[after.length - 1] as { text: string }).text).toBe("depois");
  });

  it("interleaved appends serialize into whole lines", async () => {
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) writes.push(appendHistory(CARD, { type: "user", text: `p${i}` }));
    await Promise.all(writes);
    const events = (await readHistory(CARD)) as Array<HistoryEvent & { text: string }>;
    expect(events.length).toBe(20);
    expect(events.map((e) => e.text)).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`));
  });

  it("round-trips a message's provenance (`from`) — the replay carries the sender verbatim", async () => {
    const from = { kind: "agent" as const, name: "card preview", sourceCardId: "c1", sourceProjectId: "p1" };
    await appendHistory(CARD, { type: "user", text: "oi", at: 7, from });
    const [event] = await readHistory(CARD);
    expect(event).toEqual({ type: "user", text: "oi", at: 7, from });
  });
});

describe("external messages (an agent talking to this card)", () => {
  it("publishExternalMessage appends to the log AND notifies subscribers; unsubscribe stops it", async () => {
    const from = { kind: "agent" as const, name: "maestro" };
    const seen: HistoryEvent[] = [];
    const off = onExternalMessage(CARD, (e) => seen.push(e));
    await publishExternalMessage(CARD, { type: "user", text: "delegado", at: 1, from });
    off();
    await publishExternalMessage(CARD, { type: "user", text: "depois do off", at: 2, from });
    expect(seen).toEqual([{ type: "user", text: "delegado", at: 1, from }]);
    // both landed in the log regardless of who was listening
    expect((await readHistory(CARD)).map((e) => (e as { text: string }).text)).toEqual(["delegado", "depois do off"]);
  });

  it("subscriptions are per card — another card's chat hears nothing", async () => {
    const seen: HistoryEvent[] = [];
    const off = onExternalMessage("bbbb498d1-98dd-44b6-97ee-c06a181c376", (e) => seen.push(e));
    await publishExternalMessage(CARD, { type: "user", text: "para outro card", at: 1 });
    off();
    expect(seen).toEqual([]);
  });
});
