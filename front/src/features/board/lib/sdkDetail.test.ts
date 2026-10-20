import { describe, expect, it } from "vitest";
import { setLanguage } from "@/i18n";
import { INITIAL_SDK_STATE, applySdkEvent, groupSdkRows, type SdkChatState, type SdkRow } from "@/features/board/lib/sdkChat";
import {
  agentStatus,
  bashOutput,
  changedFiles,
  createDetailChannel,
  formatDuration,
  parseDetailResponse,
  parseUnifiedDiff,
  patchRows,
  readContent,
  toolResultLine,
  toolStatus,
} from "@/features/board/lib/sdkDetail";

setLanguage("pt-BR");

const ready = (s: SdkChatState = INITIAL_SDK_STATE): SdkChatState => applySdkEvent(s, { type: "ready" });
const tool = (state: SdkChatState, id: string, name: string, input: unknown, parentToolUseId?: string) =>
  applySdkEvent(state, { type: "tool_use", id, name, input, ...(parentToolUseId ? { parentToolUseId } : {}) });
const rowOf = (s: SdkChatState, id: string) => s.rows.find((r) => r.kind === "tool" && r.id === id) as Extract<SdkRow, { kind: "tool" }>;

describe("a linha de resultado, como a do terminal", () => {
  it("cada forma de resultado vira uma frase", () => {
    expect(toolResultLine("Bash", { lines: 7 })).toBe("7 linhas");
    expect(toolResultLine("Bash", { empty: true })).toBe("sem saída");
    expect(toolResultLine("Bash", { empty: true, interrupted: true })).toBe("sem saída · interrompido");
    expect(toolResultLine("Read", { lines: 21, startLine: 60, totalLines: 290 })).toBe("linhas 60–80 de 290");
    expect(toolResultLine("Read", { lines: 18, startLine: 1, totalLines: 18 })).toBe("leu 18 linhas");
    expect(toolResultLine("Edit", { added: 2, removed: 1 })).toBe("+2 −1");
    expect(toolResultLine("Write", { created: true, added: 18, removed: 0 })).toBe("arquivo criado · 18 linhas");
    expect(toolResultLine("Grep", { files: 7, matches: 9 })).toBe("9 ocorrências em 7 arquivos");
    expect(toolResultLine("Glob", { files: 0 })).toBe("nada encontrado");
    expect(toolResultLine("Agent", { background: true })).toBe("rodando em segundo plano");
    expect(toolResultLine("Agent", { agent: { toolUses: 12, durationMs: 9000 } })).toBe("concluído · 12 ações · 9,0 s");
    expect(toolResultLine("Bash", { isError: true, error: "saiu com código 1" })).toBe("erro: saiu com código 1");
    expect(toolResultLine("Bash", undefined)).toBeNull();
  });

  it("duração", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(4200)).toBe("4,2 s");
    expect(formatDuration(84_000)).toBe("1m 24s");
  });
});

describe("o reducer guarda o resultado de cada ação", () => {
  it("ao vivo sem resultado = rodando; com resultado = ok/erro", () => {
    let s = tool(ready(), "toolu_1", "Bash", { command: "ls" });
    expect(toolStatus(rowOf(s, "toolu_1"))).toBe("running");
    s = applySdkEvent(s, { type: "tool_result", id: "toolu_1", toolResult: { lines: 3 } });
    expect(rowOf(s, "toolu_1").result).toEqual({ lines: 3 });
    expect(toolStatus(rowOf(s, "toolu_1"))).toBe("ok");
    s = tool(s, "toolu_2", "Bash", { command: "false" });
    s = applySdkEvent(s, { type: "tool_result", id: "toolu_2", toolResult: { isError: true, error: "x" } });
    expect(toolStatus(rowOf(s, "toolu_2"))).toBe("error");
  });

  it("do replay (antes do ready) não se sabe: nunca gira", () => {
    const s = tool(INITIAL_SDK_STATE, "toolu_1", "Bash", { command: "ls" });
    expect(toolStatus(rowOf(s, "toolu_1"))).toBe("unknown");
  });

  it("o fim do turno para o giro do principal, não o do subagente", () => {
    let s = tool(ready(), "toolu_a", "Agent", { description: "Review" });
    s = tool(s, "toolu_main", "Bash", { command: "sleep" });
    s = tool(s, "toolu_sub", "Read", { file_path: "/x" }, "toolu_a");
    s = applySdkEvent(s, { type: "result" });
    expect(toolStatus(rowOf(s, "toolu_main"))).toBe("unknown");
    expect(toolStatus(rowOf(s, "toolu_sub"))).toBe("running");
  });

  it("resultado de uma ação que não está na tela não muda nada", () => {
    const s = ready();
    expect(applySdkEvent(s, { type: "tool_result", id: "nope", toolResult: { lines: 1 } })).toBe(s);
  });
});

