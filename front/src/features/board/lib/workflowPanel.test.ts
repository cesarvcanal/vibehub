import { describe, expect, it } from "vitest";
import type { WorkflowAgentFrame } from "./sdkChat";
import {
  estimateWorkflowRemaining,
  feedLines,
  formatDuration,
  groupAgentsByPhase,
  phasePills,
  verbKey,
} from "./workflowPanel";

const A = (id: string, over: Partial<WorkflowAgentFrame> = {}): WorkflowAgentFrame => ({
  id, label: id, status: "running", ...over,
});

describe("formatDuration", () => {
  it("segundos, minutos com segundos, horas com minutos", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_400)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(3_840_000)).toBe("1h 04m");
    expect(formatDuration(-5_000)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("estimateWorkflowRemaining", () => {
  it("sem nenhum concluído com tempo: null", () => {
    expect(estimateWorkflowRemaining({ agents: [A("a1", { startedAt: 1 })], total: 1, done: 0 }, 5_000)).toBeNull();
    expect(estimateWorkflowRemaining({ agents: [A("a1", { status: "done" })], total: 1, done: 1 }, 5_000)).toBeNull();
  });

  it("média dos concluídos; em voo desconta o que já correu; fila conta a média inteira; divide pela concorrência", () => {
    const agents = [
      A("a1", { status: "done", startedAt: 1, endedAt: 10_001 }),
      A("a2", { status: "done", startedAt: 1, endedAt: 10_001 }),
      A("a3", { startedAt: 10_001 }),
      A("a4", { startedAt: 10_001 }),
    ];
    // em voo 2 × 6s, fila 2 × 10s, concorrência observada 2 ⇒ 16s (o mesmo cálculo do back)
    expect(estimateWorkflowRemaining({ agents, total: 6, done: 2 }, 14_001)).toEqual({ remainingMs: 16_000, averageMs: 10_000 });
  });
});

describe("groupAgentsByPhase / phasePills", () => {
  const agents = [
    A("a1", { phase: "Verificação" }),
    A("a2", { phase: "Varredura", status: "done" }),
    A("a3", { phase: "Varredura" }),
    A("a4", { phase: "Extra", status: "done" }),
    A("a5"),
  ];

  it("agrupa na ordem das fases do plano; fase fora do plano depois; sem fase por último", () => {
    const groups = groupAgentsByPhase(agents, ["Varredura", "Verificação", "Síntese"]);
    expect(groups.map((g) => [g.phase, g.agents.map((a) => a.id)])).toEqual([
      ["Varredura", ["a2", "a3"]],
      ["Verificação", ["a1"]],
      ["Extra", ["a4"]],
      ["", ["a5"]],
    ]);
  });

  it("cada fase do plano vira uma pílula — inclusive a que ainda não começou", () => {
    const pills = phasePills([
      A("a2", { phase: "Varredura", status: "done" }),
      A("a1", { phase: "Verificação" }),
    ], ["Varredura", "Verificação", "Síntese"]);
    expect(pills).toEqual([
      { title: "Varredura", done: 1, total: 1, state: "done" },
      { title: "Verificação", done: 0, total: 1, state: "current" },
      { title: "Síntese", done: 0, total: 0, state: "waiting" },
    ]);
  });

  it("rodada terminada: fase com agente que não respondeu é 'stopped', não 'current'", () => {
    const agents = [A("a1", { phase: "Verify", status: "done" }), A("a2", { phase: "Verify" }), A("a3", { phase: "Review", status: "stopped" })];
    expect(phasePills(agents, ["Review", "Verify"], true).map((p) => p.state)).toEqual(["stopped", "stopped"]);
    // Em andamento, quem roda segue 'current'; o 'stopped' explícito nunca é 'current'.
    expect(phasePills(agents, ["Review", "Verify"]).map((p) => p.state)).toEqual(["stopped", "current"]);
  });
});

describe("feedLines", () => {
  it("ferramenta e texto passam; resultado de ferramenta some; thinking vira duração, NUNCA texto", () => {
    const lines = feedLines([
      { at: 1_000, kind: "thinking", text: "segredo" },
      { at: 13_000, kind: "tool", tool: "Read", target: "/a.ts" },
      { at: 13_500, kind: "result", text: "conteúdo" },
      { at: 14_000, kind: "text", text: "achei" },
    ], { running: true, now: 20_000 });
    expect(lines).toEqual([
      { kind: "thought", ms: 12_000 },
      { kind: "tool", tool: "Read", target: "/a.ts" },
      { kind: "text", text: "achei" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("segredo");
  });

  it("o último thinking de quem ainda roda é 'pensando há'; de quem terminou, dura até o fim", () => {
    const items = [{ at: 1_000, kind: "thinking" as const }];
    expect(feedLines(items, { running: true, now: 9_000 })).toEqual([{ kind: "thinking", ms: 8_000 }]);
    expect(feedLines(items, { running: false, now: 9_000, endedAt: 4_000 })).toEqual([{ kind: "thought", ms: 3_000 }]);
  });
});

describe("verbKey", () => {
  it("ferramentas conhecidas têm verbo; parentes usam o do primo; o resto cai no genérico", () => {
    expect(verbKey("Read")).toBe("sdk.verb.Read");
    expect(verbKey("MultiEdit")).toBe("sdk.verb.Edit");
    expect(verbKey("Task")).toBe("sdk.verb.Agent");
    expect(verbKey("mcp__x__y")).toBe("sdk.verb.default");
  });
});
