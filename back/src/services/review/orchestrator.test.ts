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
let approvalNow: boolean | null = true;
const prApproval = vi.fn(async (_cardId: string, _prUrl: string, _sha: string) => approvalNow);
type MergeOutcome = import("./merge.js").ReviewMergeOutcome;
const REFUSED_NOT_READY: MergeOutcome = { kind: "refused", status: 409, reason: "not_ready", error: "não pronta" };
let mergeAnswer: MergeOutcome = REFUSED_NOT_READY;
const mergeSpy = vi.fn(async (_reviewId: string, _userId: string): Promise<MergeOutcome> => mergeAnswer);
/** O PR no GitHub, como `readPrState` o leria: o head (null = leitura que falhou) e o estado. */
let prHeadNow: string | null = null;
let prStateNow: "OPEN" | "MERGED" | "CLOSED" = "OPEN";
const prHead = vi.fn(async (_cardId: string, _prUrl: string) => (prHeadNow ? { state: prStateNow, headSha: prHeadNow } : null));
/** O veredito do gate do merge no commit aprovado (`gateAtCommit`); `gateGate` segura a resposta até ser solta. */
let gateAnswer: { ran: boolean; passed: boolean; output: string } = { ran: true, passed: true, output: "" };
let gateGate: Promise<void> | null = null;
const gateSpy = vi.fn(async (_cardId: string, _prUrl: string, _sha: string) => {
  if (gateGate) await gateGate;
  return gateAnswer;
});
const afterMerged = vi.fn(async (_cardId: string, _prUrl: string, _base: string, _branch: string) => "deleted" as const);
const prPeople = vi.fn(async (_cardId: string, _prUrl: string, people: { assignee?: string; reviewer?: string }) => ({
  ...(people.assignee ? { assignee: "ok" as const } : {}), ...(people.reviewer ? { reviewer: "ok" as const } : {}),
}));

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
    readPrState: prHead,
    readPrApproval: prApproval,
    afterPrMerged: afterMerged,
    gateAtCommit: gateSpy,
    setPrPeople: prPeople,
  }));
  vi.doMock("./merge.js", async () => ({
    ...(await vi.importActual<typeof import("./merge.js")>("./merge.js")),
    mergeReviewedPr: mergeSpy,
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
  problem: "o token da sessão sai inteiro no log de login",
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
  mergeSpy.mockClear();
  mergeAnswer = REFUSED_NOT_READY;
  prApproval.mockClear();
  approvalNow = true;
  prHead.mockClear();
  prHeadNow = null;
  prStateNow = "OPEN";
  afterMerged.mockClear();
  prPeople.mockClear();
  gateSpy.mockClear();
  gateAnswer = { ran: true, passed: true, output: "" };
  gateGate = null;
});
afterEach(async () => {
  for (const m of [
    "../maestro/maestro.js", "../board/actor.js", "../board/workspace.js", "../maestro/deliver.js",
    "../../auth/users.js", "../../auth/userGit.js", "./merge.js",
  ]) vi.doUnmock(m);
  // Fechar uma revisão manda o card do revisor pra done, e o "concluído" dele é gravado numa
  // microtask: uma escrita dessas pode chegar junto do rm.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
      "Não mergeie o PR por conta própria", "teste que falha", "question",
    ]) expect(text).toContain(piece);
    expect(lastOpts()).toMatchObject({
      wake: true, requireAgent: true, readyWaitMs: o.maestro.SEND_READY_WAIT_MS,
      origin: { kind: "system", name: "revisão de PR" },
    });
    expect(review.log.length).toBeGreaterThan(0);
  });

  it("os textos do revisor mandam chamar a ferramenta mesmo se o gh pr review falhar", async () => {
    const o = await load();
    const { author } = await seed(o);
    const review = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    const round1 = lastText();
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", commit: "c1", reply: "feito" }], headSha: SHA2,
    });
    const delta = lastText();
    expect(delta).toContain("rodada 2 de 3");
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "fixed" }], headSha: SHA2, summary: "r2",
    });
    const approve = lastText();
    expect(approve).toContain("--approve");

    // o GitHub recusa review do próprio PR (ou falta permissão): a IA que parasse ali travaria a rodada
    for (const text of [round1, delta]) {
      expect(text).toContain("Se o `gh pr review` falhar");
      expect(text).toContain("chame vibehub_review_submit mesmo assim, com o erro no summary");
    }
    expect(approve).toContain("Se o `gh pr review` falhar");
    expect(approve).toContain("chame vibehub_report mesmo assim, com o erro no summary");
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

