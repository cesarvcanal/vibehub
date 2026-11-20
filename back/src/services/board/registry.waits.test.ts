import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardWait } from "./cardWait.js";

async function freshRegistry() {
  const dataDir = mkdtempSync(join(tmpdir(), "vibehub-waits-"));
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  return { registry: await import("./registry.js"), dataDir };
}

type Registry = Awaited<ReturnType<typeof freshRegistry>>["registry"];

async function createWaitingPair(registry: Registry, wait: Partial<CardWait> = {}) {
  const project = await registry.createProject({ name: "Shop" });
  const target = await registry.createCard({ projectId: project.id, title: "Captura de falhas" });
  const waiting = await registry.createCard({ projectId: project.id, title: "Complemento" });
  await registry.setCardWait(waiting.id, { cardId: target.id, instruction: "faça o complemento", createdAt: 1, createdBy: "user-1", ...wait });
  return { target, waiting };
}

function listenWaitsReady(registry: Registry): string[][] {
  const heard: string[][] = [];
  const stop = registry.onWaitsReady((cardIds) => heard.push(cardIds));
  onTestFinished(stop);
  return heard;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("espera entre cards no registry", () => {
  it("o card esperado concluído deixa pronta a espera e avisa quem espera", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry);
    const heard = listenWaitsReady(registry);
    await registry.updateCard(target.id, { column: "done" });
    await settle();
    expect((await registry.getCard(waiting.id))?.waitingFor).toMatchObject({ outcome: "concluded", readyAt: expect.any(Number) });
    expect(heard).toEqual([[waiting.id]]);
  });

  it("o card esperado que sai de done e volta não dispara a espera de novo", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry);
    const heard = listenWaitsReady(registry);
    await registry.updateCard(target.id, { column: "done" });
    const firstReadyAt = (await registry.getCard(waiting.id))?.waitingFor?.readyAt;
    await registry.updateCard(target.id, { column: "waiting" });
    await registry.updateCard(target.id, { column: "done" });
    await settle();
    expect((await registry.getCard(waiting.id))?.waitingFor?.readyAt).toBe(firstReadyAt);
    expect(heard).toEqual([[waiting.id]]);
  });

  it("PR entregue e mergeado pelo vibehub deixa pronta a espera com o número do PR", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry);
    await registry.recordCardPr(target.id, { number: 356, url: "https://github.com/o/r/pull/356", base: "main", branch: "card/x" });
    const heard = listenWaitsReady(registry);
    await registry.markCardPrMerged(target.id, "main", 356, 5000);
    await settle();
    expect((await registry.getCard(waiting.id))?.waitingFor).toMatchObject({ outcome: "pr_merged", prNumber: 356, readyAt: 5000 });
    expect(heard).toEqual([[waiting.id]]);
  });

  it("merge fora da base fixada na espera não a deixa pronta", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry, { base: "prod" });
    await registry.recordCardPr(target.id, { number: 8, url: "https://github.com/o/r/pull/8", base: "dev", branch: "card/x" });
    await registry.markCardPrMerged(target.id, "dev", 8, 5000);
    expect((await registry.getCard(waiting.id))?.waitingFor?.readyAt).toBeUndefined();
  });

  it("PR só anexado para revisão, quando mergeado, não deixa pronta a espera", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry);
    await registry.attachCardPrs(target.id, [{ number: 9, url: "https://github.com/o/r/pull/9", base: "main", branch: "feat/y" }]);
    await registry.markCardPrMerged(target.id, "main", 9, 5000);
    expect((await registry.getCard(waiting.id))?.waitingFor?.readyAt).toBeUndefined();
  });

  it("o card esperado apagado deixa pronta a espera avisando a remoção", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry);
    const heard = listenWaitsReady(registry);
    await registry.removeCard(target.id);
    await settle();
    expect((await registry.getCard(waiting.id))?.waitingFor).toMatchObject({ outcome: "deleted" });
    expect(heard).toEqual([[waiting.id]]);
  });

  it("o card que espera ir para done cancela a espera dele", async () => {
    const { registry } = await freshRegistry();
    const { waiting } = await createWaitingPair(registry);
    await registry.updateCard(waiting.id, { column: "done" });
    expect((await registry.getCard(waiting.id))?.waitingFor).toBeUndefined();
  });

  it("o card pausado com espera pronta avisa quando é reaberto", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry);
    await registry.applyOpenTerminal(waiting.id);
    await registry.updateCard(waiting.id, { column: "paused" });
    await registry.applyCardStatus(waiting.id, "waiting");
    await registry.updateCard(target.id, { column: "done" });
    await settle();
    const heard = listenWaitsReady(registry);
    await registry.applyOpenTerminal(waiting.id);
    await settle();
    expect(heard).toEqual([[waiting.id]]);
  });

  it("tirar uma espera pronta a entrega uma vez só e nunca de um card pausado", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry);
    expect(await registry.takeReadyCardWait(waiting.id)).toBeUndefined();
    await registry.applyOpenTerminal(waiting.id);
    await registry.updateCard(waiting.id, { column: "paused" });
    await registry.applyCardStatus(waiting.id, "waiting");
    await registry.updateCard(target.id, { column: "done" });
    expect(await registry.takeReadyCardWait(waiting.id)).toBeUndefined();
    await registry.applyOpenTerminal(waiting.id);
    const [first, second] = await Promise.all([registry.takeReadyCardWait(waiting.id), registry.takeReadyCardWait(waiting.id)]);
    expect(first).toMatchObject({ cardId: target.id, outcome: "concluded" });
    expect(second).toBeUndefined();
    expect((await registry.getCard(waiting.id))?.waitingFor).toBeUndefined();
  });

  it("a falha ao acordar devolve a espera com o motivo, sem passar por cima de uma espera nova", async () => {
    const { registry } = await freshRegistry();
    const { target, waiting } = await createWaitingPair(registry);
    await registry.updateCard(target.id, { column: "done" });
    const taken = await registry.takeReadyCardWait(waiting.id);
    if (!taken) throw new Error("the ready wait was not taken");
    await registry.restoreFailedCardWait(waiting.id, taken, { at: 7, reason: "runner fora" });
    expect((await registry.getCard(waiting.id))?.waitingFor).toMatchObject({ outcome: "concluded", failure: { at: 7, reason: "runner fora" } });

    const retaken = await registry.takeReadyCardWait(waiting.id);
    if (!retaken) throw new Error("the restored wait was not taken");
    const newerWait = { cardId: "other", instruction: "outra coisa", createdAt: 9, createdBy: "user-1" };
    await registry.setCardWait(waiting.id, newerWait);
    await registry.restoreFailedCardWait(waiting.id, retaken, { at: 10, reason: "runner fora" });
    expect((await registry.getCard(waiting.id))?.waitingFor).toEqual(newerWait);
  });

  it("uma espera malformada no board.json é descartada na leitura", async () => {
    const { registry, dataDir } = await freshRegistry();
    const { waiting } = await createWaitingPair(registry);
    const boardPath = join(dataDir, "board.json");
    const board = JSON.parse(readFileSync(boardPath, "utf8"));
    board.cards.find((card: { id: string }) => card.id === waiting.id).waitingFor = { cardId: 42 };
    writeFileSync(boardPath, JSON.stringify(board));
    vi.resetModules();
    const env = await import("../../config/env.js");
    env.config.dataDir = dataDir;
    const reloaded = await import("./registry.js");
    expect((await reloaded.getCard(waiting.id))?.waitingFor).toBeUndefined();
  });
});
