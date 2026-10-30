import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SendOpts, SendResult } from "../maestro/maestro.js";
import type { PublicUser } from "../../auth/users.js";
import type { SubmittedFinding } from "./model.js";

/**
 * ORQUESTRADOR DA REVISÃO DE PR — o relay revisor <-> autor. O board, o store das revisões e o log de
 * eventos são REAIS (diretório temporário); o que sai para o runner é mock na fronteira do módulo:
 * `sendToTerminal` (digitar no card), `recordCardActor` (a identidade que pousa no runner),
 * `resumeCard` (recriar a sessão) e `deliver` (que nunca pode ser chamado: a IA não mergeia).
 *
 * O mock do envio chama o `beforeDeliver` antes de "entregar", como o de verdade: é o que prova a
 * ordem "ator primeiro, texto depois".
 */

let dir = "";
/** A ordem do que aconteceu na fronteira: `actor:<user>:<card>`, `resume:<card>`, `send:<card>`. */
const calls: string[] = [];
let sendFailure: Error | null = null;
/** Roda uma vez antes do próximo envio (a corrida "a revisão andou enquanto o texto saía"). */
let sendHook: (() => Promise<void>) | null = null;
/** O board real, para o mock recusar card pausado como o `sendToTerminal` de verdade (`wake` não despausa). */
let boardRef: { getCard: (id: string) => Promise<{ title: string; column: string; pausedAt?: number | null } | undefined> } | null = null;
const send = vi.fn(async (cardId: string, _text: string, opts: SendOpts = {}): Promise<SendResult> => {
  const hook = sendHook;
  sendHook = null;
  if (hook) await hook();
  if (sendFailure) throw sendFailure;
  const card = await boardRef?.getCard(cardId);
  if (opts.wake && card && (card.pausedAt || card.column === "paused")) {
    throw new Error(`paused: card "${card.title}" was paused on purpose and is not woken by a message`);
  }
  await opts.beforeDeliver?.();
  calls.push(`send:${cardId}`);
  return { sent: true, cardId, title: "", project: "" };
});
const actor = vi.fn(async (user: PublicUser | null, cardId: string): Promise<void> => {
  calls.push(`actor:${user?.id ?? "null"}:${cardId}`);
});
let reopen: ((cardId: string) => Promise<unknown>) | null = null;
const resume = vi.fn(async (cardId: string) => {
  calls.push(`resume:${cardId}`);
  return await reopen?.(cardId);
});
const deliverSpy = vi.fn(async () => ({ merged: true }));

const USERS: Record<string, PublicUser> = {
  "u-autor": { id: "u-autor", username: "autor", role: "member", createdAt: "" },
  "u-revisor": { id: "u-revisor", username: "revisor", role: "member", createdAt: "" },
  "u-merger": { id: "u-merger", username: "merger", role: "owner", createdAt: "" },
};
let accountOf: Record<string, string | undefined> = {};

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("../maestro/maestro.js", async () => ({
    ...(await vi.importActual<typeof import("../maestro/maestro.js")>("../maestro/maestro.js")),
    sendToTerminal: send,
  }));
  vi.doMock("../board/actor.js", async () => ({
    ...(await vi.importActual<typeof import("../board/actor.js")>("../board/actor.js")),
    recordCardActor: actor,
  }));
  vi.doMock("../board/workspace.js", async () => ({
    ...(await vi.importActual<typeof import("../board/workspace.js")>("../board/workspace.js")),
    resumeCard: resume,
  }));
  vi.doMock("../maestro/deliver.js", async () => ({
    ...(await vi.importActual<typeof import("../maestro/deliver.js")>("../maestro/deliver.js")),
    deliver: deliverSpy,
  }));
  vi.doMock("../../auth/users.js", async () => ({
    ...(await vi.importActual<typeof import("../../auth/users.js")>("../../auth/users.js")),
    findUser: async (id: string) => USERS[id] ?? null,
  }));
  vi.doMock("../../auth/userGit.js", async () => ({
    ...(await vi.importActual<typeof import("../../auth/userGit.js")>("../../auth/userGit.js")),
    creatorAccountSlug: async (id: string | undefined) => (id ? accountOf[id] : undefined),
  }));
  const registry = await import("../board/registry.js");
  registry.resetForTesting();
  reopen = (cardId) => registry.applyOpenTerminal(cardId);
  boardRef = registry;
  const events = await import("../events/cardEvents.js");
  const store = await import("./store.js");
  const orch = await import("./orchestrator.js");
  const maestro = await import("../maestro/maestro.js");
  return { registry, events, store, orch, maestro };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const PR = { number: 7, url: "https://github.com/acme/widgets/pull/7", base: "dev", branch: "card/login-ab12" };
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);
const BLOCKER: SubmittedFinding = {
  severity: "blocking",
  title: "token vaza no log",
  file: "src/auth.ts",
  line: 42,
  proof: { kind: "failing_test", ref: "src/auth.test.ts:12" },
  fix: "tirar o token do logger.info",
};
const SUGGESTION: SubmittedFinding = { severity: "suggestion", title: "nome de variável confuso" };
const QUESTION: SubmittedFinding = { severity: "question", title: "a sessão expira no meio do checkout?" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-review-orch-"));
  calls.length = 0;
  sendFailure = null;
  sendHook = null;
  accountOf = { "u-revisor": "mussa" };
  send.mockClear();
  actor.mockClear();
  resume.mockClear();
  deliverSpy.mockClear();
});
afterEach(async () => {
  for (const m of [
    "../maestro/maestro.js", "../board/actor.js", "../board/workspace.js", "../maestro/deliver.js",
    "../../auth/users.js", "../../auth/userGit.js",
  ]) vi.doUnmock(m);
  await rm(dir, { recursive: true, force: true });
});

async function seed(o: Loaded) {
  const project = await o.registry.createProject({
    name: "widgets", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", baseBranch: "main",
  });
  await o.registry.createAccount({ name: "Mussa" });
  const author = await o.registry.createCard({ projectId: project.id, title: "Login" });
  await o.registry.recordCardPr(author.id, PR);
  return { project, author: (await o.registry.getCard(author.id))! };
}

/** Uma revisão iniciada, com o envio da rodada 1 já fora dos contadores. */
async function started(o: Loaded) {
  const { author } = await seed(o);
  const review = await o.orch.startReview({
    cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
  });
  send.mockClear();
  calls.length = 0;
  return { author, review };
}

const lastText = (): string => String(send.mock.calls.at(-1)?.[1] ?? "");
const lastOpts = (): SendOpts => (send.mock.calls.at(-1)?.[2] ?? {}) as SendOpts;

async function messagesOn(o: Loaded, cardId: string) {
  return (await o.events.eventsAfter(0)).events.filter((e) => e.kind === "message" && e.cardId === cardId);
}