describe("PR anexado: a correção roda no card da branch do PR, ou num card de correção na conta do autor", () => {
  const ATTACHED = {
    number: 599, url: "https://github.com/acme/widgets/pull/599", base: "dev", branch: "feat/aviso", author: "albert-gh", title: "Aviso não saiu",
  };
  const ROLES = { prNumber: 599, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-merger" };

  async function seedHub(o: Loaded) {
    const project = await o.registry.createProject({
      name: "widgets", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", baseBranch: "main",
    });
    await o.registry.createAccount({ name: "Mussa" });
    await o.registry.createAccount({ name: "Albert" });
    accountOf = { "u-revisor": "mussa", "u-autor": "albert" };
    const hub = await o.registry.createCard({ projectId: project.id, title: "Revisar PRs do Albert" });
    await o.registry.attachCardPrs(hub.id, [ATTACHED]);
    return { project, hub };
  }

  it("cria o card de correção na conta do autor, na branch do PR, e a revisão aponta pra ele com o card que anexou", async () => {
    const o = await load();
    const { project, hub } = await seedHub(o);
    const before = (await o.registry.listCards(project.id)).length;
    const review = await o.orch.startReview({ cardId: hub.id, ...ROLES });

    expect(review.cardId).not.toBe(hub.id);
    expect(review).toMatchObject({ hubCardId: hub.id, prNumber: 599, prBranch: "feat/aviso", base: "dev", prUrl: ATTACHED.url });
    const fix = await o.registry.getCard(review.cardId);
    expect(fix).toMatchObject({
      projectId: project.id, branch: "feat/aviso", base: "dev", accountSlug: "albert", column: "waiting", title: "Correção PR #599 · Aviso não saiu",
    });
    expect(fix?.reviewOf).toBeUndefined();
    // o PR mora no card de correção como entregue por ele (é o que deliver e conferência do GitHub leem)
    expect(fix?.prs).toEqual([expect.objectContaining({ number: 599, branch: "feat/aviso", base: "dev" })]);
    expect(fix?.prs?.[0]?.attached).toBeUndefined();
    // o revisor revisa o card de correção, na branch do PR
    expect(await o.registry.getCard(review.reviewerCardId)).toMatchObject({ reviewOf: fix!.id, base: "feat/aviso", accountSlug: "mussa" });
    // visíveis no board: o hub, o de correção (o do revisor fica escondido)
    expect((await o.registry.listCards(project.id)).length).toBe(before + 2);
    // a rodada 1 sai pro revisor
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    // o autor e o merger ganham work no card de correção (o autor é ator dele a cada relay; o merger mergeia de lá)
    const shared = (await o.registry.sharesForTarget("card", fix!.id)).filter((x) => x.level === "work").map((x) => x.userId);
    expect(shared).toContain("u-autor");
  });

  it("a lista de correção vai ao card de correção, com o autor como ator", async () => {
    const o = await load();
    const { hub } = await seedHub(o);
    const review = await o.orch.startReview({ cardId: hub.id, ...ROLES });
    send.mockClear();
    calls.length = 0;
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "1 bloqueante" });
    expect(send.mock.calls.at(-1)![0]).toBe(review.cardId);
    expect(calls).toEqual([`actor:u-autor:${review.cardId}`, `send:${review.cardId}`]);
    // e o card de correção responde como o autor da revisão
    const after = await o.orch.submitAuthorResponse(review.cardId, {
      round: 1, items: [{ id: "f1", status: "fixed", commit: "abc1234", reply: "tirei" }], headSha: SHA2,
    });
    expect(after).toMatchObject({ phase: "reviewing", round: 2 });
  });

  it("reaproveita o card que já trabalha a branch do PR, sem criar outro", async () => {
    const o = await load();
    const { project, hub } = await seedHub(o);
    const albert = await o.registry.createCard({ projectId: project.id, title: "Aviso" }, { branch: "feat/aviso" });
    const before = (await o.registry.listCards(project.id)).length;
    const review = await o.orch.startReview({ cardId: hub.id, ...ROLES });
    expect(review).toMatchObject({ cardId: albert.id, hubCardId: hub.id });
    expect((await o.registry.listCards(project.id)).length).toBe(before + 1);
    // o card do Albert não ganha o PR registrado por cima da vaga de entrega dele
    expect((await o.registry.getCard(albert.id))?.prs).toBeUndefined();
  });

  it("card concluído na branch não conta: nasce o card de correção", async () => {
    const o = await load();
    const { project, hub } = await seedHub(o);
    const old = await o.registry.createCard({ projectId: project.id, title: "Aviso velho" }, { branch: "feat/aviso", column: "done" });
    const review = await o.orch.startReview({ cardId: hub.id, ...ROLES });
    expect(review.cardId).not.toBe(old.id);
    expect(review.cardId).not.toBe(hub.id);
  });

  it("o próprio card que anexou, se está na branch do PR, é o do autor (sem hubCardId)", async () => {
    const o = await load();
    const { project } = await seedHub(o);
    const self = await o.registry.createCard({ projectId: project.id, title: "Eu mesmo" }, { branch: "feat/aviso" });
    await o.registry.attachCardPrs(self.id, [ATTACHED]);
    const review = await o.orch.startReview({ cardId: self.id, ...ROLES });
    expect(review.cardId).toBe(self.id);
    expect(review.hubCardId).toBeUndefined();
  });

  it("autor sem conta Claude própria: autor_sem_conta, nenhum card criado", async () => {
    const o = await load();
    const { project, hub } = await seedHub(o);
    accountOf = { "u-revisor": "mussa" };
    const before = (await o.registry.listAllCards()).length;
    await expect(o.orch.startReview({ cardId: hub.id, ...ROLES })).rejects.toThrow(/autor_sem_conta/);
    expect((await o.registry.listAllCards()).length).toBe(before);
    expect(await o.store.listReviewsFollowedBy([hub.id])).toEqual([]);
    expect(project).toBeDefined();
  });

  it("o mesmo PR anexado em dois cards não ganha duas revisões", async () => {
    const o = await load();
    const { project, hub } = await seedHub(o);
    const other = await o.registry.createCard({ projectId: project.id, title: "Outro" });
    await o.registry.attachCardPrs(other.id, [ATTACHED]);
    await o.orch.startReview({ cardId: hub.id, ...ROLES });
    await expect(o.orch.startReview({ cardId: other.id, ...ROLES })).rejects.toThrow(/revisao_ativa/);
  });

  it("falha depois de criar o card de correção leva ele junto", async () => {
    const o = await load();
    const { hub } = await seedHub(o);
    // a conta do revisor não existe: o card do revisor não nasce, e o de correção já tinha nascido
    accountOf = { "u-revisor": "fantasma", "u-autor": "albert" };
    const before = (await o.registry.listAllCards()).length;
    await expect(o.orch.startReview({ cardId: hub.id, ...ROLES })).rejects.toThrow(/does not exist/);
    expect((await o.registry.listAllCards()).length).toBe(before);
  });

  it("o card que anexou recebe os avisos de fase e vê o PR mergeado", async () => {
    const o = await load();
    const { hub } = await seedHub(o);
    const review = await o.orch.startReview({ cardId: hub.id, ...ROLES });
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
    expect((await messagesOn(o, hub.id)).length).toBe(1);
    await o.orch.markReviewMerged(review.id, "merger");
    expect((await messagesOn(o, hub.id)).length).toBe(2);
    expect((await o.registry.getCard(hub.id))?.prs?.find((p) => p.number === 599)?.mergedAt).toEqual(expect.any(Number));
    expect(await o.store.listReviewsFollowedBy([hub.id])).toEqual([expect.objectContaining({ id: review.id, phase: "merged" })]);
  });

  it("PR entregue pelo próprio card segue o caminho de sempre", async () => {
    const o = await load();
    const { author } = await seed(o);
    const review = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    expect(review.cardId).toBe(author.id);
    expect(review.hubCardId).toBeUndefined();
  });
});

