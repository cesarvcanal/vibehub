import { describe, expect, it } from "vitest";
import {
  INITIAL_SDK_STATE,
  applySdkEvent,
  appendUserRow,
  decidePermission,
  groupSdkRows,
  parseSdkFrame,
  toolSummary,
  type SdkChatState,
  type SdkEvent,
} from "./sdkChat";

function feed(events: SdkEvent[], from: SdkChatState = INITIAL_SDK_STATE): SdkChatState {
  return events.reduce((state, event) => applySdkEvent(state, event), from);
}

describe("parseSdkFrame", () => {
  it("parses a typed frame and rejects junk", () => {
    expect(parseSdkFrame(`{"type":"ready"}`)).toEqual({ type: "ready" });
    expect(parseSdkFrame("not json")).toBeNull();
    expect(parseSdkFrame(`"just a string"`)).toBeNull();
    expect(parseSdkFrame(`{"noType":true}`)).toBeNull();
  });
});

describe("message provenance (from)", () => {
  const agent = { kind: "agent" as const, name: "card preview", sourceCardId: "c1", sourceProjectId: "p1" };

  it("parseSdkFrame keeps a valid `from` and drops a malformed one", () => {
    expect(parseSdkFrame(JSON.stringify({ type: "user", text: "oi", from: agent }))?.from).toEqual(agent);
    expect(parseSdkFrame(JSON.stringify({ type: "user", text: "oi", from: { kind: "ghost" } }))?.from).toBeUndefined();
  });

  it("a user event with provenance becomes a user row that says who sent it", () => {
    const state = feed([{ type: "user", text: "roda os testes", from: agent }]);
    expect(state.rows).toEqual([{ kind: "user", id: "u:1", text: "roda os testes", state: "sent", from: agent }]);
  });

  it("one's own send (appendUserRow without from) stays unlabelled", () => {
    const state = appendUserRow(INITIAL_SDK_STATE, "oi");
    expect(state.rows[0]).toEqual({ kind: "user", id: "u:1", text: "oi", state: "sent", from: undefined });
  });
});

