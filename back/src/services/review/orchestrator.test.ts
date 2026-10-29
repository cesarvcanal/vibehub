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
const send = vi.fn(async (cardId: string, _text: string, opts: SendOpts = {}): Promise<SendResult> => {
  if (sendFailure) throw sendFailure;
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
    expect(notices[0]).toMatchObject({ messageType: "info", cardId: author.id });
    expect(notices[0]!.text).toMatch(/PR #7/);
    expect(notices[0]!.text).toMatch(/pront/i);
    // anunciar de novo (replay) não duplica
    await o.orch.announcePhase(after);
    expect(await messagesOn(o, author.id)).toHaveLength(1);
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

describe("falha de entrega e fim de turno sem ferramenta", () => {
  it("envio que falha vira impasse com o motivo, sem lançar", async () => {
    const o = await load();
    const { author, review } = await started(o);
    sendFailure = new Error("done: card \"Login\" is finished and asleep");
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "x" });
    expect(after).toMatchObject({ phase: "impasse", impasseReason: expect.stringContaining("finished and asleep") });
    expect((await messagesOn(o, author.id)).map((e) => e.text)).toEqual([expect.stringMatching(/impasse/i)]);
  });

  it("aprovação que não chega ao revisor mantém o ready (o merge humano não fica preso)", async () => {
    const o = await load();
    const { review } = await started(o);
    sendFailure = new Error("no agent running");
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "x" });
    expect(after.phase).toBe("ready");
    expect(after.log.some((e) => e.text.includes("no agent running"))).toBe(true);
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
