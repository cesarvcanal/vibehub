import { describe, it, expect } from "vitest";
import { analysisReportInput } from "./tools.js";

const SHA = "c".repeat(40);
const base = { card: "card-1", headSha: SHA, stage: "analysed", summary: "ok", refutedCount: 0, dimensions: [], findings: [] };
const blocking = {
  id: "f1", severity: "blocking", title: "t", problem: "p", fix: "x", dimension: "correctness", status: "open",
  proof: { kind: "scenario", ref: "a.ts:3" },
};

describe("entrada da vibehub_analysis_report", () => {
  it("aceita o relatório completo", () => {
    expect(analysisReportInput.safeParse({ ...base, findings: [blocking] }).success).toBe(true);
  });
  it("bloqueante sem prova é recusado", () => {
    const { proof: _proof, ...blockingWithoutProof } = blocking;
    expect(analysisReportInput.safeParse({ ...base, findings: [blockingWithoutProof] }).success).toBe(false);
  });
  it("bloqueante com prova de referência vazia é recusado", () => {
    expect(analysisReportInput.safeParse({ ...base, findings: [{ ...blocking, proof: { kind: "scenario", ref: "  " } }] }).success).toBe(false);
  });
  it("achado sem problema explicado é recusado, como na revisão", () => {
    expect(analysisReportInput.safeParse({ ...base, findings: [{ ...blocking, problem: "" }] }).success).toBe(false);
  });
  it("frota indisponível exige o motivo", () => {
    expect(analysisReportInput.safeParse({ ...base, stage: "fleet_unavailable" }).success).toBe(false);
    expect(analysisReportInput.safeParse({ ...base, stage: "fleet_unavailable", unavailableReason: "CLI antigo" }).success).toBe(true);
  });
  it("dimensão desconhecida é recusada", () => {
    expect(analysisReportInput.safeParse({ ...base, dimensions: [{ key: "estilo", status: "ran" }] }).success).toBe(false);
  });
  it("achado corrigido sem o commit que o corrige é recusado", () => {
    expect(analysisReportInput.safeParse({ ...base, stage: "done", findings: [{ ...blocking, status: "fixed" }] }).success).toBe(false);
    expect(analysisReportInput.safeParse({ ...base, stage: "done", findings: [{ ...blocking, status: "fixed", commit: "abc1234" }] }).success).toBe(true);
  });
  it("a dimensão leva quantos achados a frota não verificou", () => {
    const dimensions = [{ key: "tests", status: "ran", unverifiedCount: 2, reason: "2 achados sem veredito" }];
    expect(analysisReportInput.parse({ ...base, dimensions }).dimensions[0]).toMatchObject({ unverifiedCount: 2 });
  });
  it("achado derrubado não entra no relatório: refuted é recusado", () => {
    expect(analysisReportInput.safeParse({ ...base, findings: [{ ...blocking, severity: "refuted" }] }).success).toBe(false);
  });
});
