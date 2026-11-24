import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliverOpts, DeliverResult } from "../maestro/deliver.js";

const PR = "https://github.com/acme/widgets/pull/7";
const SHA = "c".repeat(40);
const ORDERED_AT = 1_000_000;
const deliverAnswers: Array<DeliverResult | Error> = [];
const deliver = vi.fn<(cardId: string, opts?: DeliverOpts) => Promise<DeliverResult>>(async () => {
  const answer = deliverAnswers.shift() ?? queued();
  if (answer instanceof Error) throw answer;
  return answer;
});

const queued = (): DeliverResult => ({ prUrl: PR, merged: false, reason: "merge_queued", branch: "main", cardBranch: "card/x", queuedSha: SHA });
const answer = (over: Partial<DeliverResult>): DeliverResult => ({ prUrl: PR, merged: false, reason: "gate", branch: "main", cardBranch: "card/x", ...over });

const dir = { path: "" };

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir.path;
  vi.doMock("../maestro/deliver.js", async () => ({
    ...(await vi.importActual<typeof import("../maestro/deliver.js")>("../maestro/deliver.js")),
    deliver,
  }));
  const registry = await import("../board/registry.js");
  registry.resetForTesting();
  return {
    registry,
    events: await import("../events/cardEvents.js"),
    reviews: await import("./store.js"),
    mergeOrder: await import("./mergeOrder.js"),
  };
}

async function cardWithOrder(over: { analysis?: boolean } = {}) {
  const modules = await load();
  const project = await modules.registry.createProject({ name: "widgets" });
  const card = over.analysis
    ? await modules.registry.createAnalysisCard({ projectId: project.id, accountSlug: undefined, prBranch: "feat-7", title: "Análise PR #7" })
    : await modules.registry.createCard({ projectId: project.id, title: "Docs" });
  await modules.registry.saveMergeOrder(card.id, {
    sha: SHA, target: "main", prUrl: PR, orderedBy: "mussa", connectionId: "conn-mussa", orderedAt: ORDERED_AT,
  });
  return { ...modules, card };
}

async function messagesOf(events: Awaited<ReturnType<typeof load>>["events"], cardId: string) {
  await events.cardEventsSettled();
  return (await events.eventsAfter(0)).events.filter((event) => event.cardId === cardId && event.kind === "message");
}