describe("os papéis no GitHub e o crédito do co-autor", () => {
  /** Conexão GitHub própria e identidade git de uma pessoa (o que o vibehub guarda dela). */
  async function identity(o: Loaded, userId: string, login: string, git?: { gitName: string; gitEmail: string }) {
    const conn = await o.registry.addGithubConnection({ label: login, login });
    const { setUserGit } = await import("../../auth/userGit.js");
    await setUserGit(userId, { githubConnectionId: conn.id, ...(git ?? {}) });
  }

  it("ao iniciar, o PR ganha o responsável como assignee e o revisor como reviewer pedido, e a conversa conta", async () => {
    const o = await load();
    const { author } = await seed(o);
    await identity(o, "u-autor", "autor-gh");
    await identity(o, "u-revisor", "revisor-gh");
    const review = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    expect(prPeople).toHaveBeenCalledWith(author.id, PR.url, { assignee: "autor-gh", reviewer: "revisor-gh" });
    expect(review.log.some((e) => e.who === "system" && /assignee autor-gh.*reviewer revisor-gh/.test(e.text))).toBe(true);
  });

  it("responsável sem conexão GitHub própria: só o reviewer é pedido, e a conversa diz por quê", async () => {
    const o = await load();
    const { author } = await seed(o);
    await identity(o, "u-revisor", "revisor-gh");
    const review = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    expect(prPeople).toHaveBeenCalledWith(author.id, PR.url, { reviewer: "revisor-gh" });
    expect(review.log.some((e) => /não tem conexão GitHub própria/.test(e.text))).toBe(true);
  });

  it("com co-autor, os commits da correção levam Co-authored-by com o nome e o e-mail git dele", async () => {
    const o = await load();
    const { author } = await seed(o);
    await identity(o, "u-merger", "merger-gh", { gitName: "Bia Souza", gitEmail: "bia@acme.dev" });
    const review = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", coauthorUserId: "u-merger",
      mergerUserId: "u-merger", by: "u-autor",
    });
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    expect(lastText()).toContain("Co-authored-by: Bia Souza <bia@acme.dev>");
  });

  it("sem co-autor, ou co-autor sem identidade git, nenhuma linha de crédito é pedida", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    expect(lastText()).not.toContain("Co-authored-by");
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
      "vibehub_review_respond", `card: "${author.id}"`, review.id, "rodada 1 de 3", "Não mergeie o PR por conta própria", PR.branch,
    ]) expect(text).toContain(piece);
    expect(lastOpts()).toMatchObject({ wake: true, requireAgent: true, origin: { kind: "system", name: "revisão de PR" } });
    // o push é git push na branch do PR; vibehub_deliver não é caminho nesta revisão
    expect(text).toContain(`git push origin HEAD:${PR.branch}`);
    expect(text).toContain("O push desta correção é o git push acima, não o vibehub_deliver");
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
    expect(text).toMatch(/Não mergeie por conta própria/);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  /**
   * O revisor termina o turno do Approve declarando `ready` (o passo 3 do prompt de Approve), como em
   * produção: o turno começa (limpa a declaração), o `vibehub_report` grava no card, o turno acaba.
   */
  const approveTurnEnds = async (o: Loaded, reviewerCardId: string, state: "ready" | "working" = "ready") => {
    await o.registry.applyCardStatus(reviewerCardId, "working");
    await o.events.observeCardStatus(reviewerCardId, "waiting", "working");
    await o.registry.reportCardState(reviewerCardId, state, "PR #7 aprovado no GitHub");
    await o.registry.applyCardStatus(reviewerCardId, "waiting");
    await o.events.observeCardStatus(reviewerCardId, "working", "waiting", { state });
  };

  it("pronta com sugestão em aberto: o merge segue humano, nem depois do Approve", async () => {
    const o = await load();
    const { review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "s" });
      await approveTurnEnds(o, review.reviewerCardId);
      await new Promise((r) => setTimeout(r, 40));
      expect(mergeSpy).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("pronta sem nada em aberto: o submit NÃO mergeia (nem espera CI); o merge sai quando o revisor termina o Approve", async () => {
    const o = await load();
    const { review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
      expect(after.phase).toBe("ready");
      // a ferramenta do revisor volta já: o merge não roda dentro dela, e o Approve ainda não saiu
      expect(mergeSpy).not.toHaveBeenCalled();
      expect(lastText()).toContain("o PAINEL mergeia sozinho");
      // um fim de turno que não reporta ready (o do próprio submit) não dispara nada
      await approveTurnEnds(o, review.reviewerCardId, "working");
      await new Promise((r) => setTimeout(r, 40));
      expect(mergeSpy).not.toHaveBeenCalled();
      // o turno do Approve termina com ready: o merge sai, automático, em nome do responsável
      await approveTurnEnds(o, review.reviewerCardId);
      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledWith(review.id, "u-merger", { auto: true }));
      expect(mergeSpy).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("revisor reporta ready mas o GitHub recusou o Approve: nada é mergeado, a rodada vai pro botão (f9)", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      approvalNow = false;
      await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
      await approveTurnEnds(o, review.reviewerCardId);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.autoMergeFailedRound).toBe(1));
      expect(prApproval).toHaveBeenCalledWith(author.id, PR.url, SHA1);
      expect(mergeSpy).not.toHaveBeenCalled();
      const after = (await o.store.getReview(review.id))!;
      expect(after.phase).toBe("ready");
      expect(after.log.at(-1)!.text).toMatch(/o Approve do revisor não está no GitHub no commit revisado/);
      // O aviso é gravado DEPOIS da marca na revisão: espera por ele, não lê no mesmo tique (corria no CI).
      await vi.waitFor(async () => expect((await messagesOn(o, author.id)).map((e) => e.text))
        .toContainEqual(expect.stringMatching(/PR #7: o merge automático não saiu \(o Approve do revisor não está no GitHub/)));
    } finally {
      off();
    }
  });

  it("leitura das reviews que falha conta como sem Approve: não mergeia", async () => {
    const o = await load();
    const { review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      approvalNow = null;
      await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
      await approveTurnEnds(o, review.reviewerCardId);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.autoMergeFailedRound).toBe(1));
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await o.store.getReview(review.id))!.log.at(-1)!.text).toMatch(/não consegui ler as reviews do PR/);
    } finally {
      off();
    }
  });

  it("Approve que não chegou (approvePending) segura o merge automático", async () => {
    const o = await load();
    const { review } = await started(o);
    sendFailure = new Error("card do revisor fora do ar");
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
    expect(after).toMatchObject({ phase: "ready", approvePending: true });
    sendFailure = null;
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      await approveTurnEnds(o, review.reviewerCardId);
      await new Promise((r) => setTimeout(r, 40));
      expect(mergeSpy).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("merge automático recusado (CI vermelho): nota e aviso curtos, a rodada não tenta de novo e os textos voltam ao botão", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      mergeAnswer = { kind: "refused", status: 409, reason: "gate", error: `checks vermelhos ${"log ".repeat(200)}` };
      await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
      await approveTurnEnds(o, review.reviewerCardId);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.autoMergeFailedRound).toBe(1));
      const after = (await o.store.getReview(review.id))!;
      expect(after.phase).toBe("ready");
      const failed = after.log.find((e) => e.who === "system" && /Merge automático não saiu \(checks vermelhos/.test(e.text));
      expect(failed).toBeDefined();
      expect(failed!.text.length).toBeLessThan(300);
      const noticeOf = async () => (await messagesOn(o, author.id)).map((e) => e.text).find((t) => /merge automático não saiu/.test(t));
      await vi.waitFor(async () => expect(await noticeOf()).toBeDefined());
      const notice = await noticeOf();
      expect(notice).toMatch(/^PR #7: o merge automático não saiu \(checks vermelhos/);
      expect(notice!.length).toBeLessThan(300);
      // a mesma rodada não tenta de novo, e a resposta das tools já não promete o merge sozinho
      expect(o.orch.reviewToolAnswer(after, "reviewer", 1).next).toMatch(/merge humano/);
      await approveTurnEnds(o, review.reviewerCardId);
      await new Promise((r) => setTimeout(r, 40));
      expect(mergeSpy).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("dúvida retirada pelo humano deixa a revisão limpa: o merge sai depois do Approve", async () => {
    const o = await load();
    const { review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      const waiting = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [QUESTION], headSha: SHA1, summary: "d" });
      expect(waiting.phase).toBe("reviewing");
      const after = await o.orch.decideQuestion(review.id, waiting.findings[0]!.id, "drop", "revisor");
      expect(after.phase).toBe("ready");
      expect(mergeSpy).not.toHaveBeenCalled();
      await approveTurnEnds(o, review.reviewerCardId);
      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledWith(review.id, "u-merger", { auto: true }));
    } finally {
      off();
    }
  });

  it("'não fazer' a última sugestão de uma revisão já aprovada: o merge sai sozinho", async () => {
    const o = await load();
    const { review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      const ready = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "s" });
      await approveTurnEnds(o, review.reviewerCardId);
      await new Promise((r) => setTimeout(r, 40));
      expect(mergeSpy).not.toHaveBeenCalled();
      await o.orch.decideSuggestions(review.id, { skip: [ready.findings[0]!.id] }, "revisor");
      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledWith(review.id, "u-merger", { auto: true }));
    } finally {
      off();
    }
  });

  it("'não fazer' a última sugestão ANTES do Approve terminar: espera o fim de turno do revisor", async () => {
    const o = await load();
    const { review } = await started(o);
    const ready = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "s" });
    await o.orch.decideSuggestions(review.id, { skip: [ready.findings[0]!.id] }, "revisor");
    await new Promise((r) => setTimeout(r, 40));
    expect(mergeSpy).not.toHaveBeenCalled();
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
      "introducedInRound", "verdicts", "vibehub_review_submit", `card: "${review.reviewerCardId}"`, "Não mergeie o PR por conta própria",
    ]) expect(text).toContain(piece);
    expect(after.log.some((e) => e.who === "author" && /1 corrigido/.test(e.text))).toBe(true);

    // repetir a resposta é idempotente
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [], headSha: SHA2 });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await o.store.getReview(review.id))?.round).toBe(2);
  });

  it("resposta a sugestão vale junto da rodada: a sugestão fecha com o commit, sem pesar na fase", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "r1" });
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1,
      items: [
        { id: "f1", status: "fixed", commit: "c1", reply: "feito" },
        { id: "f2", status: "fixed", commit: "c2", reply: "renomeei" },
      ],
      headSha: SHA2,
    });
    expect(after).toMatchObject({ round: 2, phase: "reviewing" });
    expect(after.findings.find((f) => f.id === "f2")).toMatchObject({ status: "fixed", commit: "c2", authorReply: "renomeei" });
    expect(after.log.find((e) => e.who === "author")?.items?.map((i) => i.id)).toEqual(["f1", "f2"]);
  });

  it("resposta a item fechado (corrigido, retirado) é ignorada com nota no log", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, QUESTION], headSha: SHA1, summary: "r1" });
    await o.orch.decideQuestion(review.id, "f2", "drop", "mussa");
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1,
      items: [{ id: "f1", status: "fixed", commit: "c1", reply: "feito" }, { id: "f2", status: "fixed", reply: "também" }],
      headSha: SHA2,
    });
    expect(after.findings.find((f) => f.id === "f2")).toMatchObject({ status: "dropped" });
    expect(after.log.some((e) => e.who === "system" && e.text.includes("f2"))).toBe(true);
  });

  it("depois do pronto, o autor fecha as sugestões que aplicou: corrigida, contestada ou não vai aplicar — sem abrir rodada", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const ready = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [SUGGESTION, { severity: "suggestion", title: "extrair helper" }, { severity: "suggestion", title: "trocar lib" }],
      headSha: SHA1, summary: "só sugestões",
    });
    expect(ready.phase).toBe("ready");
    send.mockClear();
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1,
      items: [
        { id: "f1", status: "fixed", commit: "8159653", reply: "renomeado" },
        { id: "f2", status: "contested", reply: "o helper só tem um uso" },
        { id: "f3", status: "wontfix", reply: "fora do escopo deste PR" },
      ],
      headSha: SHA2,
    });
    expect(after).toMatchObject({ phase: "ready", round: 1 });
    expect(after.findings.map((f) => [f.id, f.status])).toEqual([["f1", "fixed"], ["f2", "contested"], ["f3", "wontfix"]]);
    expect(after.findings[0]).toMatchObject({ commit: "8159653", authorReply: "renomeado" });
    const said = after.log.filter((e) => e.who === "author");
    expect(said).toHaveLength(1);
    expect(said[0]!.items?.map((i) => [i.id, i.status])).toEqual([["f1", "fixed"], ["f2", "contested"], ["f3", "wontfix"]]);
    // não abre rodada nem manda nada a ninguém: o push, se houve, a conferência do GitHub pega
    expect(send).not.toHaveBeenCalled();

    // a mesma resposta de novo não grava outra fala
    const again = await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", commit: "8159653", reply: "renomeado" }], headSha: SHA2,
    });
    expect(again.log.filter((e) => e.who === "author")).toHaveLength(1);
  });

  it("wontfix só vale para sugestão, e contestar ou não aplicar exigem o motivo", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "r1" });
    await expect(o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "wontfix", reply: "não quero" }], headSha: SHA2,
    })).rejects.toThrow(/wontfix.*sugestão/);
    await expect(o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f2", status: "wontfix", reply: "  " }], headSha: SHA2,
    })).rejects.toThrow(/exige uma resposta/);
    expect((await o.store.getReview(review.id))).toMatchObject({ phase: "fixing", round: 1 });
  });

  it("resposta mal formada a um item que seria ignorado (fechado) não derruba as respostas válidas", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "r1" });
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", reply: "ok" }], headSha: SHA2 });
    const ready = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "fixed" }], headSha: SHA2, summary: "ok",
    });
    expect(ready.phase).toBe("ready");
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 2, items: [{ id: "f2", status: "fixed", reply: "renomeei" }, { id: "f1", status: "wontfix", reply: "" }], headSha: SHA3,
    });
    expect(after.findings.find((f) => f.id === "f2")).toMatchObject({ status: "fixed" });
    expect(after.findings.find((f) => f.id === "f1")).toMatchObject({ status: "fixed" });
  });

  it("sugestão que o revisor já tinha respondido volta ao delta quando o autor responde de novo", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "r1" });
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", reply: "ok" }], headSha: SHA2 });
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [],
      verdicts: [{ id: "f1", status: "open", reviewerReply: "ainda vaza" }, { id: "f2", status: "open", reviewerReply: "não aplicou" }],
      headSha: SHA2, summary: "r2",
    });
    send.mockClear();
    await o.orch.submitAuthorResponse(author.id, {
      round: 2, items: [{ id: "f1", status: "fixed", reply: "agora sim" }, { id: "f2", status: "wontfix", reply: "fora do escopo" }], headSha: SHA3,
    });
    expect(lastText()).toContain("rodada 3 de 3");
    expect(lastText()).toContain("nome de variável confuso");
    expect(lastText()).toContain("fora do escopo");
  });

  it("fora da rodada, resposta só a itens que não esperam o autor fica registrada como ignorada", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", reply: "ok" }], headSha: SHA2 });
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 2, findings: [], verdicts: [{ id: "f1", status: "fixed" }], headSha: SHA2, summary: "ok" });
    const after = await o.orch.submitAuthorResponse(author.id, { round: 2, items: [{ id: "f1", status: "fixed", reply: "de novo" }], headSha: SHA2 });
    expect(after.log.at(-1)).toMatchObject({ who: "system" });
    expect(after.log.at(-1)?.text).toMatch(/ignoradas: f1/);
  });

  it("revisão encerrada não aceita resposta a sugestão", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "ok" });
    await o.orch.markReviewMerged(review.id, "merger");
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", reply: "feito" }], headSha: SHA2, reviewId: review.id,
    });
    expect(after.findings[0]).toMatchObject({ status: "open" });
  });

  it("o delta mostra ao revisor as sugestões que o autor respondeu, pra conferir", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "r1" });
    send.mockClear();
    await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", reply: "feito" }, { id: "f2", status: "fixed", commit: "c2", reply: "renomeei" }], headSha: SHA2,
    });
    expect(lastText()).toContain("nome de variável confuso");
    expect(lastText()).toContain("renomeei");
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
    // o card do revisor fica escondido do board: o aviso vai também ao card do autor, onde as pessoas
    // olham, dizendo quem decide
    const onAuthor = (await messagesOn(o, author.id)).filter((e) => /dúvida/.test(e.text ?? ""));
    expect(onAuthor).toEqual([expect.objectContaining({ text: "PR #7: 1 dúvida esperando a decisão de revisor no painel da revisão" })]);
    // o submit repetido (retry da IA) não duplica
    await o.orch.submitReviewerRound(review.reviewerCardId, payload);
    expect(await messagesOn(o, review.reviewerCardId)).toHaveLength(1);
    expect((await messagesOn(o, author.id)).filter((e) => /dúvida/.test(e.text ?? ""))).toHaveLength(1);
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

