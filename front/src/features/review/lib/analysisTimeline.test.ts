import { describe, expect, it } from "vitest";
import {
  DELIVER_REASONS, type AnalysisFinding, type AnalysisStage, type AnalysisTimelineEntry, type AnalysisTimelineEvent,
} from "@/api/types";
import type { CardStateKind } from "@/features/board/lib/board";
import { analysisTimelineRows, fixingNotStartedYet, questionsWaitingForPerson } from "@/features/review/lib/analysisTimeline";
import { en } from "@/i18n/en";
import { ptBR } from "@/i18n/pt-BR";

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

  it("achado que a IA largou (seguiu para a reconferência sem o commit dele) deixa de estar em andamento", () => {
    const rows = analysisTimelineRows(
      entriesOf({ kind: "fixing", findingId: "f1" }, { kind: "recheck", outcome: "clean" }), FINDINGS, { cardWorking: true },
    );
    expect(rows.map((row) => row.current)).toEqual([false, false]);
  });

  it.each([
    [{ kind: "recheck", outcome: "clean" } as const, "analysis.timeline.recheckClean", undefined, false],
    [{ kind: "recheck", outcome: "found", note: "teste do PDV quebrou" } as const, "analysis.timeline.recheckFound", "teste do PDV quebrou", true],
    [{ kind: "delivered", reason: "gate", stopped: true, output: "lint: 12 erros" } as const, "analysis.timeline.delivered.gate", "lint: 12 erros", true],
    [{ kind: "delivered", reason: "unauthorized", stopped: false } as const, "analysis.timeline.delivered.unauthorized", undefined, false],
    [{ kind: "delivered", reason: "push_failed", stopped: true, output: "403" } as const, "analysis.timeline.delivered.push_failed", "403", true],
  ])("%o vira a linha %s com o detalhe e o alerta certos", (event, textKey, detail, needsAttention) => {
    const [row] = analysisTimelineRows(entriesOf(event), FINDINGS, { cardWorking: false });
    expect(row).toMatchObject({ textKey, needsAttention });
    expect(row?.detail).toBe(detail);
  });

  it.each(DELIVER_REASONS)("o motivo de entrega %s tem texto próprio nos dois idiomas", (reason) => {
    expect(en[`analysis.timeline.delivered.${reason}`]).toBeTruthy();
    expect(ptBR[`analysis.timeline.delivered.${reason}`]).toBeTruthy();
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
  const decided = finding({ id: "f3", severity: "question", status: "decided", decision: "fica" });

  it("depois do done, com o card esperando a pessoa, são as questions abertas", () => {
    expect(questionsWaitingForPerson({ stage: "done", findings: [...FINDINGS, decided] }, "needs_me").map((open) => open.id)).toEqual(["f2"]);
  });

  it.each<[string, AnalysisStage, CardStateKind | undefined]>([
    ["antes do done", "analysed", "needs_me"],
    ["com a IA ainda trabalhando (não perguntou)", "done", "working"],
    ["com o card concluído", "done", "done"],
    ["sem o estado do card", "done", undefined],
  ])("%s, nenhuma pergunta aparece como esperando", (_case, stage, cardState) => {
    expect(questionsWaitingForPerson({ stage, findings: FINDINGS }, cardState)).toEqual([]);
  });
});

describe("aviso de que a IA ainda não começou a corrigir", () => {
  const analysedReport = entriesOf({ kind: "report", stage: "analysed", fixed: 0, decided: 0, open: 2 });

  it("aparece só com o analysed gravado e nenhum passo da correção", () => {
    expect(fixingNotStartedYet(analysedReport, "analysed")).toBe(true);
  });

  it.each<[string, AnalysisTimelineEntry[], AnalysisStage]>([
    ["análise concluída antes da linha do tempo existir", [], "done"],
    ["frota que não rodou", [], "fleet_unavailable"],
    ["com um passo da correção", entriesOf({ kind: "report", stage: "analysed", fixed: 0, decided: 0, open: 2 }, { kind: "fixing", findingId: "f1" }), "analysed"],
  ])("não aparece: %s", (_case, entries, stage) => {
    expect(fixingNotStartedYet(entries, stage)).toBe(false);
  });
});