describe("iniciar a revisão", () => {
  it("iniciar cria o card do revisor e manda a rodada 1 pra ele", async () => {
    const o = await load();
    const { author } = await seed(o);
    const review = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });

    expect(review).toMatchObject({
      cardId: author.id, projectId: author.projectId, prNumber: 7, prUrl: PR.url, prBranch: PR.branch, base: "dev",
      reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger",
      round: 1, phase: "reviewing", findings: [], nudges: 0,
    });
    // o card do revisor: na conta do revisor, nascido da branch do PR, ligado ao autor
    const reviewer = await o.registry.getCard(review.reviewerCardId);
    expect(reviewer).toMatchObject({ reviewOf: author.id, accountSlug: "mussa", base: PR.branch, projectId: author.projectId });
    expect(await o.store.getReview(review.id)).toMatchObject({ reviewerCardId: reviewer!.id });

    // a rodada 1 vai pro card do revisor, com o revisor como ator antes do texto
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(reviewer!.id);
    expect(calls).toEqual([`actor:u-revisor:${reviewer!.id}`, `send:${reviewer!.id}`]);
    const text = lastText();
    for (const piece of [
      "/code-review high", "PR #7", PR.url, review.id, "rodada 1 de 3", `reset --hard origin/${PR.branch}`,
      "git rev-parse HEAD", "--request-changes", "--comment", "vibehub_review_submit", `card: "${reviewer!.id}"`,
      "NUNCA", "teste que falha", "question",
    ]) expect(text).toContain(piece);
    expect(lastOpts()).toMatchObject({
      wake: true, requireAgent: true, readyWaitMs: o.maestro.SEND_READY_WAIT_MS,
      origin: { kind: "system", name: "revisão de PR" },
    });
    expect(review.log.length).toBeGreaterThan(0);
  });

  it("revisor member sem work no card do revisor ganha um share work nele antes da rodada 1; owner não", async () => {
    const o = await load();
    const { author } = await seed(o);
    const review = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    // o share existe antes do envio: o recordCardActor do relay precisa de work para pousar
    expect(await o.registry.sharesForTarget("card", review.reviewerCardId)).toEqual([
      expect.objectContaining({ kind: "card", targetId: review.reviewerCardId, userId: "u-revisor", level: "work" }),
    ]);
    // e nada além do card do revisor: o card do autor não ganhou share nenhum
    expect(await o.registry.sharesForTarget("card", author.id)).toEqual([]);

    // um owner já tem work em tudo: nenhum share é escrito
    accountOf = { "u-merger": "mussa" };
    const other = await o.registry.createCard({ projectId: author.projectId, title: "Outro" });
    await o.registry.recordCardPr(other.id, { ...PR, number: 8, url: "https://github.com/acme/widgets/pull/8" });
    const byOwner = await o.orch.startReview({
      cardId: other.id, prNumber: 8, reviewerUserId: "u-merger", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    expect(await o.registry.sharesForTarget("card", byOwner.reviewerCardId)).toEqual([]);
  });

  it("PR mergeado não pode ser revisado", async () => {
    const o = await load();
    const { author } = await seed(o);
    const base = { cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor" };
    await o.registry.markCardPrMerged(author.id, PR.base, 7, Date.now());

    await expect(o.orch.startReview(base)).rejects.toThrow(/pr_mergeado/);
    // recusado antes de criar o card do revisor, de escrever a revisão e de falar com qualquer IA
    expect((await o.registry.listAllCards()).filter((c) => c.reviewOf)).toEqual([]);
    expect(await o.store.activeReviewFor(author.id)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();

    // um PR novo no mesmo slot da base é outro PR: a marca de mergeado era do velho
    await o.registry.recordCardPr(author.id, { ...PR, number: 8, url: "https://github.com/acme/widgets/pull/8" });
    await expect(o.orch.startReview({ ...base, prNumber: 8 })).resolves.toMatchObject({ prNumber: 8 });
  });

  it("iniciar recusa revisor igual ao autor, card sem o PR, revisão já ativa e revisor sem conta", async () => {
    const o = await load();
    const { author } = await seed(o);
    const base = { cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor" };
    await expect(o.orch.startReview({ ...base, reviewerUserId: "u-autor" })).rejects.toThrow(/revisor_igual_autor/);
    await expect(o.orch.startReview({ ...base, prNumber: 99 })).rejects.toThrow(/sem_pr/);
    accountOf = {};
    await expect(o.orch.startReview(base)).rejects.toThrow(/revisor_sem_conta/);
    // nada disso deixou card de revisor nem revisão pra trás
    expect((await o.registry.listAllCards()).filter((c) => c.reviewOf)).toEqual([]);
    expect(await o.store.activeReviewFor(author.id)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();

    accountOf = { "u-revisor": "mussa" };
    await o.orch.startReview(base);
    await expect(o.orch.startReview(base)).rejects.toThrow(/revisao_ativa/);
    // dois cliques ao mesmo tempo: só um passa
    const other = await o.registry.createCard({ projectId: author.projectId, title: "Outro" });
    await o.registry.recordCardPr(other.id, { ...PR, number: 8, url: "https://github.com/acme/widgets/pull/8" });
    const twice = await Promise.allSettled([
      o.orch.startReview({ ...base, cardId: other.id, prNumber: 8 }),
      o.orch.startReview({ ...base, cardId: other.id, prNumber: 8 }),
    ]);
    expect(twice.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String((twice.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/revisao_ativa/);
    expect((await o.registry.listAllCards()).filter((c) => c.reviewOf === other.id)).toHaveLength(1);
  });
});

describe("rodada do revisor", () => {
  it("submit com bloqueante manda a lista ao autor, com o autor como ator", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "Um bloqueante: o token vaza no log.",
    });

    expect(after).toMatchObject({ phase: "fixing", round: 1, reviewedSha: SHA1, lastSubmitRound: 1, nudges: 0 });
    expect(after.findings.map((f) => [f.id, f.severity, f.status])).toEqual([
      ["f1", "blocking", "open"],
      ["f2", "suggestion", "open"],
    ]);
    // ator do card do autor = o autor, ANTES do texto chegar
    expect(calls).toEqual([`actor:u-autor:${author.id}`, `send:${author.id}`]);
    const text = lastText();
    for (const piece of [
      "f1", "token vaza no log", "src/auth.ts:42", "src/auth.test.ts:12", "receiving-code-review", "gh pr comment",
      "vibehub_review_respond", `card: "${author.id}"`, review.id, "rodada 1 de 3", "NUNCA", PR.branch,
    ]) expect(text).toContain(piece);
    expect(lastOpts()).toMatchObject({ wake: true, requireAgent: true, origin: { kind: "system", name: "revisão de PR" } });
    // o push é git push na branch do PR; vibehub_deliver não é caminho nesta revisão
    expect(text).toContain(`git push origin HEAD:${PR.branch}`);
    expect(text.toLowerCase()).toContain("não use vibehub_deliver nesta revisão");
    expect(text).not.toMatch(/SEM authorized|vibehub_deliver com branch/);
    // a conversa das IAs ganhou a fala do revisor
    expect(after.log.some((e) => e.who === "reviewer" && e.text.includes("o token vaza no log"))).toBe(true);
  });

  it("submit repetido na mesma rodada não manda de novo", async () => {
    const o = await load();
    const { review } = await started(o);
    const payload = { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "um bloqueante" };
    const first = await o.orch.submitReviewerRound(review.reviewerCardId, payload);
    const again = await o.orch.submitReviewerRound(review.reviewerCardId, payload);
    expect(send).toHaveBeenCalledTimes(1);
    expect(again.findings).toHaveLength(1);
    expect(again.updatedAt).toBe(first.updatedAt);
    // rodada errada também não mexe em nada
    const wrong = await o.orch.submitReviewerRound(review.reviewerCardId, { ...payload, round: 2 });
    expect(wrong.findings).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("dois submits simultâneos da mesma rodada viram um relay só", async () => {
    const o = await load();
    const { review } = await started(o);
    const payload = { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "um bloqueante" };
    await Promise.all([
      o.orch.submitReviewerRound(review.reviewerCardId, payload),
      o.orch.submitReviewerRound(review.reviewerCardId, payload),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await o.store.getReview(review.id))?.findings).toHaveLength(1);
  });

  it("autor pausado é tirado de Paused e recebe a lista", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.registry.applyOpenTerminal(author.id);
    await o.registry.pauseCard(author.id, { effective: true });
    expect(await o.registry.getCard(author.id)).toMatchObject({ column: "paused" });

    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "x" });

    const card = await o.registry.getCard(author.id);
    expect(card?.column).toBe("waiting");
    expect(card?.pausedAt).toBeFalsy();
    expect(calls).toEqual([`resume:${author.id}`, `actor:u-autor:${author.id}`, `send:${author.id}`]);
    expect(lastText()).toContain("token vaza no log");
  });

  it("autor parado (nunca aberto) só recebe com wake: o envio acorda", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "x" });
    expect(resume).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![0]).toBe(author.id);
    expect(lastOpts().wake).toBe(true);
  });

  it("rodada 3 com bloqueante vira impasse e não manda nada", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "contested", reply: "o logger já redige o token (src/log.ts:5)" }], headSha: SHA2,
    });
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "open", reviewerReply: "o redator não cobre esse campo" }], headSha: SHA2, summary: "r2",
    });
    await o.orch.submitAuthorResponse(author.id, {
      round: 2, items: [{ id: "f1", status: "contested", reply: "cobre: src/log.test.ts:30 passa" }], headSha: SHA3,
    });
    send.mockClear();

    const after = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 3, findings: [], verdicts: [{ id: "f1", status: "open", reviewerReply: "o teste não exercita o campo" }], headSha: SHA3, summary: "r3",
    });
    expect(after).toMatchObject({ phase: "impasse", impasseReason: "rodadas", round: 3, reviewedSha: SHA3 });
    expect(send).not.toHaveBeenCalled();
    expect(after.log.some((e) => e.who === "system" && /impasse/i.test(e.text))).toBe(true);
    const notices = await messagesOn(o, author.id);
    expect(notices.map((e) => e.text)).toEqual([expect.stringMatching(/PR #7.*impasse/i)]);
  });

  it("ready manda o revisor aprovar no GitHub e nunca chama merge", async () => {
    const o = await load();
    const { review } = await started(o);
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "só uma sugestão",
    });
    expect(after.phase).toBe("ready");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    expect(calls).toEqual([`actor:u-revisor:${review.reviewerCardId}`, `send:${review.reviewerCardId}`]);
    const text = lastText();
    expect(text).toContain("gh pr review 7 --approve");
    expect(text).toMatch(/NÃO mergeie|NUNCA mergeie/);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("mudança pra ready grava aviso no card do autor", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
    expect(after.phase).toBe("ready");
    const notices = await messagesOn(o, author.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ messageType: "info", cardId: author.id, id: `message:${author.id}:review:${review.id}:ready:1:author` });
    expect(notices[0]!.text).toMatch(/PR #7/);
    expect(notices[0]!.text).toMatch(/pront/i);
    // o card do revisor recebe o mesmo aviso, com a chave dele
    const theirs = await messagesOn(o, review.reviewerCardId);
    expect(theirs.map((e) => e.id)).toEqual([`message:${review.reviewerCardId}:review:${review.id}:ready:1:reviewer`]);
    // anunciar de novo (replay) não duplica
    await o.orch.announcePhase(after);
    expect(await messagesOn(o, author.id)).toHaveLength(1);
    expect(await messagesOn(o, review.reviewerCardId)).toHaveLength(1);
  });

  it("veredito do revisor fora de fixed|open|dropped é recusado sem mexer na revisão", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "contested", reply: "prova" }], headSha: SHA2 });
    const before = await o.store.getReview(review.id);
    await expect(o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "accepted_risk" }], headSha: SHA2, summary: "r2",
    })).rejects.toThrow(/fixed.*open.*dropped/);
    expect(await o.store.getReview(review.id)).toEqual(before);
  });

  it("achado novo na rodada 2 sem introducedInRound é recusado (lista fechada) e nada muda", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", commit: "c1", reply: "ok" }], headSha: SHA2 });
    send.mockClear();
    const before = await o.store.getReview(review.id);
    await expect(o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [{ ...BLOCKER, title: "outro" }], verdicts: [{ id: "f1", status: "fixed" }], headSha: SHA2, summary: "r2",
    })).rejects.toThrow(/lista fechada/);
    expect(await o.store.getReview(review.id)).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  });

  it("sha inválido é recusado", async () => {
    const o = await load();
    const { review } = await started(o);
    await expect(o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: "abc123", summary: "x" }))
      .rejects.toThrow(/headSha/);
    expect((await o.store.getReview(review.id))?.lastSubmitRound).toBeUndefined();
  });
});

