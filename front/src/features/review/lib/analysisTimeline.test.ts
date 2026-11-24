import { describe, expect, it } from "vitest";
import type { AnalysisFinding, AnalysisTimelineEntry, AnalysisTimelineEvent } from "@/api/types";
import { analysisTimelineRows, openQuestionFindings } from "@/features/review/lib/analysisTimeline";

const FIX_SHA = "d".repeat(40);

const finding = (over: Partial<AnalysisFinding> & Pick<AnalysisFinding, "id">): AnalysisFinding => ({
  severity: "blocking", dimension: "correctness", title: `Achado ${over.id}`, problem: "p", status: "open", ...over,
} as AnalysisFinding);

const FINDINGS = [finding({ id: "f1", title: "Saldo fica negativo" }), finding({ id: "f2", severity: "question", title: "Qual filial?" })];

const entriesOf = (...events: AnalysisTimelineEvent[]): AnalysisTimelineEntry[] =>
  events.map((event, index) => ({ ...event, cardId: "c1", analysedSha: "e".repeat(40), at: 1_000 + index }));

describe("linhas da linha do tempo da correção", () => {
  it("o achado em correção leva o id e o título do relatório, e está em andamento enquanto a IA trabalha", () => {
    const rows = analysisTimelineRows(entriesOf({ kind: "fixing", findingId: "f1" }), FINDINGS, { cardWorking: true });
    expect(rows).toEqual([expect.objectContaining({ textKey: "analysis.timeline.fixing", vars: { id: "f1", title: "Saldo fica negativo" }, current: true })]);
  });

  it("achado já corrigido deixa de estar em andamento, e a linha do commit leva o sha curto", () => {
    const rows = analysisTimelineRows(
      entriesOf({ kind: "fixing", findingId: "f1" }, { kind: "fixed", findingId: "f1", commit: FIX_SHA }), FINDINGS, { cardWorking: true },
    );
    expect(rows.map((row) => row.current)).toEqual([false, false]);
    expect(rows[1]).toMatchObject({ textKey: "analysis.timeline.fixed", vars: { id: "f1", title: "Saldo fica negativo", commit: "ddddddd" } });
  });

  it("com a IA parada, nenhum achado aparece em andamento", () => {
    const rows = analysisTimelineRows(entriesOf({ kind: "fixing", findingId: "f1" }), FINDINGS, { cardWorking: false });
    expect(rows[0]?.current).toBe(false);
  });

  it.each([
    [{ kind: "recheck", outcome: "clean" } as const, "analysis.timeline.recheckClean", undefined],
    [{ kind: "recheck", outcome: "found", note: "teste do PDV quebrou" } as const, "analysis.timeline.recheckFound", "teste do PDV quebrou"],
    [{ kind: "delivered", reason: "gate", output: "lint: 12 erros" } as const, "analysis.timeline.delivered.gate", "lint: 12 erros"],
    [{ kind: "delivered", reason: "unauthorized", output: "falta authorized" } as const, "analysis.timeline.delivered.unauthorized", undefined],
    [{ kind: "delivered", reason: "push_failed", output: "403" } as const, "analysis.timeline.delivered.unknown", "403"],
  ])("%o vira a linha %s com o detalhe certo", (event, textKey, detail) => {
    const [row] = analysisTimelineRows(entriesOf(event), FINDINGS, { cardWorking: false });
    expect(row?.textKey).toBe(textKey);
    expect(row?.detail).toBe(detail);
  });

  it("motivo de entrega sem texto próprio mostra o motivo cru, sem sumir", () => {
    const [row] = analysisTimelineRows(entriesOf({ kind: "delivered", reason: "push_failed" }), FINDINGS, { cardWorking: false });
    expect(row?.vars).toEqual({ reason: "push_failed" });
  });

  it("o relatório final traz a contagem de corrigidos, decididos e abertos", () => {
    const [row] = analysisTimelineRows(entriesOf({ kind: "report", stage: "done", fixed: 4, decided: 1, open: 2 }), FINDINGS, { cardWorking: false });
    expect(row).toMatchObject({ textKey: "analysis.timeline.done", vars: { fixed: 4, decided: 1, open: 2 } });
  });

  it("achado que o relatório não tem mostra só o id", () => {
    const [row] = analysisTimelineRows(entriesOf({ kind: "fixing", findingId: "f9" }), FINDINGS, { cardWorking: false });
    expect(row?.vars).toEqual({ id: "f9", title: "" });
  });
});

describe("perguntas que esperam a pessoa", () => {
  it("só as questions abertas, e só depois do done", () => {
    const decided = finding({ id: "f3", severity: "question", status: "decided", decision: "fica" });
    expect(openQuestionFindings({ stage: "done", findings: [...FINDINGS, decided] }).map((open) => open.id)).toEqual(["f2"]);
    expect(openQuestionFindings({ stage: "analysed", findings: FINDINGS })).toEqual([]);
  });
});
