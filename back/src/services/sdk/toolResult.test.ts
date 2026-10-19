import { describe, expect, it } from "vitest";
import { firstErrorLine, lineCount, mergeTaskEvent, summarizeToolResult, toolResultEvent } from "./toolResult.js";
import { replayableHistoryEvent } from "./history.js";

describe("summarizeToolResult — a linha de resultado de cada ação", () => {
  it("erro: a primeira linha útil, sem as etiquetas do CLI", () => {
    expect(summarizeToolResult({ type: "tool_result", id: "t", isError: true, text: "<tool_use_error>\n\nString to replace not found\nmore</tool_use_error>" }))
      .toEqual({ isError: true, error: "String to replace not found" });
  });

  it("erro sem texto ainda diz que é erro", () => {
    expect(summarizeToolResult({ type: "tool_result", id: "t", isError: true, text: "" })).toEqual({ isError: true, error: "error" });
  });

  it("Read: linhas lidas, de onde e de quantas", () => {
    const structured = { type: "text", file: { filePath: "/a.ts", content: "a\nb", numLines: 2, startLine: 10, totalLines: 300 } };
    expect(summarizeToolResult({ type: "tool_result", id: "t", text: "…", structured })).toEqual({ lines: 2, startLine: 10, totalLines: 300 });
  });

  it("Edit: +/− contados no patch", () => {
    const structured = { filePath: "/a.ts", structuredPatch: [{ lines: [" ctx", "-old", "+new", "+new2"] }] };
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured })).toEqual({ added: 2, removed: 1 });
  });

  it("Write de arquivo novo: criado, com as linhas do conteúdo", () => {
    const structured = { type: "create", filePath: "/n.md", content: "a\nb\nc\n", structuredPatch: [] };
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured })).toEqual({ created: true, added: 3, removed: 0 });
  });

  it("Bash: linhas de saída; sem saída vira `empty`; segundo plano vira `background`", () => {
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured: { stdout: "1\n2\n", stderr: "x", interrupted: false } })).toEqual({ lines: 3 });
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured: { stdout: "", stderr: "", interrupted: false } })).toEqual({ empty: true });
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured: { stdout: "", stderr: "", interrupted: true } })).toEqual({ empty: true, interrupted: true });
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured: { stdout: "", stderr: "", backgroundTaskId: "b1" } })).toEqual({ background: true });
  });

  it("Grep/Glob: arquivos e ocorrências", () => {
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured: { mode: "content", numFiles: 7, filenames: [], numLines: 9 } })).toEqual({ files: 7, matches: 9 });
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured: { numFiles: 3, filenames: [] } })).toEqual({ files: 3 });
  });

  it("subagente: assíncrono = segundo plano; terminado = números da rodada", () => {
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured: { status: "async_launched", agentId: "a1" } })).toEqual({ background: true });
    expect(summarizeToolResult({ type: "tool_result", id: "t", structured: { status: "completed", totalToolUseCount: 12, totalDurationMs: 9000, totalTokens: 4000 } }))
      .toEqual({ agent: { toolUses: 12, durationMs: 9000, tokens: 4000 } });
  });

  it("sem estruturado (MCP): pelo texto", () => {
    expect(summarizeToolResult({ type: "tool_result", id: "t", text: "a\nb\n" })).toEqual({ lines: 2 });
    expect(summarizeToolResult({ type: "tool_result", id: "t", text: "  " })).toEqual({ empty: true });
  });

  it("o frame que sai não carrega o cru (texto/estruturado)", () => {
    const out = toolResultEvent({ type: "tool_result", id: "t", text: "segredo\n", structured: { stdout: "segredo" }, parentToolUseId: "p" });
    expect(out).toEqual({ type: "tool_result", id: "t", parentToolUseId: "p", result: { lines: 1 } });
  });

  it("helpers", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\n\n")).toBe(1);
    expect(firstErrorLine("x".repeat(300)).length).toBe(200);
  });
});

describe("histórico — o que dos resultados e subagentes é gravado", () => {
  it("resultado do principal sim; de subagente não; cru nunca", () => {
    expect(replayableHistoryEvent({ type: "tool_result", id: "t", result: { lines: 1 } })).toBe(true);
    expect(replayableHistoryEvent({ type: "tool_result", id: "t", parentToolUseId: "p", result: { lines: 1 } })).toBe(false);
    expect(replayableHistoryEvent({ type: "tool_result", id: "t", text: "cru" } as never)).toBe(false);
  });

  it("subagente: só o fim é gravado", () => {
    expect(replayableHistoryEvent({ type: "agent_task", toolUseId: "u", taskId: "k", status: "running" })).toBe(false);
    expect(replayableHistoryEvent({ type: "agent_task", toolUseId: "u", taskId: "k", status: "completed" })).toBe(true);
  });
});

describe("mergeTaskEvent — o estado de um subagente", () => {
  it("começa, anda e termina sem perder o que já sabia", () => {
    const started = mergeTaskEvent(undefined, { type: "task_started", taskId: "k", toolUseId: "u", description: "Review PR 510", subagentType: "general-purpose" }, 1000)!;
    expect(started).toMatchObject({ type: "agent_task", toolUseId: "u", status: "running", description: "Review PR 510", startedAt: 1000 });
    const moving = mergeTaskEvent(started, { type: "task_progress", taskId: "k", toolUses: 5, tokens: 900, durationMs: 4000, summary: "Lendo o controller", lastTool: "Read" }, 2000)!;
    expect(moving).toMatchObject({ status: "running", toolUses: 5, summary: "Lendo o controller", description: "Review PR 510", startedAt: 1000 });
    const done = mergeTaskEvent(moving, { type: "task_notification", taskId: "k", status: "completed", summary: "Aprovar com ajustes" }, 3000)!;
    expect(done).toMatchObject({ status: "completed", summary: "Aprovar com ajustes", toolUses: 5 });
  });

  it("sem chamada que o ligue, não há o que mostrar", () => {
    expect(mergeTaskEvent(undefined, { type: "task_started", taskId: "k" }, 0)).toBeNull();
  });

  it("status desconhecido no fim vira concluído", () => {
    expect(mergeTaskEvent(undefined, { type: "task_notification", taskId: "k", toolUseId: "u", status: "weird" }, 0)!.status).toBe("completed");
  });
});
