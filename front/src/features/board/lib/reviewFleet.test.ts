import { describe, expect, it } from "vitest";
import type { Review, ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import type { ReviewEvent } from "@/api/types";
import { conversationRows } from "./review";
import { fleetMessages, fleetsByRound, readAgentResult, withFleets, workflowRowOf } from "./reviewFleet";

function agent(overrides: Partial<ReviewFleetAgent> = {}): ReviewFleetAgent {
  return { id: "a1", label: "contexto", phase: "Contexto", status: "done", toolCount: 0, ...overrides };
}

function run(overrides: Partial<ReviewFleetRun> = {}): ReviewFleetRun {
  return { runId: "wf_1", name: "revisao", phases: ["Contexto", "Revisão"], total: 1, done: 1, agents: [agent()], at: 1, finished: true, ...overrides };
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: "r1", prNumber: 1, phase: "reviewing", round: 1, cardId: "c1", projectId: "p1", prUrl: "u", prBranch: "b", base: "main",
    reviewerUserId: "u1", authorUserId: "u2", mergerUserId: "u2", reviewerCardId: "rc1", findings: [], log: [], createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

describe("readAgentResult", () => {
  it.each([
    ["findings com títulos", '{"findings":[{"title":"A"},{"title":"B"}]}', { kind: "findings", titles: ["A", "B"] }],
    ["findings vazio", '{"findings":[]}', { kind: "findings", titles: [] }],
    ["verificação confirmada com evidência", '{"confirmed":true,"evidence":"linha 3"}', { kind: "verdict", confirmed: true, evidence: "linha 3" }],
    ["verificação refutada sem evidência", '{"confirmed":false}', { kind: "verdict", confirmed: false }],
    ["JSON de outro formato vira chave: valor", '{"verdict":"apt","summary":"ok"}', { kind: "text", text: "verdict: apt\nsummary: ok" }],
    ["JSON cortado com títulos", '{"findings":[{"title":"Aspas \\"x\\"","problem":"p"},{"title":"Seg', { kind: "findings", titles: ['Aspas "x"'] }],
    ["JSON cortado com veredito e evidência pela metade", '{"confirmed":false,"evidence":"o teste nunca', { kind: "verdict", confirmed: false, evidence: "o teste nunca" }],
    ["JSON cortado sem nada legível", '{"summary":"meio', { kind: "text", text: '{"summary":"meio' }],
    ["texto puro", "  só texto  ", { kind: "text", text: "só texto" }],
  ])("%s", (_name, raw, expected) => {
    expect(readAgentResult(raw)).toEqual(expected);
  });
});

describe("fleetMessages", () => {
  it("só os que terminaram, na ordem em que terminaram, o juiz por último e a verificação respondendo ao achado", () => {
    const messages = fleetMessages(
      run({
        agents: [
          agent({ id: "judge", label: "juiz", endedAt: 5 }),
          agent({ id: "ver", label: "verificação: correctness · Busca duplicada", endedAt: 30, result: '{"confirmed":true}' }),
          agent({ id: "rev", label: "revisão: correctness", endedAt: 20 }),
          agent({ id: "live", label: "revisão: tests", status: "running" }),
        ],
      }),
    );
    expect(messages.map((message) => message.agent.id)).toEqual(["rev", "ver", "judge"]);
    expect(messages[1].repliesTo).toBe("Busca duplicada");
    expect(messages[0].repliesTo).toBeUndefined();
  });
});

describe("fleetsByRound", () => {
  it("rodada entregue usa a frota gravada; a rodada aberta do revisor usa a frota viva", () => {
    const persisted = run({ runId: "wf_old" });
    const live = run({ runId: "wf_live" });
    const fleets = fleetsByRound(review({ round: 2, lastSubmitRound: 1, fleet: [{ round: 1, runs: [persisted] }] }), [live]);
    expect(fleets.get(1)).toEqual([persisted]);
    expect(fleets.get(2)).toEqual([live]);
  });

  it("rodada já entregue ignora a frota viva", () => {
    expect(fleetsByRound(review({ round: 1, lastSubmitRound: 1 }), [run()]).size).toBe(0);
  });
});

describe("workflowRowOf", () => {
  it("vira a linha do painel da frota com o id wf: e as fases como títulos", () => {
    const row = workflowRowOf(run());
    expect(row.id).toBe("wf:wf_1");
    expect(row.phases).toEqual([{ title: "Contexto" }, { title: "Revisão" }]);
  });
});

describe("withFleets", () => {
  const line = (round: number, who: ReviewEvent["who"]): ReviewEvent => ({ at: round * 10 + (who === "reviewer" ? 1 : 0), round, who, text: who }) as ReviewEvent;
  const shape = (rows: ReturnType<typeof withFleets>) =>
    rows.map((row) => (row.kind === "round" ? `R${row.round}` : row.kind === "fleet" ? `F${row.round}` : row.event.who));

  it("a frota da rodada entra antes da fala do revisor daquela rodada", () => {
    const rows = conversationRows([line(1, "system"), line(1, "reviewer"), line(2, "author"), line(2, "reviewer")]);
    expect(shape(withFleets(rows, new Map([[1, [run()]], [2, [run()]]])))).toEqual(["R1", "system", "F1", "reviewer", "R2", "author", "F2", "reviewer"]);
  });

  it("revisor ainda sem resposta: a frota fica no fim da rodada", () => {
    const rows = conversationRows([line(1, "system")]);
    expect(shape(withFleets(rows, new Map([[1, [run()]]])))).toEqual(["R1", "system", "F1"]);
  });

  it("rodada sem frota não ganha nada", () => {
    const rows = conversationRows([line(1, "system"), line(1, "reviewer")]);
    expect(shape(withFleets(rows, new Map()))).toEqual(["R1", "system", "reviewer"]);
  });
});
