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

const blockingFinding = {
  id: "f1", severity: "blocking" as const, title: "t", problem: "p", fix: "x", dimension: "correctness" as const, status: "open" as const,
  proof: { kind: "scenario" as const, ref: "a.ts:1" },
};

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

  it("chamar done de novo não duplica o aviso no card", async () => {
    const { analysisCard, reportService, events } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input());
    await reportService.recordAnalysisReport(analysisCard.id, input({ stage: "done" }));
    await reportService.recordAnalysisReport(analysisCard.id, input({ stage: "done" }));
    const cardMessages = (await events.eventsAfter(0)).events.filter((event) => event.cardId === analysisCard.id && event.kind === "message");
    expect(cardMessages).toHaveLength(2);
  });

  it("frota indisponível vira aviso de alerta no card, com o motivo", async () => {
    const { analysisCard, reportService, events } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input({ stage: "fleet_unavailable", unavailableReason: "Workflow desligado" }));
    const cardMessage = (await events.eventsAfter(0)).events.find((event) => event.cardId === analysisCard.id && event.kind === "message");
    expect(cardMessage).toMatchObject({ severity: "warning" });
    expect(cardMessage?.text).toContain("Workflow desligado");
  });

  it("frota indisponível conclui o card, e um novo pedido da mesma PR abre outro card", async () => {
    const { analysisCard, reportService } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input({ stage: "fleet_unavailable", unavailableReason: "Workflow desligado" }));
    const registry = await import("../board/registry.js");
    expect((await registry.getCard(analysisCard.id))?.column).toBe("done");
    expect(registry.openAnalysisCard(await registry.listCards(analysisCard.projectId), PR.url)).toBeUndefined();
  });

  it.each([[["analysed"]], [["analysed", "done"]]] as const)("relatório %j não move o card", async (stages) => {
    const { analysisCard, reportService } = await load();
    for (const stage of stages) await reportService.recordAnalysisReport(analysisCard.id, input({ stage }));
    const registry = await import("../board/registry.js");
    expect((await registry.getCard(analysisCard.id))?.column).toBe(analysisCard.column);
  });

  it("relatório done que perde um achado do analysed é recusado", async () => {
    const { analysisCard, reportService, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input({ findings: [blockingFinding] }));
    await expect(reportService.recordAnalysisReport(analysisCard.id, input({ stage: "done", findings: [] }))).rejects.toThrow(/f1/);
    expect((await store.getAnalysis(analysisCard.id))?.stage).toBe("analysed");
  });

  it("relatório done que perde o unverifiedCount do analysed é recusado; o mesmo done com ele é gravado", async () => {
    const { analysisCard, reportService, store } = await load();
    const dimensionsWithUnverifiedTests = [{ key: "tests" as const, status: "ran" as const, unverifiedCount: 3, reason: "3 achados acima do teto" }];
    await reportService.recordAnalysisReport(analysisCard.id, input({ dimensions: dimensionsWithUnverifiedTests }));
    await expect(reportService.recordAnalysisReport(analysisCard.id, input({ stage: "done", dimensions: [{ key: "tests", status: "ran" }] })))
      .rejects.toThrow(/tests/);
    await reportService.recordAnalysisReport(analysisCard.id, input({ stage: "done", dimensions: dimensionsWithUnverifiedTests }));
    expect((await store.getAnalysis(analysisCard.id))?.stage).toBe("done");
  });

  it.each([
    ["rebaixa a severity de um achado", { findings: [{ ...blockingFinding, severity: "suggestion" as const }] }, /f1/],
    ["muda a dimensão de um achado", { findings: [{ ...blockingFinding, dimension: "tests" as const }] }, /f1/],
    ["troca o estado de uma dimensão", { dimensions: [{ key: "security" as const, status: "skipped" as const, reason: "x" }] }, /security/],
  ])("relatório done que %s do analysed é recusado: o veredito não sai do que o card reescreve", async (_case, doneOver, named) => {
    const { analysisCard, reportService } = await load();
    const dimensions = [{ key: "correctness" as const, status: "ran" as const }, { key: "security" as const, status: "not_run" as const, reason: "sem resposta" }];
    await reportService.recordAnalysisReport(analysisCard.id, input({ dimensions, findings: [blockingFinding] }));
    await expect(reportService.recordAnalysisReport(analysisCard.id, input({ stage: "done", dimensions, findings: [blockingFinding], ...doneOver })))
      .rejects.toThrow(named);
  });

  it("relatório done que acrescenta como ran uma dimensão ausente do analysed é recusado: ausente conta como não rodou", async () => {
    const { analysisCard, reportService } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input());
    const everyDimensionRan = (["correctness", "security", "performance", "contracts", "tests", "repoRules"] as const)
      .map((key) => ({ key, status: "ran" as const }));
    await expect(reportService.recordAnalysisReport(analysisCard.id, input({ stage: "done", dimensions: everyDimensionRan })))
      .rejects.toThrow(/security/);
  });

  it("segundo relatório analysed é recusado: o que a frota gravou não some por um analysed novo", async () => {
    const { analysisCard, reportService, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input({ findings: [blockingFinding] }));
    await expect(reportService.recordAnalysisReport(analysisCard.id, input({ findings: [] }))).rejects.toThrow(/analysed já foi gravado/);
    expect((await store.getAnalysis(analysisCard.id))?.findings).toHaveLength(1);
  });

  it("frota indisponível depois do analysed gravado é recusada: os achados da frota não somem", async () => {
    const { analysisCard, reportService, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input({ findings: [blockingFinding] }));
    await expect(reportService.recordAnalysisReport(analysisCard.id, input({ stage: "fleet_unavailable", unavailableReason: "x" })))
      .rejects.toThrow(/frota já rodou/);
    expect((await store.getAnalysis(analysisCard.id))?.findings).toHaveLength(1);
  });

  it("relatório done sem o analysed gravado antes é recusado", async () => {
    const { analysisCard, reportService, store } = await load();
    await expect(reportService.recordAnalysisReport(analysisCard.id, input({ stage: "done" }))).rejects.toThrow(/passo 3/);
    expect(await store.getAnalysis(analysisCard.id)).toBeUndefined();
  });

  it("card de análise já concluído não grava relatório: a PR pode já ter outro card trabalhando nela", async () => {
    const { analysisCard, reportService, store } = await load();
    await reportService.recordAnalysisReport(analysisCard.id, input({ stage: "fleet_unavailable", unavailableReason: "Workflow desligado" }));
    await expect(reportService.recordAnalysisReport(analysisCard.id, input({ stage: "analysed" }))).rejects.toThrow(/concluído/);
    expect((await store.getAnalysis(analysisCard.id))?.stage).toBe("fleet_unavailable");
  });
});