describe("applySdkEvent", () => {
  it("ready arms the view; a resume id becomes the session and a note", () => {
    const state = feed([{ type: "ready", resume: "abc-123" }]);
    expect(state.ready).toBe(true);
    expect(state.sessionId).toBe("abc-123");
    expect(state.rows).toEqual([{ kind: "note", id: "note:1", text: "resume:abc-123" }]);
  });

  it("streams deltas into ONE growing assistant row, consolidated by assistant_text", () => {
    const state = feed([
      { type: "ready" },
      { type: "assistant_delta", text: "Olá" },
      { type: "assistant_delta", text: ", César" },
      { type: "assistant_text", text: "Olá, César!" },
    ]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "assistant", text: "Olá, César!", streaming: false });
    expect(state.turnActive).toBe(true);
  });

  it("a tool call settles the streaming block and adds a compact line", () => {
    const state = feed([
      { type: "assistant_delta", text: "Vou rodar os testes." },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
    ]);
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({ kind: "assistant", streaming: false });
    expect(state.rows[1]).toMatchObject({ kind: "tool", id: "toolu_1", name: "Bash", summary: "npm test" });
  });

  it("permission_request becomes a pending card; the driver's echo settles it", () => {
    let state = feed([
      { type: "permission_request", id: "perm_1", tool: "Bash", input: { command: "rm -rf ." }, reason: "sensitive" },
    ]);
    expect(state.rows[0]).toMatchObject({ kind: "permission", id: "perm_1", outcome: "pending", summary: "rm -rf ." });
    state = applySdkEvent(state, { type: "permission", id: "perm_1", tool: "Bash", decision: "deny", sensitive: true });
    expect(state.rows[0]).toMatchObject({ kind: "permission", outcome: "denied" });
  });

  it("a timeout deny is told apart from a human deny", () => {
    const state = feed([
      { type: "permission_request", id: "perm_2", tool: "Bash" },
      { type: "permission", id: "perm_2", tool: "Bash", decision: "deny", sensitive: true, timedOut: true },
    ]);
    expect(state.rows[0]).toMatchObject({ kind: "permission", outcome: "timeout" });
  });

  it("auto-allowed (non-escalated) permission events draw NOTHING — they are the bulk", () => {
    const state = feed([{ type: "permission", tool: "Read", decision: "allow", sensitive: false }]);
    expect(state.rows).toEqual([]);
  });

  it("result ends the turn and captures the session id; an error result is shown", () => {
    const ok = feed([
      { type: "assistant_delta", text: "…" },
      { type: "result", isError: false, sessionId: "s-1" },
    ]);
    expect(ok.turnActive).toBe(false);
    expect(ok.sessionId).toBe("s-1");
    expect(ok.rows.filter((r) => r.kind === "error")).toHaveLength(0);

    const bad = feed([{ type: "result", isError: true, result: "boom" }]);
    expect(bad.rows[0]).toMatchObject({ kind: "error", text: "boom" });
  });

  it("error and parse_error rows are visible, never swallowed", () => {
    const state = feed([
      { type: "error", message: "driver exited (code 1)" },
      { type: "parse_error", raw: "{bad" },
    ]);
    expect(state.rows.map((r) => r.kind)).toEqual(["error", "error"]);
  });

  it("collapses the SAME error repeated by a reconnect loop into one counted row", () => {
    // Flag off: every reconnect attempt is refused with the identical message. A validation
    // session once stacked ~14 copies of this banner; now it is one row that counts.
    const refusal = { type: "error", message: "the SDK driver is off (enable the sdkDriver setting)" } as const;
    const state = feed(Array.from({ length: 14 }, () => ({ ...refusal })));
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "error", text: refusal.message, count: 14 });
  });

  it("keeps DIFFERENT errors as separate rows, and a repeat after other rows starts fresh", () => {
    const state = feed([
      { type: "error", message: "a" },
      { type: "error", message: "b" },
      { type: "assistant_text", text: "hi" },
      { type: "error", message: "b" },
    ]);
    expect(state.rows.map((r) => (r.kind === "error" ? r.text : r.kind))).toEqual([
      "a",
      "b",
      "assistant",
      "b",
    ]);
    expect(state.rows.every((r) => r.kind !== "error" || (r.count ?? 1) === 1)).toBe(true);
  });

  it("collapses a repeated parse_error and a repeated error result too", () => {
    const parses = feed([
      { type: "parse_error", raw: "{bad" },
      { type: "parse_error", raw: "{bad" },
    ]);
    expect(parses.rows).toHaveLength(1);
    expect(parses.rows[0]).toMatchObject({ kind: "error", count: 2 });

    const results = feed([
      { type: "result", isError: true, result: "boom" },
      { type: "result", isError: true, result: "boom" },
    ]);
    expect(results.rows).toHaveLength(1);
    expect(results.rows[0]).toMatchObject({ kind: "error", text: "boom", count: 2 });
  });
});

describe("decidePermission", () => {
  it("is idempotent and never flips a settled outcome back to pending", () => {
    let state = feed([{ type: "permission_request", id: "p", tool: "Bash" }]);
    state = decidePermission(state, "p", "allowed");
    const settled = state;
    expect(decidePermission(settled, "p", "allowed")).toBe(settled); // no change, same object
    expect(decidePermission(settled, "p", "pending").rows[0]).toMatchObject({ outcome: "allowed" });
  });
});

describe("appendUserRow", () => {
  it("adds the sent message as its own row", () => {
    const state = appendUserRow(INITIAL_SDK_STATE, "faz o deploy");
    expect(state.rows[0]).toMatchObject({ kind: "user", text: "faz o deploy", state: "sent" });
  });
});

