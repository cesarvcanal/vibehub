import { describe, it, expect } from "vitest";
import { analysisPill, countFinishedAnalysisReports } from "./analysis";
import { ANALYSIS_DIMENSIONS, type AnalysisFinding, type AnalysisReadModel, type AnalysisReport, type AnalysisVerdict } from "@/api/types";
import type { SdkRow } from "./sdkChat";

const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: "c", prUrl: "u", prNumber: 7, analysedSha: "a".repeat(40), stage: "analysed", summary: "s",
  dimensions: ANALYSIS_DIMENSIONS.map((key) => ({ key, status: "ran" as const })), findings: [], refutedCount: 0, updatedAt: 1, ...over,
});

const readModel = (
  over: Partial<AnalysisReport> = {}, verdict: AnalysisVerdict = "pending", healthOver: Partial<AnalysisReadModel["health"]> = {},
): AnalysisReadModel => ({
  analysis: report(over),
  health: { correctness: "ok", security: "ok", performance: "ok", contracts: "ok", tests: "ok", repoRules: "ok", ...healthOver },
  verdict,
});

const finding = (over: Partial<AnalysisFinding> = {}): AnalysisFinding => ({
  id: "f1", severity: "blocking", title: "t", dimension: "tests", status: "open", ...over,
});

describe("pílula da análise na linha da PR", () => {
  it.each([
    ["card trabalhando: analisando", true, "analysis.pill.running", "info"],
    ["card ocioso: sem relatório, nunca analisando para sempre", false, "analysis.pill.noReport", "warn"],
  ] as const)("sem relatório e %s", (_scenario, cardWorking, key, tone) => {
    expect(analysisPill({ analysis: null }, { cardWorking })).toMatchObject({ key, tone });
  });
  it("depois do juiz: conta os achados e diz que está corrigindo", () => {
    const pill = analysisPill(readModel({ findings: [finding(), finding({ id: "f2" })] }, "pending", { tests: "problem" }), { cardWorking: true });
    expect(pill).toMatchObject({ key: "analysis.pill.fixing", vars: { n: 2 }, tone: "info" });
  });
  it("concluída e apta: conta os corrigidos", () => {
    const pill = analysisPill(readModel({ stage: "done", findings: [finding({ status: "fixed" })] }, "apt"), { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.apt", vars: { n: 1 }, tone: "ok" });
  });
  it("concluída e não apta: conta os bloqueantes abertos", () => {
    const findings = [finding(), finding({ id: "f2", status: "fixed" }), finding({ id: "f3", severity: "question" })];
    const pill = analysisPill(readModel({ stage: "done", findings }, "not_apt", { tests: "problem" }), { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.notApt", vars: { n: 1 }, tone: "critical" });
  });
  it("não apta sem bloqueante aberto: conta as dimensões sem conferência, nunca \"0 bloqueantes\"", () => {
    const dimensions: AnalysisReport["dimensions"] = [
      { key: "correctness", status: "ran", unverifiedCount: 1, reason: "1 achado sem veredito" },
      { key: "security", status: "not_run", reason: "o agente de revisão não respondeu" },
      { key: "performance", status: "ran" }, { key: "contracts", status: "ran" }, { key: "tests", status: "ran" }, { key: "repoRules", status: "ran" },
    ];
    const read = readModel({ stage: "done", dimensions }, "not_apt", { correctness: "attention", security: "not_run" });
    expect(analysisPill(read, { cardWorking: false })).toMatchObject({ key: "analysis.pill.notAptUnverified", vars: { n: 2 }, tone: "critical" });
  });
  it("frota indisponível", () => {
    const read = readModel({ stage: "fleet_unavailable", unavailableReason: "x", dimensions: [] }, "not_apt", {
      correctness: "not_run", security: "not_run", performance: "not_run", contracts: "not_run", tests: "not_run", repoRules: "not_run",
    });
    const pill = analysisPill(read, { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.fleetUnavailable", tone: "critical" });
  });
});

describe("chamadas concluídas da ferramenta de relatório no chat", () => {
  it("conta só a vibehub_analysis_report que voltou sem erro", () => {
    const rows: SdkRow[] = [
      { kind: "tool", id: "1", name: "mcp__vibehub__vibehub_analysis_report", summary: "", result: {} },
      { kind: "tool", id: "2", name: "mcp__vibehub__vibehub_analysis_report", summary: "" },
      { kind: "tool", id: "3", name: "mcp__vibehub__vibehub_analysis_report", summary: "", result: { isError: true } },
      { kind: "tool", id: "4", name: "Bash", summary: "", result: {} },
    ];
    expect(countFinishedAnalysisReports(rows)).toBe(1);
  });
});
