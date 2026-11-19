import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenPull } from "../github/client.js";
import type { PublicUser } from "../../auth/users.js";
import type { SendOpts } from "../maestro/maestro.js";

/**
 * PR ANALYSIS — the board is REAL (temporary directory); what leaves the process is mocked at the
 * boundary: GitHub (`listOpenPulls`) and typing into the card (`sendToTerminal`).
 */

// The purge after a failed start goes through the whole card teardown: generous under a loaded runner.
vi.setConfig({ testTimeout: 30_000 });

let dir = "";
let pulls: OpenPull[] = [];
let githubDown = false;
/** The asker's GitHub account does not see the repository: GitHub answers 404 and the client gives null. */
let repoHidden = false;
const listOpenPulls = vi.fn(async (): Promise<OpenPull[] | null> => {
  if (githubDown) throw new Error("GitHub returned 502 while listing pull requests");
  return repoHidden ? null : pulls;
});
/** One PR by number, as GitHub would answer: the open ones come from `pulls`, the rest is closed or unknown. */
let closed: OpenPull[] = [];
const readPull = vi.fn(async (_c: unknown, _o: string, _r: string, n: number) => {
  if (githubDown) throw new Error("GitHub returned 502 while reading the pull request");
  const open = pulls.find((p) => p.number === n);
  if (open) return { ...open, open: true };
  const gone = closed.find((p) => p.number === n);
  return gone ? { ...gone, open: false } : null;
});
const sendToTerminal = vi.fn(async (cardId: string, _text: string, opts: SendOpts = {}) => {
  await opts.beforeDeliver?.();
  return { sent: true, cardId, title: "", project: "" };
});

const pull = (n: number, extra: Partial<OpenPull> = {}): OpenPull => ({
  number: n, title: `PR ${n}`, url: `https://github.com/acme/widgets/pull/${n}`, author: "albert-gh",
  branch: `feat/pr-${n}`, base: "dev", fromFork: false, draft: false, updatedAt: "2026-11-16T12:00:00Z", ...extra,
});

/** A user `findUser` no longer finds (deleted mid-request); the listing still had them. */
let vanished: string | undefined;

/** Albert opened the PRs (`albert-gh`); Mussa reviews them. Both are real users with a GitHub connection each. */
let albert: PublicUser;
let mussa: PublicUser;

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  vi.doMock("../github/client.js", async () => ({
    ...(await vi.importActual<typeof import("../github/client.js")>("../github/client.js")),
    listOpenPulls,
    readPull,
  }));
  vi.doMock("../maestro/maestro.js", async () => ({
    ...(await vi.importActual<typeof import("../maestro/maestro.js")>("../maestro/maestro.js")),
    sendToTerminal,
  }));
  vi.doMock("../board/workspace.js", async () => ({
    ...(await vi.importActual<typeof import("../board/workspace.js")>("../board/workspace.js")),
    reapplyCardIdentity: vi.fn(async () => true),
  }));
  vi.doMock("../../auth/users.js", async () => {
    const actual = await vi.importActual<typeof import("../../auth/users.js")>("../../auth/users.js");
    return { ...actual, findUser: async (id: string) => (id === vanished ? undefined : actual.findUser(id)) };
  });
  const registry = await import("../board/registry.js");
  registry.resetForTesting();
  const analysis = await import("./analysis.js");
  const project = await registry.createProject({
    name: "widgets", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", baseBranch: "main",
  });
  const users = await import("../../auth/users.js");
  const userGit = await import("../../auth/userGit.js");
  const person = async (username: string, login: string, gitName: string, gitEmail: string) => {
    const id = (await users.createUser(username, "supersecret1")).id;
    const connection = await registry.addGithubConnection({ login });
    await userGit.setUserGit(id, { githubConnectionId: connection.id, gitName, gitEmail });
    // they work on the project (a project share with `work`), as the route demands
    await registry.shareWith({ kind: "project", targetId: project.id, userId: id, level: "work" });
    return (await users.findUser(id))!;
  };
  albert = await person("albert", "albert-gh", "Albert-Reginato", "albert@example.com");
  mussa = await person("mussa", "mussa-gh", "wellesley-mussolini", "xerif.off@gmail.com");
  return { registry, analysis, project, users, userGit, person };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-analysis-"));
  pulls = [pull(7), pull(8, { fromFork: true, branch: "patch" })];
  githubDown = false;
  repoHidden = false;
  closed = [pull(5)];
  listOpenPulls.mockClear();
  readPull.mockClear();
  sendToTerminal.mockClear();
  vanished = undefined;
});
afterEach(async () => {
  vi.doUnmock("../github/client.js");
  vi.doUnmock("../maestro/maestro.js");
  vi.doUnmock("../board/workspace.js");
  vi.doUnmock("../../auth/users.js");
  await rm(dir, { recursive: true, force: true });
});