describe("history replay (the conversation must survive a remount)", () => {
  it("draws a replayed `user` event as the person's own bubble", () => {
    const state = applySdkEvent(INITIAL_SDK_STATE, { type: "user", text: "manda a primeira" });
    expect(state.rows[0]).toMatchObject({ kind: "user", text: "manda a primeira" });
  });

  it("ignores a user event with no text", () => {
    expect(applySdkEvent(INITIAL_SDK_STATE, { type: "user" })).toBe(INITIAL_SDK_STATE);
  });

  it("rebuilds a whole replayed conversation in order", () => {
    let state = INITIAL_SDK_STATE;
    state = applySdkEvent(state, { type: "user", text: "roda os testes" });
    state = applySdkEvent(state, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    state = applySdkEvent(state, { type: "assistant_text", text: "Tudo verde." });
    state = applySdkEvent(state, { type: "ready" });
    expect(state.rows.map((r) => r.kind)).toEqual(["user", "tool", "assistant"]);
    expect(state.ready).toBe(true);
  });

  it("a replayed tail NEVER lights the spinner — nothing is running before `ready`", () => {
    // The production incident: replayed assistant/tool events carry no `result`, so they used to
    // leave "Trabalhando…" on until the driver finally said `ready` — a lie for however long the
    // driver took to boot (an npm install, a slow docker exec), or forever when it died silently.
    let state = applySdkEvent(INITIAL_SDK_STATE, { type: "tool_use", id: "t1", name: "Bash", input: {} });
    expect(state.turnActive).toBe(false);
    state = applySdkEvent(state, { type: "assistant_text", text: "replayed" });
    expect(state.turnActive).toBe(false);
    state = applySdkEvent(state, { type: "ready" });
    expect(state.turnActive).toBe(false);
    // Only a LIVE driver event (after ready) means work is happening.
    state = applySdkEvent(state, { type: "tool_use", id: "t2", name: "Bash", input: {} });
    expect(state.turnActive).toBe(true);
  });

  it("`ready` settles a streaming row before adding the resume note", () => {
    let state = applySdkEvent(INITIAL_SDK_STATE, { type: "assistant_delta", text: "meio de fra" });
    state = applySdkEvent(state, { type: "ready", resume: "bfe63d25-95df-4c86-bf34-047b1366cc02" });
    expect(state.rows[0]).toMatchObject({ kind: "assistant", streaming: false });
    expect(state.rows[1]).toMatchObject({ kind: "note" });
    expect(state.sessionId).toBe("bfe63d25-95df-4c86-bf34-047b1366cc02");
  });
});

describe("terminal mirror (the conversation that happens in the TUI)", () => {
  const ready: SdkEvent = { type: "ready" };

  it("a terminal-mirrored burst opens with ONE 'atividade no terminal' note", () => {
    const state = feed([
      ready,
      { type: "user", text: "ok boa como a gnt segue?", source: "terminal" },
      { type: "assistant_text", text: "Seguimos assim…", source: "terminal" },
      { type: "tool_use", id: "t9", name: "Bash", input: {}, source: "terminal" },
    ]);
    const notes = state.rows.filter((r) => r.kind === "note" && r.text === "terminal-activity");
    expect(notes).toHaveLength(1);
    expect(state.rows.map((r) => r.kind)).toEqual(["note", "user", "assistant", "tool"]);
  });

  it("terminal events never light 'Trabalhando…' — the terminal's work is told by the note", () => {
    const state = feed([
      ready,
      { type: "assistant_text", text: "resposta na TUI", source: "terminal" },
      { type: "tool_use", id: "t1", name: "Bash", input: {}, source: "terminal" },
    ]);
    expect(state.turnActive).toBe(false);
  });

  it("a driver turn between two terminal bursts starts a NEW note", () => {
    const state = feed([
      ready,
      { type: "assistant_text", text: "tui 1", source: "terminal" },
      { type: "assistant_text", text: "driver falando" },
      { type: "assistant_text", text: "tui 2", source: "terminal" },
    ]);
    const notes = state.rows.filter((r) => r.kind === "note" && r.text === "terminal-activity");
    expect(notes).toHaveLength(2);
  });

  it("a mirrored user message keeps its provenance", () => {
    const from = { kind: "user" as const, name: "mussa" };
    const state = feed([ready, { type: "user", text: "oi", source: "terminal", from }]);
    const user = state.rows.find((r) => r.kind === "user");
    expect(user).toMatchObject({ text: "oi", from });
  });
});

describe("honest turn end (the driver closes every turn)", () => {
  it("an aborted result (interrupt, silent stall) clears the spinner", () => {
    const state = feed([
      { type: "ready" },
      { type: "assistant_delta", text: "meio de fra" },
      { type: "result", isError: false, subtype: "aborted" },
    ]);
    expect(state.turnActive).toBe(false);
    expect(state.rows[0]).toMatchObject({ kind: "assistant", streaming: false });
  });
});

describe("toolSummary", () => {
  it("prefers the command, falls back to the file, and truncates long lines", () => {
    expect(toolSummary({ command: "ls -la" })).toBe("ls -la");
    expect(toolSummary({ file_path: "/work/a.ts" })).toBe("/work/a.ts");
    expect(toolSummary(undefined)).toBe("");
    expect(toolSummary({ command: "x".repeat(300) })).toHaveLength(120);
  });
});

describe("groupSdkRows", () => {
  it("folds a run of 3+ tool rows and leaves shorter runs flat", () => {
    const tools = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ kind: "tool" as const, id: `t${i}`, name: "Read", summary: "" }));
    expect(groupSdkRows(tools(3)).map((r) => r.kind)).toEqual(["tools"]);
    expect(groupSdkRows(tools(2)).map((r) => r.kind)).toEqual(["row", "row"]);
  });
});
