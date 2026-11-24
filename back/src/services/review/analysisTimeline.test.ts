import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisReportInput } from "./analysisReport.js";

vi.setConfig({ testTimeout: 30_000 });

const SHA = "c".repeat(40);
const FIX_SHA = "d".repeat(40);
const PR = { number: 9, url: "https://github.com/acme/widgets/pull/9", base: "dev", branch: "feat/y" };

async function load() {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-analysis-timeline-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  env.config.secretKey = "";
  const registry = await import("../board/registry.js");
  registry.resetForTesting();
  const project = await registry.createProject({
    name: "widgets", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", baseBranch: "main",
  });
  const analysisCard = await registry.createAnalysisCard({ projectId: project.id, accountSlug: undefined, prBranch: "feat/y", title: "Análise PR #9" });
  await registry.recordCardPr(analysisCard.id, PR);
  return {
    dataDir,
    analysisCard,
    registry,
    reportService: await import("./analysisReport.js"),
    timeline: await import("./analysisTimeline.js"),
    store: await import("./analysisStore.js"),
  };
}

const blockingFinding = {
  id: "f1", severity: "blocking" as const, title: "Saldo negativo", problem: "p", fix: "x", dimension: "correctness" as const,
  status: "open" as const, proof: { kind: "scenario" as const, ref: "a.ts:1" },
};

const analysedInput = (over: Partial<AnalysisReportInput> = {}): AnalysisReportInput => ({
  headSha: SHA, stage: "analysed", summary: "1 achado", refutedCount: 0,
  dimensions: [{ key: "correctness", status: "ran" }], findings: [blockingFinding], ...over,
});

describe("linha do tempo da correção na análise de PR", () => {
  it("os passos que a IA declara entram em ordem, presos ao sha analisado", async () => {
    const { analysisCard, reportService, timeline, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, analysedInput());
    await timeline.recordAnalysisStep(analysisCard.id, { kind: "fixing", findingId: "f1" });
    await timeline.recordAnalysisStep(analysisCard.id, { kind: "fixed", findingId: "f1", commit: FIX_SHA });
    await timeline.recordAnalysisStep(analysisCard.id, { kind: "recheck", outcome: "clean" });
    const entries = await store.listAnalysisTimeline(analysisCard.id);
    expect(entries.map((entry) => entry.kind)).toEqual(["report", "fixing", "fixed", "recheck"]);
    expect(entries[2]).toMatchObject({ cardId: analysisCard.id, analysedSha: SHA, findingId: "f1", commit: FIX_SHA });
  });

  it("achado que o relatório não tem é recusado, dizendo os ids que existem", async () => {
    const { analysisCard, reportService, timeline, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, analysedInput());
    await expect(timeline.recordAnalysisStep(analysisCard.id, { kind: "fixing", findingId: "f9" })).rejects.toThrow(/f9.*f1/);
    expect((await store.listAnalysisTimeline(analysisCard.id)).map((entry) => entry.kind)).toEqual(["report"]);
  });

  it("passo antes do relatório analysed é recusado", async () => {
    const { analysisCard, timeline } = await load();
    await expect(timeline.recordAnalysisStep(analysisCard.id, { kind: "recheck", outcome: "clean" })).rejects.toThrow(/analysed/);
  });

  it("passo depois da frota indisponível é recusado", async () => {
    const { analysisCard, reportService, timeline } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, analysedInput({ stage: "fleet_unavailable", unavailableReason: "sem Workflow", findings: [] }));
    await expect(timeline.recordAnalysisStep(analysisCard.id, { kind: "recheck", outcome: "clean" })).rejects.toThrow(/concluído|frota/);
  });

  it("card de análise concluído recusa passo novo", async () => {
    const { analysisCard, reportService, timeline, registry } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, analysedInput());
    await registry.updateCard(analysisCard.id, { column: "done" });
    await expect(timeline.recordAnalysisStep(analysisCard.id, { kind: "fixing", findingId: "f1" })).rejects.toThrow(/concluído/);
  });

  it("o mesmo passo repetido em seguida (retry da IA) fica uma entrada só", async () => {
    const { analysisCard, reportService, timeline, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, analysedInput());
    await timeline.recordAnalysisStep(analysisCard.id, { kind: "fixed", findingId: "f1", commit: FIX_SHA });
    await timeline.recordAnalysisStep(analysisCard.id, { kind: "fixed", findingId: "f1", commit: FIX_SHA.toUpperCase() });
    expect((await store.listAnalysisTimeline(analysisCard.id)).filter((entry) => entry.kind === "fixed")).toHaveLength(1);
  });

  it("o relatório done entra com a contagem de fixed, decided e open daquele momento", async () => {
    const { analysisCard, reportService, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, analysedInput());
    await reportService.recordAnalysisReport(analysisCard.id, analysedInput({ stage: "done", findings: [{ ...blockingFinding, status: "fixed", commit: FIX_SHA }] }));
    const doneEntry = (await store.listAnalysisTimeline(analysisCard.id)).at(-1);
    expect(doneEntry).toMatchObject({ kind: "report", stage: "done", fixed: 1, decided: 0, open: 0 });
  });

  it("analyses.json gravado antes da linha do tempo existir lê a linha vazia", async () => {
    const { dataDir, analysisCard } = await load();
    await writeFile(join(dataDir, "analyses.json"), JSON.stringify({ analyses: [], mergeRefusals: [], mergeGates: [] }));
    const store = await import("./analysisStore.js");
    expect(await store.listAnalysisTimeline(analysisCard.id)).toEqual([]);
  });

  it("cada entrega do card de análise entra com o motivo, a PR e a saída do gate", async () => {
    const { analysisCard, reportService, timeline, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, analysedInput());
    await timeline.recordAnalysisDelivery(analysisCard.id, {
      merged: false, reason: "gate", branch: "dev", cardBranch: "feat/y", prUrl: PR.url, output: "lint: 12 erros",
    });
    expect((await store.listAnalysisTimeline(analysisCard.id)).at(-1)).toMatchObject({
      kind: "delivered", reason: "gate", prUrl: PR.url, output: "lint: 12 erros", analysedSha: SHA,
    });
  });

  it("entrega de card sem relatório de análise não grava nada", async () => {
    const { analysisCard, timeline, store } = await load();
    await timeline.recordAnalysisDelivery(analysisCard.id, { merged: false, reason: "pushed", branch: "dev", cardBranch: "feat/y" });
    expect(await store.listAnalysisTimeline(analysisCard.id)).toEqual([]);
  });
});
