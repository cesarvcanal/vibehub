import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliverOpts, DeliverResult } from "../maestro/deliver.js";
import type { ReviewMergeOutcome } from "./merge.js";
import type { ReviewPhase } from "./model.js";

/**
 * O `vibehub_deliver` de um card com revisão de PR ativa (deliverCard). O board e o store das revisões
 * são REAIS (diretório temporário); o que vai ao runner é mock na fronteira: `deliver` (git/gh) e
 * `mergeReviewedPr` (o merge do botão do painel, que tem os próprios testes na rota).
 */

let dir = "";
const PR = "https://github.com/acme/widgets/pull/7";
const pushedResult: DeliverResult = { prUrl: PR, merged: false, reason: "pushed", branch: "dev", cardBranch: "card/x" };
let deliverAnswer: DeliverResult = pushedResult;
const deliver = vi.fn(async (_cardId: string, _opts: DeliverOpts = {}): Promise<DeliverResult> => deliverAnswer);
let mergeAnswer: ReviewMergeOutcome | null = null;
const mergeReviewedPr = vi.fn(async (_reviewId: string, _userId: string): Promise<ReviewMergeOutcome> => mergeAnswer!);

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("../maestro/deliver.js", async () => ({
    ...(await vi.importActual<typeof import("../maestro/deliver.js")>("../maestro/deliver.js")),
    deliver,
  }));
  vi.doMock("./merge.js", () => ({ mergeReviewedPr }));
  vi.doMock("../../auth/users.js", async () => ({
    ...(await vi.importActual<typeof import("../../auth/users.js")>("../../auth/users.js")),
    findUser: async (id: string) => (id === "u-m" ? { id, username: "mussa", role: "member", createdAt: "" } : null),
  }));
  const registry = await import("../board/registry.js");
  registry.resetForTesting();
  const store = await import("./store.js");
  const { deliverCard } = await import("./deliverCard.js");
  return { registry, store, deliverCard };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-deliver-card-"));
  deliver.mockClear();
  mergeReviewedPr.mockClear();
  deliverAnswer = pushedResult;
  mergeAnswer = null;
});
afterEach(async () => {
  for (const m of ["../maestro/deliver.js", "./merge.js", "../../auth/users.js"]) vi.doUnmock(m);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** Um card com o PR #7 em revisão na `phase`, o responsável pelo merge `u-m`, e quem deu a última ordem `actor`. */
async function cardUnderReview(phase: ReviewPhase, actor: string) {
  const o = await load();
  const project = await o.registry.createProject({ name: "widgets" });
  const card = await o.registry.createCard({ projectId: project.id, title: "Login" });
  await o.registry.stampCardActor(card.id, actor);
  const now = Date.now();
  await o.store.insertReview({
    id: "rev-1", cardId: card.id, projectId: project.id, prNumber: 7, prUrl: PR, prBranch: "card/x", base: "dev",
    reviewerUserId: "u-r", authorUserId: "u-a", mergerUserId: "u-m", reviewerCardId: "card-r",
    round: 2, lastSubmitRound: 2, phase, findings: [], log: [], nudges: 0, createdAt: now, updatedAt: now,
  });
  return { ...o, card };
}

describe("deliverCard — o vibehub_deliver com revisão de PR ativa", () => {
  it("caso real: ordem do responsável pelo merge com a revisão pronta — push, e o merge pelo caminho do botão", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    mergeAnswer = {
      kind: "merged", review: { phase: "merged" } as never,
      result: { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x", headBranch: "deleted" },
    };
    const out = await deliverCard(card.id, { branch: "dev", authorized: true, by: "mussa" });
    expect(deliver).toHaveBeenCalledWith(card.id, { branch: "dev", by: "mussa", pushOnly: true });
    expect(mergeReviewedPr).toHaveBeenCalledWith("rev-1", "u-m");
    expect(out).toMatchObject({ merged: true, reason: "merged", prUrl: PR, headBranch: "deleted" });
  });

  it("ordem de quem NÃO é o responsável: o push sai, o merge é recusado dizendo quem pode e onde", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-a");
    const out = await deliverCard(card.id, { branch: "dev", authorized: true });
    expect(deliver).toHaveBeenCalledWith(card.id, expect.objectContaining({ pushOnly: true }));
    expect(mergeReviewedPr).not.toHaveBeenCalled();
    expect(out).toMatchObject({ merged: false, reason: "review_active", prUrl: PR });
    expect(out.output).toMatch(/mussa/);
    expect(out.output).toMatch(/Mergear na dev/);
    expect(out.output).toMatch(/O push foi feito/);
  });

  it("responsável, mas revisão com bloqueante, dúvida pendente ou impasse: push sim, merge não, com o estágio", async () => {
    for (const [phase, words] of [["fixing", /corrigindo/], ["reviewing", /decidir as dúvidas/], ["impasse", /impasse/]] as const) {
      const { deliverCard, card } = await cardUnderReview(phase, "u-m");
      deliver.mockClear();
      const out = await deliverCard(card.id, { branch: "dev", authorized: true });
      expect(out).toMatchObject({ merged: false, reason: "review_active" });
      expect(out.output).toMatch(words);
      expect(mergeReviewedPr).not.toHaveBeenCalled();
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "vibehub-deliver-card-"));
    }
  });

  it("o push trouxe commit que o revisor não viu: volta head_moved, com a revisão de volta ao revisor", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    mergeAnswer = { kind: "refused", status: 409, reason: "head_moved", error: "o PR andou", review: { phase: "reviewing", round: 3 } as never };
    const out = await deliverCard(card.id, { branch: "dev", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "head_moved" });
    expect(out.output).toMatch(/rodada 3/);
  });

  it("CI vermelho volta gate com o que falhou; outra recusa do merge volta review_active com o motivo", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    mergeAnswer = { kind: "refused", status: 409, reason: "gate", error: "back: failing" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true })).toMatchObject({ reason: "gate", output: "back: failing" });
    mergeAnswer = { kind: "refused", status: 400, reason: "merger_sem_github", error: "merger_sem_github: sem conexão" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true })).toMatchObject({
      reason: "review_active", output: "merger_sem_github: sem conexão",
    });
  });

  it("push que falha volta como veio, sem tentar merge", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    deliverAnswer = { merged: false, reason: "push_failed", branch: "dev", cardBranch: "card/x", output: "rejected" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true })).toMatchObject({ reason: "push_failed" });
    expect(mergeReviewedPr).not.toHaveBeenCalled();
  });

  it("sem revisão ativa, ou sem autorização, é o deliver de sempre, com as opções como vieram", async () => {
    const o = await load();
    const project = await o.registry.createProject({ name: "widgets" });
    const card = await o.registry.createCard({ projectId: project.id, title: "Login" });
    deliverAnswer = { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x" };
    await o.deliverCard(card.id, { branch: "dev", authorized: true, by: "x" });
    expect(deliver).toHaveBeenLastCalledWith(card.id, { branch: "dev", authorized: true, by: "x" });

    const { deliverCard, card: reviewed } = await cardUnderReview("ready", "u-m");
    deliver.mockClear();
    await deliverCard(reviewed.id, { branch: "dev" });
    expect(deliver).toHaveBeenCalledWith(reviewed.id, { branch: "dev" });
    expect(mergeReviewedPr).not.toHaveBeenCalled();
  });
});