describe("listProjectPulls", () => {
  it("devolve as PRs abertas do GitHub e marca a que já tem análise aberta", async () => {
    const { analysis, project } = await load();
    const started = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    await started.prompt;
    const listed = await analysis.listProjectPulls(project.id, albert);
    expect(listOpenPulls).toHaveBeenCalledWith(expect.any(String), "acme", "widgets");
    expect(listed.find((p) => p.number === 7)?.analysisCardId).toBe(started.card.id);
    expect(listed.find((p) => p.number === 8)?.analysisCardId).toBeUndefined();
  });

  it("marca a PR cuja branch o vibehub não aceita, para a tela não oferecer uma análise que falharia", async () => {
    const { analysis, project } = await load();
    pulls.push(pull(9, { branch: "feat/ação-estoque" }));
    const listed = await analysis.listProjectPulls(project.id, albert);
    expect(listed.find((p) => p.number === 9)?.unsupportedBranch).toBe(true);
    expect(listed.find((p) => p.number === 7)).not.toHaveProperty("unsupportedBranch");
  });

  it("projeto sem repositório no GitHub é recusado, e GitHub fora do ar falha à vista", async () => {
    const { analysis, registry, project } = await load();
    const bare = await registry.createProject({ name: "solto" });
    await expect(analysis.listProjectPulls(bare.id, albert)).rejects.toThrow(/sem_repositorio/);
    githubDown = true;
    await expect(analysis.listProjectPulls(project.id, albert)).rejects.toThrow(/502/);
  });

  it("repositório que a conta de quem pede não enxerga é recusado dizendo a conta e o repositório", async () => {
    const { analysis, project } = await load();
    repoHidden = true;
    await expect(analysis.listProjectPulls(project.id, albert)).rejects.toThrow(/^sem_acesso_repo: .*albert-gh.*acme\/widgets/);
  });
});

describe("analysisPeople", () => {
  it("lista quem trabalha no projeto, com o login do GitHub com que cada um empurraria", async () => {
    const { analysis, project, users } = await load();
    await users.createUser("kim", "supersecret1");
    const people = await analysis.analysisPeople(project.id);
    expect(people.map((p) => [p.username, p.githubLogin])).toEqual([["albert", "albert-gh"], ["mussa", "mussa-gh"]]);
  });
});

