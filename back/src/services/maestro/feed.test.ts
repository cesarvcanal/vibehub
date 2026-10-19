import { describe, it, expect } from "vitest";
import {
  pendingQuestionFromHistory, pendingPermissionFromHistory, pendingQuestionFromTranscript, activityFromTranscript,
  ACTIVITY_TEXT_MAX,
} from "./feed.js";
import { QUESTION_TIMEOUT_MS, PERMISSION_TIMEOUT_MS } from "../sdk/protocol.js";
import type { HistoryEvent } from "../sdk/history.js";

/**
 * FEED — what an assistant OUTSIDE the board (ChatGPT, by voice) needs to follow a card without
 * looking at it: is the card asking the user something, what has it been doing, and what did it say.
 * Everything here is PURE: the inputs are the card's sdk history and its Claude transcript tail.
 */

const NOW = 1_800_000_000_000;
const Q = [{ question: "Qual banco?", header: "Banco", options: [{ label: "Mongo (recomendado)" }, { label: "MySQL" }] }];

describe("pendingQuestionFromHistory (the native chat's question card)", () => {
  it("is the question the card asked and nobody answered yet", () => {
    const events: HistoryEvent[] = [
      { type: "user", text: "crie a tabela", at: NOW - 5000 },
      { type: "user_question", id: "q1", questions: Q, at: NOW - 1000 },
    ];
    expect(pendingQuestionFromHistory(events, NOW)).toEqual({ id: "q1", source: "chat", askedAt: NOW - 1000, questions: Q });
  });

  it("is gone once the question was answered (question_result)", () => {
    const events: HistoryEvent[] = [
      { type: "user_question", id: "q1", questions: Q, at: NOW - 1000 },
      { type: "question_result", id: "q1", answers: [{ selected: ["MySQL"] }], at: NOW - 500 },
    ];
    expect(pendingQuestionFromHistory(events, NOW)).toBeNull();
  });

  it("is gone once someone SPOKE after it — a message answers the question (falar é responder)", () => {
    const events: HistoryEvent[] = [
      { type: "user_question", id: "q1", questions: Q, at: NOW - 1000 },
      { type: "user", text: "use o mysql", at: NOW - 500 },
    ];
    expect(pendingQuestionFromHistory(events, NOW)).toBeNull();
  });

  it("is gone after the driver's own timeout — the model was already told 'no answer'", () => {
    const events: HistoryEvent[] = [{ type: "user_question", id: "q1", questions: Q, at: NOW - QUESTION_TIMEOUT_MS - 1 }];
    expect(pendingQuestionFromHistory(events, NOW)).toBeNull();
  });

  it("picks the NEWEST open question when several are open", () => {
    const later = [{ question: "E o índice?", options: [{ label: "Sim" }] }];
    const events: HistoryEvent[] = [
      { type: "user_question", id: "q1", questions: Q, at: NOW - 2000 },
      { type: "user_question", id: "q2", questions: later, at: NOW - 1000 },
    ];
    expect(pendingQuestionFromHistory(events, NOW)?.id).toBe("q2");
  });

  it("is null on an empty history", () => {
    expect(pendingQuestionFromHistory([], NOW)).toBeNull();
  });
});

describe("pendingPermissionFromHistory (a sensitive tool waiting for Permitir/Negar)", () => {
  it("is the request no decision paired yet", () => {
    const events: HistoryEvent[] = [
      { type: "permission_request", id: "p1", tool: "Bash", reason: "git push --force", at: NOW - 1000 },
    ];
    expect(pendingPermissionFromHistory(events, NOW)).toEqual({ id: "p1", tool: "Bash", reason: "git push --force", askedAt: NOW - 1000 });
  });

  it("is gone once decided, or after its timeout", () => {
    expect(pendingPermissionFromHistory([
      { type: "permission_request", id: "p1", tool: "Bash", at: NOW - 1000 },
      { type: "permission", id: "p1", tool: "Bash", decision: "allow", sensitive: true, at: NOW - 900 },
    ], NOW)).toBeNull();
    expect(pendingPermissionFromHistory([
      { type: "permission_request", id: "p1", tool: "Bash", at: NOW - PERMISSION_TIMEOUT_MS - 1 },
    ], NOW)).toBeNull();
  });
});

/* ------------------------------------------------------------- transcripts */

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const ts = (ms: number) => new Date(ms).toISOString();
const assistant = (uuid: string, at: number, content: unknown[]) =>
  line({ type: "assistant", uuid, timestamp: ts(at), message: { content } });
