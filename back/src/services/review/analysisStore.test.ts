import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisReport } from "./analysisModel.js";

async function load() {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-analyses-"));
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
});
