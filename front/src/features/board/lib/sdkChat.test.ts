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

describe("applySdkEvent", () => {
  it("ready arms the view; a resume id becomes the session and a note", () => {
    const state = feed([{ type: "ready", resume: "abc-123" }]);
    expect(state.ready).toBe(true);
    expect(state.sessionId).toBe("abc-123");
    expect(state.rows).toEqual([{ kind: "note", id: "note:1", text: "resume:abc-123" }]);
  });

  it("streams deltas into ONE growing assistant row, consolidated by assistant_text", () => {
    const state = feed([
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
