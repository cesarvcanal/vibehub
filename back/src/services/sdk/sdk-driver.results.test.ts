import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** Recorta do .mjs o bloco dos resultados e das tarefas (mesmo recurso de driver.test.ts). */
function load(): { toolResultFrames: (msg: unknown) => Array<Record<string, unknown>>; taskFrame: (msg: unknown) => Record<string, unknown> | null } {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");
  const from = source.indexOf("const RESULT_TEXT_MAX");
  const end = source.indexOf("function taskFrame(");
  const to = source.indexOf("\n}", end) + 2;
  const factory = new Function(`${source.slice(from, to)}\nreturn { toolResultFrames, taskFrame };`);
  return factory() as ReturnType<typeof load>;
}

describe("driver — o resultado de cada ferramenta sai para a tela", () => {
  const { toolResultFrames, taskFrame } = load();

  it("um tool_result do principal: texto capado, estruturado podado", () => {
    const frames = toolResultFrames({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "x".repeat(5000) }] }] },
      tool_use_result: { stdout: "y".repeat(3000), stderr: "", interrupted: false },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "tool_result", id: "toolu_1", isError: false, textLength: 5000 });
    expect((frames[0]!.text as string).length).toBe(4000);
    expect(((frames[0]!.structured as { stdout: string }).stdout).length).toBe(2000);
    expect(frames[0]).not.toHaveProperty("parentToolUseId");
  });

  it("de subagente leva o pai; erro sai marcado", () => {
    const [frame] = toolResultFrames({
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "falhou" }] },
    });
    expect(frame).toMatchObject({ id: "toolu_2", isError: true, text: "falhou", parentToolUseId: "toolu_agent" });
  });

  it("um prompt de pessoa não é resultado", () => {
    expect(toolResultFrames({ type: "user", message: { content: "oi" } })).toEqual([]);
  });

  it("vários resultados na mesma mensagem: o estruturado não é atribuído a nenhum", () => {
    const frames = toolResultFrames({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "a", content: "1" }, { type: "tool_result", tool_use_id: "b", content: "2" }] },
      tool_use_result: { stdout: "?" },
    });
    expect(frames.map((f) => f.id)).toEqual(["a", "b"]);
    expect(frames.every((f) => !("structured" in f))).toBe(true);
  });

  it("tarefas: início liga o task_id à chamada; o progresso herda a ligação", () => {
    expect(taskFrame({ subtype: "task_started", task_id: "k1", tool_use_id: "toolu_a", description: "Review PR 510", subagent_type: "general-purpose" }))
      .toMatchObject({ type: "task_started", taskId: "k1", toolUseId: "toolu_a", description: "Review PR 510", subagentType: "general-purpose" });
    expect(taskFrame({ subtype: "task_progress", task_id: "k1", usage: { tool_uses: 4, total_tokens: 900, duration_ms: 3000 }, summary: "Lendo", last_tool_name: "Read" }))
      .toMatchObject({ type: "task_progress", toolUseId: "toolu_a", toolUses: 4, tokens: 900, durationMs: 3000, summary: "Lendo", lastTool: "Read" });
    expect(taskFrame({ subtype: "task_notification", task_id: "k1", status: "completed", summary: "ok" }))
      .toMatchObject({ type: "task_notification", toolUseId: "toolu_a", status: "completed", summary: "ok" });
  });

  it("tarefa ambiente não aparece", () => {
    expect(taskFrame({ subtype: "task_started", task_id: "k2", ambient: true })).toBeNull();
  });
});