beforeEach(async () => {
  dir.path = await mkdtemp(join(tmpdir(), "vibehub-merge-order-"));
  deliver.mockClear();
  deliverAnswers.length = 0;
});
afterEach(async () => {
  vi.doUnmock("../maestro/deliver.js");
  await rm(dir.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("servidor cumpre a ordem de merge guardada", { timeout: 30_000 }, () => {
  it("relê o PR em merge-only, preso ao commit da ordem, com a conexão de quem mandou", async () => {
    const { mergeOrder, card } = await cardWithOrder();
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    expect(deliver).toHaveBeenCalledWith(card.id, {
      authorized: true, mergeOnly: true, expectedHeadSha: SHA, branch: "main", connectionId: "conn-mussa", by: "mussa", queueWhileCiRuns: true,
    });
  });

  it("CI ainda rodando: a ordem continua guardada e livre para o próximo ciclo", async () => {
    const { mergeOrder, registry, events, card } = await cardWithOrder();
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    const order = (await registry.getCard(card.id))?.mergeOrder;
    expect(order).toMatchObject({ sha: SHA });
    expect(order?.claimedAt).toBeUndefined();
    expect(await messagesOf(events, card.id)).toEqual([]);
  });

  it("CI verde: mergeia, apaga a ordem, avisa no card e o card vai para Concluído", async () => {
    const { mergeOrder, registry, events, card } = await cardWithOrder();
    deliverAnswers.push(answer({ merged: true, reason: "merged" }));
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    const after = await registry.getCard(card.id);
    expect(after?.mergeOrder).toBeUndefined();
    expect(after?.column).toBe("done");
    expect(await messagesOf(events, card.id)).toEqual([expect.objectContaining({ messageType: "done", text: expect.stringContaining("Mergeado") })]);
  });

  it.each([
    ["CI vermelho", answer({ reason: "gate", output: "CI do PR vermelho: back" }), "CI do PR vermelho: back"],
    ["PR andou", answer({ reason: "head_moved", output: "o PR está em eeeeeee" }), "voltou para você"],
    ["conflito", answer({ reason: "conflict", output: "o PR tem conflito com main" }), "conflito"],
    ["sem CI", answer({ reason: "no_ci", output: "o PR não tem CI no GitHub" }), "não tem CI"],
  ])("%s: apaga a ordem e avisa no card com o motivo", async (_case, result, expectedText) => {
    const { mergeOrder, registry, events, card } = await cardWithOrder();
    deliverAnswers.push(result);
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    expect((await registry.getCard(card.id))?.mergeOrder).toBeUndefined();
    expect(await messagesOf(events, card.id)).toEqual([
      expect.objectContaining({ messageType: "error", severity: "warning", text: expect.stringContaining(expectedText) }),
    ]);
  });

  it("passou de 6 h: a ordem cai sem ler o CI e o card é avisado", async () => {
    const { mergeOrder, registry, events, card } = await cardWithOrder();
    await mergeOrder.runMergeOrders(ORDERED_AT + mergeOrder.MERGE_ORDER_TTL_MS);
    expect(deliver).not.toHaveBeenCalled();
    expect((await registry.getCard(card.id))?.mergeOrder).toBeUndefined();
    expect(await messagesOf(events, card.id)).toEqual([expect.objectContaining({ text: expect.stringContaining("6 h") })]);
  });

  it("card concluído à mão: a ordem morre sem rodar", async () => {
    const { mergeOrder, registry, card } = await cardWithOrder();
    await registry.updateCard(card.id, { column: "done" });
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    expect(deliver).not.toHaveBeenCalled();
    expect((await registry.getCard(card.id))?.mergeOrder).toBeUndefined();
  });

  it("revisão de PR aberta depois da ordem: o merge é da revisão, a ordem cai e o card é avisado", async () => {
    const { mergeOrder, registry, reviews, events, card } = await cardWithOrder();
    await reviews.insertReview({
      id: "rev-1", cardId: card.id, projectId: card.projectId, prNumber: 7, prUrl: PR, prBranch: "card/x", base: "main",
      reviewerUserId: "u-r", authorUserId: "u-a", mergerUserId: "u-m", reviewerCardId: "card-r",
      round: 1, phase: "reviewing", findings: [], log: [], nudges: 0, createdAt: 1, updatedAt: 1,
    });
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    expect(deliver).not.toHaveBeenCalled();
    expect((await registry.getCard(card.id))?.mergeOrder).toBeUndefined();
    expect(await messagesOf(events, card.id)).toEqual([expect.objectContaining({ text: expect.stringContaining("revisão") })]);
  });

  it("falha do runner ou do GitHub ao ler: solta a ordem para o próximo ciclo, sem avisar", async () => {
    const { mergeOrder, registry, events, card } = await cardWithOrder();
    deliverAnswers.push(new Error("runner fora do ar"));
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    const order = (await registry.getCard(card.id))?.mergeOrder;
    expect(order).toMatchObject({ sha: SHA });
    expect(order?.claimedAt).toBeUndefined();
    expect(await messagesOf(events, card.id)).toEqual([]);
  });

  it("dois ciclos ao mesmo tempo (dois backends no deploy): o PR é lido uma vez só", async () => {
    const { mergeOrder } = await cardWithOrder();
    await Promise.all([mergeOrder.runMergeOrders(ORDERED_AT + 60_000), mergeOrder.runMergeOrders(ORDERED_AT + 60_000)]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("depois de um reinício do servidor, a ordem gravada no board é retomada", async () => {
    const { card } = await cardWithOrder();
    const { mergeOrder } = await load();
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    expect(deliver).toHaveBeenCalledWith(card.id, expect.objectContaining({ expectedHeadSha: SHA }));
  });

  it("card de análise: mergeia pelo caminho da análise e o card vai para Concluído", async () => {
    const { mergeOrder, registry, card } = await cardWithOrder({ analysis: true });
    deliverAnswers.push(answer({ merged: true, reason: "merged", cardBranch: "feat-7" }));
    await mergeOrder.runMergeOrders(ORDERED_AT + 60_000);
    expect(deliver).toHaveBeenCalledWith(card.id, expect.objectContaining({ mergeOnly: true, expectedHeadSha: SHA }));
    expect((await registry.getCard(card.id))?.column).toBe("done");
  });
});
