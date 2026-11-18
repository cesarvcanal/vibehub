import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisReportInput } from "./analysisReport.js";

vi.setConfig({ testTimeout: 30_000 });

let dir = "";
const SHA = "b".repeat(40);
const PR = { number: 7, url: "https://github.com/acme/widgets/pull/7", base: "dev", branch: "feat/x" };

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  const registry = await import("../board/registry.js");
  registry.resetForTesting();
  const project = await registry.createProject({
    name: "widgets", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", baseBranch: "main",
  });
  const analysisCard = await registry.createAnalysisCard({ projectId: project.id, accountSlug: undefined, prBranch: "feat/x", title: "Análise PR #7" });
  await registry.recordCardPr(analysisCard.id, PR);
  const plainCard = await registry.createCard({ projectId: project.id, title: "Login" });
  await registry.recordCardPr(plainCard.id, { ...PR, number: 8, url: "https://github.com/acme/widgets/pull/8" });
  return {
    analysisCard, plainCard,
    reportService: await import("./analysisReport.js"),
    store: await import("./analysisStore.js"),
    events: await import("../events/cardEvents.js"),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-analysis-report-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const input = (over: Partial<AnalysisReportInput> = {}): AnalysisReportInput => ({
  headSha: SHA, stage: "analysed", summary: "2 achados", refutedCount: 3,
  dimensions: [{ key: "correctness", status: "ran" }], findings: [], ...over,
});

describe("relatório da análise pela ferramenta do card", () => {
  it("o card de análise grava o relatório com a PR que ele analisa", async () => {
    const { analysisCard, reportService, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input());
    expect(await store.getAnalysis(analysisCard.id)).toMatchObject({
      cardId: analysisCard.id, prUrl: PR.url, prNumber: 7, analysedSha: SHA, stage: "analysed", refutedCount: 3,
    });
  });

  it("card que não é de análise é recusado mesmo com PR, e nada é gravado", async () => {
    const { plainCard, reportService, store } = await load();
    await expect(reportService.recordAnalysisReport(plainCard.id, input())).rejects.toThrow(/não é um card de análise/);
    expect(await store.getAnalysis(plainCard.id)).toBeUndefined();
  });

  it("card inexistente é recusado", async () => {
    const { reportService } = await load();
    await expect(reportService.recordAnalysisReport("nao-existe", input())).rejects.toThrow(/card não encontrado/);
  });

  it("chamar de novo no mesmo estágio não duplica o aviso no card", async () => {
    const { analysisCard, reportService, events } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input());
    await reportService.recordAnalysisReport(analysisCard.id, input());
    const cardMessages = (await events.eventsAfter(0)).events.filter((event) => event.cardId === analysisCard.id && event.kind === "message");
    expect(cardMessages).toHaveLength(1);
  });

  it("frota indisponível vira aviso de alerta no card, com o motivo", async () => {
    const { analysisCard, reportService, events } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input({ stage: "fleet_unavailable", unavailableReason: "Workflow desligado" }));
    const cardMessage = (await events.eventsAfter(0)).events.find((event) => event.cardId === analysisCard.id && event.kind === "message");
    expect(cardMessage).toMatchObject({ severity: "warning" });
    expect(cardMessage?.text).toContain("Workflow desligado");
  });
});
