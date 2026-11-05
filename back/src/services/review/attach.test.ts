import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrInfo } from "../maestro/deliver.js";

/**
 * ANEXAR PRs — o board é REAL (diretório temporário); o GitHub é o `readPrInfo` mockado, com o PR que
 * cada referência devolveria.
 */

let dir = "";
let github: Record<string, { pr: PrInfo } | { error: string }> = {};
const readPrInfo = vi.fn(async (_cardId: string, ref: number | string) => github[String(ref)] ?? { error: "não encontrado (no pull requests found)" });

const open = (n: number, extra: Partial<PrInfo> = {}): { pr: PrInfo } => ({
  pr: {
    number: n, url: `https://github.com/acme/widgets/pull/${n}`, branch: `feat/pr-${n}`, base: "dev",
    author: "albert-gh", title: `PR ${n}`, state: "OPEN", fork: false, ...extra,
  },
});

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("../maestro/deliver.js", async () => ({
    ...(await vi.importActual<typeof import("../maestro/deliver.js")>("../maestro/deliver.js")),
    readPrInfo,
  }));
  const registry = await import("../board/registry.js");
  registry.resetForTesting();
  const attach = await import("./attach.js");
  const project = await registry.createProject({
    name: "widgets", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", baseBranch: "main",
  });
  const card = await registry.createCard({ projectId: project.id, title: "Revisar PRs do Albert" });
  return { registry, attach, project, card };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-attach-"));
  github = {};
  readPrInfo.mockClear();
});
afterEach(async () => {
  vi.doUnmock("../maestro/deliver.js");
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("attachPrs", () => {
  it("anexa os PRs abertos do repositório, um por linha, com autor, título e branch do GitHub", async () => {
    const o = await load();
    github = { "598": open(598), "599": open(599, { author: "outra-pessoa" }) };
    const out = await o.attach.attachPrs(o.card.id, [598, 599]);
    expect(out.refused).toEqual([]);
    expect(out.attached).toEqual([
      { number: 598, title: "PR 598", branch: "feat/pr-598", base: "dev", author: "albert-gh" },
      { number: 599, title: "PR 599", branch: "feat/pr-599", base: "dev", author: "outra-pessoa" },
    ]);
    const prs = (await o.registry.getCard(o.card.id))?.prs;
    expect(prs).toHaveLength(2);
    expect(prs?.every((p) => p.attached)).toBe(true);
    expect(prs?.find((p) => p.number === 599)).toMatchObject({ author: "outra-pessoa", branch: "feat/pr-599", title: "PR 599" });
    // lido com a conexão do card (o id dele vai ao gh)
    expect(readPrInfo.mock.calls.every(([cardId]) => cardId === o.card.id)).toBe(true);
  });

  it("recusa, com o motivo, PR mergeado, fechado, de fork, de outro repositório e o que não existe; anexa o resto", async () => {
    const o = await load();
    github = {
      "1": open(1, { state: "MERGED" }),
      "2": open(2, { state: "CLOSED" }),
      "3": open(3, { fork: true }),
      "4": open(4, { url: "https://github.com/acme/outro/pull/4" }),
      "5": open(5),
    };
    const out = await o.attach.attachPrs(o.card.id, [1, 2, 3, 4, 5, 6]);
    expect(out.attached.map((p) => p.number)).toEqual([5]);
    const reasons = Object.fromEntries(out.refused.map((r) => [r.pr, r.reason.split(":")[0]]));
    expect(reasons).toEqual({ 1: "mergeado", 2: "fechado", 3: "fork", 4: "outro_repositorio", 6: "nao_encontrado" });
    expect((await o.registry.getCard(o.card.id))?.prs?.map((p) => p.number)).toEqual([5]);
  });

  it("o mesmo PR pelo número e pela URL vira uma linha só; repetir a chamada não duplica", async () => {
    const o = await load();
    const url = "https://github.com/acme/widgets/pull/600";
    github = { "600": open(600), [url]: open(600) };
    const out = await o.attach.attachPrs(o.card.id, [600, url, 600]);
    expect(out.attached).toHaveLength(1);
    expect(readPrInfo).toHaveBeenCalledTimes(2);
    await o.attach.attachPrs(o.card.id, [600]);
    expect((await o.registry.getCard(o.card.id))?.prs).toHaveLength(1);
  });

  it("nada anexável não grava nada; card de revisor, card sumido e projeto sem repo recusam", async () => {
    const o = await load();
    const out = await o.attach.attachPrs(o.card.id, [42]);
    expect(out.attached).toEqual([]);
    expect((await o.registry.getCard(o.card.id))?.prs).toBeUndefined();

    await o.registry.createAccount({ name: "Mussa" });
    const reviewer = await o.registry.createReviewerCard({ authorCard: o.card, reviewerAccountSlug: "mussa", prBranch: "feat/x", title: "Rev" });
    await expect(o.attach.attachPrs(reviewer.id, [1])).rejects.toThrow(/revisor/);
    await expect(o.attach.attachPrs("sumiu", [1])).rejects.toThrow(/card not found/);
    const scratch = await o.registry.createProject({ name: "rascunho", baseBranch: "main" });
    const loose = await o.registry.createCard({ projectId: scratch.id, title: "solto" });
    await expect(o.attach.attachPrs(loose.id, [1])).rejects.toThrow(/repositório/);
    expect(readPrInfo).toHaveBeenCalledTimes(1);
  });
});
