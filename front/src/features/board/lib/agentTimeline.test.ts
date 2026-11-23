import { describe, expect, it } from "vitest";
import type { TimelineItem } from "./sdkDetail";
import { groupAgentTimeline } from "./agentTimeline";

const tool = (id: string, name: string, at: number, endedAt?: number): TimelineItem => ({ kind: "tool", at, id, name, ...(endedAt === undefined ? {} : { endedAt }) });

describe("groupAgentTimeline — a linha do tempo do subagente vira falas e caixas de ações", () => {
  it("ações seguidas entre duas falas ficam numa caixa só, com início e fim", () => {
    const blocks = groupAgentTimeline([
      { kind: "text", at: 1, text: "vou ler o diff" },
      tool("t1", "Bash", 2, 3),
      tool("t2", "Read", 4, 5),
      { kind: "text", at: 6, text: "achei" },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(["text", "work", "text"]);
    expect(blocks[1]).toMatchObject({ kind: "work", startedAt: 2, endedAt: 5 });
    expect(blocks[1].kind === "work" && blocks[1].steps.map((step) => step.kind === "tool" && step.id)).toEqual(["t1", "t2"]);
  });

  it("o raciocínio entre ações fica dentro da caixa, no lugar em que aconteceu, sem abrir caixa nova", () => {
    const blocks = groupAgentTimeline([tool("t1", "Read", 1, 2), { kind: "thinking", at: 3, text: "hum" }, tool("t2", "Grep", 4, 5)]);
    expect(blocks.map((block) => block.kind)).toEqual(["work"]);
    expect(blocks[0].kind === "work" && blocks[0].steps.map((step) => step.kind)).toEqual(["tool", "thinking", "tool"]);
    expect(blocks[0].kind === "work" && blocks[0].verbs.map((verb) => verb.count)).toEqual([1, 1]);
  });

  it("raciocínio sem nenhuma ação até a próxima fala fica solto, sem caixa vazia", () => {
    const blocks = groupAgentTimeline([{ kind: "text", at: 1, text: "oi" }, { kind: "thinking", at: 2, text: "hum" }, { kind: "text", at: 3, text: "pronto" }]);
    expect(blocks.map((block) => block.kind)).toEqual(["text", "thinking", "text"]);
  });

  it("caixa com ação ainda rodando fica sem fim", () => {
    const [work] = groupAgentTimeline([tool("t1", "Read", 1, 2), tool("t2", "Bash", 3)]);
    expect(work).toMatchObject({ kind: "work", startedAt: 1 });
    expect(work.kind === "work" && work.endedAt).toBeUndefined();
  });

  it("o resumo da caixa conta as ações pelo verbo, na ordem em que o verbo aparece; ferramentas sinônimas somam juntas", () => {
    const [work] = groupAgentTimeline([
      tool("t1", "Read", 1, 2),
      tool("t2", "Bash", 3, 4),
      tool("t3", "Read", 5, 6),
      tool("t4", "Edit", 7, 8),
      tool("t5", "MultiEdit", 9, 10),
      tool("t6", "mcp__vibehub__vibehub_gate", 11, 12),
    ]);
    expect(work.kind === "work" && work.verbs).toEqual([
      { key: "sdk.verb.Read", tool: "Read", count: 2 },
      { key: "sdk.verb.Bash", tool: "Bash", count: 1 },
      { key: "sdk.verb.Edit", tool: "Edit", count: 2 },
      { key: "sdk.verb.default", tool: "mcp__vibehub__vibehub_gate", count: 1 },
    ]);
  });

  it("ferramentas desconhecidas diferentes não se misturam no resumo", () => {
    const [work] = groupAgentTimeline([tool("t1", "Foo", 1, 2), tool("t2", "Bar", 3, 4), tool("t3", "Foo", 5, 6)]);
    expect(work.kind === "work" && work.verbs.map((verb) => [verb.tool, verb.count])).toEqual([["Foo", 2], ["Bar", 1]]);
  });

  it("linha do tempo vazia não tem blocos", () => {
    expect(groupAgentTimeline([])).toEqual([]);
  });
});
