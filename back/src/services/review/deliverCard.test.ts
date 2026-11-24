import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliverOpts, DeliverResult } from "../maestro/deliver.js";
import type { ReviewMergeOutcome } from "./merge.js";
import type { ReviewPhase } from "./model.js";

/**
 * The `vibehub_deliver` of a card with an active PR review (deliverCard). The board and the reviews store
 * are REAL (temporary directory); what goes to the runner is mocked at the boundary: `deliver` (git/gh) and
 * `mergeReviewedPr` (the merge of the panel's button, which has its own tests in the route).
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

/** A card with PR #7 under review in `phase`, the merge owner `u-m`, and whoever gave the latest order `actor`. */
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

/** The REVIEWER's card of PR #7 (`reviewOf` = the author's card), with the review in `phase` and the latest order given by `actor`. */
async function reviewerCardOf(phase: ReviewPhase, actor: string) {
  const o = await cardUnderReview(phase, "u-a");
  await o.registry.createAccount({ name: "Mussa" });
  const reviewer = await o.registry.createReviewerCard({
    authorCard: o.card, reviewerAccountSlug: "mussa", prBranch: "card/x", title: "Revisão: Login",
  });
  await o.registry.stampCardActor(reviewer.id, actor);
  await o.store.mutateReview("rev-1", (r) => { r.reviewerCardId = reviewer.id; });
  return { ...o, reviewer };
}

