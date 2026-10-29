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
 *  - o projeto tem a conexão GitHub da org; o merger tem a dele; ninguém mais tem conexão própria.
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
  await reg.updateProject(projectId, { githubConnectionId: org.id });
  await (await import("../auth/userGit.js")).setUserGit(people.merger!.id, { githubConnectionId: mine.id });
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

/** Uma revisão iniciada e levada a `ready` (rodada 1 sem bloqueante, SHA1 revisado). */
async function readyReview(w: World) {
  const started = await startReview(w);
  expect(started.statusCode).toBe(200);
  const review = started.json().review as { id: string; reviewerCardId: string };
  const ready = await (await orchestrator()).submitReviewerRound(review.reviewerCardId, {
    round: 1, findings: [], headSha: SHA1, summary: "nada bloqueia",
  });
  expect(ready.phase).toBe("ready");
  send.mockClear();
  return ready;
}

const merge = async (reviewId: string, as: Person) =>
  await app.inject({ method: "POST", url: `/api/reviews/${reviewId}/merge`, headers: { cookie: as.cookie } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-review-routes-"));
  send.mockClear();
  deliver.mockClear();
  actorAtDeliver = undefined;
  deliverResult = { prUrl: PR.url, merged: true, reason: "merged", branch: "dev", cardBranch: PR.branch };
  app = await boot();
});
afterEach(async () => {
  await app?.close();
  for (const m of [
    "../runtime/runner.js", "../services/board/workspace.js", "../services/maestro/maestro.js", "../services/maestro/deliver.js",
  ]) vi.doUnmock(m);
  await rm(dir, { recursive: true, force: true });
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

describe("pessoas do card", () => {
  it("people lista owner e quem tem share, com canReview", async () => {
    const w = await world();
    // member chama (GET /api/users é só do owner)
    const res = await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/people`, headers: { cookie: w.autor.cookie } });
    expect(res.statusCode).toBe(200);
    const people = res.json().people as { id: string; username: string; canReview: boolean }[];
    const byName = Object.fromEntries(people.map((p) => [p.username, p]));
    expect(Object.keys(byName).sort()).toEqual(["autor", "cesar", "leitor", "merger", "revisor"]);
    expect(byName.revisor).toEqual({ id: w.revisor.id, username: "revisor", canReview: true });
    expect(byName.autor!.canReview).toBe(false);
    expect(byName.cesar!.canReview).toBe(false);
    // quem não tem acesso ao card não entra (e nem vê a lista)
    expect(people.some((p) => p.id === w.outro.id)).toBe(false);
    expect((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/people`, headers: { cookie: w.outro.cookie } })).statusCode)
      .toBe(404);
  });
});

describe("merge", () => {
  it("só o responsável pelo merge mergeia", async () => {
    const w = await world();
    const review = await readyReview(w);
    for (const who of [w.owner, w.autor, w.revisor, w.leitor, w.outro]) {
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
    await (await orchestrator()).submitReviewerRound(review.reviewerCardId, { round: 1, findings: [], headSha: SHA1, summary: "ok" });
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
    expect(ok.json().review.phase).toBe("ready");
    expect((await decide("nao-existe", w.revisor, { findingId: "f1", decision: "drop" })).statusCode).toBe(404);
  });

  it("owner também decide", async () => {
    const w = await world();
    const review = await withQuestion(w);
    const res = await decide(review.id, w.owner, { findingId: "f1", decision: "block" });
    expect(res.statusCode).toBe(200);
    expect(res.json().review.phase).toBe("fixing");
  });

  it("retry: revisor, merger ou owner; sem nada a tentar é 409", async () => {
    const w = await world();
    const review = (await startReview(w)).json().review as { id: string };
    const retry = async (as: Person) =>
      await app.inject({ method: "POST", url: `/api/reviews/${review.id}/retry`, headers: { cookie: as.cookie } });
    for (const who of [w.autor, w.leitor, w.outro]) expect((await retry(who)).statusCode).toBe(403);
    for (const who of [w.revisor, w.merger, w.owner]) {
      const res = await retry(who);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/nada_a_tentar/);
    }
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