describe("startAnalysis", () => {
  it("cria o card na branch da PR, grava a PR e manda o prompt em nome de quem pediu", async () => {
    const { analysis, registry, project } = await load();
    const { card, created, prompt } = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    await prompt;
    expect(created).toBe(true);
    expect(card).toMatchObject({ projectId: project.id, title: "Análise PR #7 · PR 7", base: "feat/pr-7", pushBranch: "feat/pr-7" });
    expect((await registry.getCard(card.id))?.prs?.[0]).toMatchObject({ number: 7, url: pull(7).url, base: "dev", branch: "feat/pr-7" });
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    const [cardId, text, opts] = sendToTerminal.mock.calls[0]!;
    expect(cardId).toBe(card.id);
    expect(text).toContain("[vibehub · análise de PR] PR #7");
    expect(opts).toMatchObject({ wake: true, requireAgent: true, viaNativeChat: true, guardInteractiveMenu: true });
    // the commits and the PR comments go out on the REVIEWER's account, not on the one of whoever clicked
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
  });

  it("repetir a mesma PR devolve o card que já existe, sem outro prompt", async () => {
    const { analysis, project } = await load();
    const first = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    await first.prompt;
    const again = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    expect(again).toMatchObject({ created: false, card: { id: first.card.id } });
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
  });

  it("dois pedidos ao mesmo tempo para a mesma PR criam um card só", async () => {
    const { analysis, registry, project } = await load();
    const [a, b] = await Promise.all([
      analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id }),
      analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id }),
    ]);
    await Promise.all([a.prompt, b.prompt]);
    expect(a.card.id).toBe(b.card.id);
    expect((await registry.listCards(project.id)).filter((c) => c.pushBranch === "feat/pr-7")).toHaveLength(1);
  });

  it("análise concluída não segura a PR: pedir de novo abre um card novo", async () => {
    const { analysis, registry, project } = await load();
    const first = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    await first.prompt;
    await registry.updateCard(first.card.id, { column: "done" });
    const again = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    expect(again.created).toBe(true);
    expect(again.card.id).not.toBe(first.card.id);
  });

  it("card de análise reativado depois da frota indisponível não segura a PR: a lista não o mostra e pedir de novo abre um card novo", async () => {
    const { analysis, registry, project } = await load();
    const first = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    await first.prompt;
    const reportService = await import("./analysisReport.js");
    await reportService.recordAnalysisReport(first.card.id, {
      headSha: "a".repeat(40), stage: "fleet_unavailable", summary: "frota indisponível", dimensions: [], findings: [],
      refutedCount: 0, unavailableReason: "Workflow desligado",
    });
    await registry.applyCardStatus(first.card.id, "working");
    await registry.applyCardStatus(first.card.id, "waiting");
    expect((await registry.getCard(first.card.id))?.column).not.toBe("done");
    const listed = await analysis.listProjectPulls(project.id, albert);
    expect(listed.find((listedPull) => listedPull.number === 7)?.analysisCardId).toBeUndefined();
    const again = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    await again.prompt;
    expect(again.created).toBe(true);
    expect(again.card.id).not.toBe(first.card.id);
  });

  it("responde assim que o card existe: subir o card e entregar o prompt não seguram o pedido", async () => {
    const { analysis, project } = await load();
    let deliver!: () => void;
    sendToTerminal.mockImplementationOnce(async (cardId: string) => {
      await new Promise<void>((resolve) => { deliver = resolve; });
      return { sent: true, cardId, title: "", project: "" };
    });
    const started = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    expect(started.created).toBe(true);
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    // the prompt is still on its way, and a second click already answers with the same card
    expect(await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id })).toMatchObject({ created: false, card: { id: started.card.id } });
    deliver();
    await started.prompt;
  });

  it("se o prompt não chega ao card, o card vai para concluído com o motivo para quem pediu: tentar de novo cria outro", async () => {
    const { analysis, registry, project } = await load();
    sendToTerminal.mockRejectedValueOnce(new Error("card has no live session"));
    const events = await import("../events/cardEvents.js");
    const heard: import("../events/cardEvents.js").CardEvent[] = [];
    const stop = events.onCardEvent((e) => void heard.push(e));
    const first = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    await first.prompt;
    stop();
    expect((await registry.getCard(first.card.id))?.column).toBe("done");
    // the one who asked hears why, instead of the card vanishing after the "started" toast
    const notice = heard.find((e) => e.cardId === first.card.id && e.kind === "message");
    expect(notice).toMatchObject({ messageType: "error", text: expect.stringMatching(/PR #7 não começou.*card has no live session/) });
    expect(await events.canHear(albert, notice!)).toBe(true);
    const retry = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id });
    expect(retry.created).toBe(true);
    await retry.prompt;
    expect(sendToTerminal).toHaveBeenCalledTimes(2);
  });

  it("revisor que some no meio do pedido é recusado antes de criar o card", async () => {
    const { analysis, registry, project } = await load();
    vanished = mussa.id;
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id }))
      .rejects.toThrow(/pessoa_sem_acesso/);
    expect(await registry.listCards(project.id)).toHaveLength(0);
    expect(sendToTerminal).not.toHaveBeenCalled();
  });

  it("quem abriu a PR não a revisa: escolher o autor como revisor é recusado", async () => {
    const { analysis, registry, project } = await load();
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: mussa, reviewerUserId: albert.id }))
      .rejects.toThrow(/revisor_igual_autor/);
    expect(await registry.listCards(project.id)).toHaveLength(0);
  });

  it("o coautor ganha o crédito em cada commit da análise", async () => {
    const { analysis, project, person } = await load();
    const cesar = await person("cesar", "cesar-gh", "Cesar Canal", "cesar@example.com");
    const { prompt } = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id, coauthorUserId: cesar.id });
    await prompt;
    expect(sendToTerminal.mock.calls[0]![1]).toContain("Co-authored-by: Cesar Canal <cesar@example.com>");
  });

  it("o revisor também pode ser o coautor: revisou e escreveu junto com quem abriu a PR", async () => {
    const { analysis, project } = await load();
    const { created, prompt } = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: mussa, reviewerUserId: mussa.id, coauthorUserId: mussa.id });
    await prompt;
    expect(created).toBe(true);
    expect(sendToTerminal.mock.calls[0]![1]).toContain("Co-authored-by: wellesley-mussolini <xerif.off@gmail.com>");
  });

  it("quem abriu a PR não é coautor dela: escolher o autor como coautor é recusado", async () => {
    const { analysis, registry, project } = await load();
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: mussa, reviewerUserId: mussa.id, coauthorUserId: albert.id }))
      .rejects.toThrow(/coautor_igual_autor/);
    expect(await registry.listCards(project.id)).toHaveLength(0);
    expect(sendToTerminal).not.toHaveBeenCalled();
  });

  it("revisor sem trabalho no projeto ou coautor sem identidade git são recusados", async () => {
    const { analysis, registry, project, users, userGit } = await load();
    const outsider = (await users.createUser("kim", "supersecret1")).id;
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: outsider }))
      .rejects.toThrow(/pessoa_sem_acesso/);
    await userGit.setUserGit(mussa.id, { gitEmail: null });
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: mussa, reviewerUserId: mussa.id, coauthorUserId: mussa.id }))
      .rejects.toThrow(/coautor_sem_identidade/);
    expect(await registry.listCards(project.id)).toHaveLength(0);
  });

  it("PR com revisão de duas IAs em andamento é recusada: o push da análise mexeria no que está sendo revisado", async () => {
    const { analysis, registry, project } = await load();
    const store = await import("./store.js");
    const now = Date.now();
    await store.insertReview({
      id: "rev-1", cardId: "card-a", projectId: project.id, prNumber: 7, prUrl: pull(7).url, prBranch: "feat/pr-7", base: "dev",
      reviewerUserId: "u-r", authorUserId: "u-a", mergerUserId: "u-m", reviewerCardId: "card-r",
      round: 1, phase: "reviewing", findings: [], log: [], nudges: 0, createdAt: now, updatedAt: now,
    });
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert, reviewerUserId: mussa.id })).rejects.toThrow(/revisao_ativa/);
    expect(await registry.listCards(project.id)).toHaveLength(0);
  });

  it("PR de fork, fechada, inexistente ou com branch que o vibehub não aceita é recusada sem criar card", async () => {
    const { analysis, registry, project } = await load();
    pulls.push(pull(9, { branch: "feat/ação-estoque" }));
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 8, requester: albert, reviewerUserId: mussa.id })).rejects.toThrow(/pr_fork/);
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 5, requester: albert, reviewerUserId: mussa.id })).rejects.toThrow(/pr_nao_aberta/);
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 99, requester: albert, reviewerUserId: mussa.id })).rejects.toThrow(/pr_nao_aberta/);
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 9, requester: albert, reviewerUserId: mussa.id })).rejects.toThrow(/branch_invalida/);
    // only the PR asked for is read, never the whole list
    expect(listOpenPulls).not.toHaveBeenCalled();
    expect(readPull).toHaveBeenCalledWith(expect.any(String), "acme", "widgets", 9);
    expect(await registry.listCards(project.id)).toHaveLength(0);
    expect(sendToTerminal).not.toHaveBeenCalled();
  });
});