describe("deliverCard — card de análise de PR", () => {
  async function analysisCard() {
    const o = await load();
    const project = await o.registry.createProject({ name: "widgets" });
    const analysis = await o.registry.createAnalysisCard({ projectId: project.id, accountSlug: undefined, prBranch: "feat-7", title: "Análise PR #7" });
    return { ...o, analysis };
  }

  it("ordem de merge vinda de outro card não mergeia: o deliver vai sem authorized e a resposta diz por quê", async () => {
    const { deliverCard, analysis } = await analysisCard();
    deliverAnswer = { prUrl: PR, merged: false, reason: "unauthorized", branch: "dev", cardBranch: "feat-7", output: "falta authorized" };
    const out = await deliverCard(analysis.id, { branch: "dev", authorized: true, by: "card", from: "outro-card" });
    expect(deliver).toHaveBeenCalledWith(analysis.id, expect.objectContaining({ authorized: false }));
    expect(out).toMatchObject({ merged: false, reason: "unauthorized" });
    expect(out.output).toContain("from");
  });

  it("ordem dada no chat do próprio card de análise (from = o card) vai ao deliver com authorized", async () => {
    const { deliverCard, analysis } = await analysisCard();
    deliverAnswer = { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "feat-7" };
    const out = await deliverCard(analysis.id, { branch: "dev", authorized: true, by: "card", from: analysis.id });
    expect(deliver).toHaveBeenCalledWith(analysis.id, expect.objectContaining({ authorized: true }));
    expect(out).toMatchObject({ merged: true });
  });

  it("merge do próprio card de análise barrado pelo gate fica gravado no commit analisado, para o painel avisar antes do clique", async () => {
    const { deliverCard, analysis } = await analysisCard();
    const analysisStore = await import("./analysisStore.js");
    const analysedSha = "e".repeat(40);
    await analysisStore.saveAnalysis({
      cardId: analysis.id, prUrl: PR, prNumber: 7, analysedSha, stage: "done", summary: "s",
      dimensions: [], findings: [], refutedCount: 0, updatedAt: 1,
    }, () => undefined);
    deliverAnswer = { prUrl: PR, merged: false, reason: "gate", branch: "dev", cardBranch: "feat-7", output: "npm test estourou 585 s" };
    await deliverCard(analysis.id, { branch: "dev", authorized: true, by: "mussa", from: analysis.id });
    expect(await analysisStore.getAnalysisMergeRefusal(analysis.id)).toMatchObject({
      analysedSha, reason: "gate", output: "npm test estourou 585 s", by: "mussa",
    });
  });

  it("com um merge da análise já rodando, a ordem do próprio card não dispara outro deliver", async () => {
    const { deliverCard, analysis } = await analysisCard();
    const firstDeliver = Promise.withResolvers<void>();
    deliver.mockImplementationOnce(async () => {
      await firstDeliver.promise;
      return deliverAnswer;
    });
    const first = deliverCard(analysis.id, { branch: "dev", authorized: true, by: "mussa", from: analysis.id });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const second = await deliverCard(analysis.id, { branch: "dev", authorized: true, by: "mussa", from: analysis.id });
    firstDeliver.resolve();
    await first;
    expect(second).toMatchObject({ merged: false, reason: "merge_failed" });
    expect(second.output).toContain("merge já em andamento");
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("deliverCard — o vibehub_deliver com revisão de PR ativa", () => {
  it("caso real: ordem do responsável pelo merge com a revisão pronta — push, e o merge pelo caminho do botão", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    mergeAnswer = {
      kind: "merged", review: { phase: "merged" } as never,
      result: { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x", headBranch: "deleted" },
    };
    const out = await deliverCard(card.id, { branch: "dev", authorized: true, by: "mussa", from: card.id });
    expect(deliver).toHaveBeenCalledWith(card.id, { branch: "dev", by: "mussa", pushOnly: true });
    expect(mergeReviewedPr).toHaveBeenCalledWith("rev-1", "u-m");
    expect(out).toMatchObject({ merged: true, reason: "merged", prUrl: PR, headBranch: "deleted" });
  });

  it("a documentação do PR vai junto no push da correção (comentários do autor no diff)", async () => {
    const { deliverCard, card } = await cardUnderReview("fixing", "u-a");
    const docs = { comments: [{ path: "a.ts", line: 3, body: "explica o bloco" }] };
    await deliverCard(card.id, { branch: "dev", authorized: true, by: "mussa", from: card.id, docs });
    expect(deliver).toHaveBeenCalledWith(card.id, expect.objectContaining({ pushOnly: true, docs }));
  });

  it("a IA de OUTRO card entregando este (from diferente, ou sem from): push sim, merge não — mesmo com o responsável como ator", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    for (const from of ["outro-card", undefined]) {
      deliver.mockClear();
      const out = await deliverCard(card.id, { branch: "dev", authorized: true, ...(from ? { from } : {}) });
      expect(deliver).toHaveBeenCalledWith(card.id, expect.objectContaining({ pushOnly: true }));
      expect(out).toMatchObject({ merged: false, reason: "review_active" });
      expect(out.output).toMatch(/próprio card/);
    }
    expect(mergeReviewedPr).not.toHaveBeenCalled();
  });

  it("a revisão ficou pronta durante o push: vale o estado relido depois dele", async () => {
    const { deliverCard, store, card } = await cardUnderReview("reviewing", "u-m");
    deliver.mockImplementationOnce(async () => {
      await store.mutateReview("rev-1", (r) => { r.phase = "ready"; });
      return pushedResult;
    });
    mergeAnswer = {
      kind: "merged", review: { phase: "merged" } as never,
      result: { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x" },
    };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id })).toMatchObject({ merged: true });
    expect(mergeReviewedPr).toHaveBeenCalledTimes(1);
  });

  it("a revisão fechou durante o push (cancelada): segue o deliver de sempre, sem a regra da revisão", async () => {
    const { deliverCard, store, card } = await cardUnderReview("ready", "u-a");
    deliver.mockImplementationOnce(async () => {
      await store.mutateReview("rev-1", (r) => { r.phase = "cancelled"; });
      return pushedResult;
    });
    deliverAnswer = { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id })).toMatchObject({ merged: true, reason: "merged" });
    expect(deliver).toHaveBeenLastCalledWith(card.id, { branch: "dev", authorized: true, from: card.id });
    expect(mergeReviewedPr).not.toHaveBeenCalled();
  });

  it("ordem de outro papel da revisão (revisor, autor) no próprio card: o merge sai na conta de QUEM mandou", async () => {
    for (const actor of ["u-r", "u-a"]) {
      mergeReviewedPr.mockClear();
      const { deliverCard, card } = await cardUnderReview("ready", actor);
      mergeAnswer = {
        kind: "merged", review: { phase: "merged" } as never,
        result: { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x" },
      };
      const out = await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id });
      expect(mergeReviewedPr).toHaveBeenCalledWith("rev-1", actor);
      expect(out).toMatchObject({ merged: true });
      // each role in a clean world (the afterEach deletes the last one)
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "vibehub-deliver-card-"));
    }
  });

  it("ordem de quem NÃO tem papel na revisão: o push sai, o merge é recusado dizendo quem pode e onde", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-x");
    const out = await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id });
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
      const out = await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id });
      expect(out).toMatchObject({ merged: false, reason: "review_active" });
      expect(out.output).toMatch(words);
      expect(mergeReviewedPr).not.toHaveBeenCalled();
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "vibehub-deliver-card-"));
    }
  });

  it("caso real (PR #301): a ordem de mergear e concluir chega com a revisão ainda correndo — fica gravada nela", async () => {
    const { deliverCard, store, card } = await cardUnderReview("fixing", "u-m");
    const out = await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id, concludeWhenMerged: true });
    expect(out).toMatchObject({ merged: false, reason: "review_active" });
    expect(out.output).toMatch(/merge autorizado/);
    expect(out.output).toMatch(/Approve/);
    expect(out.output).toMatch(/este card vai para Concluído/);
    const review = await store.getReview("rev-1");
    expect(review).toMatchObject({ mergeAuthorized: true, concludeCardIds: [card.id] });
    expect(review?.log.at(-1)?.text).toMatch(/Concluído/);
    expect(mergeReviewedPr).not.toHaveBeenCalled();
  });

  it("revisão pronta: a ordem de concluir é gravada ANTES do merge, que é quem move o card", async () => {
    const { deliverCard, store, card } = await cardUnderReview("ready", "u-m");
    mergeReviewedPr.mockImplementationOnce(async () => {
      expect(await store.getReview("rev-1")).toMatchObject({ concludeCardIds: [card.id] });
      return { kind: "merged", review: { phase: "merged" } as never, result: { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x" } };
    });
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id, concludeWhenMerged: true })).toMatchObject({ merged: true });
  });

  it("ordem de outro papel (autor): nada é gravado — mergear no fim e concluir são ordens de quem mergeia, como no início", async () => {
    const { deliverCard, store, card } = await cardUnderReview("fixing", "u-a");
    const out = await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id, concludeWhenMerged: true });
    const review = await store.getReview("rev-1");
    expect(review?.concludeCardIds).toBeUndefined();
    expect(review?.mergeAuthorized).toBeUndefined();
    expect(out.output).toMatch(/concluir o card NÃO foi registrada/);
  });

  it("sem papel na revisão, ou outro card entregando: nenhuma ordem é gravada, e a resposta diz que a de concluir não ficou", async () => {
    const { deliverCard, store, card, registry } = await cardUnderReview("fixing", "u-x");
    expect((await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id, concludeWhenMerged: true })).output)
      .toMatch(/concluir o card NÃO foi registrada/);
    await registry.stampCardActor(card.id, "u-m");
    expect((await deliverCard(card.id, { branch: "dev", authorized: true, from: "outro-card", concludeWhenMerged: true })).output)
      .toMatch(/concluir o card NÃO foi registrada/);
    const review = await store.getReview("rev-1");
    expect(review?.concludeCardIds).toBeUndefined();
    expect(review?.mergeAuthorized).toBeUndefined();
    expect(review?.log).toEqual([]);
  });

  it("concludeWhenMerged sem authorized: o deliver de sempre, avisando que a ordem de concluir não ficou", async () => {
    const o = await load();
    const project = await o.registry.createProject({ name: "widgets" });
    const card = await o.registry.createCard({ projectId: project.id, title: "Login" });
    deliverAnswer = { prUrl: PR, merged: false, reason: "unauthorized", branch: "dev", cardBranch: "card/x" };
    const out = await o.deliverCard(card.id, { branch: "dev", from: card.id, concludeWhenMerged: true });
    expect(out).toMatchObject({ merged: false, reason: "unauthorized" });
    expect(out.output).toMatch(/concluir o card NÃO foi registrada/);
    expect(out.output).toMatch(/vibehub_move_cards/);
  });

  it("repetir a ordem não regrava a revisão nem duplica o registro, e a resposta diz que já estava", async () => {
    const { deliverCard, store, card } = await cardUnderReview("fixing", "u-m");
    await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id, concludeWhenMerged: true });
    const first = await store.getReview("rev-1");
    const again = await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id, concludeWhenMerged: true });
    const second = await store.getReview("rev-1");
    expect(second?.log).toHaveLength(2);
    expect(second?.updatedAt).toBe(first?.updatedAt);
    expect(again.output).toMatch(/já estava registrad/);
    expect(again.output).not.toMatch(/merge autorizado:/);
  });

  it("push sem nada novo a gravar (responsável já autorizou, sem concluir): a revisão não é regravada", async () => {
    const { deliverCard, store, card } = await cardUnderReview("fixing", "u-m");
    await store.mutateReview("rev-1", (r) => { r.mergeAuthorized = true; });
    const before = (await store.getReview("rev-1"))?.updatedAt;
    await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id });
    expect((await store.getReview("rev-1"))?.updatedAt).toBe(before);
  });

  it("o push trouxe commit que o revisor não viu: volta head_moved, com a revisão de volta ao revisor", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    mergeAnswer = { kind: "refused", status: 409, reason: "head_moved", error: "o PR andou", review: { phase: "reviewing", round: 3 } as never };
    const out = await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id });
    expect(out).toMatchObject({ merged: false, reason: "head_moved" });
    expect(out.output).toMatch(/rodada 3/);
  });

  it("revisão barrada por PR sem CI: o deliver do card volta no_ci, não gate", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    mergeAnswer = { kind: "refused", status: 409, reason: "no_ci", error: "o PR não tem CI no GitHub" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id })).toMatchObject({ merged: false, reason: "no_ci" });
  });

  it("CI vermelho volta gate com o que falhou; outra recusa do merge volta review_active com o motivo", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    mergeAnswer = { kind: "refused", status: 409, reason: "gate", error: "back: failing" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id })).toMatchObject({ reason: "gate", output: expect.stringContaining("back: failing") });
    mergeAnswer = { kind: "refused", status: 409, reason: "conflict", error: "o PR tem conflito com dev: o merge commit não sai limpo" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id })).toMatchObject({
      reason: "conflict", output: expect.stringContaining("o PR tem conflito com dev"),
    });
    // the real reason reaches the AI, not a generic "a revisão está ativa"
    mergeAnswer = { kind: "refused", status: 400, reason: "merger_sem_github", error: "merger_sem_github: sem conexão" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id })).toMatchObject({
      reason: "merge_failed", output: expect.stringContaining("merger_sem_github: sem conexão"),
    });
    mergeAnswer = {
      kind: "refused", status: 409, reason: "merge_failed", error: "conflito com a base",
      result: { prUrl: PR, merged: false, reason: "merge_failed", branch: "dev", cardBranch: "card/x", output: expect.stringContaining("conflito com a base") },
    };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id })).toMatchObject({
      reason: "merge_failed", output: expect.stringContaining("conflito com a base"),
    });
    mergeAnswer = { kind: "refused", status: 409, reason: "merging", error: "merge já em andamento" };
    expect(await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id })).toMatchObject({
      reason: "review_active", output: expect.stringContaining("merge já em andamento"),
    });
  });

  it("entregar pra outra base com a revisão ativa: recusa antes de qualquer script (não abre um PR solto sem revisão)", async () => {
    const { deliverCard, card } = await cardUnderReview("ready", "u-m");
    const out = await deliverCard(card.id, { branch: "prod", authorized: true });
    expect(deliver).not.toHaveBeenCalled();
    expect(out).toMatchObject({ merged: false, reason: "review_active", branch: "prod" });
    expect(out.output).toMatch(/PR #7 pra dev/);
  });

  it("sem branch, a entrega vai pra base da revisão (não pra base do projeto)", async () => {
    const { deliverCard, card } = await cardUnderReview("fixing", "u-a");
    await deliverCard(card.id, { authorized: true });
    expect(deliver).toHaveBeenCalledWith(card.id, expect.objectContaining({ branch: "dev", pushOnly: true }));
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

describe("deliverCard — merge feito pelo próprio card o conclui", () => {
  const mergedAnswer: DeliverResult = { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x" };

  async function plainCard() {
    const o = await load();
    const project = await o.registry.createProject({ name: "widgets" });
    const card = await o.registry.createCard({ projectId: project.id, title: "Docs" });
    return { ...o, card };
  }

  it("caso real (PRs #387 e #388): o card mergeia o próprio PR sem revisão e vai para Concluído", async () => {
    const { deliverCard, registry, card } = await plainCard();
    deliverAnswer = mergedAnswer;
    const out = await deliverCard(card.id, { branch: "main", authorized: true, by: "mussa", from: card.id });
    expect(out).toMatchObject({ merged: true, reason: "merged" });
    expect((await registry.getCard(card.id))?.column).toBe("done");
  });

  it("com concludeWhenMerged, o merge próprio conclui e a resposta não diz que a ordem ficou sem registro", async () => {
    const { deliverCard, registry, card } = await plainCard();
    deliverAnswer = mergedAnswer;
    const out = await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id, concludeWhenMerged: true });
    expect((await registry.getCard(card.id))?.column).toBe("done");
    expect(out.output ?? "").not.toMatch(/NÃO foi registrada/);
  });

  it.each([
    ["de outro card", "outro-card"],
    ["sem from", undefined],
  ])("merge mandado %s não conclui o card entregue", async (_case, from) => {
    const { deliverCard, registry, card } = await plainCard();
    deliverAnswer = mergedAnswer;
    await deliverCard(card.id, { branch: "dev", authorized: true, from });
    expect((await registry.getCard(card.id))?.column).not.toBe("done");
  });

  it("entrega que não mergeou (gate vermelho) deixa o card onde estava", async () => {
    const { deliverCard, registry, card } = await plainCard();
    deliverAnswer = { prUrl: PR, merged: false, reason: "gate", branch: "dev", cardBranch: "card/x", output: "back: failing" };
    await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id });
    expect((await registry.getCard(card.id))?.column).not.toBe("done");
  });

  it("revisão pronta mergeada pelo próprio card do autor também o conclui", async () => {
    const { deliverCard, registry, card } = await cardUnderReview("ready", "u-m");
    mergeAnswer = { kind: "merged", review: { phase: "merged" } as never, result: mergedAnswer };
    await deliverCard(card.id, { branch: "dev", authorized: true, from: card.id });
    expect((await registry.getCard(card.id))?.column).toBe("done");
  });
});

