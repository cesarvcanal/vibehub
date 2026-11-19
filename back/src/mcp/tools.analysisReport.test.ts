import { describe, it, expect } from "vitest";
import { analysisReportInput } from "./tools.js";

const SHA = "c".repeat(40);
const base = { card: "card-1", headSha: SHA, stage: "analysed", summary: "ok", refutedCount: 0, dimensions: [], findings: [] };
const blocking = {
  id: "f1", severity: "blocking", title: "t", problem: "p", fix: "x", dimension: "correctness", status: "open",
  proof: { kind: "scenario", ref: "a.ts:3" },
};
const { proof: _proof, ...blockingWithoutProof } = blocking;

describe("entrada da vibehub_analysis_report", () => {
  it("aceita o relatório completo", () => {
    expect(analysisReportInput.safeParse({ ...base, findings: [blocking] }).success).toBe(true);
  });
  it.each([
    ["bloqueante sem prova é recusado", { ...base, findings: [blockingWithoutProof] }],
    ["bloqueante com prova de referência vazia é recusado", { ...base, findings: [{ ...blocking, proof: { kind: "scenario", ref: "  " } }] }],
    ["achado sem problema explicado é recusado, como na revisão", { ...base, findings: [{ ...blocking, problem: "" }] }],
    ["dimensão desconhecida é recusada", { ...base, dimensions: [{ key: "estilo", status: "ran" }] }],
    ["achado derrubado não entra no relatório: refuted é recusado", { ...base, findings: [{ ...blocking, severity: "refuted" }] }],
    ["ids de achado repetidos são recusados: o done casa cada achado pelo id", { ...base, findings: [blocking, { ...blocking, title: "outro" }] }],
  ])("%s", (_case, report) => {
    expect(analysisReportInput.safeParse(report).success).toBe(false);
  });
  it("frota indisponível exige o motivo", () => {
    expect(analysisReportInput.safeParse({ ...base, stage: "fleet_unavailable" }).success).toBe(false);
    expect(analysisReportInput.safeParse({ ...base, stage: "fleet_unavailable", unavailableReason: "CLI antigo" }).success).toBe(true);
  });
  it("achado corrigido sem o commit que o corrige é recusado, com a mensagem que diz o que falta", () => {
    const withoutCommit = analysisReportInput.safeParse({ ...base, stage: "done", findings: [{ ...blocking, status: "fixed" }] });
    expect(withoutCommit.success).toBe(false);
    expect(withoutCommit.error?.issues.map((issue) => issue.message)).toContain("a fixed finding needs the sha of the commit that fixes it");
    expect(analysisReportInput.safeParse({ ...base, stage: "done", findings: [{ ...blocking, status: "fixed", commit: "abc1234" }] }).success).toBe(true);
  });
  it("dúvida que a pessoa decidiu sem mudar código fecha como decidida, com a decisão dela", () => {
    const question = { ...blocking, severity: "question", status: "decided", decision: "fica como está: o cliente pediu assim" };
    expect(analysisReportInput.safeParse({ ...base, stage: "done", findings: [question] }).success).toBe(true);
  });
  it.each([
    ["decidida sem a decisão é recusada", { ...blocking, severity: "question", status: "decided" }],
    ["decidida com a decisão em branco é recusada", { ...blocking, severity: "question", status: "decided", decision: "  " }],
    ["só dúvida se decide: bloqueante decidido é recusado (corrige com commit ou fica aberto)", { ...blocking, status: "decided", decision: "deixa" }],
    ["só dúvida se decide: melhoria decidida é recusada", { ...blocking, severity: "improvement", status: "decided", decision: "deixa" }],
  ])("%s", (_case, finding) => {
    expect(analysisReportInput.safeParse({ ...base, stage: "done", findings: [finding] }).success).toBe(false);
  });
  it("a dimensão leva quantos achados a frota não verificou", () => {
    const dimensions = [{ key: "tests", status: "ran", unverifiedCount: 2, reason: "2 achados sem veredito" }];
    expect(analysisReportInput.parse({ ...base, dimensions }).dimensions[0]).toMatchObject({ unverifiedCount: 2 });
  });
});
