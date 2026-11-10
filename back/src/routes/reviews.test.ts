import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SendOpts, SendResult } from "../services/maestro/maestro.js";
import type { DeliverOpts, DeliverResult } from "../services/maestro/deliver.js";

/**
 * ROTAS DA REVISÃO DE PR — quem pode iniciar, decidir, tentar de novo, cancelar e, sobretudo,
 * mergear. O servidor, o board, os shares e o store das revisões são REAIS; o que sai para o runner
 * é mock na fronteira: `sendToTerminal` (digitar num card), `deliver` (git/gh) e a aplicação da
 * identidade no runner (`reapplyCardIdentity`). O `recordCardActor` é o de verdade: é ele que diz se
 * o revisor vira o ator do card dele no relay. O merge não mexe no ator: leva a conexão do merger.
 *
 * Cada teste sobe um servidor e faz scrypt de várias senhas: o orçamento é largo de propósito.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let dir = "";
let app: FastifyInstance;

const send = vi.fn(async (cardId: string, _text: string, opts: SendOpts = {}): Promise<SendResult> => {
  await opts.beforeDeliver?.();
  return { sent: true, cardId, title: "", project: "" };
});
/** O ator do card do autor no instante em que o deliver rodou (o token do merge sai dele). */
let actorAtDeliver: string | undefined;
let deliverResult: DeliverResult = { merged: true, reason: "merged", branch: "dev", cardBranch: "card/x" };
/** O PR no GitHub, como `readPrState` o leria (null = leitura que falhou). */
let prState: { state: "OPEN" | "MERGED" | "CLOSED"; headSha: string } | null = null;
const readPrState = vi.fn(async () => prState);
const afterPrMerged = vi.fn(async () => "deleted" as const);
/** O gate do merge no commit aprovado (rodado quando a revisão fica pronta). */
let gateAnswer = { ran: true, passed: true, output: "" };
const gateAtCommit = vi.fn(async (_cardId: string, _prUrl: string, _sha: string) => gateAnswer);
const deliver = vi.fn(async (cardId: string, _opts: DeliverOpts = {}): Promise<DeliverResult> => {
  actorAtDeliver = (await (await import("../services/board/registry.js")).getCard(cardId))?.actorUserId;
  return deliverResult;
});

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  vi.doMock("../services/board/workspace.js", async () => ({
    ...(await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js")),
    prepareCard: vi.fn(async () => undefined),
    openCard: vi.fn(async () => undefined),
    resumeCard: vi.fn(async () => undefined),
    applySessionChange: vi.fn(async () => null),
    killCardSession: vi.fn(async () => undefined),
    reapplyCardIdentity: vi.fn(async () => true),
  }));
  vi.doMock("../services/maestro/maestro.js", async () => ({
    ...(await vi.importActual<typeof import("../services/maestro/maestro.js")>("../services/maestro/maestro.js")),
    sendToTerminal: send,
  }));
  vi.doMock("../services/maestro/deliver.js", async () => ({
    ...(await vi.importActual<typeof import("../services/maestro/deliver.js")>("../services/maestro/deliver.js")),
    deliver,
    gateAtCommit,
    readPrState,
    afterPrMerged,
    setPrPeople: vi.fn(async () => ({})),
  }));
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

const registry = async () => await import("../services/board/registry.js");
const orchestrator = async () => await import("../services/review/orchestrator.js");
const store = async () => await import("../services/review/store.js");

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

const PR = { number: 7, url: "https://github.com/acme/widgets/pull/7", base: "dev", branch: "card/login-ab12" };
const SHA1 = "a".repeat(40);
const BLOCKER = {
  severity: "blocking" as const, title: "token vaza no log", proof: { kind: "failing_test" as const, ref: "src/auth.test.ts:12" },
};

interface Person { id: string; cookie: string }
interface World {
  owner: Person;
  autor: Person;
  revisor: Person;
  merger: Person;
  leitor: Person;
  outro: Person;
  projectId: string;
  cardId: string;
  /** Conexões GitHub: a do projeto e a própria do merger. */
  gh: { project: string; merger: string };
}

/**
 * O dono, um projeto com o card do autor (com o PR #7 gravado) e cinco membros:
 *  - autor: `work` no card; revisor e merger: `work` no projeto; leitor: `view` no card; outro: nada.
 *  - o revisor tem conta Claude própria (`mussa`); os outros não.
 *  - o projeto tem a conexão GitHub da org; o merger e o revisor têm a deles (o revisor publica
 *    os reviews do PR na conta dele); ninguém mais tem conexão própria.
 */
async function world(): Promise<World> {
  const ownerRes = await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "cesar", password: "supersecret" },
  });
  const owner = { id: ownerRes.json().user?.id as string, cookie: cookieOf(ownerRes) };
  const people: Record<string, Person> = {};
  for (const name of ["autor", "revisor", "merger", "leitor", "outro"]) {
    const created = await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: owner.cookie },
      payload: { username: name, password: "supersecret", role: "member" },
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: name, password: "supersecret" } });
    people[name] = { id: created.json().user.id as string, cookie: cookieOf(login) };
  }
  if (!owner.id) owner.id = (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner.cookie } })).json().user.id;
  await app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner.cookie }, payload: { name: "Mussa" } });
  await app.inject({
    method: "PATCH", url: `/api/users/${people.revisor!.id}`, headers: { cookie: owner.cookie }, payload: { claudeAccountSlug: "mussa" },
  });
  const projectId = (await app.inject({
    method: "POST", url: "/api/projects", headers: { cookie: owner.cookie }, payload: { name: "widgets" },
  })).json().project.id as string;
  const cardId = (await app.inject({
    method: "POST", url: "/api/cards", headers: { cookie: owner.cookie }, payload: { projectId, title: "Login" },
  })).json().card.id as string;
  const share = async (path: string, id: string, who: Person, level: string) => {
    const res = await app.inject({
      method: "POST", url: `/api/${path}/${id}/shares`, headers: { cookie: owner.cookie }, payload: { userId: who.id, level },
    });
    expect(res.statusCode).toBe(200);
  };
  await share("cards", cardId, people.autor!, "work");
  await share("projects", projectId, people.revisor!, "work");
  await share("projects", projectId, people.merger!, "work");
  await share("cards", cardId, people.leitor!, "view");
  const reg = await registry();
  await reg.recordCardPr(cardId, PR);
  const org = await reg.addGithubConnection({ label: "org", login: "acme-bot" });
  const mine = await reg.addGithubConnection({ label: "merger", login: "merger-gh" });
  const reviewerGh = await reg.addGithubConnection({ label: "revisor", login: "revisor-gh" });
  await reg.updateProject(projectId, { githubConnectionId: org.id });
  await (await import("../auth/userGit.js")).setUserGit(people.merger!.id, { githubConnectionId: mine.id });
  await (await import("../auth/userGit.js")).setUserGit(people.revisor!.id, { githubConnectionId: reviewerGh.id });
  return {
    owner, autor: people.autor!, revisor: people.revisor!, merger: people.merger!, leitor: people.leitor!, outro: people.outro!,
    projectId, cardId, gh: { project: org.id, merger: mine.id },
  };
}