describe("resposta do autor", () => {
  it("resposta do autor abre a rodada 2 só com o diff", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    send.mockClear();
    calls.length = 0;

    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", commit: "c0ffee1", reply: "token removido, teste novo" }], headSha: SHA2,
    });
    expect(after).toMatchObject({ round: 2, phase: "reviewing", lastRespondRound: 1, nudges: 0, reviewedSha: SHA1 });
    expect(after.findings[0]).toMatchObject({ id: "f1", status: "fixed", commit: "c0ffee1", authorReply: "token removido, teste novo" });
    expect(calls).toEqual([`actor:u-revisor:${review.reviewerCardId}`, `send:${review.reviewerCardId}`]);
    const text = lastText();
    for (const piece of [
      `reset --hard origin/${PR.branch}`, SHA1, "rodada 2 de 3", "f1", "token removido", "c0ffee1",
      "introducedInRound", "verdicts", "vibehub_review_submit", `card: "${review.reviewerCardId}"`, "NUNCA",
    ]) expect(text).toContain(piece);
    expect(after.log.some((e) => e.who === "author" && /1 corrigido/.test(e.text))).toBe(true);

    // repetir a resposta é idempotente
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [], headSha: SHA2 });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await o.store.getReview(review.id))?.round).toBe(2);
  });

  it("resposta a sugestão ou a item fechado é ignorada com nota no log", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "r1" });
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1,
      items: [
        { id: "f1", status: "fixed", commit: "c1", reply: "feito" },
        { id: "f2", status: "fixed", commit: "c2", reply: "também" },
      ],
      headSha: SHA2,
    });
    expect(after.findings.find((f) => f.id === "f2")).toMatchObject({ status: "open" });
    expect(after.findings.find((f) => f.id === "f2")?.authorReply).toBeUndefined();
    expect(after.log.some((e) => e.text.includes("f2"))).toBe(true);
  });

  it("resposta a id desconhecido é ignorada com nota, sem derrubar o resto", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1,
      items: [{ id: "f1", status: "fixed", commit: "c1", reply: "feito" }, { id: "f99", status: "fixed", reply: "?" }],
      headSha: SHA2,
    });
    expect(after).toMatchObject({ round: 2, phase: "reviewing" });
    expect(after.findings).toHaveLength(1);
    expect(after.findings[0]).toMatchObject({ id: "f1", status: "fixed" });
    expect(after.log.some((e) => e.who === "system" && e.text.includes("f99"))).toBe(true);
  });

  it("só o card do revisor submete e só o card do autor responde", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await expect(o.orch.submitReviewerRound(author.id, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "x" }))
      .rejects.toThrow(/revisor/);
    expect((await o.store.getReview(review.id))?.lastSubmitRound).toBeUndefined();

    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "x" });
    await expect(o.orch.submitAuthorResponse(review.reviewerCardId, {
      round: 1, items: [{ id: "f1", status: "fixed", reply: "x" }], headSha: SHA2,
    })).rejects.toThrow(/autor/);
    expect((await o.store.getReview(review.id))?.phase).toBe("fixing");
  });
});

