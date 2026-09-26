import { describe, expect, it } from "vitest";
import {
  INITIAL_SDK_STATE,
  applySdkEvent,
  appendUserRow,
  answerQuestion,
  currentActivity,
  decidePermission,
  dropRewoundRows,
  groupSdkRows,
  markInterruptRequested,
  markUserEdited,
  parseSdkFrame,
  toolHeadline,
  toolSummary,
  type SdkChatState,
  type SdkEvent,
} from "./sdkChat";
import { pendingDecisions } from "./pendingDecisions";

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

  it("system_note draws the panel's own line as a muted note, never a bubble, never a turn", () => {
    // The deploy-resume line ("o turno foi interrompido por uma atualização do painel…"): replayed
    // from the history like any other event, rendered like the terminal-activity note.
    const state = feed([
      { type: "ready" },
      { type: "system_note", text: "O turno foi interrompido por uma atualização do painel — retomando automaticamente…" },
    ]);
    expect(state.rows).toEqual([
      { kind: "note", id: "note:1", text: "O turno foi interrompido por uma atualização do painel — retomando automaticamente…" },
    ]);
    expect(state.turnActive).toBe(false); // a note is about the conversation, not work in flight
  });

  it("streams deltas into ONE growing assistant row, consolidated by assistant_text", () => {
    const state = feed([
      { type: "ready" },
      { type: "assistant_delta", text: "Olá" },
      { type: "assistant_delta", text: ", Alex" },
      { type: "assistant_text", text: "Olá, Alex!" },
    ]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "assistant", text: "Olá, Alex!", streaming: false });
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

  /**
   * The MUTE bubble: an interrupted turn comes back as `is_error` with no `result` text, and the
   * reducer used to write the bare string "error" into a red row. Two rules replaced it.
   */
  it("an error result with no words carries a translatable sentinel, never the word 'error'", () => {
    const state = feed([{ type: "result", isError: true, subtype: "error_during_execution" }]);
    expect(state.rows[0]).toMatchObject({ kind: "error", text: "sdk-error:turn-failed|error_during_execution" });

    const bare = feed([{ type: "result", isError: true }]);
    expect(bare.rows[0]).toMatchObject({ kind: "error", text: "sdk-error:turn-failed" });
  });

  it("a stop WE asked for draws nothing: an aborted turn is not a failure", () => {
    const stopped = markInterruptRequested(feed([{ type: "ready" }, { type: "assistant_delta", text: "indo…" }]));
    const state = applySdkEvent(stopped, { type: "result", isError: true, subtype: "error_during_execution" });
    expect(state.rows.filter((r) => r.kind === "error")).toHaveLength(0);
    expect(state.turnActive).toBe(false);
    expect(state.interruptRequested).toBe(false); // one result consumes the flag

    // …and the NEXT failure, which nobody asked for, is drawn again
    const after = applySdkEvent(state, { type: "result", isError: true });
    expect(after.rows.filter((r) => r.kind === "error")).toHaveLength(1);
  });

  it("a reconnect drops the pending stop — it must not swallow a later real failure", () => {
    const stopped = markInterruptRequested(feed([{ type: "ready" }]));
    const reconnected = applySdkEvent(stopped, { type: "ready" });
    expect(reconnected.interruptRequested).toBe(false);
  });

  it("an error/parse_error with no text falls back to a sentinel instead of an empty red box", () => {
    const state = feed([{ type: "error", message: "" }, { type: "assistant_text", text: "x" }, { type: "parse_error", raw: "" }]);
    const errors = state.rows.filter((r) => r.kind === "error");
    expect(errors).toHaveLength(2);
    expect(errors.every((r) => r.kind === "error" && r.text === "sdk-error:no-detail")).toBe(true);
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

  it("`ready` with turnActive:true LIGHTS the spinner — the reattach mid-turn", () => {
    // The user switched Terminal↔Chat with a turn running: the remounted view reattached to the live
    // driver, the synthesized `ready` arrived, and nothing re-lit "Trabalhando…" until the next
    // live event. The frame now carries the manager's real state: turn in flight = spinner on.
    let state = applySdkEvent(INITIAL_SDK_STATE, { type: "user", text: "replayed" });
    state = applySdkEvent(state, { type: "assistant_text", text: "tail replayed" });
    state = applySdkEvent(state, { type: "ready", turnActive: true });
    expect(state.ready).toBe(true);
    expect(state.turnActive).toBe(true);
    // …and the turn's end still puts it out.
    state = applySdkEvent(state, { type: "result", isError: false });
    expect(state.turnActive).toBe(false);
  });

  it("`ready` with turnActive:false (or absent) keeps the spinner OFF", () => {
    let state = applySdkEvent(INITIAL_SDK_STATE, { type: "ready", turnActive: false });
    expect(state.turnActive).toBe(false);
    state = applySdkEvent(INITIAL_SDK_STATE, { type: "ready" });
    expect(state.turnActive).toBe(false);
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
    const from = { kind: "user" as const, name: "alex" };
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

describe("user questions (AskUserQuestion no chat)", () => {
  const QUESTIONS = [
    { question: "Formato?", header: "Format", options: [{ label: "Resumo" }, { label: "Detalhado" }] },
  ];

  it("a user_question draws a pending question card and keeps the turn alive", () => {
    const state = feed([
      { type: "ready" },
      { type: "user_question", id: "q_1", questions: QUESTIONS },
    ]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ kind: "question", id: "q_1", outcome: "pending" });
    expect(state.turnActive).toBe(true);
  });

  it("ignores a question with no id or no questions", () => {
    const ready = feed([{ type: "ready" }]);
    expect(applySdkEvent(ready, { type: "user_question", questions: QUESTIONS })).toBe(ready);
    expect(applySdkEvent(ready, { type: "user_question", id: "q_1", questions: [] })).toBe(ready);
  });

  it("a question_result settles the card — answered with the picks, unanswered without", () => {
    const pending = feed([
      { type: "ready" },
      { type: "user_question", id: "q_1", questions: QUESTIONS },
    ]);
    const answered = applySdkEvent(pending, { type: "question_result", id: "q_1", answers: [{ selected: ["Resumo"] }] });
    expect(answered.rows[0]).toMatchObject({ kind: "question", outcome: "answered", answers: [{ selected: ["Resumo"] }] });

    const gaveUp = applySdkEvent(pending, { type: "question_result", id: "q_1", timedOut: true });
    expect(gaveUp.rows[0]).toMatchObject({ kind: "question", outcome: "unanswered" });
  });

  it("the first settlement wins — a late echo cannot flip the card", () => {
    const pending = feed([
      { type: "ready" },
      { type: "user_question", id: "q_1", questions: QUESTIONS },
    ]);
    const clicked = answerQuestion(pending, "q_1", [{ selected: ["Resumo"] }]);
    expect(clicked.rows[0]).toMatchObject({ outcome: "answered" });
    const echoed = applySdkEvent(clicked, { type: "question_result", id: "q_1", answers: [{ selected: ["Detalhado"] }] });
    expect(echoed.rows[0]).toMatchObject({ outcome: "answered", answers: [{ selected: ["Resumo"] }] });
  });

  it("REPLAY: a user_question with no question_result re-renders PENDING (clickable after F5)", () => {
    // History replays before `ready` — exactly what a reconnect looks like.
    const state = feed([
      { type: "user", text: "planeja a tela" },
      { type: "user_question", id: "q_9", questions: QUESTIONS },
      { type: "ready", turnActive: true },
    ]);
    expect(state.rows[1]).toMatchObject({ kind: "question", id: "q_9", outcome: "pending" });
    // …and a replayed PAIR comes back settled.
    const settled = feed([
      { type: "user_question", id: "q_9", questions: QUESTIONS },
      { type: "question_result", id: "q_9", answers: [{ selected: ["Detalhado"] }] },
      { type: "ready" },
    ]);
    expect(settled.rows[0]).toMatchObject({ kind: "question", outcome: "answered" });
  });

  it("answerQuestion on an unknown id changes nothing", () => {
    const state = feed([{ type: "ready" }]);
    expect(answerQuestion(state, "ghost", [{ selected: ["A"] }])).toBe(state);
  });
});

describe("mensagem editada (supersede)", () => {
  it("markUserEdited dims the LAST user row with those words, once", () => {
    let state = appendUserRow(INITIAL_SDK_STATE, "sobe pra prod");
    state = appendUserRow(state, "outra coisa");
    state = markUserEdited(state, "sobe pra prod");
    expect(state.rows[0]).toMatchObject({ kind: "user", text: "sobe pra prod", edited: true });
    expect((state.rows[1] as { edited?: boolean }).edited).toBeUndefined();
  });

  it("matches whitespace-insensitively and skips rows already edited", () => {
    let state = appendUserRow(INITIAL_SDK_STATE, "roda  os testes");
    state = appendUserRow(state, "roda os testes");
    state = markUserEdited(state, "roda os testes"); // marks the LAST match
    state = markUserEdited(state, "roda os testes"); // then the remaining one
    expect(state.rows.every((r) => (r as { edited?: boolean }).edited === true)).toBe(true);
  });

  it("no match / blank target: the state comes back untouched (same object)", () => {
    const state = appendUserRow(INITIAL_SDK_STATE, "oi");
    expect(markUserEdited(state, "tchau")).toBe(state);
    expect(markUserEdited(state, "   ")).toBe(state);
  });

  it("a replayed message_edited event settles the original and the new version stands", () => {
    const state = feed([
      { type: "user", text: "sobe pra prod" },
      { type: "message_edited", originalText: "sobe pra prod" },
      { type: "user", text: "sobe pra dev" },
    ]);
    expect(state.rows[0]).toMatchObject({ kind: "user", text: "sobe pra prod", edited: true });
    expect(state.rows[1]).toMatchObject({ kind: "user", text: "sobe pra dev" });
    expect((state.rows[1] as { edited?: boolean }).edited).toBeUndefined();
  });

  it("message_edited without originalText changes nothing", () => {
    const state = appendUserRow(INITIAL_SDK_STATE, "oi");
    expect(applySdkEvent(state, { type: "message_edited" })).toBe(state);
  });
});

describe("mensagem no meio do turno (turn_absorbed — streaming input)", () => {
  it("labels the LAST user row as absorbed (entrou no turno em andamento)", () => {
    let state = appendUserRow(INITIAL_SDK_STATE, "faz a tarefa");
    state = feed([{ type: "ready" }], state);
    state = appendUserRow(state, "aproveita e ajusta o título", undefined, { awaiting: true });
    state = feed([{ type: "turn_absorbed" }], state);
    const users = state.rows.filter((r) => r.kind === "user");
    expect(users[0]).toMatchObject({ text: "faz a tarefa" });
    expect((users[0] as { absorbed?: boolean }).absorbed).toBeUndefined();
    expect(users[1]).toMatchObject({ text: "aproveita e ajusta o título", absorbed: true });
    // The driver reacted AND the turn keeps running: the ladder settles into plain "Trabalhando…".
    expect(state.awaiting).toBe(false);
    expect(state.turnActive).toBe(true);
  });

  it("two absorbed sends each get their own label (newest first, never re-labelling)", () => {
    let state = feed([{ type: "ready" }], appendUserRow(INITIAL_SDK_STATE, "um"));
    state = appendUserRow(state, "dois");
    state = feed([{ type: "turn_absorbed" }], state);
    state = appendUserRow(state, "três");
    state = feed([{ type: "turn_absorbed" }], state);
    const users = state.rows.filter((r) => r.kind === "user") as Array<{ text: string; absorbed?: boolean }>;
    expect(users.map((u) => !!u.absorbed)).toEqual([false, true, true]);
  });

  it("a duplicated turn_absorbed with nothing newer to label changes nothing", () => {
    let state = feed([{ type: "ready" }], appendUserRow(INITIAL_SDK_STATE, "um"));
    state = appendUserRow(state, "dois");
    state = feed([{ type: "turn_absorbed" }], state);
    const again = feed([{ type: "turn_absorbed" }], state);
    expect(again.rows).toEqual(state.rows);
  });

  it("with no user row at all it is a no-op", () => {
    const state = feed([{ type: "ready" }, { type: "turn_absorbed" }]);
    expect(state.rows).toEqual([]);
  });
});

describe("escada de estados — awaiting (Preparando/Pensando antes do primeiro token)", () => {
  it("one's own live send lights `awaiting`; a replayed user event never does", () => {
    const live = appendUserRow(INITIAL_SDK_STATE, "oi", undefined, { awaiting: true });
    expect(live.awaiting).toBe(true);
    const replayed = applySdkEvent(INITIAL_SDK_STATE, { type: "user", text: "oi" });
    expect(replayed.awaiting).toBe(false);
  });

  it("`ready` does NOT clear it (that is the Preparando→Pensando transition)", () => {
    const state = feed([{ type: "ready" }], appendUserRow(INITIAL_SDK_STATE, "oi", undefined, { awaiting: true }));
    expect(state.awaiting).toBe(true);
    expect(state.ready).toBe(true);
  });

  it("the first delta clears it and the plain turn spinner takes over", () => {
    let state = appendUserRow(INITIAL_SDK_STATE, "oi", undefined, { awaiting: true });
    state = feed([{ type: "ready" }, { type: "assistant_delta", text: "olá" }], state);
    expect(state.awaiting).toBe(false);
    expect(state.turnActive).toBe(true);
  });

  it("a tool call, a result and an error all clear it", () => {
    const base = appendUserRow(INITIAL_SDK_STATE, "oi", undefined, { awaiting: true });
    expect(feed([{ type: "tool_use", id: "t1", name: "Bash" }], base).awaiting).toBe(false);
    expect(feed([{ type: "result", isError: false }], base).awaiting).toBe(false);
    expect(feed([{ type: "error", message: "boom" }], base).awaiting).toBe(false);
  });
});

/**
 * O RACIOCÍNIO NA TELA (pedido do César, 2026-09-17): "só fica um loading escrito 'Trabalhando…' e
 * eu não sei o que está acontecendo. Se ela estiver pensando, mostra o pensamento ali."
 *
 * O pensamento é a única coisa que o modelo produz ANTES da resposta, então é ele que transforma a
 * espera em acompanhamento. Regra central: pensamento e resposta são DUAS correntes — uma nunca
 * escreve na linha da outra.
 */
describe("raciocínio ao vivo (o que a espera mostra)", () => {
  it("deltas de raciocínio se acumulam numa linha própria, marcada como em curso", () => {
    const state = feed([
      { type: "ready" },
      { type: "thinking_delta", text: "Vou ler o " },
      { type: "thinking_delta", text: "arquivo primeiro" },
    ]);
    expect(state.rows).toEqual([
      { kind: "thinking", id: "t:1", text: "Vou ler o arquivo primeiro", streaming: true },
    ]);
    expect(state.turnActive).toBe(true);
  });

  it("o bloco consolidado FECHA a linha e substitui os deltas (mesmas palavras, sem duplicar)", () => {
    const state = feed([
      { type: "ready" },
      { type: "thinking_delta", text: "Vou ler o " },
      { type: "thinking", text: "Vou ler o arquivo primeiro." },
    ]);
    expect(state.rows).toEqual([
      { kind: "thinking", id: "t:1", text: "Vou ler o arquivo primeiro.", streaming: false },
    ]);
  });

  it("a RESPOSTA não é escrita na linha do raciocínio (as duas correntes não se misturam)", () => {
    const state = feed([
      { type: "ready" },
      { type: "thinking_delta", text: "preciso checar o teste" },
      { type: "assistant_delta", text: "Claro! " },
      { type: "assistant_delta", text: "Já vou." },
    ]);
    expect(state.rows).toEqual([
      { kind: "thinking", id: "t:1", text: "preciso checar o teste", streaming: false },
      { kind: "assistant", id: "a:2", text: "Claro! Já vou.", streaming: true },
    ]);
  });

  it("voltar a pensar depois de responder abre OUTRA linha, e fecha o parágrafo anterior", () => {
    const state = feed([
      { type: "ready" },
      { type: "assistant_delta", text: "Vou verificar." },
      { type: "thinking_delta", text: "o teste falhou, então…" },
    ]);
    expect(state.rows.map((r) => [r.kind, "streaming" in r ? r.streaming : null])).toEqual([
      ["assistant", false],
      ["thinking", true],
    ]);
  });

  it("raciocínio vazio não vira linha nenhuma (bloco redigido/omitido não polui a conversa)", () => {
    const state = feed([{ type: "ready" }, { type: "thinking", text: "" }, { type: "thinking_delta", text: "" }]);
    expect(state.rows).toEqual([]);
  });

  it("pensar é sinal de trabalho: a escada de status sai de 'Pensando…' para o pensamento real", () => {
    const after = feed([
      { type: "ready" },
      { type: "thinking_delta", text: "hmm" },
    ], { ...INITIAL_SDK_STATE, awaiting: true });
    expect(after.awaiting).toBe(false); // o texto na tela substitui a promessa do spinner
    expect(after.turnActive).toBe(true);
  });

  it("o fim do turno fecha um raciocínio que ficou aberto (nada fica 'pensando' para sempre)", () => {
    const state = feed([
      { type: "ready" },
      { type: "thinking_delta", text: "pensando alto" },
      { type: "result", isError: false },
    ]);
    expect(state.turnActive).toBe(false);
    expect(state.rows.every((r) => !("streaming" in r) || r.streaming === false)).toBe(true);
  });
});

/**
 * "MANDEI A MENSAGEM E NADA ACONTECE, FICA PRESO NESSA TELA" (produção, 2026-09-17): com um plano de
 * opções na tela, quem não gostava do plano escrevia no chat para mudar o rumo — e o turno seguia
 * parado, esperando um clique que não viria, até o timeout de 30 minutos.
 *
 * A regra agora: falar É responder. O cartão se resolve como SUBSTITUÍDO — que não é o mesmo que
 * "sem resposta": a pessoa respondeu, só não pelo cartão, e a tela não pode dizer o contrário.
 */
describe("a mensagem substitui o cartão de pergunta", () => {
  const question: SdkEvent = {
    type: "user_question",
    id: "q1",
    questions: [{ question: "Abro PR ou commito direto?", options: [{ label: "PR" }, { label: "direto" }] }],
  };

  it("question_result com superseded resolve o cartão como substituído", () => {
    const state = feed([{ type: "ready" }, question, { type: "question_result", id: "q1", superseded: true }]);
    const card = state.rows.find((r) => r.kind === "question");
    expect(card).toMatchObject({ kind: "question", outcome: "superseded" });
  });

  it("substituído NÃO é 'sem resposta' (o timeout continua dizendo o que é)", () => {
    const superseded = feed([{ type: "ready" }, question, { type: "question_result", id: "q1", superseded: true }]);
    const gaveUp = feed([{ type: "ready" }, question, { type: "question_result", id: "q1" }]);
    expect((superseded.rows.find((r) => r.kind === "question") as { outcome: string }).outcome).toBe("superseded");
    expect((gaveUp.rows.find((r) => r.kind === "question") as { outcome: string }).outcome).toBe("unanswered");
  });

  it("o cartão sai da bandeja de decisões pendentes — nada mais fica cobrando um clique", () => {
    const before = feed([{ type: "ready" }, question]);
    expect(pendingDecisions(before.rows)).toHaveLength(1);
    const after = applySdkEvent(before, { type: "question_result", id: "q1", superseded: true });
    expect(pendingDecisions(after.rows)).toHaveLength(0);
  });

  it("um clique que chegou primeiro ganha: a resposta real não é rebaixada a 'substituída'", () => {
    const answered = feed([
      { type: "ready" },
      question,
      { type: "question_result", id: "q1", answers: [{ selected: ["PR"] }] },
      { type: "question_result", id: "q1", superseded: true },
    ]);
    expect((answered.rows.find((r) => r.kind === "question") as { outcome: string }).outcome).toBe("answered");
  });
});

describe("the session's command catalogue", () => {
  const commands = [
    { name: "code-review", description: "Review the diff", source: "skill" as const },
    { name: "compact", source: "command" as const },
  ];

  it("keeps the catalogue as state, out of the conversation", () => {
    const state = feed([{ type: "catalog", commands }]);
    expect(state.commands).toEqual(commands);
    expect(state.rows).toEqual([]);
  });

  it("REPLACES it when it changes — a refreshed catalogue is the whole truth", () => {
    const state = feed([
      { type: "catalog", commands },
      { type: "catalog", commands: [{ name: "simplify", source: "skill" as const }] },
    ]);
    expect(state.commands.map((c) => c.name)).toEqual(["simplify"]);
  });

  it("ignores a frame with no list rather than emptying the menu", () => {
    const state = feed([{ type: "catalog", commands }, { type: "catalog" }]);
    expect(state.commands).toEqual(commands);
  });

  it("draws a local command's answer as its own row, not as something Claude said", () => {
    const state = feed([{ type: "local_output", text: "Session cost: $0.42" }]);
    expect(state.rows).toEqual([{ kind: "command_output", id: expect.any(String), text: "Session cost: $0.42" }]);
    // It also ends the waiting ladder: the command WAS answered, there is nothing to wait for.
    expect(state.awaiting).toBe(false);
  });
});


/**
 * REBOBINAR NA TELA. Quando a edição rebobina a sessão, o modelo perde o original, a resposta pela
 * metade e as ferramentas do meio — e a tela tem de perder também, ou ela fica mostrando uma
 * conversa que o modelo não tem.
 *
 * Os dois erros aqui têm custos MUITO diferentes: apagar de menos deixa uma linha velha na tela
 * (feio); apagar de mais some com a mensagem que a pessoa acabou de escrever (perda). Por isso a
 * maior parte do que está abaixo tenta fazer a função apagar demais.
 */
describe("dropRewoundRows — apagar de menos é feio, apagar de mais é perda", () => {
  const edited = (text: string) => markUserEdited(appendUserRow(INITIAL_SDK_STATE, text), text);

  it("tira o original, a meia resposta e a nota, e mantém a mensagem nova", () => {
    let state = edited("errada");
    state = applySdkEvent(state, { type: "assistant_text", text: "meia resposta" });
    state = applySdkEvent(state, { type: "system_note", text: "turn-interrupted-edit" });
    state = appendUserRow(state, "certa");

    const after = dropRewoundRows(state);
    expect(after.rows.map((r) => r.kind)).toEqual(["user"]);
    expect(after.rows[0]).toMatchObject({ kind: "user", text: "certa" });
  });

  it("o que veio DEPOIS da mensagem nova sobrevive — é mais novo que o rebobinar", () => {
    let state = edited("errada");
    state = applySdkEvent(state, { type: "assistant_text", text: "meia" });
    state = appendUserRow(state, "certa");
    state = applySdkEvent(state, { type: "assistant_text", text: "já respondendo a nova" });

    const after = dropRewoundRows(state);
    expect(after.rows.map((r) => (r.kind === "user" ? r.text : r.kind === "assistant" ? r.text : r.kind)))
      .toEqual(["certa", "já respondendo a nova"]);
  });

  it("sem linha marcada como editada, devolve o MESMO objeto — nada é tocado por engano", () => {
    let state = appendUserRow(INITIAL_SDK_STATE, "só uma mensagem");
    state = applySdkEvent(state, { type: "assistant_text", text: "resposta" });
    expect(dropRewoundRows(state)).toBe(state);
  });

  it("a conversa ANTES da mensagem editada fica intacta", () => {
    let state = appendUserRow(INITIAL_SDK_STATE, "primeira");
    state = applySdkEvent(state, { type: "assistant_text", text: "resposta da primeira" });
    state = markUserEdited(appendUserRow(state, "errada"), "errada");
    state = applySdkEvent(state, { type: "assistant_text", text: "meia" });
    state = appendUserRow(state, "certa");

    const after = dropRewoundRows(state);
    expect(after.rows.map((r) => (r.kind === "user" ? `u:${r.text}` : r.kind === "assistant" ? `a:${r.text}` : r.kind)))
      .toEqual(["u:primeira", "a:resposta da primeira", "u:certa"]);
  });

  it("com DUAS edições no histórico, corta só a mais recente", () => {
    let state = markUserEdited(appendUserRow(INITIAL_SDK_STATE, "errada 1"), "errada 1");
    state = appendUserRow(state, "certa 1");
    state = applySdkEvent(state, { type: "assistant_text", text: "resposta da certa 1" });
    state = markUserEdited(appendUserRow(state, "errada 2"), "errada 2");
    state = applySdkEvent(state, { type: "assistant_text", text: "meia 2" });
    state = appendUserRow(state, "certa 2");

    const after = dropRewoundRows(state);
    const texts = after.rows.map((r) => (r.kind === "user" ? `u:${r.text}` : r.kind === "assistant" ? `a:${r.text}` : r.kind));
    // a edição antiga e sua resposta continuam lá; só o miolo da segunda sai
    expect(texts).toEqual(["u:errada 1", "u:certa 1", "a:resposta da certa 1", "u:certa 2"]);
  });

  it("a linha editada sendo a ÚLTIMA mensagem, nada é cortado — nunca some a mensagem de quem escreveu", () => {
    // Ordem que o fluxo real não produz (a nova mensagem é sempre acrescentada depois). Se um dia
    // produzir, o pior resultado aceitável é NÃO cortar nada.
    let state = edited("errada");
    state = applySdkEvent(state, { type: "assistant_text", text: "meia" });
    expect(dropRewoundRows(state)).toBe(state);
    expect(dropRewoundRows(state).rows.some((r) => r.kind === "user" && r.text === "errada")).toBe(true);
  });

  it("uma tela vazia não vira erro", () => {
    expect(dropRewoundRows(INITIAL_SDK_STATE)).toBe(INITIAL_SDK_STATE);
  });

  /**
   * A trava de ordem (`editedAt >= lastUserAt`) é defendida DUAS vezes no código — pela própria
   * checagem e pela de "não cortou nada" —, então nenhum caso isolado consegue provar que ela
   * existe. Em vez de fingir que prova, este teste ataca a CLASSE do erro: monta centenas de
   * conversas diferentes (determinísticas) e cobra as duas invariantes que, se quebrarem, custam
   * uma mensagem de gente.
   */
  it("invariante, em centenas de conversas: a última mensagem do usuário e tudo antes da editada sobrevivem", () => {
    let seed = 20260926;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const KINDS = ["user", "assistant", "note", "tool"] as const;

    for (let round = 0; round < 400; round += 1) {
      let state = INITIAL_SDK_STATE;
      const length = 1 + rnd(9);
      for (let i = 0; i < length; i += 1) {
        const kind = KINDS[rnd(KINDS.length)] as (typeof KINDS)[number];
        if (kind === "user") {
          state = appendUserRow(state, `u${round}-${i}`);
          if (rnd(3) === 0) state = markUserEdited(state, `u${round}-${i}`);
        } else if (kind === "assistant") {
          state = applySdkEvent(state, { type: "assistant_text", text: `a${round}-${i}` });
        } else if (kind === "note") {
          state = applySdkEvent(state, { type: "system_note", text: "turn-interrupted-edit" });
        } else {
          state = applySdkEvent(state, { type: "tool_use", id: `t${i}`, name: "Bash", input: {} });
        }
      }
      const before = state.rows;
      const lastUser = [...before].reverse().find((r) => r.kind === "user");
      const editedAt = before.map((r) => r.kind === "user" && r.edited === true).lastIndexOf(true);
      const after = dropRewoundRows(state).rows;

      // 1. a mensagem que a pessoa acabou de escrever NUNCA some
      if (lastUser) expect(after).toContain(lastUser);
      // 2. tudo que vem antes da linha editada é conversa que o modelo ainda tem — fica igual
      if (editedAt > 0) expect(after.slice(0, editedAt)).toEqual(before.slice(0, editedAt));
      // 3. nada é inventado nem duplicado
      expect(after.length).toBeLessThanOrEqual(before.length);
      expect(new Set(after).size).toBe(after.length);
      for (const row of after) expect(before).toContain(row);
    }
  });
});

describe("evento `rewound` — a tela só esquece quando o modelo esqueceu", () => {
  function conversaEditada(): SdkChatState {
    let state = appendUserRow(INITIAL_SDK_STATE, "primeira");
    state = applySdkEvent(state, { type: "assistant_text", text: "resposta" });
    state = markUserEdited(appendUserRow(state, "errada"), "errada");
    state = applySdkEvent(state, { type: "assistant_text", text: "meia" });
    return appendUserRow(state, "certa");
  }

  it("ok: true corta as linhas que o modelo perdeu", () => {
    const after = applySdkEvent(conversaEditada(), { type: "rewound", ok: true, uuid: "u1" } as SdkEvent);
    expect(after.rows.some((r) => r.kind === "user" && r.text === "errada")).toBe(false);
    expect(after.rows.some((r) => r.kind === "assistant" && r.text === "meia")).toBe(false);
    expect(after.rows.some((r) => r.kind === "user" && r.text === "certa")).toBe(true);
  });

  it("ok: false NÃO corta nada — o driver mandou um supersede, tudo na tela ainda vale", () => {
    const state = conversaEditada();
    for (const reason of ["absorbed", "no-fork-point"] as const) {
      const after = applySdkEvent(state, { type: "rewound", ok: false, reason } as SdkEvent);
      expect(after).toBe(state);
    }
  });

  it("um `rewound` sem `ok` (versão antiga, frame truncado) não corta nada", () => {
    const state = conversaEditada();
    expect(applySdkEvent(state, { type: "rewound" } as SdkEvent)).toBe(state);
    expect(applySdkEvent(state, { type: "rewound", ok: "sim" } as unknown as SdkEvent)).toBe(state);
  });

  it("`rewound` é aceito pelo parser de frames — o back emite, a tela não pode chamar de lixo", () => {
    expect(parseSdkFrame(`{"type":"rewound","ok":true,"uuid":"abc"}`)).toEqual({ type: "rewound", ok: true, uuid: "abc" });
  });
});

/**
 * THE FLOW OF THE AGENT, as the terminal shows it. A tool call used to read `Bash` plus a
 * truncated blob of its input: the agent's own headline for what it was doing was IN that input
 * and never reached the screen, and a skill that goes off to run in the background looked exactly
 * like a file being read.
 */
describe("toolHeadline", () => {
  it("Bash: the agent's description is the headline, the command is the detail", () => {
    expect(toolHeadline("Bash", { description: "Measuring PDV module size", command: "ls && find src" })).toEqual({
      title: "Measuring PDV module size",
      detail: "$ ls && find src",
    });
    // No description: the tool's name is the headline, never an empty line.
    expect(toolHeadline("Bash", { command: "npm test" })).toEqual({ title: "Bash", detail: "$ npm test" });
    expect(toolHeadline("Bash", {})).toEqual({ title: "Bash" });
  });

  it("files: the basename in the headline, the full path underneath", () => {
    expect(toolHeadline("Read", { file_path: "/work/repo/src/registry.ts" })).toEqual({
      title: "Read(registry.ts)",
      detail: "/work/repo/src/registry.ts",
    });
    // A bare name has nothing to add on the second line.
    expect(toolHeadline("Write", { file_path: "notes.md" })).toEqual({ title: "Write(notes.md)" });
  });

  it("search and fetch name what they are looking for", () => {
    expect(toolHeadline("Grep", { pattern: "purgeCard", path: "back/src" })).toEqual({
      title: "Grep(purgeCard)",
      detail: "back/src",
    });
    expect(toolHeadline("WebFetch", { url: "https://docs.anthropic.com/x" })).toEqual({
      title: "Fetch(docs.anthropic.com)",
      detail: "https://docs.anthropic.com/x",
    });
    expect(toolHeadline("WebSearch", { query: "vibehub" })).toEqual({ title: "Search(vibehub)" });
  });

  it("a SKILL and a TASK say they are running in the background — that is the point of the line", () => {
    expect(toolHeadline("Skill", { skill: "code-review", args: "high backend/src" })).toEqual({
      title: "Skill(code-review)",
      detail: "high backend/src",
      background: true,
    });
    expect(toolHeadline("Task", { description: "audita o pdv", subagent_type: "Explore" })).toEqual({
      title: "Task(audita o pdv)",
      detail: "Explore",
      background: true,
    });
    expect(toolHeadline("Workflow", { name: "review-changes" }).background).toBe(true);
  });

  it("an unknown tool keeps the old behaviour: its name and the one-line summary", () => {
    expect(toolHeadline("SomeNewTool", { prompt: "faz  isso\naqui" })).toEqual({
      title: "SomeNewTool",
      detail: "faz isso aqui",
    });
    expect(toolHeadline("", null)).toEqual({ title: "?" });
  });

  it("caps a long line instead of letting it push the layout", () => {
    const headline = toolHeadline("Bash", { command: "x".repeat(400) });
    expect((headline.detail ?? "").length).toBeLessThanOrEqual(120);
    expect(headline.detail?.endsWith("…")).toBe(true);
  });
});

describe("currentActivity (what the sticky bar reports)", () => {
  const ready = (): SdkChatState => applySdkEvent(INITIAL_SDK_STATE, { type: "ready" });

  it("names the newest tool call of the turn", () => {
    let state = ready();
    state = appendUserRow(state, "faz a coisa", undefined, { awaiting: true });
    state = applySdkEvent(state, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a/b.ts" } });
    state = applySdkEvent(state, {
      type: "tool_use", id: "t2", name: "Skill", input: { skill: "code-review" },
    });
    expect(currentActivity(state)).toEqual({
      kind: "tool", label: "Skill(code-review)", rowId: "t2", background: true,
    });
  });

  it("reports the reasoning while it streams and the answer while it is being written", () => {
    let state = ready();
    state = appendUserRow(state, "pensa", undefined, { awaiting: true });
    state = applySdkEvent(state, { type: "thinking_delta", text: "hmm" });
    expect(currentActivity(state)?.kind).toBe("thinking");
    state = applySdkEvent(state, { type: "assistant_delta", text: "então" });
    expect(currentActivity(state)?.kind).toBe("answering");
    // A settled answer is not activity any more — the turn produced it.
    state = applySdkEvent(state, { type: "assistant_text", text: "então: isso." });
    expect(currentActivity(state)).toBeNull();
  });

  it("never reports work from a turn that is over (it stops at the last message)", () => {
    let state = ready();
    state = applySdkEvent(state, { type: "tool_use", id: "t1", name: "Bash", input: { command: "old" } });
    state = appendUserRow(state, "outra pergunta", undefined, { awaiting: true });
    expect(currentActivity(state)).toBeNull();
  });
});
