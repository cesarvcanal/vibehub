import { describe, it, expect, vi, onTestFinished } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "a".repeat(40);

async function freshRegistry(dir?: string) {
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "vibehub-merge-order-")));
  if (!dir) onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  return { registry: await import("./registry.js"), dataDir };
}

async function cardWithOrder() {
  const { registry, dataDir } = await freshRegistry();
  const project = await registry.createProject({ name: "widgets" });
  const card = await registry.createCard({ projectId: project.id, title: "Login" });
  const order = {
    sha: SHA, target: "main", prUrl: "https://github.com/acme/widgets/pull/7",
    orderedBy: "u-m", connectionId: "conn-1", orderedAt: 1_000,
  };
  await registry.saveMergeOrder(card.id, order);
  return { registry, dataDir, card, order };
}

describe("ordem de merge guardada no card", () => {
  it("grava, aparece na lista de cards com ordem e some quando apagada", async () => {
    const { registry, card, order } = await cardWithOrder();
    expect((await registry.getCard(card.id))?.mergeOrder).toEqual(order);
    expect((await registry.listCardsWithMergeOrder()).map((listed) => listed.id)).toEqual([card.id]);

    await registry.saveMergeOrder(card.id, undefined);
    expect((await registry.getCard(card.id))?.mergeOrder).toBeUndefined();
    expect(await registry.listCardsWithMergeOrder()).toEqual([]);
  });

  it("dois backends reivindicando a mesma ordem ao mesmo tempo: só um leva", async () => {
    const { registry, card } = await cardWithOrder();
    const claims = await Promise.all([registry.claimMergeOrder(card.id, 5_000), registry.claimMergeOrder(card.id, 5_000)]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect((await registry.getCard(card.id))?.mergeOrder?.claimedAt).toBe(5_000);
  });

  it("reivindicação de um backend que morreu é retomada depois do prazo", async () => {
    const { registry, card } = await cardWithOrder();
    await registry.claimMergeOrder(card.id, 5_000);
    expect(await registry.claimMergeOrder(card.id, 5_000 + registry.MERGE_ORDER_CLAIM_MS - 1)).toBeNull();
    expect(await registry.claimMergeOrder(card.id, 5_000 + registry.MERGE_ORDER_CLAIM_MS)).toMatchObject({ sha: SHA });
  });

  it("soltar a reivindicação libera a ordem do mesmo commit, e não mexe numa ordem nova", async () => {
    const { registry, card, order } = await cardWithOrder();
    await registry.claimMergeOrder(card.id, 5_000);
    await registry.releaseMergeOrder(card.id, "b".repeat(40));
    expect((await registry.getCard(card.id))?.mergeOrder?.claimedAt).toBe(5_000);

    await registry.releaseMergeOrder(card.id, order.sha);
    expect((await registry.getCard(card.id))?.mergeOrder).toEqual(order);
  });

  it("card sem ordem: nada a reivindicar", async () => {
    const { registry } = await freshRegistry();
    const project = await registry.createProject({ name: "widgets" });
    const card = await registry.createCard({ projectId: project.id, title: "Login" });
    expect(await registry.claimMergeOrder(card.id, 5_000)).toBeNull();
  });

  it("ordem malformada no board.json (edição à mão) é lida como ausente", async () => {
    const { card, dataDir } = await cardWithOrder();
    const boardPath = join(dataDir, "board.json");
    const doc = JSON.parse(await readFile(boardPath, "utf8"));
    doc.cards[0].mergeOrder = { sha: "curto", target: "main" };
    await writeFile(boardPath, JSON.stringify(doc));
    const { registry } = await freshRegistry(dataDir);
    expect((await registry.getCard(card.id))?.mergeOrder).toBeUndefined();
  });
});