const user = (uuid: string, at: number, content: unknown) =>
  line({ type: "user", uuid, timestamp: ts(at), message: { content } });
const askTool = (id: string) => ({ type: "tool_use", id, name: "AskUserQuestion", input: { questions: Q } });

describe("pendingQuestionFromTranscript (the terminal's question menu)", () => {
  it("is an AskUserQuestion call with no result yet, when nothing was said after it", () => {
    const jsonl = [
      user("u1", NOW - 3000, "crie a tabela"),
      assistant("a1", NOW - 2000, [{ type: "text", text: "Antes, uma dúvida." }, askTool("tu1")]),
    ].join("\n");
    expect(pendingQuestionFromTranscript(jsonl)).toEqual({ id: "tu1", source: "terminal", askedAt: NOW - 2000, questions: Q });
  });

  it("is gone once the tool has its result", () => {
    const jsonl = [
      assistant("a1", NOW - 2000, [askTool("tu1")]),
      user("u2", NOW - 1000, [{ type: "tool_result", tool_use_id: "tu1", content: "MySQL" }]),
    ].join("\n");
    expect(pendingQuestionFromTranscript(jsonl)).toBeNull();
  });

  it("is gone when the conversation moved on after it (an interrupted call that never got a result)", () => {
    const jsonl = [
      assistant("a1", NOW - 3000, [askTool("tu1")]),
      user("u2", NOW - 2000, "esquece, faça outra coisa"),
      assistant("a2", NOW - 1000, [{ type: "text", text: "Ok." }]),
    ].join("\n");
    expect(pendingQuestionFromTranscript(jsonl)).toBeNull();
  });

  it("survives torn and malformed lines, and ignores other tools", () => {
    const jsonl = [
      "{\"type\":\"assis",
      "not json",
      assistant("a1", NOW - 2000, [{ type: "tool_use", id: "tu9", name: "Bash", input: { command: "ls" } }]),
    ].join("\n");
    expect(pendingQuestionFromTranscript(jsonl)).toBeNull();
  });

  it("refuses a malformed AskUserQuestion input instead of inventing a question", () => {
    const jsonl = assistant("a1", NOW, [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: { questions: "?" } }]);
    expect(pendingQuestionFromTranscript(jsonl)).toBeNull();
  });
});

describe("activityFromTranscript (what the card has been doing)", () => {
  const jsonl = [
    user("u1", NOW - 5000, "rode os testes"),
    assistant("a1", NOW - 4000, [
      { type: "thinking", thinking: "segredo do raciocínio" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Run the test suite" } },
    ]),
    user("u2", NOW - 3500, [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
    assistant("a2", NOW - 3000, [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/w/src/app.ts" } }]),
    assistant("a3", NOW - 2000, [{ type: "text", text: "Testes verdes, corrigi app.ts." }]),
  ].join("\n");

  it("lists messages, tool calls (one line each) and answers, oldest first — never the reasoning or raw tool output", () => {
    const events = activityFromTranscript(jsonl);
    expect(events).toEqual([
      { at: NOW - 5000, kind: "user", text: "rode os testes" },
      { at: NOW - 4000, kind: "tool", tool: "Bash", text: "Run the test suite" },
      { at: NOW - 3000, kind: "tool", tool: "Edit", text: "app.ts" },
      { at: NOW - 2000, kind: "assistant", text: "Testes verdes, corrigi app.ts." },
    ]);
    expect(JSON.stringify(events)).not.toContain("segredo");
    expect(JSON.stringify(events)).not.toContain("\"ok\"");
  });

  it("`since` keeps only what happened strictly after it (incremental polling)", () => {
    expect(activityFromTranscript(jsonl, { since: NOW - 3000 }).map((e) => e.kind)).toEqual(["assistant"]);
  });

  it("`limit` keeps the NEWEST events", () => {
    expect(activityFromTranscript(jsonl, { limit: 2 }).map((e) => e.text)).toEqual(["app.ts", "Testes verdes, corrigi app.ts."]);
  });

  it("clamps a huge answer so one card cannot flood the assistant's context", () => {
    const big = "x".repeat(ACTIVITY_TEXT_MAX * 3);
    const [event] = activityFromTranscript(assistant("a1", NOW, [{ type: "text", text: big }]));
    expect(event!.text.length).toBeLessThanOrEqual(ACTIVITY_TEXT_MAX);
    expect(event!.text.endsWith("…")).toBe(true);
  });

  it("is empty for an empty transcript", () => {
    expect(activityFromTranscript("")).toEqual([]);
  });
});