/** O corpo de "Pedir revisão" com os papéis de sempre (autor corrige, revisor revisa, merger mergeia). */
const roles = (w: World, over: Record<string, unknown> = {}) => ({
  prNumber: 7, reviewerUserId: w.revisor.id, authorUserId: w.autor.id, mergerUserId: w.merger.id, ...over,
});

async function startReview(w: World, as: Person = w.autor, over: Record<string, unknown> = {}) {
  return await app.inject({
    method: "POST", url: `/api/cards/${w.cardId}/review`, headers: { cookie: as.cookie }, payload: roles(w, over),
  });
}

/**
 * Uma sugestão em aberto: deixa a revisão em `ready` sem o merge automático (que só sai sem NADA em
 * pé), para os testes do botão exercitarem o botão.
 */
const OPEN_SUGGESTION = [{ severity: "suggestion" as const, title: "nome confuso" }];

/** Uma revisão iniciada e levada a `ready` (rodada 1 sem bloqueante, SHA1 revisado, merge pelo botão). */
async function readyReview(w: World) {
  const started = await startReview(w);
  expect(started.statusCode).toBe(200);
  const review = started.json().review as { id: string; reviewerCardId: string };
  const ready = await (await orchestrator()).submitReviewerRound(review.reviewerCardId, {
    round: 1, findings: OPEN_SUGGESTION, headSha: SHA1, summary: "nada bloqueia",
  });
  expect(ready.phase).toBe("ready");
  // o gate do merge roda em segundo plano assim que fica pronta: a revisão entregue já tem o veredito
  await vi.waitFor(async () => expect((await (await store()).getReview(ready.id))?.mergeGate?.state).toMatch(/passed|failed/));
  send.mockClear();
  return (await (await store()).getReview(ready.id))!;
}

const merge = async (reviewId: string, as: Person) =>
  await app.inject({ method: "POST", url: `/api/reviews/${reviewId}/merge`, headers: { cookie: as.cookie } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-review-routes-"));
  send.mockClear();
  deliver.mockClear();
  gateAtCommit.mockClear();
  gateAnswer = { ran: true, passed: true, output: "" };
  readPrState.mockClear();
  afterPrMerged.mockClear();
  prState = null;
  actorAtDeliver = undefined;
  deliverResult = { prUrl: PR.url, merged: true, reason: "merged", branch: "dev", cardBranch: PR.branch };
  app = await boot();
});
afterEach(async () => {
  await app?.close();
  for (const m of [
    "../runtime/runner.js", "../services/board/workspace.js", "../services/maestro/maestro.js", "../services/maestro/deliver.js",
  ]) vi.doUnmock(m);
  // Fechar uma revisão manda o card do revisor pra done, e o "concluído" dele é gravado numa
  // microtask: uma escrita dessas pode chegar junto do rm.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("iniciar a revisão", () => {
  it("quem tem work no card inicia: cria a revisão e o card do revisor recebe a rodada 1", async () => {
    const w = await world();
    const res = await startReview(w);
    expect(res.statusCode).toBe(200);
    const review = res.json().review;
    expect(review).toMatchObject({
      cardId: w.cardId, prNumber: 7, base: "dev", phase: "reviewing", round: 1,
      reviewerUserId: w.revisor.id, authorUserId: w.autor.id, mergerUserId: w.merger.id,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    // GET devolve a ativa
    const got = await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.leitor.cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.json().review.id).toBe(review.id);
  });

  it("revisor igual ao autor é recusado", async () => {
    const w = await world();
    const res = await startReview(w, w.autor, { reviewerUserId: w.autor.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/revisor_igual_autor/);
    expect(send).not.toHaveBeenCalled();
  });

  it("card sem PR é recusado", async () => {
    const w = await world();
    const res = await startReview(w, w.autor, { prNumber: 99 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/sem_pr/);
  });

  it("PR mergeado não pode ser revisado", async () => {
    const w = await world();
    await (await registry()).markCardPrMerged(w.cardId, "dev", 7, Date.now());
    const res = await startReview(w);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^pr_mergeado/);
    expect(send).not.toHaveBeenCalled();
  });

  it("segunda revisão ativa no mesmo PR é recusada", async () => {
    const w = await world();
    expect((await startReview(w)).statusCode).toBe(200);
    const again = await startReview(w, w.owner);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/revisao_ativa/);
  });

  it("revisor sem conta Claude própria é recusado", async () => {
    const w = await world();
    const res = await startReview(w, w.autor, { reviewerUserId: w.merger.id, mergerUserId: w.revisor.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/revisor_sem_conta/);
  });

  it("revisor vinculado à conta embutida ('default') revisa, e o card dele roda nela", async () => {
    const w = await world();
    await app.inject({
      method: "PATCH", url: `/api/users/${w.merger.id}`, headers: { cookie: w.owner.cookie }, payload: { claudeAccountSlug: "default" },
    });
    const res = await startReview(w, w.autor, { reviewerUserId: w.merger.id, mergerUserId: w.revisor.id });
    expect(res.statusCode).toBe(200);
    const reviewerCard = await (await registry()).getCard(res.json().review.reviewerCardId);
    // a conta embutida é a ausência de slug no card, como a de um card criado por quem está em "default"
    expect(reviewerCard).toMatchObject({ reviewOf: w.cardId });
    expect(reviewerCard?.accountSlug).toBeUndefined();
  });

  it("revisor sem conexão GitHub própria é recusado (os reviews do PR sairiam na conta de outra pessoa)", async () => {
    const w = await world();
    // "outro" alcança o projeto e tem conta Claude própria, mas nenhuma conexão GitHub dele
    await app.inject({
      method: "POST", url: `/api/projects/${w.projectId}/shares`, headers: { cookie: w.owner.cookie }, payload: { userId: w.outro.id, level: "work" },
    });
    await app.inject({
      method: "PATCH", url: `/api/users/${w.outro.id}`, headers: { cookie: w.owner.cookie }, payload: { claudeAccountSlug: "mussa" },
    });
    const userGit = await import("../auth/userGit.js");
    for (const githubConnectionId of [undefined, "conexao-que-sumiu"]) {
      if (githubConnectionId) await userGit.setUserGit(w.outro.id, { githubConnectionId });
      const res = await startReview(w, w.autor, { reviewerUserId: w.outro.id });
      expect({ githubConnectionId, status: res.statusCode }).toEqual({ githubConnectionId, status: 400 });
      expect(res.json().error).toMatch(/^revisor_sem_github/);
    }
    // nada começou: nem card de revisor, nem revisão, nem rodada 1
    expect(send).not.toHaveBeenCalled();
    expect(await (await store()).activeReviewFor(w.cardId)).toBeUndefined();
    expect((await (await registry()).listAllCards()).filter((c) => c.reviewOf)).toEqual([]);
  });

  it("owner revisor sem conexão GitHub própria usa a do projeto, como no merge", async () => {
    const w = await world();
    await app.inject({
      method: "PATCH", url: `/api/users/${w.owner.id}`, headers: { cookie: w.owner.cookie }, payload: { claudeAccountSlug: "mussa" },
    });
    const res = await startReview(w, w.autor, { reviewerUserId: w.owner.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().review.reviewerUserId).toBe(w.owner.id);
  });

  it("member sem work recebe 403", async () => {
    const w = await world();
    const res = await startReview(w, w.leitor);
    expect(res.statusCode).toBe(403);
    // e quem não enxerga o card nem sabe que ele existe
    expect((await startReview(w, w.outro)).statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect(await (await store()).activeReviewFor(w.cardId)).toBeUndefined();
  });

  it("autor ou merger só com view é recusado", async () => {
    const w = await world();
    for (const over of [{ authorUserId: w.leitor.id }, { mergerUserId: w.leitor.id }]) {
      const res = await startReview(w, w.autor, over);
      expect({ over, status: res.statusCode }).toEqual({ over, status: 400 });
      expect(res.json().error).toMatch(/papel_sem_work/);
    }
    expect(send).not.toHaveBeenCalled();
    expect(await (await store()).activeReviewFor(w.cardId)).toBeUndefined();
  });

  it("revisor com share só no card do autor ganha work no card do revisor e vira ator dele", async () => {
    const w = await world();
    // "outro" passa a alcançar só o card do autor (view), com conta Claude própria
    const share = await app.inject({
      method: "POST", url: `/api/cards/${w.cardId}/shares`, headers: { cookie: w.owner.cookie }, payload: { userId: w.outro.id, level: "view" },
    });
    expect(share.statusCode).toBe(200);
    await app.inject({
      method: "PATCH", url: `/api/users/${w.outro.id}`, headers: { cookie: w.owner.cookie }, payload: { claudeAccountSlug: "mussa" },
    });
    const gh = await (await registry()).addGithubConnection({ label: "outro", login: "outro-gh" });
    await (await import("../auth/userGit.js")).setUserGit(w.outro.id, { githubConnectionId: gh.id });
    const res = await startReview(w, w.autor, { reviewerUserId: w.outro.id });
    expect(res.statusCode).toBe(200);
    const reviewerCardId = res.json().review.reviewerCardId as string;
    const reg = await registry();
    expect(await reg.sharesForTarget("card", reviewerCardId)).toEqual([
      expect.objectContaining({ userId: w.outro.id, level: "work" }),
    ]);
    // a rodada 1 saiu com o revisor como ator do card dele (o gh pr review vai na conta dele)
    expect(send).toHaveBeenCalledTimes(1);
    expect((await reg.getCard(reviewerCardId))?.actorUserId).toBe(w.outro.id);
    // e ele enxerga o card do revisor (abrir a sessão dele pelo painel)
    expect((await app.inject({ method: "GET", url: `/api/cards/${reviewerCardId}`, headers: { cookie: w.outro.cookie } })).statusCode)
      .toBe(200);
  });

  it("papel faltando, PR inválido ou pessoa sem acesso ao card é 400", async () => {
    const w = await world();
    for (const over of [
      { prNumber: "7a" }, { prNumber: 0 }, { mergerUserId: "" }, { reviewerUserId: undefined },
      { mergerUserId: w.outro.id }, { coauthorUserId: w.outro.id }, { authorUserId: "nao-existe" },
    ]) {
      const res = await startReview(w, w.autor, over);
      expect({ over, status: res.statusCode }).toEqual({ over, status: 400 });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("GET da revisão: null sem revisão; depois de cancelada, devolve a última", async () => {
    const w = await world();
    const none = await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.autor.cookie } });
    expect(none.json()).toEqual({ review: null });
    const id = (await startReview(w)).json().review.id as string;
    await app.inject({ method: "POST", url: `/api/reviews/${id}/cancel`, headers: { cookie: w.autor.cookie } });
    const last = await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.autor.cookie } });
    expect(last.json().review).toMatchObject({ id, phase: "cancelled" });
    expect((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.outro.cookie } })).statusCode)
      .toBe(404);
  });
});

