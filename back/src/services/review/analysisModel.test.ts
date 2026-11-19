import { describe, it, expect } from "vitest";
import { analysisVerdict, dimensionHealth, uncheckedDimensions, type AnalysisFinding, type AnalysisReport } from "./analysisModel.js";

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
  it.each([
    ["dimensão que rodou sem achado aberto fica ok", report(), "correctness", "ok"],
    ["bloqueante aberto deixa a dimensão em problema", report({ findings: [finding()] }), "correctness", "problem"],
    [
      "bloqueante corrigido não pesa; dúvida ou melhoria aberta deixa em atenção",
      report({ findings: [finding({ status: "fixed" }), finding({ id: "f2", severity: "question" })] }), "correctness", "attention",
    ],
    ["sugestão aberta não muda o estado", report({ findings: [finding({ severity: "suggestion" })] }), "correctness", "ok"],
    ["dimensão pulada diz isso, nunca ok", report(), "security", "skipped"],
    ["dimensão que não rodou diz isso, nunca ok", report(), "performance", "not_run"],
    ["dimensão ausente do relatório conta como não rodou", report(), "tests", "not_run"],
    [
      "dimensão que rodou com achado não verificado fica em atenção, mesmo sem achado aberto",
      report({ dimensions: [{ key: "correctness", status: "ran", unverifiedCount: 2, reason: "2 achados acima do teto" }] }), "correctness", "attention",
    ],
  ] as const)("%s", (_case, read, key, expected) => {
    expect(dimensionHealth(read, key)).toBe(expected);
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
  it.each([
    ["não apto com bloqueante aberto", report({ dimensions: everyDimensionAccounted(), findings: [finding()] })],
    ["dimensão que o relatório não menciona impede o apto, como no estado do painel", report({ dimensions: [{ key: "correctness", status: "ran" }] })],
    ["não apto com dimensão que não rodou", report({ dimensions: [{ key: "correctness", status: "not_run", reason: "x" }] })],
    [
      "achado que a frota não verificou impede o apto: um bloqueante possível não some atrás de um apto",
      report({
        dimensions: everyDimensionAccounted().map((dimension) =>
          dimension.key === "tests" ? { ...dimension, unverifiedCount: 1, reason: "1 achado sem veredito" } : dimension),
      }),
    ],
    ["frota indisponível nunca é apta", report({ stage: "fleet_unavailable", unavailableReason: "CLI antigo" })],
    [
      "dúvida aberta no done impede o apto: decisão em aberto é não apto até a pessoa decidir",
      report({ dimensions: everyDimensionAccounted(), findings: [finding({ severity: "question" })] }),
    ],
  ])("%s", (_case, read) => {
    expect(analysisVerdict(read)).toBe("not_apt");
  });
  it("bloqueante aberto em dimensão fora do diff impede o apto: o juiz pode pôr o achado em qualquer dimensão", () => {
    const dimensions = everyDimensionAccounted().map((dimension) =>
      dimension.key === "tests" ? { key: "tests" as const, status: "skipped" as const, reason: "fora do diff" } : dimension);
    const read = report({ dimensions, findings: [finding({ dimension: "tests" })] });
    expect(dimensionHealth(read, "tests")).toBe("problem");
    expect(analysisVerdict(read)).toBe("not_apt");
  });
});

describe("dimensões sem conferência da análise", () => {
  it("são as que não rodaram, as ausentes do relatório e as com achado que a frota não verificou; pulada e conferida ficam de fora", () => {
    const dimensions = everyDimensionAccounted().map((dimension) => {
      if (dimension.key === "tests") return { ...dimension, unverifiedCount: 2, reason: "2 achados sem veredito" };
      if (dimension.key === "performance") return { key: "performance" as const, status: "not_run" as const, reason: "agente sem resposta" };
      return dimension;
    }).filter((dimension) => dimension.key !== "contracts");
    expect(uncheckedDimensions(report({ dimensions }))).toEqual(["performance", "contracts", "tests"]);
  });
});