describe("subagentes", () => {
  it("agent_task guarda o estado pela chamada, substituindo", () => {
    let s = applySdkEvent(ready(), { type: "agent_task", toolUseId: "toolu_a", taskId: "k", status: "running", toolUses: 3, summary: "Lendo" });
    expect(s.agentTasks.toolu_a).toMatchObject({ status: "running", toolUses: 3, summary: "Lendo" });
    s = applySdkEvent(s, { type: "agent_task", toolUseId: "toolu_a", taskId: "k", status: "completed", toolUses: 9 });
    expect(s.agentTasks.toolu_a).toMatchObject({ status: "completed", toolUses: 9 });
    expect(s.agentTasks.toolu_a?.summary).toBeUndefined();
  });

  it("status do subagente: a tarefa manda; sem ela, o resultado da chamada", () => {
    let s = tool(ready(), "toolu_a", "Agent", { description: "R" });
    s = applySdkEvent(s, { type: "tool_result", id: "toolu_a", toolResult: { background: true } });
    expect(agentStatus(rowOf(s, "toolu_a"), undefined)).toBe("running");
    expect(agentStatus(rowOf(s, "toolu_a"), { toolUseId: "toolu_a", taskId: "k", status: "completed" })).toBe("ok");
    expect(agentStatus(rowOf(s, "toolu_a"), { toolUseId: "toolu_a", taskId: "k", status: "failed" })).toBe("error");
  });

  it("a bandeja guarda a chamada de cada tarefa", () => {
    const s = applySdkEvent(ready(), { type: "background_tasks", tasks: [{ id: "k", type: "local_agent", description: "R", toolUseId: "toolu_a" }] });
    expect(s.backgroundTasks[0]).toEqual({ id: "k", type: "local_agent", description: "R", toolUseId: "toolu_a" });
  });

  it("chamadas de subagente seguidas viram UMA frota, nunca o '6 ações'", () => {
    let s = ready();
    for (const id of ["a1", "a2", "a3"]) s = tool(s, id, "Agent", { description: id });
    s = tool(s, "b1", "Bash", { command: "ls" });
    const out = groupSdkRows(s.rows);
    expect(out.map((e) => e.kind)).toEqual(["agents", "row"]);
    expect(out[0]!.kind === "agents" && out[0]!.rows.map((r) => r.id)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("o que vem do detalhe", () => {
  it("diff unificado do git em linhas, sem cabeçalhos", () => {
    const rows = parseUnifiedDiff("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n\\ No newline at end of file");
    expect(rows).toEqual([{ kind: "hunk", text: "@@ -1,2 +1,2 @@", oldStart: 1, newStart: 1 }, { kind: "ctx", text: "ctx" }, { kind: "del", text: "old" }, { kind: "add", text: "new" }]);
  });

  it("dentro do trecho, `--- `/`+++ ` são linhas removidas/adicionadas, não cabeçalho", () => {
    const rows = parseUnifiedDiff("diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- nota antiga\n+++ nota nova\n select 1;");
    expect(rows.map((r) => [r.kind, r.text])).toEqual([["hunk", "@@ -1,2 +1,2 @@"], ["del", "-- nota antiga"], ["add", "++ nota nova"], ["ctx", "select 1;"]]);
  });

  it("structuredPatch do Edit em linhas", () => {
    expect(patchRows({ structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [" a", "-b", "+c"] }] }))
      .toEqual([{ kind: "hunk", text: "@@ -3,1 +3,2 @@", oldStart: 3, newStart: 3 }, { kind: "ctx", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "c" }]);
    expect(patchRows({})).toBeNull();
  });

  it("saída do Bash e conteúdo do Read", () => {
    expect(bashOutput({ structured: { stdout: "o", stderr: "e" } })).toEqual({ stdout: "o", stderr: "e" });
    expect(bashOutput({ text: "t" })).toEqual({ stdout: "t", stderr: "" });
    expect(readContent({ structured: { file: { content: "x", startLine: 5 } } })).toEqual({ content: "x", startLine: 5 });
    expect(readContent({ text: "    12→a\n    13→b" })).toEqual({ content: "a\nb", startLine: 12 });
  });

  it("arquivos alterados: por caminho, sem as edições que falharam", () => {
    let s = tool(ready(), "e1", "Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" });
    s = applySdkEvent(s, { type: "tool_result", id: "e1", toolResult: { added: 1, removed: 1 } });
    s = tool(s, "e2", "Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y" });
    s = applySdkEvent(s, { type: "tool_result", id: "e2", toolResult: { isError: true, error: "not found" } });
    s = tool(s, "w1", "Write", { file_path: "/w/n.md", content: "1\n2" }, "toolu_agent");
    const files = changedFiles(s.rows, () => ({ added: 2, removed: 0 }));
    expect(files.map((f) => [f.path, f.rows.length, f.added, f.removed])).toEqual([["/w/a.ts", 1, 1, 1], ["/w/n.md", 1, 2, 0]]);
  });

  it("canal: pede com nonce e entrega a resposta a quem escuta", () => {
    const sent: object[] = [];
    const ch = createDetailChannel((f) => { sent.push(f); });
    const seen: string[] = [];
    ch.subscribe((r) => seen.push(`${r.req}:${r.nonce}`));
    const nonce = ch.request("tool", { id: "toolu_1" });
    expect(sent[0]).toEqual({ type: "detail", req: "tool", id: "toolu_1", nonce });
    ch.deliver(parseDetailResponse({ type: "detail", req: "tool", id: "toolu_1", nonce: nonce!, data: { found: true } })!);
    expect(seen).toEqual([`tool:${nonce}`]);
    expect(createDetailChannel(() => { throw new Error("off"); }).request("agent", { id: "x" })).toBeNull();
    expect(parseDetailResponse({ type: "detail", req: "rm" })).toBeNull();
  });
});
