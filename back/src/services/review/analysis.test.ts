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

let dir = "";
let pulls: OpenPull[] = [];
let githubDown = false;
const listOpenPulls = vi.fn(async () => {
  if (githubDown) throw new Error("GitHub returned 502 while listing pull requests");
  return pulls;
});
const sendToTerminal = vi.fn(async (cardId: string, _text: string, opts: SendOpts = {}) => {
  await opts.beforeDeliver?.();
  return { sent: true, cardId, title: "", project: "" };
});

const pull = (n: number, extra: Partial<OpenPull> = {}): OpenPull => ({
  number: n, title: `PR ${n}`, url: `https://github.com/acme/widgets/pull/${n}`, author: "albert-gh",
  branch: `feat/pr-${n}`, base: "dev", fromFork: false, draft: false, updatedAt: "2026-11-16T12:00:00Z", ...extra,
});

const albert: PublicUser = { id: "u-albert", username: "albert", role: "member", createdAt: "2026-01-01T00:00:00Z" };

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  vi.doMock("../github/client.js", async () => ({
    ...(await vi.importActual<typeof import("../github/client.js")>("../github/client.js")),
    listOpenPulls,
  }));
  vi.doMock("../maestro/maestro.js", async () => ({
    ...(await vi.importActual<typeof import("../maestro/maestro.js")>("../maestro/maestro.js")),
    sendToTerminal,
  }));
  vi.doMock("../board/workspace.js", async () => ({
    ...(await vi.importActual<typeof import("../board/workspace.js")>("../board/workspace.js")),
    reapplyCardIdentity: vi.fn(async () => true),
  }));
  const registry = await import("../board/registry.js");
  registry.resetForTesting();
  const analysis = await import("./analysis.js");
  const project = await registry.createProject({
    name: "widgets", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", baseBranch: "main",
  });
  // Albert works on the project (a project share with `work`), as the route demands of whoever asks
  await registry.shareWith({ kind: "project", targetId: project.id, userId: albert.id, level: "work" });
  return { registry, analysis, project };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-analysis-"));
  pulls = [pull(7), pull(8, { fromFork: true, branch: "patch" })];
  githubDown = false;
  listOpenPulls.mockClear();
  sendToTerminal.mockClear();
});
afterEach(async () => {
  vi.doUnmock("../github/client.js");
  vi.doUnmock("../maestro/maestro.js");
  vi.doUnmock("../board/workspace.js");
  await rm(dir, { recursive: true, force: true });
});

describe("listProjectPulls", () => {
  it("devolve as PRs abertas do GitHub e marca a que já tem análise aberta", async () => {
    const { analysis, project } = await load();
    const started = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert });
    const listed = await analysis.listProjectPulls(project.id, albert);
    expect(listOpenPulls).toHaveBeenCalledWith(undefined, "acme", "widgets");
    expect(listed.find((p) => p.number === 7)?.analysisCardId).toBe(started.card.id);
    expect(listed.find((p) => p.number === 8)?.analysisCardId).toBeUndefined();
  });

  it("projeto sem repositório no GitHub é recusado, e GitHub fora do ar falha à vista", async () => {
    const { analysis, registry, project } = await load();
    const bare = await registry.createProject({ name: "solto" });
    await expect(analysis.listProjectPulls(bare.id, albert)).rejects.toThrow(/sem_repositorio/);
    githubDown = true;
    await expect(analysis.listProjectPulls(project.id, albert)).rejects.toThrow(/502/);
  });
});

describe("startAnalysis", () => {
  it("cria o card na branch da PR, grava a PR e manda o prompt em nome de quem pediu", async () => {
    const { analysis, registry, project } = await load();
    const { card, created } = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert });
    expect(created).toBe(true);
    expect(card).toMatchObject({ projectId: project.id, title: "Análise PR #7 · PR 7", base: "feat/pr-7", pushBranch: "feat/pr-7" });
    expect((await registry.getCard(card.id))?.prs?.[0]).toMatchObject({ number: 7, url: pull(7).url, base: "dev", branch: "feat/pr-7" });
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    const [cardId, text, opts] = sendToTerminal.mock.calls[0]!;
    expect(cardId).toBe(card.id);
    expect(text).toContain("[vibehub · análise de PR] PR #7");
    expect(opts).toMatchObject({ wake: true, requireAgent: true, viaNativeChat: true, guardInteractiveMenu: true });
    // the commits and the PR comments go out on the account of whoever asked
    expect((await registry.getCard(card.id))?.actorUserId).toBe(albert.id);
  });

  it("repetir a mesma PR devolve o card que já existe, sem outro prompt", async () => {
    const { analysis, project } = await load();
    const first = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert });
    const again = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert });
    expect(again).toMatchObject({ created: false, card: { id: first.card.id } });
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
  });

  it("dois pedidos ao mesmo tempo para a mesma PR criam um card só", async () => {
    const { analysis, registry, project } = await load();
    const [a, b] = await Promise.all([
      analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert }),
      analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert }),
    ]);
    expect(a.card.id).toBe(b.card.id);
    expect((await registry.listCards(project.id)).filter((c) => c.pushBranch === "feat/pr-7")).toHaveLength(1);
  });

  it("análise concluída não segura a PR: pedir de novo abre um card novo", async () => {
    const { analysis, registry, project } = await load();
    const first = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert });
    await registry.updateCard(first.card.id, { column: "done" });
    const again = await analysis.startAnalysis({ projectId: project.id, prNumber: 7, requester: albert });
    expect(again.created).toBe(true);
    expect(again.card.id).not.toBe(first.card.id);
  });

  it("PR de fork e PR que não está aberta são recusadas sem criar card", async () => {
    const { analysis, registry, project } = await load();
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 8, requester: albert })).rejects.toThrow(/pr_fork/);
    await expect(analysis.startAnalysis({ projectId: project.id, prNumber: 99, requester: albert })).rejects.toThrow(/pr_nao_aberta/);
    expect(await registry.listCards(project.id)).toHaveLength(0);
    expect(sendToTerminal).not.toHaveBeenCalled();
  });
});
