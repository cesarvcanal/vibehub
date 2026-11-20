import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisReport } from "./analysisModel.js";

async function load(seed?: unknown) {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-analyses-"));
  if (seed !== undefined) await writeFile(join(dataDir, "analyses.json"), JSON.stringify(seed));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  return await import("./analysisStore.js");
}

const acceptAnySaved = () => undefined;

const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: "c1", prUrl: "https://github.com/acme/w/pull/7", prNumber: 7, analysedSha: "a".repeat(40), stage: "analysed",
  summary: "s", dimensions: [], findings: [], refutedCount: 0, updatedAt: 1, ...over,
});

describe("store das análises", () => {
  it("guarda um relatório por card e o seguinte substitui o anterior", async () => {
    const store = await load();
    await store.saveAnalysis(report(), acceptAnySaved);
    await store.saveAnalysis(report({ stage: "done" }), acceptAnySaved);
    expect((await store.getAnalysis("c1"))?.stage).toBe("done");
  });
  it("o relatório de um card não apaga o de outro", async () => {
    const store = await load();
    await store.saveAnalysis(report(), acceptAnySaved);
    await store.saveAnalysis(report({ cardId: "c2" }), acceptAnySaved);
    expect(await store.getAnalysis("c1")).toBeDefined();
    expect(await store.getAnalysis("c2")).toBeDefined();
  });
  it("devolve cópia: mexer no lido não muda o gravado", async () => {
    const store = await load();
    await store.saveAnalysis(report(), acceptAnySaved);
    const readReport = await store.getAnalysis("c1");
    readReport!.summary = "mexido";
    expect((await store.getAnalysis("c1"))?.summary).toBe("s");
  });
  it("card sem análise lê undefined", async () => {
    const store = await load();
    expect(await store.getAnalysis("nenhum")).toBeUndefined();
  });
  it("o veredito do gate do merge só grava no commit que a análise está agora", async () => {
    const store = await load();
    await store.saveAnalysis(report(), acceptAnySaved);
    const gate = { cardId: "c1", analysedSha: "a".repeat(40), state: "passed" as const, at: 1 };
    expect(await store.saveAnalysisMergeGate({ ...gate, analysedSha: "b".repeat(40) })).toBe(false);
    expect(await store.getAnalysisMergeGate("c1")).toBeUndefined();
    expect(await store.saveAnalysisMergeGate(gate)).toBe(true);
    expect(await store.getAnalysisMergeGate("c1")).toEqual(gate);
  });
  it("analyses.json gravado antes do gate do merge lê sem veredito e mantém o resto", async () => {
    const store = await load({ analyses: [report()], mergeRefusals: [] });
    expect(await store.getAnalysisMergeGate("c1")).toBeUndefined();
    expect((await store.getAnalysis("c1"))?.cardId).toBe("c1");
  });
});