describe("dúvidas resolvidas pelas IAs (o autor corrige ou explica, o revisor confere)", () => {
  /** Rodada 1 só com uma dúvida: a revisão fica esperando decisão. */
  async function waitingDoubt(o: Loaded) {
    const { author, review } = await started(o);
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [QUESTION], headSha: SHA1, summary: "uma dúvida" });
    expect(after).toMatchObject({ phase: "reviewing", lastSubmitRound: 1 });
    send.mockClear();
    calls.length = 0;
    return { author, review: after };
  }

  it("o autor responde a dúvida: a revisão vai à rodada seguinte e o revisor recebe a dúvida pra conferir", async () => {
    const o = await load();
    const { author, review } = await waitingDoubt(o);
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", commit: "c1", reply: "a sessão agora renova no checkout" }], headSha: SHA2,
    });
    expect(after).toMatchObject({ phase: "reviewing", round: 2 });
    expect(after.findings[0]).toMatchObject({ status: "fixed", authorReply: "a sessão agora renova no checkout" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    expect(lastText()).toContain("a sessão expira no meio do checkout?");
    expect(lastText()).toContain("a sessão agora renova no checkout");
  });

  it("o revisor confere e dá fixed: a dúvida deixa de esperar gente e a revisão fica pronta", async () => {
    const o = await load();
    const { author, review } = await waitingDoubt(o);
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", reply: "resolvido" }], headSha: SHA2 });
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "fixed", reviewerReply: "conferido" }], headSha: SHA2, summary: "ok",
    });
    expect(after.phase).toBe("ready");
  });

  it("o revisor mantém a dúvida aberta: ela volta a esperar a decisão humana", async () => {
    const o = await load();
    const { author, review } = await waitingDoubt(o);
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "contested", reply: "não expira" }], headSha: SHA2 });
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "open", reviewerReply: "ainda não sei" }], headSha: SHA2, summary: "ok",
    });
    expect(after).toMatchObject({ phase: "reviewing", lastSubmitRound: 2 });
  });

  it("dúvida que um humano já decidiu não aceita resposta do autor", async () => {
    const o = await load();
    const { author, review } = await waitingDoubt(o);
    await o.orch.decideQuestion(review.id, "f1", "accept_risk", "mussa");
    send.mockClear();
    const after = await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", reply: "x" }], headSha: SHA2 });
    expect(after.findings[0]).toMatchObject({ status: "accepted_risk" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("pedir ao autor aplicar as sugestões escolhidas", () => {
  it("manda ao card do autor só as sugestões escolhidas, com o que fazer e como responder, e a conversa conta", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [SUGGESTION, { severity: "suggestion", title: "extrair helper", fix: "mover pra lib" }, { severity: "suggestion", title: "trocar lib" }],
      headSha: SHA1, summary: "só sugestões",
    });
    send.mockClear();
    calls.length = 0;
    const after = await o.orch.requestSuggestions(review.id, ["f1", "f2"], "mussa");
    expect(calls).toEqual([`actor:u-autor:${author.id}`, `send:${author.id}`]);
    for (const piece of ["nome de variável confuso", "extrair helper", "mover pra lib", "vibehub_review_respond", "wontfix", `git push origin HEAD:${PR.branch}`, "mussa"]) {
      expect(lastText()).toContain(piece);
    }
    expect(lastText()).not.toContain("trocar lib");
    expect(after.log.at(-1)).toMatchObject({ who: "human", by: "mussa", items: [{ id: "f1" }, { id: "f2" }] });
  });

  it("'não fazer' tira a sugestão da lista por decisão de uma pessoa; 'fazer' vai ao autor, na mesma chamada", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [SUGGESTION, { severity: "suggestion", title: "extrair helper" }, { severity: "suggestion", title: "trocar lib" }],
      headSha: SHA1, summary: "só sugestões",
    });
    send.mockClear();
    const after = await o.orch.decideSuggestions(review.id, { apply: ["f2"], skip: ["f1", "f3"] }, "mussa");
    expect(after.findings.map((f) => [f.id, f.status, f.humanDecision])).toEqual([
      ["f1", "dropped", "drop"], ["f2", "open", undefined], ["f3", "dropped", "drop"],
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(author.id);
    expect(lastText()).toContain("extrair helper");
    expect(lastText()).not.toContain("trocar lib");
    const human = after.log.filter((e) => e.who === "human");
    expect(human.map((e) => e.text)).toEqual(["Não fazer as sugestões f1, f3.", "Pediu ao autor aplicar a sugestão f2."]);
    // só 'não fazer': nada vai ao autor
    send.mockClear();
    const o2 = await o.orch.decideSuggestions(review.id, { skip: ["f2"] }, "mussa");
    expect(o2.findings[1]).toMatchObject({ status: "dropped" });
    expect(send).not.toHaveBeenCalled();
  });

  it("sugestão pedida fica marcada e não vai ao autor de novo enquanto ele não responde; 'não fazer' ainda vale", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [SUGGESTION, { severity: "suggestion", title: "extrair helper" }], headSha: SHA1, summary: "só sugestões",
    });
    const after = await o.orch.requestSuggestions(review.id, ["f1", "f2"], "mussa");
    expect(after.findings.map((f) => f.requested?.by)).toEqual(["mussa", "mussa"]);
    send.mockClear();
    await expect(o.orch.requestSuggestions(review.id, ["f1"], "mussa")).rejects.toThrow(/ja_pedida: f1/);
    expect(send).not.toHaveBeenCalled();
    const dropped = await o.orch.decideSuggestions(review.id, { skip: ["f2"] }, "mussa");
    expect(dropped.findings[1]).toMatchObject({ status: "dropped" });
    // retirada, ela não está mais com o autor: a marca sai junto
    expect(dropped.findings[1]?.requested).toBeUndefined();
  });

  it("resposta do autor que deixa de fora uma sugestão pedida é recusada, sem gravar nada", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [SUGGESTION, { severity: "suggestion", title: "extrair helper" }], headSha: SHA1, summary: "só sugestões",
    });
    await o.orch.requestSuggestions(review.id, ["f1", "f2"], "mussa");
    await expect(o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", commit: "c1", reply: "renomeei" }], headSha: SHA2, reviewId: review.id,
    })).rejects.toThrow(/sugestao_sem_resposta: f2/);
    const untouched = await o.store.getReview(review.id);
    expect(untouched?.findings.map((f) => [f.status, f.requested?.by])).toEqual([["open", "mussa"], ["open", "mussa"]]);
    await o.orch.submitAuthorResponse(author.id, {
      round: 1,
      items: [
        { id: "f1", status: "fixed", commit: "c1", reply: "renomeei" },
        { id: "f2", status: "wontfix", reply: "fora do escopo deste PR" },
      ],
      headSha: SHA2, reviewId: review.id,
    });
    const answered = await o.store.getReview(review.id);
    expect(answered?.findings.map((f) => [f.status, f.requested])).toEqual([["fixed", undefined], ["wontfix", undefined]]);
  });

  it("sugestão pedida que o autor respondeu e o revisor reabriu pode ser pedida de novo (f10)", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "só sugestão" });
    await o.orch.requestSuggestions(review.id, ["f1"], "mussa");
    await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", commit: "c1", reply: "renomeei" }], headSha: SHA2, reviewId: review.id,
    });
    const answered = await o.store.getReview(review.id);
    expect(answered?.findings[0]?.requested).toBeUndefined();
    // o push do autor depois do pronto devolve a revisão ao revisor (rodada 2), que reabre a sugestão
    const back = await o.orch.reopenAfterHeadMoved(review.id, "mussa");
    expect(back).toMatchObject({ phase: "reviewing", round: 2 });
    await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "open", reviewerReply: "o nome segue confuso" }],
      headSha: SHA2, summary: "reabri a sugestão",
    });
    const reopened = await o.store.getReview(review.id);
    expect(reopened?.findings[0]).toMatchObject({ status: "open" });
    expect(reopened?.findings[0]?.requested).toBeUndefined();
    send.mockClear();
    await o.orch.requestSuggestions(review.id, ["f1"], "mussa");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a mesma sugestão nos dois lados, ou envio ao autor que falha, não muda nada", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "ok" });
    await expect(o.orch.decideSuggestions(review.id, { apply: ["f1"], skip: ["f1"] }, "mussa")).rejects.toThrow(/sem_sugestao/);
    sendFailure = new Error("card pausado");
    await expect(o.orch.decideSuggestions(review.id, { apply: ["f1"] }, "mussa")).rejects.toThrow(/envio_falhou/);
    expect((await o.store.getReview(review.id))?.findings[0]).toMatchObject({ status: "open" });
    // o envio que falhou não deixa a sugestão marcada como pedida: dá para tentar de novo
    expect((await o.store.getReview(review.id))?.findings[0]?.requested).toBeUndefined();
  });

  it("só sugestão em aberto pode ser pedida; nada escolhido ou revisão encerrada é recusado", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER, SUGGESTION], headSha: SHA1, summary: "r1" });
    await expect(o.orch.requestSuggestions(review.id, ["f1"], "mussa")).rejects.toThrow(/sem_sugestao/);
    await expect(o.orch.requestSuggestions(review.id, [], "mussa")).rejects.toThrow(/sem_sugestao/);
    await o.orch.cancelReview(review.id, "mussa");
    await expect(o.orch.requestSuggestions(review.id, ["f2"], "mussa")).rejects.toThrow(/revisao_encerrada/);
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

  it("push depois do pronto na rodada 3 ganha uma conferência extra do revisor, não um impasse", async () => {
    const o = await load();
    const { review } = await readyAt(o, 3);
    const after = await o.orch.reopenAfterHeadMoved(review.id, "u-merger");
    expect(after).toMatchObject({ phase: "reviewing", round: 3, lastSubmitRound: 2 });
    expect(after.impasseReason).toBeUndefined();
    // o revisor recebe o delta da rodada 3 e pode submeter de novo nela
    expect(send).toHaveBeenCalledTimes(1);
    expect(lastText()).toContain("rodada 3 de 3");
    expect(after.log.at(-1)?.text).toMatch(/conferência extra/);
    const checked = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 3, findings: [], headSha: SHA2, summary: "ok" });
    expect(checked).toMatchObject({ phase: "ready", reviewedSha: SHA2 });
  });

  it("bloqueante achado na conferência extra da última rodada vira impasse (o teto de rodadas continua valendo)", async () => {
    const o = await load();
    const { review } = await readyAt(o, 3);
    await o.orch.reopenAfterHeadMoved(review.id, "u-merger");
    const after = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 3, findings: [{ ...BLOCKER, introducedInRound: 3 }], headSha: SHA2, summary: "o push quebrou o login",
    });
    expect(after).toMatchObject({ phase: "impasse", impasseReason: "rodadas" });
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