describe("decisão humana", () => {
  it("dúvida decidida pelo humano como block volta a ser bloqueante", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const waiting = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [QUESTION], headSha: SHA1, summary: "uma dúvida" });
    // só a dúvida: espera o humano, sem mandar nada a ninguém
    expect(waiting.phase).toBe("reviewing");
    expect(send).not.toHaveBeenCalled();

    const after = await o.orch.decideQuestion(review.id, "f1", "block", "u-revisor");
    expect(after.findings[0]).toMatchObject({ humanDecision: "block", status: "open" });
    expect(after.phase).toBe("fixing");
    expect(calls).toEqual([`actor:u-autor:${author.id}`, `send:${author.id}`]);
    expect(lastText()).toContain("a sessão expira no meio do checkout?");
    expect(after.log.some((e) => e.who === "human")).toBe(true);
  });

  it("submit que deixa dúvida pendente avisa o card do revisor, uma vez por rodada", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const payload = { round: 1, findings: [BLOCKER, QUESTION], headSha: SHA1, summary: "um bloqueante e uma dúvida" };
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, payload);
    // o bloqueante segue para o autor; a dúvida espera o revisor humano, que fica sabendo pelo card dele
    expect(after.phase).toBe("fixing");
    const notices = await messagesOn(o, review.reviewerCardId);
    expect(notices).toEqual([
      expect.objectContaining({
        id: `message:${review.reviewerCardId}:review:${review.id}:question:1:reviewer`,
        text: "PR #7: dúvida esperando sua decisão no painel",
        messageType: "info",
      }),
    ]);
    // o aviso é do revisor humano: o card do autor não recebe
    expect((await messagesOn(o, author.id)).some((e) => /dúvida/.test(e.text ?? ""))).toBe(false);
    // o submit repetido (retry da IA) não duplica
    await o.orch.submitReviewerRound(review.reviewerCardId, payload);
    expect(await messagesOn(o, review.reviewerCardId)).toHaveLength(1);
  });

  it("submit sem dúvida pendente não avisa o revisor", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "r1" });
    expect((await messagesOn(o, review.reviewerCardId)).some((e) => /dúvida/.test(e.text ?? ""))).toBe(false);
  });

  it("dúvida retirada pelo humano libera o ready; aceitar risco no impasse também", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [QUESTION], headSha: SHA1, summary: "uma dúvida" });
    const ready = await o.orch.decideQuestion(review.id, "f1", "drop", "u-revisor");
    expect(ready.phase).toBe("ready");
    expect(ready.findings[0]).toMatchObject({ humanDecision: "drop", status: "dropped" });
    expect(lastText()).toContain("--approve");
    await expect(o.orch.decideQuestion(review.id, "f1", "block", "u-revisor")).rejects.toThrow();
  });

  it("impasse: manter segura, aceitar o risco do último item libera o ready", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const two = [BLOCKER, { ...BLOCKER, title: "sql sem bind", line: 80 }];
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: two, headSha: SHA1, summary: "r1" });
    for (const round of [1, 2]) {
      await o.orch.submitAuthorResponse(author.id, {
        round, items: [{ id: "f1", status: "contested", reply: "prova" }, { id: "f2", status: "contested", reply: "prova" }], headSha: SHA2,
      });
      await o.orch.submitReviewerRound(review.reviewerCardId, {
        round: round + 1, findings: [], verdicts: [{ id: "f1", status: "open" }, { id: "f2", status: "open" }], headSha: SHA2, summary: "segue",
      });
    }
    expect((await o.store.getReview(review.id))?.phase).toBe("impasse");
    send.mockClear();

    const kept = await o.orch.decideQuestion(review.id, "f1", "keep", "u-revisor");
    expect(kept.phase).toBe("impasse");
    const half = await o.orch.decideQuestion(review.id, "f2", "accept_risk", "u-revisor");
    expect(half.phase).toBe("impasse");
    expect(half.findings[1]).toMatchObject({ status: "accepted_risk", humanDecision: "accept_risk" });
    expect(send).not.toHaveBeenCalled();
    const done = await o.orch.decideQuestion(review.id, "f1", "accept_risk", "u-revisor");
    expect(done.phase).toBe("ready");
    expect(send).toHaveBeenCalledTimes(1);
    expect(lastText()).toContain("--approve");
  });

  it("decidir item em impasse por falha, com a rodada do revisor entregue, recalcula a fase", async () => {
    const o = await load();
    const { review } = await started(o);
    // a rodada 1 do revisor pousou, mas a lista não chega ao autor: impasse com a conferência da rodada feita
    sendFailure = new Error("no agent running");
    const stuck = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    expect(stuck).toMatchObject({ phase: "impasse", round: 1, lastSubmitRound: 1 });
    sendFailure = null;
    send.mockClear();

    const after = await o.orch.decideQuestion(review.id, "f1", "accept_risk", "u-revisor");
    expect(after.phase).toBe("ready");
    expect(after.impasseReason).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(lastText()).toContain("--approve");
  });

  it("decidir em impasse sem a conferência da rodada não vai pra ready", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const two = [BLOCKER, { ...BLOCKER, title: "sql sem bind", line: 80 }];
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: two, headSha: SHA1, summary: "r1" });
    // o autor diz que corrigiu f1 e contesta f2; o delta não chega ao revisor: ninguém conferiu o "corrigido"
    sendFailure = new Error("no agent running");
    const stuck = await o.orch.submitAuthorResponse(author.id, {
      round: 1,
      items: [{ id: "f1", status: "fixed", commit: "c1", reply: "feito" }, { id: "f2", status: "contested", reply: "o bind é do ORM (src/db.ts:5)" }],
      headSha: SHA2,
    });
    expect(stuck).toMatchObject({ phase: "impasse", round: 2, lastSubmitRound: 1 });
    sendFailure = null;
    send.mockClear();

    // o humano libera o único item "travado": a decisão fica gravada, mas a fase não sai do impasse
    const decided = await o.orch.decideQuestion(review.id, "f2", "accept_risk", "u-revisor");
    expect(decided.phase).toBe("impasse");
    expect(decided.impasseReason).toBe("no agent running");
    expect(decided.findings[1]).toMatchObject({ status: "accepted_risk", humanDecision: "accept_risk" });
    expect(send).not.toHaveBeenCalled();

    // a saída é "tentar de novo": a vez volta ao revisor, que confere o f1 no diff
    const retried = await o.orch.retryReview(review.id, "u-revisor");
    expect(retried).toMatchObject({ phase: "reviewing", round: 2 });
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    expect(lastText()).toContain("rodada 2 de 3");
    expect(lastText()).toContain("f1");

    // o submit do revisor honra a decisão humana (o open da IA sobre f2 é ignorado)
    const ready = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "fixed" }, { id: "f2", status: "open" }], headSha: SHA2, summary: "r2",
    });
    expect(ready.phase).toBe("ready");
    expect(ready.findings[1]).toMatchObject({ status: "accepted_risk" });
  });

  it("veredito da IA não passa por cima de decisão humana", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const RISK: SubmittedFinding = { severity: "question", title: "cache sem limite de memória?" };
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [BLOCKER, QUESTION, RISK], headSha: SHA1, summary: "r1",
    });
    await o.orch.decideQuestion(review.id, "f2", "block", "u-revisor");
    await o.orch.decideQuestion(review.id, "f3", "accept_risk", "u-revisor");
    await o.orch.submitAuthorResponse(author.id, {
      round: 1,
      items: [{ id: "f1", status: "fixed", commit: "c1", reply: "feito" }, { id: "f2", status: "fixed", commit: "c2", reply: "ttl novo" }],
      headSha: SHA2,
    });

    // rodada 2: o revisor recusa o "corrigido" do autor num item que um humano bloqueou -> vale
    const r2 = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [],
      verdicts: [
        { id: "f1", status: "fixed" },
        { id: "f2", status: "open", reviewerReply: "o ttl novo não cobre o refresh" },
        { id: "f3", status: "open" },
      ],
      headSha: SHA2, summary: "r2",
    });
    expect(r2.findings.find((f) => f.id === "f2")).toMatchObject({ status: "open", humanDecision: "block", reviewerReply: "o ttl novo não cobre o refresh" });
    // risco aceito por humano é final: o open da IA é ignorado
    expect(r2.findings.find((f) => f.id === "f3")).toMatchObject({ status: "accepted_risk", humanDecision: "accept_risk" });
    expect(r2.phase).toBe("fixing");
    expect(r2.log.some((e) => e.who === "system" && e.text.includes("f3 (open)") && /decisão humana/.test(e.text))).toBe(true);
    // o delta mostrou ao revisor que f2 só aceita fixed ou open
    await o.orch.submitAuthorResponse(author.id, {
      round: 2, items: [{ id: "f2", status: "contested", reply: "o refresh usa o mesmo ttl (src/session.ts:40)" }], headSha: SHA3,
    });
    expect(lastText()).toMatch(/f2: um humano mandou bloquear\. Só fixed ou open/);

    // rodada 3: a IA aceita a contestação (dropped) de um item que um humano bloqueou -> ignorado
    const r3 = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 3, findings: [], verdicts: [{ id: "f2", status: "dropped" }], headSha: SHA3, summary: "r3",
    });
    expect(r3.findings.find((f) => f.id === "f2")).toMatchObject({ status: "contested", humanDecision: "block" });
    expect(r3).toMatchObject({ phase: "impasse", impasseReason: "rodadas" });
    expect(r3.log.some((e) => e.who === "system" && e.text.includes("f2 (dropped)"))).toBe(true);
  });

  it("sugestão não espera decisão e keep não vale para dúvida", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [QUESTION, SUGGESTION], headSha: SHA1, summary: "x" });
    await expect(o.orch.decideQuestion(review.id, "f2", "block", "u-revisor")).rejects.toThrow(/f2/);
    await expect(o.orch.decideQuestion(review.id, "f1", "keep", "u-revisor")).rejects.toThrow(/keep/);
    await expect(o.orch.decideQuestion(review.id, "f9", "block", "u-revisor")).rejects.toThrow(/f9/);
    expect((await o.store.getReview(review.id))?.findings[0]?.humanDecision).toBeUndefined();
  });
});

