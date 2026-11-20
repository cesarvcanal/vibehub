import { describe, expect, it } from "vitest";
import type { Review, ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { agentRole, fleetsByRound, readAgentResult } from "./reviewFleet";

function agent(overrides: Partial<ReviewFleetAgent> = {}): ReviewFleetAgent {
  return { id: "a1", label: "contexto", phase: "Contexto", status: "done", ...overrides };
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
    ["resumo do contexto cortado vira o texto dele, com as quebras de linha", '{"summary":"PR #337:\\n(1) `pillPercent` muda\\n(2) sai o aviso', { kind: "text", text: "PR #337:\n(1) `pillPercent` muda\n(2) sai o aviso" }],
    ["JSON cortado sem nada legível", '{"verdict":"meio', { kind: "text", text: '{"verdict":"meio' }],
    ["texto puro", "  só texto  ", { kind: "text", text: "só texto" }],
    ["só o resumo do contexto vira o texto dele", '{"summary":"muda o login"}', { kind: "text", text: "muda o login" }],
  ])("%s", (_name, raw, expected) => {
    expect(readAgentResult(raw)).toEqual(expected);
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

  it("a execução que já é de uma rodada entregue não volta como frota da rodada aberta", () => {
    const delivered = run({ runId: "wf_A" });
    const fresh = run({ runId: "wf_B", finished: false });
    const previous = review({ round: 2, lastSubmitRound: 1, fleet: [{ round: 1, runs: [delivered] }] });
    expect([...fleetsByRound(previous, [delivered]).keys()]).toEqual([1]);
    expect(fleetsByRound(previous, [fresh, delivered]).get(2)).toEqual([fresh]);
  });

  it("rodada já entregue ignora a frota viva", () => {
    expect(fleetsByRound(review({ round: 1, lastSubmitRound: 1 }), [run()]).size).toBe(0);
  });
});

describe("agentRole", () => {
  it.each([
    ["contexto", { kind: "context" }],
    ["juiz", { kind: "judge" }],
    ["revisão: correctness", { kind: "review", dimension: "correctness" }],
    ["verificação: repoRules · comentário narra a linha", { kind: "verification", dimension: "repoRules" }],
    ["revisão: outra", { kind: "other", label: "revisão: outra" }],
    ["varre:front", { kind: "other", label: "varre:front" }],
  ])("%s", (label, expected) => {
    expect(agentRole(label)).toEqual(expected);
  });
});