describe("push do autor depois do pronto (a IA do autor mexeu no PR)", () => {
  /** Uma revisão em `ready` na rodada `round`, com SHA1 revisado; envios zerados e o orquestrador ligado. */
  async function readyAt(o: Loaded, round: 1 | 3 = 1) {
    const { author, review } = await started(o);
    if (round === 3) {
      await o.store.mutateReview(review.id, (r) => {
        r.round = 3;
      });
    }
    // Da rodada 2 em diante a lista é fechada: a sugestão só entra na rodada 1.
    const ready = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round, findings: round === 1 ? [SUGGESTION] : [], headSha: SHA1, summary: "sem bloqueante",
    });
    expect(ready.phase).toBe("ready");
    send.mockClear();
    calls.length = 0;
    return { author, review: ready, off: o.orch.startReviewOrchestrator({ graceMs: 0 }) };
  }
  const endTurn = async (o: Loaded, cardId: string) => {
    await o.events.observeCardStatus(cardId, "waiting", "working");
    await o.events.observeCardStatus(cardId, "working", "waiting");
  };
  /** Deixa o listener (folga 0) e a leitura do head assentarem. */
  const settle = () => new Promise((r) => setTimeout(r, 40));

  it("fim do turno do autor com push novo: a revisão volta ao revisor na rodada seguinte, sem clique de merge", async () => {
    const o = await load();
    const { author, review, off } = await readyAt(o);
    try {
      prHeadNow = SHA2;
      await endTurn(o, author.id);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.phase).toBe("reviewing"));
      expect(prHead).toHaveBeenCalledWith(author.id, PR.url);
      const after = (await o.store.getReview(review.id))!;
      expect(after).toMatchObject({ round: 2, reviewedSha: SHA1, lastSubmitRound: 1 });
      // o revisor recebe o delta desde o commit aprovado, dizendo que foi o autor que empurrou
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
      expect(calls).toEqual([`actor:u-revisor:${review.reviewerCardId}`, `send:${review.reviewerCardId}`]);
      for (const piece of ["O autor empurrou commits no PR #7", "rodada 2 de 3", `git diff ${SHA1}..HEAD`, "vibehub_review_submit"]) {
        expect(lastText()).toContain(piece);
      }
      expect(lastText()).not.toContain("Merge recusado");
      expect(after.log.at(-1)).toMatchObject({ who: "system" });
      expect(after.log.at(-1)?.text).toMatch(/O autor empurrou depois do pronto \(head bbbbbbb\).*Rodada 2 de 3/);
      expect(deliverSpy).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("vale com uma pessoa usando o card do autor (é ela quem mandou a IA mexer)", async () => {
    const o = await load();
    const { author, review, off } = await readyAt(o);
    try {
      await o.registry.markCardHumanActive(author.id);
      prHeadNow = SHA2;
      await endTurn(o, author.id);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.phase).toBe("reviewing"));
    } finally {
      off();
    }
  });

  it("head igual ao aprovado, ou leitura que falha: a revisão fica pronta e ninguém recebe nada", async () => {
    const o = await load();
    const { author, review, off } = await readyAt(o);
    try {
      prHeadNow = SHA1;
      await endTurn(o, author.id);
      await vi.waitFor(() => expect(prHead).toHaveBeenCalledTimes(1));
      await settle();
      prHeadNow = null;
      await endTurn(o, author.id);
      await vi.waitFor(() => expect(prHead).toHaveBeenCalledTimes(2));
      await settle();
      expect(await o.store.getReview(review.id)).toMatchObject({ phase: "ready", round: 1 });
      expect(send).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("dois fins de turno com o mesmo push reabrem uma vez só", async () => {
    const o = await load();
    const { author, review, off } = await readyAt(o);
    try {
      prHeadNow = SHA2;
      await endTurn(o, author.id);
      await endTurn(o, author.id);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.phase).toBe("reviewing"));
      await settle();
      expect((await o.store.getReview(review.id))?.round).toBe(2);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("na rodada 3 o push depois do pronto volta ao revisor numa conferência extra (aplicar sugestões não trava o PR)", async () => {
    const o = await load();
    const { author, review, off } = await readyAt(o, 3);
    try {
      prHeadNow = SHA2;
      await endTurn(o, author.id);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.phase).toBe("reviewing"));
      expect(await o.store.getReview(review.id)).toMatchObject({ round: 3, lastSubmitRound: 2 });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    } finally {
      off();
    }
  });

  it("fim de turno do revisor não lê o PR; o do autor fora de ready lê, mas push em fixing é a resposta, não reabre", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      prHeadNow = SHA2;
      await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
      await endTurn(o, review.reviewerCardId);
      await settle();
      expect(prHead).not.toHaveBeenCalled();
      // fixing: o autor corrige pela lista; o push dele é a resposta, não um push depois do pronto
      await o.registry.markCardHumanActive(author.id);
      await endTurn(o, author.id);
      await vi.waitFor(() => expect(prHead).toHaveBeenCalledTimes(1));
      await settle();
      expect((await o.store.getReview(review.id))?.phase).toBe("fixing");
    } finally {
      off();
    }
  });

  it("uma leitura velha (o head lido já é o aprovado) não reabre", async () => {
    const o = await load();
    const { review, off } = await readyAt(o);
    off();
    const after = await o.orch.reopenAfterHeadMoved(review.id, "teste", { cause: "push", headSha: SHA1 });
    expect(after).toMatchObject({ phase: "ready", round: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("o delta lista as sugestões em aberto, e o fixed do revisor numa sugestão aplicada vale", async () => {
    const o = await load();
    const { author, review, off } = await readyAt(o);
    try {
      prHeadNow = SHA2;
      await endTurn(o, author.id);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(lastText()).toContain("Sugestões (não bloqueiam)");
      expect(lastText()).toContain("nome de variável confuso");
      const after = await o.orch.submitReviewerRound(review.reviewerCardId, {
        round: 2, findings: [], verdicts: [{ id: "f1", status: "fixed", reviewerReply: "renomeado no diff" }], headSha: SHA2, summary: "ok",
      });
      expect(after).toMatchObject({ phase: "ready", round: 2, reviewedSha: SHA2 });
      expect(after.findings[0]).toMatchObject({ id: "f1", severity: "suggestion", status: "fixed", reviewerReply: "renomeado no diff" });
    } finally {
      off();
    }
  });
});

describe("o PR mudou no GitHub fora do painel (merge à mão, PR fechado)", () => {
  const endTurn = async (o: Loaded, cardId: string) => {
    await o.events.observeCardStatus(cardId, "waiting", "working");
    await o.events.observeCardStatus(cardId, "working", "waiting");
  };
  async function readyReview(o: Loaded) {
    const { author, review } = await started(o);
    const ready = await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "ok" });
    send.mockClear();
    calls.length = 0;
    return { author, review: ready };
  }

  it("mergeado direto no GitHub: no fim do turno do autor a revisão fecha como mergeada, o PR do card é marcado e a branch sai", async () => {
    const o = await load();
    const { author, review } = await readyReview(o);
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      prHeadNow = SHA2;
      prStateNow = "MERGED";
      await endTurn(o, author.id);
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.phase).toBe("merged"));
      const after = (await o.store.getReview(review.id))!;
      expect(after.log.at(-1)).toMatchObject({ who: "system" });
      expect(after.log.at(-1)?.text).toMatch(/Mergeado em dev fora do painel/);
      // o mesmo pós-merge do deliver: PR do card marcado e a branch fora do GitHub
      await vi.waitFor(() => expect(afterMerged).toHaveBeenCalledWith(author.id, PR.url, "dev", PR.branch));
      // o card do revisor sai junto, como no botão
      await vi.waitFor(async () => expect((await o.registry.getCard(review.reviewerCardId))?.column).toBe("done"));
      expect(send).not.toHaveBeenCalled();
      expect(deliverSpy).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("mergeado no GitHub no meio da correção também fecha (qualquer fase aberta)", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    prHeadNow = SHA2;
    prStateNow = "MERGED";
    const after = await o.orch.syncReviewWithGithub(review.id);
    expect(after?.phase).toBe("merged");
    expect(afterMerged).toHaveBeenCalledWith(author.id, PR.url, "dev", PR.branch);
  });

  it("o head atual do PR fica gravado (o painel mostra revisado x atual); em fixing isso não reabre nada", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    expect((await o.store.getReview(review.id))?.prHeadSha).toBe(SHA1);
    prHeadNow = SHA2;
    const after = await o.orch.syncReviewWithGithub(review.id);
    expect(after).toMatchObject({ phase: "fixing", prHeadSha: SHA2, reviewedSha: SHA1 });
    const answered = await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", reply: "ok" }], headSha: SHA3 });
    expect(answered.prHeadSha).toBe(SHA3);
  });

  it("leitura lenta do GitHub não sobrescreve o head mais novo que o autor gravou no meio", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    prHead.mockImplementationOnce(async () => {
      // enquanto o gh pr view demora, o autor responde com o head novo
      await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", reply: "ok" }], headSha: SHA3 });
      return { state: "OPEN", headSha: SHA2 };
    });
    await o.orch.syncReviewWithGithub(review.id);
    expect((await o.store.getReview(review.id))?.prHeadSha).toBe(SHA3);
  });

  it("PR fechado sem merge no GitHub: a revisão é cancelada e a branch fica", async () => {
    const o = await load();
    const { review } = await readyReview(o);
    prHeadNow = SHA1;
    prStateNow = "CLOSED";
    const after = await o.orch.syncReviewWithGithub(review.id);
    expect(after?.phase).toBe("cancelled");
    expect(after?.log.at(-1)?.text).toMatch(/fechado no GitHub sem merge/);
    expect(afterMerged).not.toHaveBeenCalled();
    expect(await o.store.activeReviewFor(review.cardId, 7)).toBeUndefined();
  });

  it("com o merge do botão em andamento, a conferência do GitHub não fecha a revisão como 'fora do painel'", async () => {
    const o = await load();
    const { review } = await readyReview(o);
    prHeadNow = SHA1;
    prStateNow = "MERGED";
    expect(o.orch.claimMerge(review.id)).toBe(true);
    try {
      expect((await o.orch.syncReviewWithGithub(review.id))?.phase).toBe("ready");
      expect(afterMerged).not.toHaveBeenCalled();
      // um segundo merge ao mesmo tempo não pega a vez
      expect(o.orch.claimMerge(review.id)).toBe(false);
    } finally {
      o.orch.releaseMerge(review.id);
    }
    expect((await o.orch.syncReviewWithGithub(review.id))?.phase).toBe("merged");
  });

  it("revisão já encerrada não vai ao GitHub; leitura que falha não muda nada", async () => {
    const o = await load();
    const { review } = await readyReview(o);
    prHeadNow = null;
    expect((await o.orch.syncReviewWithGithub(review.id))?.phase).toBe("ready");
    await o.orch.markReviewMerged(review.id, "merger");
    prHead.mockClear();
    prHeadNow = SHA2;
    prStateNow = "CLOSED";
    expect((await o.orch.syncReviewWithGithub(review.id))?.phase).toBe("merged");
    expect(prHead).not.toHaveBeenCalled();
  });

  it("syncReviewSoon tem freio: duas leituras do painel no mesmo minuto vão ao GitHub uma vez só", async () => {
    const o = await load();
    const { review } = await readyReview(o);
    prHeadNow = SHA1;
    o.orch.syncReviewSoon(review);
    o.orch.syncReviewSoon(review);
    await vi.waitFor(() => expect(prHead).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(prHead).toHaveBeenCalledTimes(1);
  });
});