describe("tentar de novo e cancelar", () => {
  it("impasse por falha de relay sai com retry", async () => {
    const o = await load();
    const { author, review } = await started(o);
    sendFailure = new Error("terminal not ready: Claude is still starting");
    const stuck = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    expect(stuck).toMatchObject({ phase: "impasse", impasseReason: expect.stringContaining("terminal not ready") });
    sendFailure = null;
    send.mockClear();
    calls.length = 0;

    const after = await o.orch.retryReview(review.id, "u-autor");
    // a rodada do revisor já tinha sido entregue: a vez volta ao autor, com a lista
    expect(after).toMatchObject({ phase: "fixing", round: 1, nudges: 0 });
    expect(after.impasseReason).toBeUndefined();
    expect(calls).toEqual([`actor:u-autor:${author.id}`, `send:${author.id}`]);
    expect(lastText()).toContain("token vaza no log");
    expect(after.log.some((e) => e.who === "human")).toBe(true);
    // em fixing, tentar de novo reenvia a lista (a IA do autor pode ter parado sem a ferramenta)
    send.mockClear();
    await expect(o.orch.retryReview(review.id, "u-autor")).resolves.toMatchObject({ phase: "fixing", round: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(author.id);
  });

  it("retry em fixing com o autor parado reenvia a lista, zera os lembretes e não despausa", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    // um lembrete já gasto: a IA do autor terminou um turno sem responder
    await o.store.mutateReview(review.id, (r) => {
      r.nudges = 1;
    });
    send.mockClear();
    calls.length = 0;
    resume.mockClear();

    const after = await o.orch.retryReview(review.id, "u-merger");
    expect(after).toMatchObject({ phase: "fixing", round: 1, nudges: 0 });
    expect(calls).toEqual([`actor:u-autor:${author.id}`, `send:${author.id}`]);
    expect(lastText()).toContain("token vaza no log");
    expect(lastText()).toContain("vibehub_review_respond");
    expect(after.log.at(-1)).toMatchObject({ who: "human" });
    expect(after.log.at(-1)?.text).toMatch(/autor/);
    // o mesmo caminho do lembrete: não tira ninguém de Paused
    expect(resume).not.toHaveBeenCalled();

    // a pessoa pausou o card do autor: o reenvio é recusado e vira impasse com o motivo
    await o.registry.applyOpenTerminal(author.id);
    await o.registry.pauseCard(author.id, { effective: true });
    const paused = await o.orch.retryReview(review.id, "u-merger");
    expect(paused).toMatchObject({ phase: "impasse", impasseReason: expect.stringMatching(/paused/) });
    expect(resume).not.toHaveBeenCalled();
    expect((await o.registry.getCard(author.id))?.column).toBe("paused");
  });

  it("retry em reviewing reenvia a rodada ao revisor; esperando a decisão humana não há o que tentar", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.store.mutateReview(review.id, (r) => {
      r.nudges = 1;
    });
    const after = await o.orch.retryReview(review.id, "u-revisor");
    expect(after).toMatchObject({ phase: "reviewing", round: 1, nudges: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    expect(lastText()).toContain("/code-review high");

    // a rodada do revisor pousou e só sobrou dúvida: a vez é do humano, que decide no painel
    const waiting = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [QUESTION], headSha: SHA1, summary: "uma dúvida" });
    expect(waiting).toMatchObject({ phase: "reviewing", lastSubmitRound: 1 });
    send.mockClear();
    await expect(o.orch.retryReview(review.id, "u-revisor")).rejects.toThrow(/nada_a_tentar/);
    expect(send).not.toHaveBeenCalled();
  });

  it("retry de um impasse sem a rodada do revisor devolve a vez ao revisor; impasse de rodadas não tem retry", async () => {
    const o = await load();
    const { author } = await seed(o);
    sendFailure = new Error("no agent running");
    const review = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    expect(review.phase).toBe("impasse");
    sendFailure = null;
    send.mockClear();
    const after = await o.orch.retryReview(review.id, "u-revisor");
    expect(after).toMatchObject({ phase: "reviewing", round: 1 });
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    expect(lastText()).toContain("/code-review high");

    await o.store.mutateReview(review.id, (r) => {
      r.phase = "impasse";
      r.impasseReason = "rodadas";
    });
    await expect(o.orch.retryReview(review.id, "u-revisor")).rejects.toThrow(/nada_a_tentar/);
  });

  it("cancelar libera nova revisão do mesmo PR", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const cancelled = await o.orch.cancelReview(review.id, "u-autor");
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.log.at(-1)).toMatchObject({ who: "human" });
    expect(await o.store.activeReviewFor(author.id, 7)).toBeUndefined();
    await expect(o.orch.cancelReview(review.id, "u-autor")).rejects.toThrow(/revisao_encerrada/);
    // um submit atrasado da revisão cancelada não faz nada
    const late = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "x" });
    expect(late.phase).toBe("cancelled");

    const again = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    expect(again.id).not.toBe(review.id);
    expect(again.phase).toBe("reviewing");
    expect((await o.store.activeReviewFor(author.id, 7))?.id).toBe(again.id);
  });
});