/**
 * A REVISÃO PEDIDA PELA IA DO CARD (`vibehub_review_start`): a pessoa disse no chat quem revisa, quem é
 * coautor e que pode mergear, e ainda teve que abrir o "Pedir revisão" e escolher tudo de novo
 * (produção, 2026-11-06). Agora a IA pede em nome de quem deu a ordem (o ator do card), com as MESMAS
 * conferências da rota e os padrões do diálogo para o que não foi dito.
 */
describe("iniciar a revisão pela IA do card (vibehub_review_start)", () => {
  const byAgent = async () => (await import("../services/review/start.js")).startReviewByAgent;
  const actor = async (cardId: string, userId: string) => await (await registry()).stampCardActor(cardId, userId);

  it("os papéis ditos no chat, por nome: revisor e coautor; quem corrige e quem mergeia saem dos padrões", async () => {
    const w = await world();
    await actor(w.cardId, w.autor.id);
    await app.inject({
      method: "POST", url: `/api/projects/${w.projectId}/shares`, headers: { cookie: w.owner.cookie }, payload: { userId: w.outro.id, level: "view" },
    });
    // a ordem veio do merger ("pede revisão pro revisor, coautor o outro, e mergeia quando estiver ok")
    await actor(w.cardId, w.merger.id);
    const review = await (await byAgent())(w.cardId, { reviewer: "REVISOR", coauthor: "@outro" });
    expect(review).toMatchObject({
      prNumber: 7, phase: "reviewing", reviewerUserId: w.revisor.id, coauthorUserId: w.outro.id,
      // sem `merger`: quem deu a ordem; sem `author`: quem trabalha o card agora (o mesmo do diálogo)
      mergerUserId: w.merger.id, authorUserId: w.merger.id,
    });
    expect(send).toHaveBeenCalled(); // a rodada 1 saiu para o revisor, como pelo botão
    expect((await (await store()).activeReviewFor(w.cardId))?.id).toBe(review.id);
  });

  it("autor e merger explícitos valem; o merge automático segue sendo o de sempre (em nome do merger)", async () => {
    const w = await world();
    await actor(w.cardId, w.autor.id);
    const review = await (await byAgent())(w.cardId, { reviewer: "revisor", author: "autor", merger: "merger", pr: 7 });
    expect(review).toMatchObject({ authorUserId: w.autor.id, mergerUserId: w.merger.id, reviewerUserId: w.revisor.id });
  });

  it("recusa com código, sem abrir nada: pessoa desconhecida, sem ordem, PR que não existe, papel sem work", async () => {
    const w = await world();
    const start = await byAgent();
    await expect(start(w.cardId, { reviewer: "revisor" })).rejects.toThrow(/^sem_ordem/);
    await actor(w.cardId, w.autor.id);
    await expect(start(w.cardId, { reviewer: "fulano" })).rejects.toThrow(/^pessoa_desconhecida: revisor "fulano".*revisor/);
    await expect(start(w.cardId, { reviewer: "revisor", pr: 99 })).rejects.toThrow(/^sem_pr: .*#7/);
    await expect(start(w.cardId, { reviewer: "revisor", merger: "leitor" })).rejects.toThrow(/^papel_sem_work/);
    await expect(start(w.cardId, { reviewer: "autor" })).rejects.toThrow(/^revisor_igual_autor/);
    expect(send).not.toHaveBeenCalled();
    expect(await (await store()).activeReviewFor(w.cardId)).toBeUndefined();
    expect((await (await registry()).listAllCards()).filter((c) => c.reviewOf)).toEqual([]);
  });

  it("'terminando pode mergear e concluir o card': a ordem de quem mergeia fica gravada na revisão", async () => {
    const w = await world();
    await actor(w.cardId, w.merger.id);
    const review = await (await byAgent())(w.cardId, {
      reviewer: "revisor", author: "autor", mergeWhenReady: true, concludeWhenMerged: true,
    });
    expect(review).toMatchObject({ mergerUserId: w.merger.id, mergeAuthorized: true, concludeWhenMerged: true });
    expect(review.log.some((e) => /merge autorizado/i.test(e.text))).toBe(true);
  });

  it("só quem mergeia autoriza o próprio merge: a ordem de outra pessoa é recusada, sem abrir nada", async () => {
    const w = await world();
    await actor(w.cardId, w.autor.id);
    await expect((await byAgent())(w.cardId, { reviewer: "revisor", author: "autor", merger: "merger", mergeWhenReady: true }))
      .rejects.toThrow(/^merge_autorizado_de_outro/);
    await expect((await byAgent())(w.cardId, { reviewer: "revisor", author: "autor", merger: "merger", concludeWhenMerged: true }))
      .rejects.toThrow(/^merge_autorizado_de_outro/);
    expect(send).not.toHaveBeenCalled();
    expect(await (await store()).activeReviewFor(w.cardId)).toBeUndefined();
  });

  it("revisão com 'concluir o card' mergeada: o card do autor vai para done", async () => {
    const w = await world();
    await actor(w.cardId, w.merger.id);
    const review = await (await byAgent())(w.cardId, { reviewer: "revisor", author: "autor", concludeWhenMerged: true });
    await (await orchestrator()).markReviewMerged(review.id, "merger");
    expect((await (await registry()).getCard(w.cardId))?.column).toBe("done");
  });

  it("resposta das tools em ready diz o motivo real de o merge não sair sozinho", async () => {
    const { reviewToolAnswer } = await orchestrator();
    const base = {
      id: "r", cardId: "c", projectId: "p", prNumber: 7, prUrl: "u", prBranch: "b", base: "main",
      reviewerUserId: "a", authorUserId: "b", mergerUserId: "c", reviewerCardId: "rc", round: 1,
      phase: "ready" as const, reviewedSha: "a".repeat(40), log: [], nudges: 0, createdAt: 0, updatedAt: 0,
      findings: [{ id: "f1", severity: "suggestion" as const, title: "t", status: "open" as const, introducedInRound: 1 }],
    };
    expect(reviewToolAnswer({ ...base, mergeAuthorized: true, approvePending: true }, "author", 1).next).toMatch(/Approve/);
    expect(reviewToolAnswer({ ...base, mergeAuthorized: true, approvePending: true }, "author", 1).next).not.toMatch(/sugestão/);
    expect(reviewToolAnswer({ ...base, autoMergeFailedRound: 1, findings: [] }, "author", 1).next).toMatch(/merge automático falhou/);
    expect(reviewToolAnswer(base, "author", 1).next).toMatch(/sugestão em aberto/);
    expect(reviewToolAnswer({ ...base, mergeAuthorized: true }, "author", 1).next).toMatch(/mergeia sozinho/);
  });

  it("revisão sem a ordem de concluir, mergeada: o card do autor fica onde está", async () => {
    const w = await world();
    await actor(w.cardId, w.merger.id);
    const plain = await (await byAgent())(w.cardId, { reviewer: "revisor", author: "autor" });
    const before = (await (await registry()).getCard(w.cardId))?.column;
    await (await orchestrator()).markReviewMerged(plain.id, "merger");
    expect(before).not.toBe("done");
    expect((await (await registry()).getCard(w.cardId))?.column).toBe(before);
  });

  it("quem deu a ordem sem work no card não pede revisão em nome de ninguém", async () => {
    const w = await world();
    await actor(w.cardId, w.leitor.id);
    await expect((await byAgent())(w.cardId, { reviewer: "revisor", author: "autor", merger: "merger" }))
      .rejects.toThrow(/^pessoa_sem_acesso: leitor/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("PRs anexados: uma revisão por PR, acompanhada do card que anexou", () => {
  const attached = (n: number) => ({
    number: n, url: `https://github.com/acme/widgets/pull/${n}`, base: "dev", branch: `feat/pr-${n}`, author: "albert-gh", title: `PR ${n}`,
  });

  async function hub() {
    const w = await world();
    await app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: w.owner.cookie }, payload: { name: "Albert" } });
    await app.inject({
      method: "PATCH", url: `/api/users/${w.autor.id}`, headers: { cookie: w.owner.cookie }, payload: { claudeAccountSlug: "albert" },
    });
    await (await registry()).attachCardPrs(w.cardId, [attached(599), attached(600)]);
    return w;
  }
  const read = async (w: World, query: string) =>
    await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review${query}`, headers: { cookie: w.leitor.cookie } });

  it("iniciar um PR anexado cria a revisão no card de correção; ?pr=N lê a dele do card que anexou", async () => {
    const w = await hub();
    const res = await startReview(w, w.autor, { prNumber: 599 });
    expect(res.statusCode).toBe(200);
    const review = res.json().review;
    expect(review).toMatchObject({ prNumber: 599, hubCardId: w.cardId });
    expect(review.cardId).not.toBe(w.cardId);

    expect((await read(w, "?pr=599")).json().review).toMatchObject({ id: review.id, prNumber: 599 });
    expect((await read(w, "?pr=600")).json()).toEqual({ review: null });
    expect((await read(w, "?pr=abc")).statusCode).toBe(400);
    expect((await read(w, "?pr=0")).statusCode).toBe(400);
    // sem `pr`, o de sempre: a revisão do card como autor (este card não é o autor de nenhuma)
    expect((await read(w, "")).json()).toEqual({ review: null });
  });

  it("'concluir o card' num PR anexado conclui o card que deu a ordem (o que anexou), não o de correção", async () => {
    const w = await hub();
    const review = await (await orchestrator()).startReview({
      cardId: w.cardId, prNumber: 599, reviewerUserId: w.revisor.id, authorUserId: w.autor.id, mergerUserId: w.merger.id,
      orders: { concludeWhenMerged: true }, by: "merger",
    });
    expect(review.hubCardId).toBe(w.cardId);
    const fixColumn = (await (await registry()).getCard(review.cardId))?.column;
    await (await orchestrator()).markReviewMerged(review.id, "merger");
    expect((await (await registry()).getCard(w.cardId))?.column).toBe("done");
    expect((await (await registry()).getCard(review.cardId))?.column).toBe(fixColumn);
  });

  it("o card que anexou carrega a revisão mais recente e uma por PR", async () => {
    const w = await hub();
    const a = (await startReview(w, w.autor, { prNumber: 599 })).json().review;
    const b = (await startReview(w, w.autor, { prNumber: 600 })).json().review;
    const card = (await app.inject({ method: "GET", url: `/api/cards/${w.cardId}`, headers: { cookie: w.leitor.cookie } })).json().card;
    expect(card.review).toMatchObject({ id: b.id, prNumber: 600 });
    expect(card.reviews.map((r: { id: string }) => r.id).sort()).toEqual([a.id, b.id].sort());
    // e o card de correção, como autor, tem a dele
    const fix = (await app.inject({ method: "GET", url: `/api/cards/${a.cardId}`, headers: { cookie: w.owner.cookie } })).json().card;
    expect(fix.review).toMatchObject({ id: a.id, prNumber: 599 });
    expect(fix.reviews).toBeUndefined();
  });

  it("autor vinculado à conta embutida ('default') num PR anexado ganha o card de correção nela", async () => {
    const w = await world();
    await app.inject({
      method: "PATCH", url: `/api/users/${w.autor.id}`, headers: { cookie: w.owner.cookie }, payload: { claudeAccountSlug: "default" },
    });
    await (await registry()).attachCardPrs(w.cardId, [attached(599)]);
    const res = await startReview(w, w.autor, { prNumber: 599 });
    expect(res.statusCode).toBe(200);
    const review = res.json().review;
    expect(review).toMatchObject({ prNumber: 599, hubCardId: w.cardId });
    const fix = await (await registry()).getCard(review.cardId);
    expect(fix).toMatchObject({ branch: "feat/pr-599" });
    expect(fix?.accountSlug).toBeUndefined();
    // o revisor segue na conta com nome dele
    expect((await (await registry()).getCard(review.reviewerCardId))?.accountSlug).toBe("mussa");
  });

  it("autor sem conta Claude própria num PR anexado é recusado com autor_sem_conta", async () => {
    const w = await world();
    await (await registry()).attachCardPrs(w.cardId, [attached(599)]);
    const res = await startReview(w, w.autor, { prNumber: 599 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/autor_sem_conta/);
  });
});

describe("GET da revisão: quem está trabalhando agora", () => {
  it("diz se a IA do autor e a do revisor estão num turno, pelo status de cada card", async () => {
    const w = await world();
    const review = (await startReview(w)).json().review as { id: string; reviewerCardId: string };
    const read = async () =>
      (await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.leitor.cookie } })).json();
    expect((await read()).working).toEqual({ author: false, reviewer: false });

    const reg = await registry();
    await reg.applyCardStatus(w.cardId, "working");
    expect((await read()).working).toEqual({ author: true, reviewer: false });

    await reg.applyCardStatus(review.reviewerCardId, "working");
    await reg.applyCardStatus(w.cardId, "waiting");
    expect(await read()).toMatchObject({ review: { id: review.id }, working: { author: false, reviewer: true } });
  });
});

describe("GET da revisão: se há merge rodando agora", () => {
  it("em ready com o merge segurando a vez diz merging e nem vai ao GitHub; sem a vez, confere antes de dizer false", async () => {
    const w = await world();
    const ready = await readyReview(w);
    const read = async () =>
      (await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.autor.cookie } })).json();
    const orch = await orchestrator();
    readPrState.mockClear();
    expect(orch.claimMerge(ready.id)).toBe(true);
    try {
      expect(await read()).toMatchObject({ review: { phase: "ready" }, merging: true });
      expect(readPrState).not.toHaveBeenCalled();
    } finally {
      orch.releaseMerge(ready.id);
    }
    // O PR segue aberto no GitHub no commit revisado: ready e merging false, com a conferência feita.
    prState = { state: "OPEN", headSha: SHA1 };
    expect(await read()).toMatchObject({ review: { phase: "ready" }, merging: false });
    expect(readPrState).toHaveBeenCalledTimes(1);
  });

  it("diz merging enquanto um merge segura a vez, e false depois que ela é devolvida (ou que o servidor reiniciou)", async () => {
    const w = await world();
    const review = (await startReview(w)).json().review as { id: string };
    const read = async () =>
      (await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.leitor.cookie } })).json();
    expect((await read()).merging).toBe(false);

    const orch = await orchestrator();
    expect(orch.claimMerge(review.id)).toBe(true);
    try {
      expect((await read()).merging).toBe(true);
    } finally {
      orch.releaseMerge(review.id);
    }
    // A vez devolvida é o mesmo que um processo novo depois do deploy: nenhum merge rodando.
    expect((await read()).merging).toBe(false);
  });
});

describe("GET da revisão confere o PR no GitHub (merge feito fora do painel)", () => {
  it("o PR mergeado direto no GitHub aparece mergeado já na leitura em ready, e o freio segura o gh por um minuto", async () => {
    const w = await world();
    const ready = await readyReview(w);
    prState = { state: "MERGED", headSha: SHA1 };
    const read = async () =>
      (await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.autor.cookie } })).json();

    // Em ready sem merge rodando a conferência vem antes da resposta: é também o caso do merge que
    // saiu no GitHub e morreu num deploy antes de gravar merged — nunca sai `ready` + `merging:false`.
    expect(await read()).toMatchObject({ review: { phase: "merged" }, merging: false });
    expect((await read()).review.log.at(-1).text).toMatch(/fora do painel/);
    await vi.waitFor(() => expect(afterPrMerged).toHaveBeenCalledTimes(1));
    // Várias leituras em seguida: uma ida só ao GitHub.
    expect(readPrState).toHaveBeenCalledTimes(1);
    expect(ready.id).toBeTruthy();
  });

  it("sem revisão, ou revisão encerrada, a leitura não vai ao GitHub", async () => {
    const w = await world();
    await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.autor.cookie } });
    const id = (await startReview(w)).json().review.id as string;
    await app.inject({ method: "POST", url: `/api/reviews/${id}/cancel`, headers: { cookie: w.autor.cookie } });
    readPrState.mockClear();
    await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/review`, headers: { cookie: w.autor.cookie } });
    await new Promise((r) => setTimeout(r, 30));
    expect(readPrState).not.toHaveBeenCalled();
  });
});