describe("conversa das IAs: cada fala leva os achados de que trata", () => {
  it("revisor, autor e humano: itens com a resposta daquele momento, e quem fez na fala humana", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const r1 = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [BLOCKER, QUESTION], headSha: SHA1, summary: "um bloqueante e uma dúvida",
    });
    expect(r1.log.find((e) => e.who === "reviewer")).toMatchObject({
      round: 1, text: "um bloqueante e uma dúvida",
      items: [{ id: "f1", status: "open", isNew: true }, { id: "f2", status: "open", isNew: true }],
    });

    const decided = await o.orch.decideQuestion(review.id, "f2", "drop", "mussa");
    expect(decided.log.at(-1)).toMatchObject({ who: "human", by: "mussa", items: [{ id: "f2", status: "dropped" }] });

    const r2 = await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", commit: "c0ffee1", reply: "token fora do log" }], headSha: SHA2,
    });
    expect(r2.log.find((e) => e.who === "author")).toMatchObject({
      round: 1, items: [{ id: "f1", status: "fixed", commit: "c0ffee1", reply: "token fora do log" }],
    });

    const r3 = await o.orch.submitReviewerRound(review.reviewerCardId, {
      round: 2, findings: [], verdicts: [{ id: "f1", status: "open", reviewerReply: "ainda vaza no catch" }], headSha: SHA2, summary: "r2",
    });
    const second = r3.log.filter((e) => e.who === "reviewer").at(-1);
    expect(second).toMatchObject({ round: 2, items: [{ id: "f1", status: "open", reply: "ainda vaza no catch" }] });
    // a fala da rodada 1 do autor continua com a resposta de então, mesmo depois da rodada 2
    expect(r3.log.find((e) => e.who === "author")?.items?.[0]?.reply).toBe("token fora do log");
    // falas de sistema não levam itens
    expect(r3.log.filter((e) => e.who === "system").every((e) => e.items === undefined)).toBe(true);
  });

  it("resposta longa é cortada com reticências e resposta vazia não vira item com reply", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    const after = await o.orch.submitAuthorResponse(author.id, {
      round: 1, items: [{ id: "f1", status: "fixed", reply: "x".repeat(2000) }], headSha: SHA2,
    });
    const reply = after.log.find((e) => e.who === "author")?.items?.[0]?.reply ?? "";
    expect(reply.length).toBe(600);
    expect(reply.endsWith("…")).toBe(true);
    const cancelled = await o.orch.cancelReview(review.id, "kim");
    expect(cancelled.log.at(-1)).toMatchObject({ who: "human", by: "kim" });
    expect(cancelled.log.at(-1)?.items).toBeUndefined();
  });
});

