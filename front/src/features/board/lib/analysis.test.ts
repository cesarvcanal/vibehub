import { describe, it, expect } from "vitest";
import { analysisPill } from "./analysis";
import {
  ANALYSIS_DIMENSIONS, type AnalysisFinding, type AnalysisReadModel, type AnalysisReport, type AnalysisVerdict, type CardAnalysisResponse,
} from "@/api/types";

const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: "c", prUrl: "u", prNumber: 7, analysedSha: "a".repeat(40), stage: "analysed", summary: "s",
  dimensions: ANALYSIS_DIMENSIONS.map((key) => ({ key, status: "ran" as const })), findings: [], refutedCount: 0, updatedAt: 1, ...over,
});

const readModel = (
  over: Partial<AnalysisReport> = {}, verdict: AnalysisVerdict = "pending", healthOver: Partial<AnalysisReadModel["health"]> = {},
  uncheckedDimensions: AnalysisReadModel["uncheckedDimensions"] = [],
): AnalysisReadModel => ({
  analysis: report(over),
  health: { correctness: "ok", security: "ok", performance: "ok", contracts: "ok", tests: "ok", repoRules: "ok", ...healthOver },
  verdict,
  uncheckedDimensions,
  canMerge: false,
});

const loaded = (data: CardAnalysisResponse) => ({ status: "success" as const, data });

type FindingFields = Partial<Pick<AnalysisFinding, "id" | "severity" | "title" | "dimension">>;

const openFinding = (over: FindingFields = {}): AnalysisFinding => ({
  id: "f1", severity: "blocking", title: "t", dimension: "tests", status: "open", ...over,
});

const fixedFinding = (over: FindingFields = {}): AnalysisFinding => ({ ...openFinding(over), status: "fixed", commit: "abc1234" });

describe("pílula da análise na linha da PR", () => {
  it.each([
    ["carregando: estado neutro, nunca afirma que não há relatório", { status: "pending" } as const, "common.loading", "muted"],
    ["leitura que falhou: erro visível, nunca sem relatório", { status: "error" } as const, "analysis.pill.readFailed", "critical"],
  ])("%s", (_scenario, analysisQuery, key, tone) => {
    expect(analysisPill(analysisQuery, { cardWorking: false })).toMatchObject({ key, tone });
  });
  it.each([
    ["card trabalhando: analisando", true, "analysis.pill.running", "info"],
    ["card ocioso: sem relatório, nunca analisando para sempre", false, "analysis.pill.noReport", "warn"],
  ] as const)("sem relatório e %s", (_scenario, cardWorking, key, tone) => {
    expect(analysisPill(loaded({ analysis: null }), { cardWorking })).toMatchObject({ key, tone });
  });
  it("depois do juiz: conta os achados e diz que está corrigindo", () => {
    const pill = analysisPill(loaded(readModel({ findings: [openFinding(), openFinding({ id: "f2" })] }, "pending", { tests: "problem" })), { cardWorking: true });
    expect(pill).toMatchObject({ key: "analysis.pill.fixing", vars: { n: 2 }, tone: "info" });
  });
  it("concluída e apta: conta os corrigidos", () => {
    const pill = analysisPill(loaded(readModel({ stage: "done", findings: [fixedFinding()] }, "apt")), { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.apt", vars: { n: 1 }, tone: "ok" });
  });
  it("concluída e não apta: conta os bloqueantes abertos", () => {
    const findings = [openFinding(), fixedFinding({ id: "f2" }), openFinding({ id: "f3", severity: "question" })];
    const pill = analysisPill(loaded(readModel({ stage: "done", findings }, "not_apt", { tests: "problem" })), { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.notApt", vars: { n: 1 }, tone: "critical" });
  });
  it("não apta sem bloqueante aberto: conta as dimensões que o servidor diz sem conferência, nunca \"0 bloqueantes\"", () => {
    const dimensions: AnalysisReport["dimensions"] = [
      { key: "correctness", status: "ran", unverifiedCount: 1, reason: "1 achado sem veredito" },
      { key: "security", status: "not_run", reason: "o agente de revisão não respondeu" },
      { key: "performance", status: "ran" }, { key: "contracts", status: "ran" }, { key: "tests", status: "ran" }, { key: "repoRules", status: "ran" },
    ];
    const read = readModel({ stage: "done", dimensions }, "not_apt", { correctness: "attention", security: "not_run" }, ["correctness", "security"]);
    expect(analysisPill(loaded(read), { cardWorking: false })).toMatchObject({ key: "analysis.pill.notAptUnverified", vars: { n: 2 }, tone: "critical" });
  });
  it("não apta sem bloqueante aberto e com dúvida aberta: conta as dúvidas, antes das dimensões sem conferência", () => {
    const dimensions: AnalysisReport["dimensions"] = ANALYSIS_DIMENSIONS.map((key) => (
      key === "tests" ? { key, status: "ran" as const, unverifiedCount: 1 } : { key, status: "ran" as const }
    ));
    const findings = [fixedFinding(), openFinding({ id: "f2", severity: "question", dimension: "security" })];
    const read = readModel({ stage: "done", dimensions, findings }, "not_apt", { security: "attention", tests: "attention" }, ["tests"]);
    expect(analysisPill(loaded(read), { cardWorking: false })).toMatchObject({ key: "analysis.pill.notAptQuestions", vars: { n: 1 }, tone: "critical" });
  });
  it("frota indisponível", () => {
    const read = readModel({ stage: "fleet_unavailable", unavailableReason: "x", dimensions: [] }, "not_apt", {
      correctness: "not_run", security: "not_run", performance: "not_run", contracts: "not_run", tests: "not_run", repoRules: "not_run",
    }, [...ANALYSIS_DIMENSIONS]);
    const pill = analysisPill(loaded(read), { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.fleetUnavailable", tone: "critical" });
  });
});