describe("merge humano: push depois do pronto e mergeado", () => {
  /** Uma revisão em `ready` na rodada `round`, com SHA1 revisado; envios zerados. */
  async function readyAt(o: Loaded, round: 1 | 3) {
    const { author, review } = await started(o);
    if (round === 3) {
      await o.store.mutateReview(review.id, (r) => {
        r.round = 3;
      });
    }
    const ready = await o.orch.submitReviewerRound(review.reviewerCardId, { round, findings: [], headSha: SHA1, summary: "ok" });
    expect(ready.phase).toBe("ready");
    send.mockClear();
    calls.length = 0;
    return { author, review: ready };
  }

  it("push depois do pronto reabre a rodada seguinte e manda o diff ao revisor", async () => {
    const o = await load();
    const { review } = await readyAt(o, 1);
    const after = await o.orch.reopenAfterHeadMoved(review.id, "u-merger");
    expect(after).toMatchObject({ phase: "reviewing", round: 2, nudges: 0, reviewedSha: SHA1 });
    expect(after.approvePending).toBeUndefined();
    // a vez é do revisor de novo: o fim de turno sem submit volta a ser cobrado
    expect(after.lastSubmitRound).toBe(1);
    // pelo mesmo caminho do relay: revisor como ator, depois o texto do delta da rodada 2
    expect(calls).toEqual([`actor:u-revisor:${review.reviewerCardId}`, `send:${review.reviewerCardId}`]);
    const text = lastText();
    for (const piece of ["rodada 2 de 3", `git diff ${SHA1}..HEAD`, "vibehub_review_submit", "push depois do pronto"]) {
      expect(text).toContain(piece);
    }
    expect(after.log.some((e) => e.who === "system" && /push depois do pronto/i.test(e.text))).toBe(true);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("push depois do pronto na rodada 3 vira impasse, sem relay e sem retry", async () => {
    const o = await load();
    const { author, review } = await readyAt(o, 3);
    const after = await o.orch.reopenAfterHeadMoved(review.id, "u-merger");
    expect(after).toMatchObject({ phase: "impasse", impasseReason: "push depois do pronto", round: 3 });
    expect(send).not.toHaveBeenCalled();
    const notices = await messagesOn(o, author.id);
    expect(notices.at(-1)?.text).toMatch(/PR #7.*impasse.*push depois do pronto/i);
    // não sobra rodada: "tentar de novo" não tem para onde devolver a vez (cancelar e pedir outra revisão)
    await expect(o.orch.retryReview(review.id, "u-merger")).rejects.toThrow(/nada_a_tentar/);
  });

  it("reabrir só vale em ready: revisão que andou ou fechou no meio do merge fica como está", async () => {
    const o = await load();
    const { review } = await readyAt(o, 1);
    await o.orch.cancelReview(review.id, "u-autor");
    const after = await o.orch.reopenAfterHeadMoved(review.id, "u-merger");
    expect(after).toMatchObject({ phase: "cancelled", round: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("mergeado grava a fase, avisa os dois cards e é idempotente", async () => {
    const o = await load();
    const { author, review } = await readyAt(o, 1);
    const merged = await o.orch.markReviewMerged(review.id, "merger");
    expect(merged.phase).toBe("merged");
    expect(merged.log.at(-1)).toMatchObject({ who: "human" });
    expect((await messagesOn(o, author.id)).at(-1)?.text).toMatch(/PR #7: mergeado em dev/);
    expect((await messagesOn(o, review.reviewerCardId)).at(-1)?.text).toMatch(/PR #7: mergeado em dev/);
    // merged não é ativa: o card volta a poder pedir revisão desse PR
    expect(await o.store.activeReviewFor(author.id, 7)).toBeUndefined();
    const again = await o.orch.markReviewMerged(review.id, "merger");
    expect(again.log).toHaveLength(merged.log.length);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("falha de entrega e fim de turno sem ferramenta", () => {
  it("envio que falha vira impasse com o motivo, sem lançar", async () => {
    const o = await load();
    const { author, review } = await started(o);
    sendFailure = new Error("done: card \"Login\" is finished and asleep");
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "x" });
    expect(after).toMatchObject({ phase: "impasse", impasseReason: expect.stringContaining("finished and asleep") });
    expect((await messagesOn(o, author.id)).map((e) => e.text)).toEqual([expect.stringMatching(/impasse/i)]);
  });

  it("aprovação que não chega ao revisor mantém o ready com approvePending, avisa e o retry reenvia", async () => {
    const o = await load();
    const { author, review } = await started(o);
    sendFailure = new Error("no agent running");
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "x" });
    expect(after).toMatchObject({ phase: "ready", approvePending: true });
    expect(after.log.some((e) => e.text.includes("no agent running"))).toBe(true);
    for (const cardId of [author.id, review.reviewerCardId]) {
      expect((await messagesOn(o, cardId)).map((e) => e.text)).toContain(
        "PR #7: Approve não publicado no GitHub — tente de novo pelo painel.");
    }

    sendFailure = null;
    send.mockClear();
    const retried = await o.orch.retryReview(review.id, "u-revisor");
    expect(retried.phase).toBe("ready");
    expect(retried.approvePending).toBeFalsy();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    expect(lastText()).toContain("--approve");
    // sem pendência, não há o que tentar
    await expect(o.orch.retryReview(review.id, "u-revisor")).rejects.toThrow(/nada_a_tentar/);
  });

  it("envio que falha depois que a revisão andou não vira impasse", async () => {
    const o = await load();
    const { review } = await started(o);
    // enquanto a lista sai para o autor, a resposta dele pousa (rodada 2); o envio então falha
    sendHook = async () => {
      await o.store.mutateReview(review.id, (r) => {
        r.lastRespondRound = 1;
        r.round = 2;
        r.phase = "reviewing";
      });
    };
    sendFailure = new Error("terminal not ready");
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "x" });
    expect(after).toMatchObject({ phase: "reviewing", round: 2 });
    expect(after.impasseReason).toBeUndefined();
  });

  it("turno sem submit: lembra uma vez, depois impasse", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      const turn = async (cardId: string) => {
        await o.events.observeCardStatus(cardId, "waiting", "working");
        await o.events.observeCardStatus(cardId, "working", "waiting");
      };
      // o revisor terminou o turno sem chamar vibehub_review_submit
      await turn(review.reviewerCardId);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
      expect(lastText()).toMatch(/sem chamar/);
      expect(lastText()).toContain("vibehub_review_submit");
      expect(lastText()).toContain("/code-review high");
      expect((await o.store.getReview(review.id))?.nudges).toBe(1);

      // de novo: impasse "IA não respondeu", sem mais envio
      await turn(review.reviewerCardId);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.phase).toBe("impasse"));
      expect(await o.store.getReview(review.id)).toMatchObject({ impasseReason: "IA não respondeu" });
      expect(send).toHaveBeenCalledTimes(1);
      // o aviso é gravado logo depois da mutação: espera por ele também
      await vi.waitFor(async () =>
        expect((await messagesOn(o, author.id)).map((e) => e.text)).toEqual([expect.stringMatching(/impasse/i)]));
    } finally {
      off();
    }
  });

  it("turno que termina depois do submit não lembra; o lembrete do autor reenvia a lista e o submit zera a conta", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      const turn = async (cardId: string) => {
        await o.events.observeCardStatus(cardId, "waiting", "working");
        await o.events.observeCardStatus(cardId, "working", "waiting");
      };
      // um lembrete no revisor, depois o submit chega: nudges volta a 0
      await turn(review.reviewerCardId);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
      expect((await o.store.getReview(review.id))?.nudges).toBe(0);
      expect(send).toHaveBeenCalledTimes(2); // a lista ao autor

      // o turno do revisor que fez o submit acaba: nada a lembrar
      await turn(review.reviewerCardId);
      await new Promise((r) => setTimeout(r, 20));
      expect(send).toHaveBeenCalledTimes(2);

      // o autor termina sem responder: lembrete com a lista de novo
      await turn(author.id);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
      expect(send.mock.calls[2]![0]).toBe(author.id);
      expect(lastText()).toMatch(/sem chamar/);
      expect(lastText()).toContain("vibehub_review_respond");
      expect(lastText()).toContain("token vaza no log");
      expect((await o.store.getReview(review.id))?.nudges).toBe(1);

      // um card sem revisão terminando o turno não mexe em nada (e o listener não lança)
      const other = await o.registry.createCard({ projectId: author.projectId, title: "Outro" });
      await turn(other.id);
      await new Promise((r) => setTimeout(r, 20));
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      off();
    }
  });

  /** Autor em fixing (a lista já chegou), com o listener ligado. */
  async function fixing(o: Loaded) {
    const s = await started(o);
    await o.orch.submitReviewerRound(s.review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    send.mockClear();
    calls.length = 0;
    resume.mockClear();
    return { ...s, off: o.orch.startReviewOrchestrator({ graceMs: 0 }) };
  }
  const endTurn = async (o: Loaded, cardId: string, declared?: { state?: "needs_me" | "blocked" }) => {
    await o.events.observeCardStatus(cardId, "waiting", "working");
    await o.events.observeCardStatus(cardId, "working", "waiting", declared);
  };
  /**
   * O turno com a condição de pular não conta: o turno seguinte, já sem ela, é o PRIMEIRO lembrete
   * (se o primeiro tivesse contado, o segundo seria impasse).
   */
  async function expectOnlyTheSecondCounts(o: Loaded, reviewId: string) {
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const r = await o.store.getReview(reviewId);
    expect(r).toMatchObject({ phase: "fixing", nudges: 1 });
    expect(lastText()).toMatch(/sem chamar/);
  }

  it("turno com pessoa usando o card não conta", async () => {
    const o = await load();
    const { author, review, off } = await fixing(o);
    try {
      await o.registry.markCardHumanActive(author.id);
      await endTurn(o, author.id);
      await new Promise((r) => setTimeout(r, 30));
      expect(send).not.toHaveBeenCalled();
      await o.registry.markCardHumanActive(author.id, 0);
      await endTurn(o, author.id);
      await expectOnlyTheSecondCounts(o, review.id);
    } finally {
      off();
    }
  });

  it("turno em que o agente declarou needs_me ou blocked não conta", async () => {
    const o = await load();
    const { author, review, off } = await fixing(o);
    try {
      await endTurn(o, author.id, { state: "needs_me" });
      await endTurn(o, author.id, { state: "blocked" });
      await new Promise((r) => setTimeout(r, 30));
      expect(send).not.toHaveBeenCalled();
      await endTurn(o, author.id);
      await expectOnlyTheSecondCounts(o, review.id);
    } finally {
      off();
    }
  });

  it("turno com pergunta ou permissão em aberto não conta", async () => {
    const o = await load();
    const { author, review, off } = await fixing(o);
    try {
      // pergunta em prosa no fim do turno (o carimbo do chat nativo)
      await o.registry.setCardPendingQuestion(author.id, Date.now());
      await endTurn(o, author.id);
      await new Promise((r) => setTimeout(r, 30));
      await o.registry.setCardPendingQuestion(author.id, null);
      // permissão aberta no log de eventos
      await o.events.observeCardStatus(author.id, "waiting", "working");
      await o.events.recordCardEvent({ id: "permission:p1", cardId: author.id, kind: "permission", refId: "p1", tool: "Bash" });
      await o.events.observeCardStatus(author.id, "working", "waiting");
      await new Promise((r) => setTimeout(r, 30));
      expect(send).not.toHaveBeenCalled();
      await o.events.resolveCardEvents(author.id, { refId: "p1" });
      await endTurn(o, author.id);
      await expectOnlyTheSecondCounts(o, review.id);
    } finally {
      off();
    }
  });

  it("nudge não tira de Paused", async () => {
    const o = await load();
    const { author, review, off } = await fixing(o);
    try {
      // a pessoa pausou o card no meio da correção
      await o.registry.applyOpenTerminal(author.id);
      await o.registry.pauseCard(author.id, { effective: true });
      await endTurn(o, author.id);
      // o lembrete tenta, o envio recusa o card pausado, e a revisão vai a impasse com o motivo
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.phase).toBe("impasse"));
      expect((await o.store.getReview(review.id))?.impasseReason).toMatch(/paused/);
      expect(resume).not.toHaveBeenCalled();
      expect(await o.registry.getCard(author.id)).toMatchObject({ column: "paused" });
      expect((await o.registry.getCard(author.id))?.pausedAt).toBeTruthy();
      // "tentar de novo" também não despausa
      await o.orch.retryReview(review.id, "u-autor");
      expect(resume).not.toHaveBeenCalled();
      expect((await o.registry.getCard(author.id))?.column).toBe("paused");
    } finally {
      off();
    }
  });

  it("startReviewOrchestrator devolve o unsubscribe", async () => {
    const o = await load();
    const before = o.events.cardEventListenerCount();
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    expect(o.events.cardEventListenerCount()).toBe(before + 1);
    off();
    expect(o.events.cardEventListenerCount()).toBe(before);
  });
});