describe("o card do revisor depois da revisão", () => {
  /** Entrar em `done` grava o "concluído" do card numa microtask: o teste espera por ele (e o disco fica quieto). */
  const concluded = async (o: Loaded, cardId: string) =>
    await vi.waitFor(async () =>
      expect((await o.events.eventsAfter(0)).events.some((e) => e.kind === "concluded" && e.cardId === cardId)).toBe(true));

  it("mergeado manda o card do revisor pra done (a retenção recolhe a worktree)", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.registry.applyOpenTerminal(review.reviewerCardId);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "ok" });
    expect((await o.registry.getCard(review.reviewerCardId))?.column).toBe("waiting");

    await o.orch.markReviewMerged(review.id, "merger");
    await concluded(o, review.reviewerCardId);
    const card = await o.registry.getCard(review.reviewerCardId);
    expect(card).toMatchObject({ column: "done", reviewOf: review.cardId });
    expect(card?.doneAt).toBeGreaterThan(0);
    // repetir não mexe (nem lança)
    await expect(o.orch.markReviewMerged(review.id, "merger")).resolves.toMatchObject({ phase: "merged" });
    expect((await o.registry.getCard(review.reviewerCardId))?.doneAt).toBe(card?.doneAt);
  });

  it("cancelado manda o card do revisor pra done; o do autor fica onde está", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.cancelReview(review.id, "u-autor");
    await concluded(o, review.reviewerCardId);
    expect((await o.registry.getCard(review.reviewerCardId))?.column).toBe("done");
    expect((await o.registry.getCard(author.id))?.column).toBe(author.column);
  });

  it("card do revisor que sumiu não impede de cancelar nem de marcar mergeado", async () => {
    const o = await load();
    const { review } = await started(o);
    await o.registry.removeCard(review.reviewerCardId);
    await expect(o.orch.cancelReview(review.id, "u-autor")).resolves.toMatchObject({ phase: "cancelled" });
    await expect(o.orch.markReviewMerged(review.id, "merger")).resolves.toMatchObject({ phase: "merged" });
  });

  it("card excluído: revisão ativa em que ele é autor ou revisor é cancelada; devolve os cards de revisor do autor", async () => {
    const o = await load();
    const { author, review } = await started(o);
    // uma revisão antiga do mesmo card, já mergeada, também deixou um card de revisor
    const old = await o.store.mutateReview(review.id, (r) => {
      r.phase = "merged";
    });
    const current = await o.orch.startReview({
      cardId: author.id, prNumber: 7, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });

    const reviewerCards = await o.orch.closeReviewsOfRemovedCard(author.id, "u-owner");
    expect(reviewerCards.sort()).toEqual([old.reviewerCardId, current.reviewerCardId].sort());
    expect(await o.store.getReview(current.id)).toMatchObject({ phase: "cancelled" });
    expect((await o.store.getReview(current.id))?.log.at(-1)?.text).toMatch(/excluído/);
    // a mergeada fica como está: o histórico não muda
    expect(await o.store.getReview(old.id)).toMatchObject({ phase: "merged" });
    // de novo: nada a cancelar
    await expect(o.orch.closeReviewsOfRemovedCard(author.id, "u-owner")).resolves.toHaveLength(2);

    // o card do revisor excluído sozinho: a revisão dele é cancelada, e não há card de revisor a levar junto
    const other = await o.registry.createCard({ projectId: author.projectId, title: "Outro" });
    await o.registry.recordCardPr(other.id, { ...PR, number: 8, url: "https://github.com/acme/widgets/pull/8" });
    const third = await o.orch.startReview({
      cardId: other.id, prNumber: 8, reviewerUserId: "u-revisor", authorUserId: "u-autor", mergerUserId: "u-merger", by: "u-autor",
    });
    await expect(o.orch.closeReviewsOfRemovedCard(third.reviewerCardId, "u-owner")).resolves.toEqual([]);
    expect(await o.store.getReview(third.id)).toMatchObject({ phase: "cancelled" });
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

  it("vibehub_send_to_terminal recusa o card de um revisor e vibehub_list_terminals não o lista; o orquestrador segue entregando", async () => {
    const o = await load();
    const { author, review } = await started(o);
    const call = await connect();
    actor.mockClear();

    // a IA do autor "ajudando" o revisor: recusado antes de qualquer envio (e o ator do card do revisor não muda)
    const refused = await call("vibehub_send_to_terminal", { cardId: review.reviewerCardId, text: "marca o f1 como fixed", from: author.id });
    expect(JSON.parse(refused.text).error).toMatch(/PR reviewer session.*driven by the review, not by other cards/);
    expect(send).not.toHaveBeenCalled();
    expect(actor).not.toHaveBeenCalled();

    // os outros cards seguem recebendo
    const other = await o.registry.createCard({ projectId: author.projectId, title: "Outro" });
    const sent = await call("vibehub_send_to_terminal", { cardId: other.id, text: "oi", from: author.id });
    expect(JSON.parse(sent.text)).toMatchObject({ sent: true, cardId: other.id });

    // a lista dos terminais não mostra o card do revisor
    const listed = JSON.parse((await call("vibehub_list_terminals", {})).text) as { cardId: string }[];
    expect(listed.map((t) => t.cardId).sort()).toEqual([author.id, other.id].sort());

    // o relay da revisão chama o envio direto: o revisor continua recebendo a vez dele
    send.mockClear();
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [BLOCKER], headSha: SHA1, summary: "r1" });
    await o.orch.submitAuthorResponse(author.id, { round: 1, items: [{ id: "f1", status: "fixed", commit: "c1", reply: "feito" }], headSha: SHA2 });
    expect(send.mock.calls.at(-1)![0]).toBe(review.reviewerCardId);
  });

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
    expect(JSON.parse(responded.text)).toMatchObject({ review: review.id, phase: "reviewing", round: 2, answered: 1 });
    // a mesma resposta de novo não muda nada: answered 0, mesmo com o status já igual ao enviado
    const again = await call("vibehub_review_respond", {
      card: author.id, review: review.id, round: 1, headSha: SHA2, items: [{ id: "f1", status: "fixed", commit: "c1", reply: "feito" }],
    });
    expect(JSON.parse(again.text)).toMatchObject({ answered: 0 });
    expect(deliverSpy).not.toHaveBeenCalled();
  });
});

