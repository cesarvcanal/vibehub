import { describe, it, expect } from "vitest";
import { analysisVerdict, dimensionHealth, type AnalysisFinding, type AnalysisReport } from "./analysisModel.js";

const finding = (over: Partial<AnalysisFinding> = {}): AnalysisFinding => ({
  id: "f1", severity: "blocking", title: "t", problem: "p", fix: "x", dimension: "correctness", status: "open",
  proof: { kind: "scenario", ref: "a.ts:1" }, ...over,
});

const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: "c1", prUrl: "https://github.com/acme/w/pull/7", prNumber: 7, analysedSha: "a".repeat(40),
  stage: "done", summary: "s", refutedCount: 0, updatedAt: 1,
  dimensions: [
    { key: "correctness", status: "ran" }, { key: "security", status: "skipped", reason: "o diff não toca acesso" },
    { key: "performance", status: "not_run", reason: "agente sem resposta" },
  ],
  findings: [], ...over,
});

describe("estado de cada dimensão da análise", () => {
  it("dimensão que rodou sem achado aberto fica ok", () => {
    expect(dimensionHealth(report(), "correctness")).toBe("ok");
  });
  it("bloqueante aberto deixa a dimensão em problema", () => {
    expect(dimensionHealth(report({ findings: [finding()] }), "correctness")).toBe("problem");
  });
  it("bloqueante corrigido não pesa; dúvida ou melhoria aberta deixa em atenção", () => {
    const withQuestion = report({ findings: [finding({ status: "fixed" }), finding({ id: "f2", severity: "question" })] });
    expect(dimensionHealth(withQuestion, "correctness")).toBe("attention");
  });
  it("sugestão aberta não muda o estado", () => {
    expect(dimensionHealth(report({ findings: [finding({ severity: "suggestion" })] }), "correctness")).toBe("ok");
  });
  it("dimensão pulada e dimensão que não rodou dizem isso, nunca ok", () => {
    expect(dimensionHealth(report(), "security")).toBe("skipped");
    expect(dimensionHealth(report(), "performance")).toBe("not_run");
  });
  it("dimensão ausente do relatório conta como não rodou", () => {
    expect(dimensionHealth(report(), "tests")).toBe("not_run");
  });
});

const everyDimensionAccounted = (): AnalysisReport["dimensions"] => [
  { key: "correctness", status: "ran" }, { key: "security", status: "skipped", reason: "fora do diff" },
  { key: "performance", status: "ran" }, { key: "contracts", status: "ran" }, { key: "tests", status: "ran" },
  { key: "repoRules", status: "ran" },
];

describe("veredito da análise", () => {
  it("só no fim: antes do done o veredito está pendente", () => {
    expect(analysisVerdict(report({ stage: "analysed" }))).toBe("pending");
  });
  it("apto quando não sobra bloqueante aberto no done", () => {
    expect(analysisVerdict(report({ dimensions: everyDimensionAccounted(), findings: [finding({ status: "fixed" })] }))).toBe("apt");
  });
  it("não apto com bloqueante aberto", () => {
    expect(analysisVerdict(report({ dimensions: everyDimensionAccounted(), findings: [finding()] }))).toBe("not_apt");
  });
  it("dimensão que o relatório não menciona impede o apto, como no estado do painel", () => {
    expect(analysisVerdict(report({ dimensions: [{ key: "correctness", status: "ran" }] }))).toBe("not_apt");
  });
  it("não apto com dimensão que não rodou", () => {
    expect(analysisVerdict(report({ dimensions: [{ key: "correctness", status: "not_run", reason: "x" }] }))).toBe("not_apt");
  });
  it("frota indisponível nunca é apta", () => {
    expect(analysisVerdict(report({ stage: "fleet_unavailable", unavailableReason: "CLI antigo" }))).toBe("not_apt");
  });
});