describe("ferramentas MCP", () => {
  async function connect() {
    const { registerMaestroTools } = await import("../../mcp/tools.js");
    const server = new McpServer({ name: "t", version: "1" });
    registerMaestroTools(server, "card");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "1" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]!.text;
      return { isError: res.isError === true, text };
    };
  }

  it("vibehub_review_submit e vibehub_review_respond levam a rodada adiante e validam severidade, prova e status", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const call = await connect();

    // enums no schema: severidade, tipo de prova, veredito e status do autor
    const bad = await call("vibehub_review_submit", {
      card: review.reviewerCardId, round: 1, headSha: SHA1, summary: "x", findings: [{ severity: "critical", title: "t" }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/severity/);
    const badProof = await call("vibehub_review_submit", {
      card: review.reviewerCardId, round: 1, headSha: SHA1, summary: "x",
      findings: [{ severity: "blocking", title: "t", proof: { kind: "opinion", ref: "x" } }],
    });
    expect(badProof.isError).toBe(true);
    const badVerdict = await call("vibehub_review_submit", {
      card: review.reviewerCardId, round: 1, headSha: SHA1, summary: "x", findings: [], verdicts: [{ id: "f1", status: "accepted_risk" }],
    });
    expect(badVerdict.isError).toBe(true);
    expect((await o.store.getReview(review.id))?.lastSubmitRound).toBeUndefined();

    const ok = await call("vibehub_review_submit", {
      card: review.reviewerCardId, review: review.id, round: 1, headSha: SHA1, summary: "um bloqueante", findings: [BLOCKER],
    });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.text)).toMatchObject({ review: review.id, phase: "fixing", round: 1 });

    const badStatus = await call("vibehub_review_respond", {
      card: author.id, round: 1, headSha: SHA2, items: [{ id: "f1", status: "dropped", reply: "x" }],
    });
    expect(badStatus.isError).toBe(true);
    // o card errado volta com erro, sem mexer
    const wrongCard = await call("vibehub_review_respond", {
      card: review.reviewerCardId, round: 1, headSha: SHA2, items: [{ id: "f1", status: "fixed", reply: "x" }],
    });
    expect(JSON.parse(wrongCard.text)).toHaveProperty("error");
    const responded = await call("vibehub_review_respond", {
      card: author.id, review: review.id, round: 1, headSha: SHA2, items: [{ id: "f1", status: "fixed", commit: "c1", reply: "feito" }],
    });
    expect(JSON.parse(responded.text)).toMatchObject({ review: review.id, phase: "reviewing", round: 2 });
    expect(deliverSpy).not.toHaveBeenCalled();
  });
});
