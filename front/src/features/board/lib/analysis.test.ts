import { describe, it, expect } from "vitest";
import { analysisPill, finishedAnalysisReports } from "./analysis";
import type { AnalysisFinding, AnalysisReadModel, AnalysisReport, AnalysisVerdict } from "@/api/types";
import type { SdkRow } from "./sdkChat";

const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: "c", prUrl: "u", prNumber: 7, analysedSha: "a".repeat(40), stage: "analysed", summary: "s",
  dimensions: [], findings: [], refutedCount: 0, updatedAt: 1, ...over,
});

const readModel = (over: Partial<AnalysisReport> = {}, verdict: AnalysisVerdict = "pending"): AnalysisReadModel => ({
  analysis: report(over),
  health: { correctness: "ok", security: "ok", performance: "ok", contracts: "ok", tests: "ok", repoRules: "ok" },
  verdict,
});

const finding = (over: Partial<AnalysisFinding> = {}): AnalysisFinding => ({
  id: "f1", severity: "blocking", title: "t", dimension: "tests", status: "open", ...over,
});

describe("pílula da análise na linha da PR", () => {
  it("sem relatório e card trabalhando: analisando", () => {
    expect(analysisPill(null, { cardWorking: true })).toMatchObject({ key: "analysis.pill.running", tone: "info" });
  });
  it("sem relatório e card ocioso: sem relatório, nunca analisando para sempre", () => {
    expect(analysisPill(null, { cardWorking: false })).toMatchObject({ key: "analysis.pill.noReport", tone: "warn" });
  });
  it("depois do juiz: conta os achados e diz que está corrigindo", () => {
    const pill = analysisPill(readModel({ findings: [finding(), finding({ id: "f2" })] }), { cardWorking: true });
    expect(pill).toMatchObject({ key: "analysis.pill.fixing", vars: { n: 2 }, tone: "info" });
  });
  it("concluída e apta: conta os corrigidos", () => {
    const pill = analysisPill(readModel({ stage: "done", findings: [finding({ status: "fixed" })] }, "apt"), { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.apt", vars: { n: 1 }, tone: "ok" });
  });
  it("concluída e não apta: conta os bloqueantes abertos", () => {
    const findings = [finding(), finding({ id: "f2", status: "fixed" }), finding({ id: "f3", severity: "question" })];
    const pill = analysisPill(readModel({ stage: "done", findings }, "not_apt"), { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.notApt", vars: { n: 1 }, tone: "critical" });
  });
  it("frota indisponível", () => {
    const pill = analysisPill(readModel({ stage: "fleet_unavailable", unavailableReason: "x" }, "not_apt"), { cardWorking: false });
    expect(pill).toMatchObject({ key: "analysis.pill.fleetUnavailable", tone: "critical" });
  });
});

describe("chamadas concluídas da ferramenta de relatório no chat", () => {
  it("conta só a vibehub_analysis_report que voltou sem erro", () => {
    const rows = [
      { kind: "tool", id: "1", name: "mcp__vibehub__vibehub_analysis_report", summary: "", result: {} },
      { kind: "tool", id: "2", name: "mcp__vibehub__vibehub_analysis_report", summary: "" },
      { kind: "tool", id: "3", name: "mcp__vibehub__vibehub_analysis_report", summary: "", result: { isError: true } },
      { kind: "tool", id: "4", name: "Bash", summary: "", result: {} },
    ] as SdkRow[];
    expect(finishedAnalysisReports(rows)).toBe(1);
  });
});