describe("deliverCard — o card do REVISOR mandado mergear", () => {
  const merged: ReviewMergeOutcome = {
    kind: "merged", review: { phase: "merged" } as never,
    result: { prUrl: PR, merged: true, reason: "merged", branch: "dev", cardBranch: "card/x", headBranch: "deleted" },
  };

  it("caso real (PR #215): quem tem papel manda o revisor mergear a revisão pronta — merge pelo caminho do botão, sem push", async () => {
    for (const actor of ["u-m", "u-r"]) {
      mergeReviewedPr.mockClear();
      deliver.mockClear();
      const { deliverCard, reviewer } = await reviewerCardOf("ready", actor);
      mergeAnswer = merged;
      const out = await deliverCard(reviewer.id, { authorized: true, from: reviewer.id });
      expect(deliver).not.toHaveBeenCalled();
      expect(mergeReviewedPr).toHaveBeenCalledWith("rev-1", actor);
      expect(out).toMatchObject({ merged: true, reason: "merged", prUrl: PR, branch: "dev", headBranch: "deleted" });
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "vibehub-deliver-card-"));
    }
  });

  it("revisão ainda não pronta: nada sai, e a resposta diz em que pé ela está", async () => {
    const { deliverCard, reviewer } = await reviewerCardOf("fixing", "u-m");
    const out = await deliverCard(reviewer.id, { authorized: true, from: reviewer.id });
    expect(deliver).not.toHaveBeenCalled();
    expect(mergeReviewedPr).not.toHaveBeenCalled();
    expect(out).toMatchObject({ merged: false, reason: "review_active" });
    expect(out.output).toMatch(/corrigindo/);
  });

  it("ordem de quem não tem papel, outro card entregando, ou sem authorized: o card do revisor segue sem push nem merge", async () => {
    const { deliverCard, registry, reviewer } = await reviewerCardOf("ready", "u-x");
    expect(await deliverCard(reviewer.id, { authorized: true, from: reviewer.id })).toMatchObject({ merged: false, reason: "review_active" });
    expect(mergeReviewedPr).not.toHaveBeenCalled();

    await registry.stampCardActor(reviewer.id, "u-m");
    expect(await deliverCard(reviewer.id, { authorized: true, from: "outro-card" })).toMatchObject({ merged: false, reason: "review_active" });
    expect(mergeReviewedPr).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    // without authorized it is the usual deliver, which refuses the reviewer's card (locked) before any script
    await deliverCard(reviewer.id, {});
    expect(deliver).toHaveBeenCalledWith(reviewer.id, {});
  });

  it("revisão ainda não pronta: a ordem do responsável no card do revisor fica gravada (merge autorizado e conclusão)", async () => {
    const { deliverCard, store, reviewer } = await reviewerCardOf("fixing", "u-m");
    const out = await deliverCard(reviewer.id, { authorized: true, from: reviewer.id, concludeWhenMerged: true });
    expect(out).toMatchObject({ merged: false, reason: "review_active" });
    expect(out.output).toMatch(/merge autorizado/);
    expect(await store.getReview("rev-1")).toMatchObject({ mergeAuthorized: true, concludeCardIds: [reviewer.id] });
    expect(mergeReviewedPr).not.toHaveBeenCalled();
  });

  it("entregar pra outra base pelo card do revisor: recusado, nada roda", async () => {
    const { deliverCard, reviewer } = await reviewerCardOf("ready", "u-m");
    const out = await deliverCard(reviewer.id, { branch: "prod", authorized: true, from: reviewer.id });
    expect(out).toMatchObject({ merged: false, reason: "review_active", branch: "prod" });
    expect(deliver).not.toHaveBeenCalled();
    expect(mergeReviewedPr).not.toHaveBeenCalled();
  });

  it("CI vermelho no merge do revisor volta gate com o que falhou", async () => {
    const { deliverCard, reviewer } = await reviewerCardOf("ready", "u-m");
    mergeAnswer = { kind: "refused", status: 409, reason: "gate", error: "back: failing" };
    expect(await deliverCard(reviewer.id, { authorized: true, from: reviewer.id })).toMatchObject({ merged: false, reason: "gate", output: expect.stringContaining("back: failing") });
  });
});