describe("pedir ao autor aplicar sugestões", () => {
  it("revisor, autor, merger e owner pedem; quem não tem papel recebe 403; sugestão inválida é 400", async () => {
    const w = await world();
    const started = (await startReview(w)).json().review as { id: string; reviewerCardId: string };
    await (await orchestrator()).submitReviewerRound(started.reviewerCardId, {
      round: 1, findings: [{ severity: "suggestion", title: "renomear" }], headSha: SHA1, summary: "uma sugestão",
    });
    const ask = async (as: Person, findingIds: unknown) =>
      await app.inject({ method: "POST", url: `/api/reviews/${started.id}/suggestions`, headers: { cookie: as.cookie }, payload: { findingIds } });
    expect((await ask(w.leitor, ["f1"])).statusCode).toBe(403);
    expect((await ask(w.autor, ["f9"])).statusCode).toBe(400);
    expect((await ask(w.autor, "f1")).statusCode).toBe(400);
    send.mockClear();
    const ok = await ask(w.merger, ["f1"]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().review.log.at(-1)).toMatchObject({ who: "human", by: "merger" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("pedir de novo uma sugestão que já está com o autor é 409 (a revisão mudou sob o clique), com o motivo", async () => {
    const w = await world();
    const started = (await startReview(w)).json().review as { id: string; reviewerCardId: string };
    await (await orchestrator()).submitReviewerRound(started.reviewerCardId, {
      round: 1, findings: [{ severity: "suggestion", title: "renomear" }], headSha: SHA1, summary: "uma sugestão",
    });
    const ask = async () =>
      await app.inject({ method: "POST", url: `/api/reviews/${started.id}/suggestions`, headers: { cookie: w.autor.cookie }, payload: { apply: ["f1"] } });
    expect((await ask()).statusCode).toBe(200);
    const again = await ask();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/^ja_pedida: f1/);
  });

  it("'não fazer' (skip) também é desta rota, com as mesmas permissões", async () => {
    const w = await world();
    const started = (await startReview(w)).json().review as { id: string; reviewerCardId: string };
    await (await orchestrator()).submitReviewerRound(started.reviewerCardId, {
      round: 1, findings: [{ severity: "suggestion", title: "renomear" }], headSha: SHA1, summary: "uma sugestão",
    });
    const res = await app.inject({
      method: "POST", url: `/api/reviews/${started.id}/suggestions`, headers: { cookie: w.autor.cookie }, payload: { skip: ["f1"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().review.findings[0]).toMatchObject({ status: "dropped", humanDecision: "drop" });
    const bad = await app.inject({
      method: "POST", url: `/api/reviews/${started.id}/suggestions`, headers: { cookie: w.autor.cookie }, payload: { skip: "f1" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("pessoas do card", () => {
  it("people lista owner e quem tem share, com canReview", async () => {
    const w = await world();
    // member chama (GET /api/users é só do owner)
    const res = await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/people`, headers: { cookie: w.autor.cookie } });
    expect(res.statusCode).toBe(200);
    const people = res.json().people as { id: string; username: string; canReview: boolean }[];
    const byName = Object.fromEntries(people.map((p) => [p.username, p]));
    expect(Object.keys(byName).sort()).toEqual(["autor", "cesar", "leitor", "merger", "revisor"]);
    // o login da conexão GitHub própria vem junto: é por ele que o diálogo acha o autor de um PR anexado
    expect(byName.revisor).toEqual({ id: w.revisor.id, username: "revisor", canReview: true, githubLogin: "revisor-gh" });
    expect(byName.autor!.githubLogin).toBeUndefined();
    expect(byName.autor!.canReview).toBe(false);
    expect(byName.cesar!.canReview).toBe(false);
    // vincular a conta embutida ("default") é ter conta; voltar ao "Herdar" é não ter
    await app.inject({
      method: "PATCH", url: `/api/users/${w.owner.id}`, headers: { cookie: w.owner.cookie }, payload: { claudeAccountSlug: "default" },
    });
    const canReviewOf = async (name: string) =>
      ((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/people`, headers: { cookie: w.autor.cookie } }))
        .json().people as { username: string; canReview: boolean }[]).find((p) => p.username === name)?.canReview;
    expect(await canReviewOf("cesar")).toBe(true);
    await app.inject({
      method: "PATCH", url: `/api/users/${w.owner.id}`, headers: { cookie: w.owner.cookie }, payload: { claudeAccountSlug: null },
    });
    expect(await canReviewOf("cesar")).toBe(false);
    // quem não tem acesso ao card não entra (e nem vê a lista)
    expect(people.some((p) => p.id === w.outro.id)).toBe(false);
    expect((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/people`, headers: { cookie: w.outro.cookie } })).statusCode)
      .toBe(404);
  });
});

describe("merge", () => {
  it("o responsável pelo merge mergeia; quem não tem papel na revisão, não", async () => {
    const w = await world();
    const review = await readyReview(w);
    for (const who of [w.owner, w.leitor, w.outro]) {
      const res = await merge(review.id, who);
      expect({ who: who.id, status: res.statusCode }).toEqual({ who: who.id, status: 403 });
    }
    expect(deliver).not.toHaveBeenCalled();

    const res = await merge(review.id, w.merger);
    expect(res.statusCode).toBe(200);
    expect(res.json().review).toMatchObject({ id: review.id, phase: "merged" });
    // só-merge, preso ao sha revisado, na base do PR, com o merger como ator do card do autor
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toBe(w.cardId);
    expect(deliver.mock.calls[0]![1]).toMatchObject({
      authorized: true, mergeOnly: true, expectedHeadSha: SHA1, branch: "dev", connectionId: w.gh.merger,
    });
    expect((await (await store()).getReview(review.id))?.phase).toBe("merged");
    // mergeada não é ativa, e não mergeia de novo
    expect((await merge(review.id, w.merger)).statusCode).toBe(409);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  /**
   * CONTINUIDADE SEM O RESPONSÁVEL (produção, 2026-11-09): o César era o responsável pelo merge e o
   * Albert, revisor e coautor, não tinha botão nenhum — a revisão pronta parava esperando o César
   * voltar. Quem tem papel na revisão (revisor, autor, coautor) mergeia uma revisão PRONTA, com a
   * conexão GitHub PRÓPRIA dele (o merge passa pela permissão dele no GitHub).
   */
  it("revisor, autor e coautor também mergeiam a revisão pronta, cada um na própria conta GitHub", async () => {
    const w = await world();
    const review = await readyReview(w);
    const res = await merge(review.id, w.revisor);
    expect(res.statusCode).toBe(200);
    expect(res.json().review).toMatchObject({ id: review.id, phase: "merged" });
    const revisorGh = (await (await import("../auth/userGit.js")).getUserGit(w.revisor.id))?.githubConnectionId;
    expect(deliver.mock.calls[0]![1]).toMatchObject({ mergeOnly: true, expectedHeadSha: SHA1, connectionId: revisorGh });
  });

  it("o coautor mergeia; papel sem conexão GitHub própria é recusado com o motivo, não 403", async () => {
    const w = await world();
    const started = await startReview(w, w.autor, { coauthorUserId: w.outro.id });
    expect(started.statusCode).toBe(400); // "outro" não alcança o card: o coautor precisa alcançar
    await app.inject({
      method: "POST", url: `/api/projects/${w.projectId}/shares`, headers: { cookie: w.owner.cookie }, payload: { userId: w.outro.id, level: "work" },
    });
    const ok = await startReview(w, w.autor, { coauthorUserId: w.outro.id });
    expect(ok.statusCode).toBe(200);
    const id = ok.json().review.id as string;
    await (await orchestrator()).submitReviewerRound(ok.json().review.reviewerCardId, {
      round: 1, findings: OPEN_SUGGESTION, headSha: SHA1, summary: "nada bloqueia",
    });
    // coautor e autor têm papel, mas nenhum dos dois tem conexão GitHub própria
    for (const who of [w.outro, w.autor]) {
      const res = await merge(id, who);
      expect({ who: who.id, status: res.statusCode }).toEqual({ who: who.id, status: 400 });
      expect(res.json().error).toMatch(/^merger_sem_github/);
    }
    const gh = await (await registry()).addGithubConnection({ label: "outro", login: "outro-gh" });
    await (await import("../auth/userGit.js")).setUserGit(w.outro.id, { githubConnectionId: gh.id });
    const res = await merge(id, w.outro);
    expect(res.statusCode).toBe(200);
    expect(deliver.mock.calls.at(-1)![1]).toMatchObject({ connectionId: gh.id });
  });

  it("gate verde no commit aprovado: o clique mergeia sem rodar o gate de novo (gatePassed)", async () => {
    const w = await world();
    const review = await readyReview(w);
    expect(review.mergeGate).toMatchObject({ sha: SHA1, state: "passed" });
    const res = await merge(review.id, w.merger);
    expect(res.statusCode).toBe(200);
    expect(deliver.mock.calls[0]![1]).toMatchObject({ mergeOnly: true, expectedHeadSha: SHA1, gatePassed: true });
    expect(gateAtCommit).toHaveBeenCalledTimes(1);
  });

  it("caso real (PR #215): gate vermelho no commit aprovado — o clique responde NA HORA com a falha, sem deliver", async () => {
    const w = await world();
    gateAnswer = { ran: true, passed: false, output: "FAIL src/services/secrets/audit.test.ts > Test timed out in 5000ms." };
    const review = await readyReview(w);
    const res = await merge(review.id, w.merger);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/os testes do merge falharam no commit aprovado/);
    expect(res.json().error).toContain("audit.test.ts");
    expect(deliver).not.toHaveBeenCalled();
    // quem não tem papel segue levando 403, não a falha do gate
    expect((await merge(review.id, w.outro)).statusCode).toBe(403);
  });

  it("gate ainda rodando: o clique é recusado na hora (gate_running), sem deliver", async () => {
    const w = await world();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    gateAtCommit.mockImplementationOnce(async () => { await held; return gateAnswer; });
    const started = await startReview(w);
    const id = started.json().review.id as string;
    await (await orchestrator()).submitReviewerRound(started.json().review.reviewerCardId, {
      round: 1, findings: OPEN_SUGGESTION, headSha: SHA1, summary: "nada bloqueia",
    });
    await vi.waitFor(() => expect(gateAtCommit).toHaveBeenCalled());
    const res = await merge(id, w.merger);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/ainda estão rodando/);
    expect(deliver).not.toHaveBeenCalled();
    release();
    await vi.waitFor(async () => expect((await (await store()).getReview(id))?.mergeGate?.state).toBe("passed"));
    expect((await merge(id, w.merger)).statusCode).toBe(200);
  });

  it("dois cliques no merge ao mesmo tempo mergeiam uma vez só", async () => {
    const w = await world();
    const review = await readyReview(w);
    const [a, b] = await Promise.all([merge(review.id, w.merger), merge(review.id, w.merger)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await (await store()).getReview(review.id))?.phase).toBe("merged");
  });

  it("merge com head diferente do revisado é recusado e reabre a revisão", async () => {
    const w = await world();
    const review = await readyReview(w);
    deliverResult = {
      prUrl: PR.url, merged: false, reason: "head_moved", branch: "dev", cardBranch: PR.branch, output: "o PR está em bbbbbbb",
    };
    const res = await merge(review.id, w.merger);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "head_moved", review: { phase: "reviewing", round: 2 } });
    const after = await (await store()).getReview(review.id);
    expect(after).toMatchObject({ phase: "reviewing", round: 2, reviewedSha: SHA1 });
    // o revisor recebe o delta da rodada 2 (o mesmo caminho do relay)
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);
    expect(String(send.mock.calls[0]![1])).toContain(`git diff ${SHA1}..HEAD`);
  });

  it("merge só acontece em ready", async () => {
    const w = await world();
    const started = (await startReview(w)).json().review as { id: string; reviewerCardId: string };
    // em reviewing
    expect((await merge(started.id, w.merger)).statusCode).toBe(409);
    // em fixing
    const fixing = await (await orchestrator()).submitReviewerRound(started.reviewerCardId, {
      round: 1, findings: [BLOCKER], headSha: SHA1, summary: "um bloqueante",
    });
    expect(fixing.phase).toBe("fixing");
    const res = await merge(started.id, w.merger);
    expect(res.statusCode).toBe(409);
    expect(res.json().phase).toBe("fixing");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("falha do gh (403) volta como está: sem outra credencial, revisão segue em ready", async () => {
    const w = await world();
    const review = await readyReview(w);
    deliverResult = {
      prUrl: PR.url, merged: false, reason: "merge_failed", branch: "dev", cardBranch: PR.branch,
      output: "GraphQL: merger does not have permission to merge (HTTP 403)",
    };
    const res = await merge(review.id, w.merger);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "merge_failed", result: { output: expect.stringContaining("403") } });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await (await store()).getReview(review.id))?.phase).toBe("ready");
  });

  it("responsável pelo merge que perdeu o work no card é recusado antes do deliver", async () => {
    const w = await world();
    const review = await readyReview(w);
    // o share do projeto cai para view depois que a revisão começou
    await app.inject({
      method: "POST", url: `/api/projects/${w.projectId}/shares`, headers: { cookie: w.owner.cookie },
      payload: { userId: w.merger.id, level: "view" },
    });
    const res = await merge(review.id, w.merger);
    expect(res.statusCode).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("merger sem conexão própria é recusado e o deliver nunca é chamado", async () => {
    const w = await world();
    const review = await readyReview(w);
    const userGit = await import("../auth/userGit.js");
    await userGit.setUserGit(w.merger.id, { githubConnectionId: null });
    const res = await merge(review.id, w.merger);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/merger_sem_github/);
    // uma conexão que o owner removeu também não vale: não cai para a do projeto
    const gone = await (await registry()).addGithubConnection({ label: "velha", login: "merger-velho" });
    await userGit.setUserGit(w.merger.id, { githubConnectionId: gone.id });
    await (await registry()).removeGithubConnection(gone.id);
    expect((await merge(review.id, w.merger)).json().error).toMatch(/merger_sem_github/);
    expect(deliver).not.toHaveBeenCalled();
    expect((await (await store()).getReview(review.id))?.phase).toBe("ready");
  });

  it("owner sem conexão própria usa a do projeto", async () => {
    const w = await world();
    const started = await startReview(w, w.autor, { mergerUserId: w.owner.id });
    expect(started.statusCode).toBe(200);
    const review = started.json().review as { id: string; reviewerCardId: string };
    await (await orchestrator()).submitReviewerRound(review.reviewerCardId, { round: 1, findings: OPEN_SUGGESTION, headSha: SHA1, summary: "ok" });
    const res = await merge(review.id, w.owner);
    expect(res.statusCode).toBe(200);
    expect(deliver.mock.calls[0]![1]).toMatchObject({ mergeOnly: true, connectionId: w.gh.project });
  });

  it("merge sai com a conexão do merger, não a do ator do card", async () => {
    const w = await world();
    const reg = await registry();
    const autorGh = await reg.addGithubConnection({ label: "autor", login: "autor-gh" });
    await (await import("../auth/userGit.js")).setUserGit(w.autor.id, { githubConnectionId: autorGh.id });
    const review = await readyReview(w);
    await reg.stampCardActor(w.cardId, w.autor.id);

    const res = await merge(review.id, w.merger);
    expect(res.statusCode).toBe(200);
    expect(deliver.mock.calls[0]![1]).toMatchObject({ connectionId: w.gh.merger });
    // o ator do card do autor não muda: nem durante o deliver, nem depois
    expect(actorAtDeliver).toBe(w.autor.id);
    expect((await reg.getCard(w.cardId))?.actorUserId).toBe(w.autor.id);
  });
});

describe("decidir, tentar de novo e cancelar", () => {
  /** Uma revisão em reviewing com uma dúvida pendente (f1) esperando o revisor humano. */
  async function withQuestion(w: World) {
    const review = (await startReview(w)).json().review as { id: string; reviewerCardId: string };
    await (await orchestrator()).submitReviewerRound(review.reviewerCardId, {
      round: 1, findings: [{ severity: "question", title: "a sessão expira no checkout?" }], headSha: SHA1, summary: "uma dúvida",
    });
    return review;
  }
  const decide = async (id: string, as: Person, body: Record<string, unknown>) =>
    await app.inject({ method: "POST", url: `/api/reviews/${id}/decide`, headers: { cookie: as.cookie }, payload: body });

  it("só o revisor (ou um owner) decide; decisão fora da lista é 400", async () => {
    const w = await world();
    const review = await withQuestion(w);
    for (const who of [w.autor, w.merger, w.leitor, w.outro]) {
      expect((await decide(review.id, who, { findingId: "f1", decision: "drop" })).statusCode).toBe(403);
    }
    expect((await decide(review.id, w.revisor, { findingId: "f1", decision: "talvez" })).statusCode).toBe(400);
    expect((await decide(review.id, w.revisor, { findingId: "f1" })).statusCode).toBe(400);
    const ok = await decide(review.id, w.revisor, { findingId: "f1", decision: "drop" });
    expect(ok.statusCode).toBe(200);
    // Retirada a única dúvida, a revisão vai a ready; o merge automático espera o Approve do revisor
    // (o fim de turno dele), então a rota responde na hora e nada é mergeado aqui.
    expect(ok.json().review.phase).toBe("ready");
    expect(deliver).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mergeOnly: true }));
    expect((await decide("nao-existe", w.revisor, { findingId: "f1", decision: "drop" })).statusCode).toBe(404);
  });

  it("owner também decide", async () => {
    const w = await world();
    const review = await withQuestion(w);
    const res = await decide(review.id, w.owner, { findingId: "f1", decision: "block" });
    expect(res.statusCode).toBe(200);
    expect(res.json().review.phase).toBe("fixing");
  });

  it("retry: revisor, merger ou owner; esperando a decisão humana é 409; vez parada ou impasse reenviam", async () => {
    const w = await world();
    // só dúvida, com a rodada do revisor entregue: a vez é do humano, não há o que tentar
    const review = await withQuestion(w);
    const retry = async (as: Person) =>
      await app.inject({ method: "POST", url: `/api/reviews/${review.id}/retry`, headers: { cookie: as.cookie } });
    for (const who of [w.autor, w.leitor, w.outro]) expect((await retry(who)).statusCode).toBe(403);
    for (const who of [w.revisor, w.merger, w.owner]) {
      const res = await retry(who);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/nada_a_tentar/);
    }
    // a vez do revisor parada (a rodada não foi entregue): reenvia sem mudar a fase
    await (await store()).mutateReview(review.id, (r) => {
      r.lastSubmitRound = undefined;
    });
    send.mockClear();
    const again = await retry(w.merger);
    expect(again.statusCode).toBe(200);
    expect(again.json().review.phase).toBe("reviewing");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(review.reviewerCardId);

    await (await store()).mutateReview(review.id, (r) => {
      r.phase = "impasse";
      r.impasseReason = "IA não respondeu";
    });
    send.mockClear();
    const res = await retry(w.revisor);
    expect(res.statusCode).toBe(200);
    expect(res.json().review.phase).toBe("reviewing");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancelar: revisor, autor, merger ou owner; encerrada é 409", async () => {
    const w = await world();
    const cancel = async (id: string, as: Person) =>
      await app.inject({ method: "POST", url: `/api/reviews/${id}/cancel`, headers: { cookie: as.cookie } });
    const first = (await startReview(w)).json().review as { id: string };
    for (const who of [w.leitor, w.outro]) expect((await cancel(first.id, who)).statusCode).toBe(403);
    const res = await cancel(first.id, w.autor);
    expect(res.statusCode).toBe(200);
    expect(res.json().review.phase).toBe("cancelled");
    expect((await cancel(first.id, w.autor)).statusCode).toBe(409);
    for (const who of [w.revisor, w.merger, w.owner]) {
      const id = (await startReview(w)).json().review.id as string;
      expect((await cancel(id, who)).statusCode).toBe(200);
    }
  });
});
