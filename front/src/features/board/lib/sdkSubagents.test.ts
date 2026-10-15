import { describe, expect, it } from "vitest";
import type { SdkRow } from "./sdkChat";
import { isAgentTool, latestTodoRowId, splitSubagentRows } from "./sdkSubagents";

const tool = (id: string, name: string, parent?: string): SdkRow => ({
  kind: "tool", id, name, summary: "", input: {}, ...(parent ? { parent } : {}),
});

describe("splitSubagentRows — o que é do subagente sai do fio principal", () => {
  it("as filhas vão para o pai, na ordem; o fio principal fica só com o principal", () => {
    const rows: SdkRow[] = [
      tool("t1", "Agent"),
      tool("c1", "Read", "t1"),
      { kind: "assistant", id: "a1", text: "achei", streaming: false, parent: "t1" },
      tool("t2", "Bash"),
      tool("c2", "Grep", "t1"),
    ];
    const { main, children } = splitSubagentRows(rows);
    expect(main.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(children.get("t1")?.map((r) => r.id)).toEqual(["c1", "a1", "c2"]);
  });

  it("subagente dentro de subagente: a neta fica sob a filha", () => {
    const { main, children } = splitSubagentRows([tool("t1", "Task"), tool("t2", "Agent", "t1"), tool("c1", "Read", "t2")]);
    expect(main.map((r) => r.id)).toEqual(["t1"]);
    expect(children.get("t1")?.map((r) => r.id)).toEqual(["t2"]);
    expect(children.get("t2")?.map((r) => r.id)).toEqual(["c1"]);
  });

  it("uma filha cujo pai não está na tela (cortado pelo replay) continua visível no fio principal", () => {
    const { main, children } = splitSubagentRows([tool("c1", "Read", "sumiu")]);
    expect(main.map((r) => r.id)).toEqual(["c1"]);
    expect(children.size).toBe(0);
  });

  it("sem subagente nenhum, devolve as MESMAS linhas (o memo da tela não redesenha à toa)", () => {
    const rows: SdkRow[] = [tool("t1", "Bash")];
    expect(splitSubagentRows(rows).main).toBe(rows);
  });
});

describe("splitSubagentRows(rows, previous) — um token do principal não redesenha os cards de subagente", () => {
  it("devolve o MESMO mapa quando as linhas de cada subagente não mudaram", () => {
    const agent = tool("t1", "Agent");
    const child = tool("c1", "Read", "t1");
    const first = splitSubagentRows([agent, child]);
    const streaming: SdkRow = { kind: "assistant", id: "a1", text: "oi", streaming: true };
    const second = splitSubagentRows([agent, child, streaming], first.children);
    expect(second.children).toBe(first.children);
    // Uma filha nova é mudança de verdade: mapa novo.
    const third = splitSubagentRows([agent, child, tool("c2", "Grep", "t1")], second.children);
    expect(third.children).not.toBe(second.children);
    expect(third.children.get("t1")?.map((r) => r.id)).toEqual(["c1", "c2"]);
  });
});

describe("isAgentTool", () => {
  it("Task e Agent são subagentes; o resto não", () => {
    expect(isAgentTool("Task")).toBe(true);
    expect(isAgentTool("Agent")).toBe(true);
    expect(isAgentTool("Bash")).toBe(false);
  });
});

describe("latestTodoRowId", () => {
  it("o TodoWrite mais recente do fio principal", () => {
    expect(latestTodoRowId([tool("t1", "TodoWrite"), tool("t2", "Bash"), tool("t3", "TodoWrite"), tool("c1", "TodoWrite", "t9")]))
      .toBe("t3");
    expect(latestTodoRowId([tool("t2", "Bash")])).toBeNull();
  });
});