describe("gate do merge rodado quando a revisão fica pronta", () => {
  const RED = {
    ran: true, passed: false,
    output: "[vibehub] dependência faltando na worktree (@vitejs/plugin-react): rode npm install no card e entregue de novo",
  };
  const authorTurnEnds = async (o: Loaded, cardId: string) => {
    await o.registry.applyCardStatus(cardId, "working");
    await o.events.observeCardStatus(cardId, "waiting", "working");
    await o.registry.applyCardStatus(cardId, "waiting");
    await o.events.observeCardStatus(cardId, "working", "waiting");
  };

  it("caso real (PR #215): pronta e gate vermelho — o veredito fica gravado antes do clique, e o autor recebe a falha", async () => {
    const o = await load();
    const { author, review } = await started(o);
    gateAnswer = RED;
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
    await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.mergeGate?.state).toBe("failed"));
    expect(gateSpy).toHaveBeenCalledWith(author.id, PR.url, SHA1);
    const after = (await o.store.getReview(review.id))!;
    expect(after.phase).toBe("ready");
    expect(after.mergeGate).toMatchObject({ sha: SHA1, state: "failed", output: RED.output });
    await vi.waitFor(() => expect(send.mock.calls.some(([card, text]) => card === author.id && String(text).includes("@vitejs/plugin-react"))).toBe(true));
    const toAuthor = String(send.mock.calls.find(([card]) => card === author.id)?.[1]);
    expect(toAuthor).toContain("falharam no commit aprovado (aaaaaaa)");
    expect(toAuthor).toContain("npm install");
    expect(after.log.at(-1)?.text).toMatch(/Testes do merge vermelhos/);
  });

  it("pronta e gate verde: grava passed no commit aprovado e não manda nada ao autor", async () => {
    const o = await load();
    const { author, review } = await started(o);
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "s" });
    await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.mergeGate?.state).toBe("passed"));
    expect(send.mock.calls.some(([card]) => card === author.id)).toBe(false);
  });

  it("gate ainda rodando: o merge automático espera; ao ficar verde ele sai sozinho", async () => {
    const o = await load();
    const { review } = await started(o);
    let release!: () => void;
    gateGate = new Promise((r) => { release = r; });
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.mergeGate?.state).toBe("running"));
      await o.registry.applyCardStatus(review.reviewerCardId, "working");
      await o.events.observeCardStatus(review.reviewerCardId, "waiting", "working");
      await o.registry.reportCardState(review.reviewerCardId, "ready", "PR #7 aprovado no GitHub");
      await o.registry.applyCardStatus(review.reviewerCardId, "waiting");
      await o.events.observeCardStatus(review.reviewerCardId, "working", "waiting", { state: "ready" });
      await new Promise((r) => setTimeout(r, 40));
      expect(mergeSpy).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(mergeSpy).toHaveBeenCalledWith(review.id, "u-merger", { auto: true }));
    } finally {
      off();
    }
  });

  it("o autor termina um turno com o gate vermelho: roda de novo UMA vez sozinho (o npm install dele chega ao veredito)", async () => {
    const o = await load();
    const { author, review } = await started(o);
    gateAnswer = RED;
    const off = o.orch.startReviewOrchestrator({ graceMs: 0 });
    try {
      await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "limpo" });
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.mergeGate?.state).toBe("failed"));
      expect(gateSpy).toHaveBeenCalledTimes(1);
      await authorTurnEnds(o, author.id);
      await vi.waitFor(() => expect(gateSpy).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.mergeGate).toMatchObject({ state: "failed", autoRetried: true }));
      // vermelho de novo: o próximo turno do autor não roda outra vez (o "Tentar de novo" do painel roda)
      await authorTurnEnds(o, author.id);
      await new Promise((r) => setTimeout(r, 40));
      expect(gateSpy).toHaveBeenCalledTimes(2);
      gateAnswer = { ran: true, passed: true, output: "" };
      await o.orch.retryReview(review.id, "mussa");
      await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.mergeGate?.state).toBe("passed"));
      expect(gateSpy).toHaveBeenCalledTimes(3);
    } finally {
      off();
    }
  });

  it("revisão pronta de antes do gate (sem veredito), ou com 'running' órfão de um deploy: abrir o painel roda o gate", async () => {
    const o = await load();
    const { review } = await started(o);
    let release!: () => void;
    gateGate = new Promise((r) => { release = r; });
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "s" });
    await vi.waitFor(() => expect(gateSpy).toHaveBeenCalledTimes(1));
    // enquanto este processo roda o gate, ler o painel não dispara outro
    await o.orch.reviewForRead((await o.store.getReview(review.id))!);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.mergeGate?.state).toBe("passed"));
    // o processo morreu no meio (deploy): `running` gravado, nada rodando aqui
    await o.store.mutateReview(review.id, (r) => { r.mergeGate = { sha: SHA1, state: "running", at: 1 }; });
    gateGate = null;
    await o.orch.reviewForRead((await o.store.getReview(review.id))!);
    await vi.waitFor(async () => expect((await o.store.getReview(review.id))?.mergeGate?.state).toBe("passed"));
    expect(gateSpy).toHaveBeenCalledTimes(2);
    // verde no commit aprovado: ler de novo não roda nada
    await o.orch.reviewForRead((await o.store.getReview(review.id))!);
    await new Promise((r) => setTimeout(r, 20));
    expect(gateSpy).toHaveBeenCalledTimes(2);
  });

  it("o PR andou enquanto o gate rodava: o veredito velho não pousa na revisão reaberta", async () => {
    const o = await load();
    const { review } = await started(o);
    let release!: () => void;
    gateGate = new Promise((r) => { release = r; });
    gateAnswer = RED;
    await o.orch.submitReviewerRound(review.reviewerCardId, { round: 1, findings: [SUGGESTION], headSha: SHA1, summary: "s" });
    await vi.waitFor(() => expect(gateSpy).toHaveBeenCalledTimes(1));
    await o.orch.reopenAfterHeadMoved(review.id, "teste", { cause: "push", headSha: SHA2 });
    send.mockClear();
    release();
    await new Promise((r) => setTimeout(r, 40));
    const after = (await o.store.getReview(review.id))!;
    expect(after.phase).toBe("reviewing");
    expect(after.mergeGate?.state).toBe("running");
    expect(send).not.toHaveBeenCalled();
  });
});
