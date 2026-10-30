import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "./model.js";

/**
 * STORE DAS REVISÕES — `reviews.json`, o segundo arquivo do vibehub além do board. Mesmo padrão do
 * card-events: um JsonStore próprio, apontado pra um diretório temporário e recriado a cada teste
 * (`vi.resetModules`), sem tocar o board.
 */

let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  return await import("./store.js");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-reviews-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function review(over: Partial<Review> = {}): Review {
  return {
    id: "rev-1",
    cardId: "card-autor",
    projectId: "proj-1",
    prNumber: 7,
    prUrl: "https://github.com/acme/repo/pull/7",
    prBranch: "card/login-ab12",
    base: "dev",
    reviewerUserId: "u-revisor",
    authorUserId: "u-autor",
    mergerUserId: "u-autor",
    reviewerCardId: "card-revisor",
    round: 1,
    phase: "reviewing",
    findings: [],
    log: [],
    nudges: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

describe("store das revisões", () => {
  it("insere, muta e acha a revisão ativa do card", async () => {
    const store = await load();
    await store.insertReview(review());
    expect(await store.getReview("rev-1")).toMatchObject({ id: "rev-1", phase: "reviewing", round: 1 });

    const before = Date.now();
    const mutated = await store.mutateReview("rev-1", (r) => {
      r.phase = "fixing";
      r.round = 2;
    });
    expect(mutated).toMatchObject({ phase: "fixing", round: 2 });
    // a mutação carimba o updatedAt: é o que o front usa pra ordenar e o orquestrador pra detectar parada
    expect(mutated.updatedAt).toBeGreaterThanOrEqual(before);

    // a leitura devolve o que foi pro disco, e por qualquer das três chaves
    expect(await store.getReview("rev-1")).toMatchObject({ phase: "fixing", round: 2 });
    expect((await store.activeReviewFor("card-autor"))?.id).toBe("rev-1");
    expect((await store.activeReviewFor("card-autor", 7))?.id).toBe("rev-1");
    expect((await store.reviewByReviewerCard("card-revisor"))?.id).toBe("rev-1");

    // e persistiu em reviews.json, não só na memória
    const onDisk = JSON.parse(await readFile(join(dir, "reviews.json"), "utf8")) as { reviews: Review[] };
    expect(onDisk.reviews.map((r) => [r.id, r.phase])).toEqual([["rev-1", "fixing"]]);
  });

  it("revisão merged ou cancelled não é ativa", async () => {
    const store = await load();
    await store.insertReview(review({ id: "rev-m", cardId: "c-merged", prNumber: 1, phase: "merged" }));
    await store.insertReview(review({ id: "rev-c", cardId: "c-cancel", prNumber: 2, phase: "cancelled" }));
    expect(await store.activeReviewFor("c-merged")).toBeUndefined();
    expect(await store.activeReviewFor("c-cancel")).toBeUndefined();
    // continuam acháveis pelo id e pelo card do revisor: o histórico não some
    expect((await store.getReview("rev-m"))?.phase).toBe("merged");
    expect((await store.reviewByReviewerCard("card-revisor"))?.id).toBeDefined();

    // ready, impasse, fixing e reviewing seguem ativas (impasse espera a decisão humana)
    for (const phase of ["reviewing", "fixing", "ready", "impasse"] as const) {
      const cardId = `c-${phase}`;
      await store.insertReview(review({ id: `rev-${phase}`, cardId, prNumber: 3, phase }));
      expect((await store.activeReviewFor(cardId))?.id).toBe(`rev-${phase}`);
    }

    // uma nova revisão do mesmo PR depois de uma merged/cancelled vira a ativa
    await store.insertReview(review({ id: "rev-m2", cardId: "c-merged", prNumber: 1, phase: "reviewing" }));
    expect((await store.activeReviewFor("c-merged"))?.id).toBe("rev-m2");
  });

  it("duas mutações concorrentes não se perdem", async () => {
    const store = await load();
    await store.insertReview(review());
    await Promise.all([
      store.mutateReview("rev-1", (r) => {
        r.log.push({ at: 1, round: 1, who: "reviewer", text: "achei um bug" });
      }),
      store.mutateReview("rev-1", (r) => {
        r.nudges += 1;
      }),
    ]);
    const after = await store.getReview("rev-1");
    expect(after?.log.map((e) => e.text)).toEqual(["achei um bug"]);
    expect(after?.nudges).toBe(1);
  });

  it("activeReviewFor com prNumber separa os PRs do mesmo card", async () => {
    const store = await load();
    await store.insertReview(review({ id: "rev-dev", prNumber: 7 }));
    await store.insertReview(review({ id: "rev-prod", prNumber: 8, reviewerCardId: "card-revisor-2" }));
    expect((await store.activeReviewFor("card-autor", 7))?.id).toBe("rev-dev");
    expect((await store.activeReviewFor("card-autor", 8))?.id).toBe("rev-prod");
    expect(await store.activeReviewFor("card-autor", 9)).toBeUndefined();
    expect(await store.activeReviewFor("outro-card")).toBeUndefined();
  });

  it("listReviewsForCards devolve as revisões só dos cards pedidos, ativas ou não", async () => {
    const store = await load();
    await store.insertReview(review({ id: "a", cardId: "c-a", phase: "merged", reviewerCardId: "r-a" }));
    await store.insertReview(review({ id: "b", cardId: "c-b", reviewerCardId: "r-b" }));
    await store.insertReview(review({ id: "c", cardId: "c-c", reviewerCardId: "r-c" }));
    expect((await store.listReviewsForCards(["c-a", "c-b"])).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(await store.listReviewsForCards([])).toEqual([]);
    expect(await store.listReviewsForCards(["nada"])).toEqual([]);
  });

  it("insertReview recusa o mesmo id duas vezes e não duplica no arquivo", async () => {
    const store = await load();
    await store.insertReview(review());
    await expect(store.insertReview(review({ phase: "fixing" }))).rejects.toThrow(/already exists/);
    expect(await store.listReviewsForCards(["card-autor"])).toHaveLength(1);
    expect((await store.getReview("rev-1"))?.phase).toBe("reviewing");
  });

  it("mutateReview de id desconhecido recusa; uma mutação que lança não deixa rastro", async () => {
    const store = await load();
    await store.insertReview(review());
    await expect(store.mutateReview("nada", () => undefined)).rejects.toThrow(/not found/);
    await expect(
      store.mutateReview("rev-1", (r) => {
        r.phase = "fixing";
        throw new Error("falhou no meio");
      }),
    ).rejects.toThrow(/falhou no meio/);
    // tudo ou nada: a fase alterada antes do throw não pode sobreviver nem no cache nem no disco
    expect((await store.getReview("rev-1"))?.phase).toBe("reviewing");
    const onDisk = JSON.parse(await readFile(join(dir, "reviews.json"), "utf8")) as { reviews: Review[] };
    expect(onDisk.reviews[0]?.phase).toBe("reviewing");
  });

  it("o que a leitura devolve é cópia: mexer nele não altera o store", async () => {
    const store = await load();
    await store.insertReview(review());
    const read = await store.getReview("rev-1");
    read!.phase = "merged";
    expect((await store.getReview("rev-1"))?.phase).toBe("reviewing");
    expect((await store.activeReviewFor("card-autor"))?.id).toBe("rev-1");
  });

  it("arquivo sem a lista (documento antigo ou vazio) hidrata como store vazio", async () => {
    await writeFile(join(dir, "reviews.json"), "{}");
    const store = await load();
    expect(await store.activeReviewFor("card-autor")).toBeUndefined();
    await store.insertReview(review());
    expect((await store.getReview("rev-1"))?.id).toBe("rev-1");
  });
});
