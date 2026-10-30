import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
const tokenFor = vi.fn(async () => TOKEN);

/** A GitHub-token-shaped value (writeGhTokenLines validates it): safe charset, no spaces. */
const TOKEN = "ghp_" + "A".repeat(36);

let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn() }) };
  });
  vi.doMock("../github/client.js", () => ({ tokenFor, gitAuthHeaderFor: vi.fn() }));
  return {
    deliver: await import("./deliver.js"),
    registry: await import("../board/registry.js"),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-deliver-"));
  runScript.mockClear();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
  tokenFor.mockClear();
  tokenFor.mockResolvedValue(TOKEN);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const PR = "https://github.com/acme/repo/pull/7";

/** Wire the runner: one canned reply per phase, chosen by the script's content. */
function wire(over: { push?: string; probe?: string; run?: string; merge?: string; ci?: string } = {}) {
  const push = over.push ?? `pushed\n__VIBEHUB_DELIVER__ pr ${PR}`;
  const probe = over.probe ?? ['pkg=0', 'test=0', 'tsconfig=0', 'localtsc=0', '__VIBEHUB_GATE_JSON__', '{"checks":["npm test"]}'].join("\n");
  const run = over.run ?? "ran\n__VIBEHUB_GATE__ pass\n";
  const merge = over.merge ?? "Merged\n__VIBEHUB_DELIVER__ merged\n";
  runScript.mockImplementation(async (script: string) => {
    if (script.includes("gh pr merge")) return { stdout: merge, stderr: "" };
    if (script.includes("gh pr checks")) return { stdout: `${over.ci ?? ""}\n__VIBEHUB_CI__ done\n`, stderr: "" };
    if (script.includes("git push --force-with-lease")) return { stdout: push, stderr: "" };
    if (script.includes("__VIBEHUB_GATE_JSON__")) return { stdout: probe, stderr: "" };
    if (script.includes('echo "__VIBEHUB_GATE__ pass"')) return { stdout: run, stderr: "" };
    return { stdout: "", stderr: "" };
  });
}

/** Every script that was run, and the ones that were a merge. */
const scripts = () => runScript.mock.calls.map((c) => (c as unknown as string[])[0]);
const mergeRan = () => scripts().some((s) => s.includes("gh pr merge"));

async function makeCard() {
  const { deliver, registry } = await load();
  const p = await registry.createProject({ name: "billing" });
  const c = await registry.createCard({ projectId: p.id, title: "the fix" });
  return { deliver, registry, project: p, card: c };
}

describe("buildPushAndPrScript", () => {
  it("carries the token over stdin, NEVER in a docker exec argv line", async () => {
    const { deliver } = await load();
    const s = deliver.buildPushAndPrScript("vibehub-runner", "card-1", TOKEN, "/work/scratch/x", "card/fix-1", "dev");
    const dockerLine = s.split("\n").find((l) => l.startsWith("docker exec")) ?? "";
    expect(dockerLine).toContain("docker exec -i");
    expect(dockerLine).not.toContain(TOKEN);
    // the token only ever appears in an `export` (a bash builtin — no argv), inside the heredoc body
    const tokenLines = s.split("\n").filter((l) => l.includes(TOKEN));
    expect(tokenLines.length).toBe(1);
    expect(tokenLines[0]).toContain("export GH_TOKEN=");
    // and the CARD's token file is not touched: rewriting it here raced the card's own author
    // switch and could leave the next author's commits pushing with this delivery's token
    expect(s).not.toContain("/root/.vibehub/gh/");
    // git push is force-with-lease, and the PR targets the given branch
    expect(s).toContain("git push --force-with-lease origin 'card/fix-1'");
    expect(s).toContain("gh pr create --base 'dev' --head 'card/fix-1' --fill");
  });
});

describe("buildMergeScript", () => {
  it("merges with a merge commit, never a squash, token over stdin", async () => {
    const { deliver } = await load();
    const s = deliver.buildMergeScript("vibehub-runner", "card-1", TOKEN, "/work/scratch/x", PR);
    expect(s).toContain(`gh pr merge '${PR}' --merge`);
    expect(s).not.toContain("--squash");
    const dockerLine = s.split("\n").find((l) => l.startsWith("docker exec")) ?? "";
    expect(dockerLine).not.toContain(TOKEN);
  });
});

describe("parsePushAndPr / parseMerge", () => {
  it("reads the PR url or the failed stage", async () => {
    const { deliver } = await load();
    expect(deliver.parsePushAndPr(`x\n__VIBEHUB_DELIVER__ pr ${PR}`)).toEqual({ ok: true, prUrl: PR });
    expect(deliver.parsePushAndPr("boom\n__VIBEHUB_DELIVER__ error push")).toMatchObject({ ok: false, stage: "push" });
  });
  it("reads the merge verdict", async () => {
    const { deliver } = await load();
    expect(deliver.parseMerge("__VIBEHUB_DELIVER__ merged\n").merged).toBe(true);
    expect(deliver.parseMerge("nope\n__VIBEHUB_DELIVER__ error merge\n").merged).toBe(false);
  });
});

const localGateRan = () => scripts().some((s) => s.includes("__VIBEHUB_GATE_JSON__"));

describe("parseCiChecks", () => {
  it("reads the verdict of the PR's checks", async () => {
    const { deliver } = await load();
    const p = deliver.parseCiChecks;
    expect(p('[{"name":"back","bucket":"pass"},{"name":"lint","bucket":"skipping"}]\n__VIBEHUB_CI__ done')).toMatchObject({ verdict: "pass" });
    expect(p('[{"name":"back","bucket":"pass"},{"name":"front","bucket":"fail"}]')).toEqual({ verdict: "fail", output: "CI do PR vermelho: front" });
    expect(p('[{"name":"e2e","bucket":"cancel"}]').verdict).toBe("fail");
    expect(p('[{"name":"front","bucket":"pending"}]')).toEqual({ verdict: "pending", output: "CI do PR ainda rodando: front" });
  });
  it("no checks, an empty list or an unreadable answer is 'none' — the local gate decides", async () => {
    const { deliver } = await load();
    expect(deliver.parseCiChecks("no checks reported on the 'x' branch\n__VIBEHUB_CI__ done").verdict).toBe("none");
    expect(deliver.parseCiChecks("[]").verdict).toBe("none");
    expect(deliver.parseCiChecks("HTTP 502 [oops").verdict).toBe("none");
    expect(deliver.parseCiChecks("").verdict).toBe("none");
  });
  it("a PR that never moved to the pushed commit is NOT read as green", async () => {
    const { deliver } = await load();
    expect(deliver.parseCiChecks("__VIBEHUB_CI__ stale\n")).toMatchObject({ verdict: "pending" });
  });
});

describe("buildCiChecksScript", () => {
  it("polls with the card's token over stdin, bounded, and waits for checks to appear only when the repo has workflows", async () => {
    const { deliver } = await load();
    const s = deliver.buildCiChecksScript("vibehub-runner", "card1", TOKEN, "/work/scratch/x", PR);
    const dockerLine = s.split("\n").find((l) => l.startsWith("docker exec")) ?? "";
    expect(dockerLine).not.toContain(TOKEN);
    expect(s).toContain(`gh pr checks '${PR}' --json name,bucket`);
    expect(s).toContain(`-lt ${Math.ceil(deliver.CI_WAIT_SECONDS / deliver.CI_POLL_SECONDS)} ] || break`);
    expect(s).toContain(`[ "$WF" = 1 ] && [ "$i" -lt ${Math.ceil(deliver.CI_APPEAR_SECONDS / deliver.CI_POLL_SECONDS)} ] || break`);
    // each glob tested alone: a repo with only *.yml still counts as having workflows
    expect(s).toContain('for f in .github/workflows/*.yml .github/workflows/*.yaml; do [ -e "$f" ] && WF=1; done');
    // the checks are read only once the PR points at the pushed commit
    expect(s.indexOf(`gh pr view '${PR}' --json headRefOid`)).toBeGreaterThan(-1);
    expect(s.indexOf(`gh pr view '${PR}' --json headRefOid`)).toBeLessThan(s.indexOf("gh pr checks"));
  });
});

describe("deliver uses the PR's CI as the gate when there is one", () => {
  it("green CI merges WITHOUT running the suite again in the runner", async () => {
    const { deliver, card } = await makeCard();
    wire({ ci: '[{"name":"back","bucket":"pass"},{"name":"front","bucket":"pass"}]' });
    const out = await deliver.deliver(card.id, { branch: "main", authorized: true });
    expect(out).toMatchObject({ merged: true, reason: "merged" });
    expect(localGateRan()).toBe(false);
  });

  it("red CI stops the merge and names the failing check", async () => {
    const { deliver, card } = await makeCard();
    wire({ ci: '[{"name":"back","bucket":"pass"},{"name":"front","bucket":"fail"}]' });
    const out = await deliver.deliver(card.id, { branch: "main", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "gate", output: "CI do PR vermelho: front" });
    expect(mergeRan()).toBe(false);
  });

  it("CI still running past the wait is red — never merged on a guess", async () => {
    const { deliver, card } = await makeCard();
    wire({ ci: '[{"name":"front","bucket":"pending"}]' });
    const out = await deliver.deliver(card.id, { branch: "main", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "gate" });
    expect(out.output).toContain("ainda rodando");
    expect(mergeRan()).toBe(false);
  });

  it("a PR stuck on an older commit is red — its checks are not this push's", async () => {
    const { deliver, card } = await makeCard();
    runScript.mockImplementation(async (script: string) => {
      if (script.includes("git push --force-with-lease")) return { stdout: `__VIBEHUB_DELIVER__ pr ${PR}`, stderr: "" };
      if (script.includes("gh pr checks")) return { stdout: "__VIBEHUB_CI__ stale\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const out = await deliver.deliver(card.id, { branch: "main", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "gate" });
    expect(mergeRan()).toBe(false);
    expect(localGateRan()).toBe(false);
  });

  it("a PR with no CI falls back to the local gate", async () => {
    const { deliver, card } = await makeCard();
    wire({ ci: "no checks reported on the 'card/x' branch", run: "1 failing\n__VIBEHUB_GATE__ fail\n" });
    const out = await deliver.deliver(card.id, { branch: "main", authorized: true });
    expect(localGateRan()).toBe(true);
    expect(out).toMatchObject({ merged: false, reason: "gate" });
  });
});

describe("deliver orchestration", () => {
  it("push → PR → gate → merge, and merges ONLY with authorized:true and a green gate", async () => {
    const { deliver, card } = await makeCard();
    wire();
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true });
    expect(out).toMatchObject({ merged: true, reason: "merged", prUrl: PR, branch: "dev" });
    expect(mergeRan()).toBe(true);
    // the token never appears on any docker exec argv line, in ANY of the phase scripts
    for (const s of scripts()) {
      for (const line of s.split("\n").filter((l) => l.startsWith("docker exec"))) {
        expect(line).not.toContain(TOKEN);
      }
    }
  });

  it("STOPS at a red gate and never merges", async () => {
    const { deliver, card } = await makeCard();
    wire({ run: "1 failing test\n__VIBEHUB_GATE__ fail\n" });
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "gate", prUrl: PR });
    expect(out.output).toContain("1 failing test");
    expect(mergeRan()).toBe(false);
  });

  it("prepares the PR but does NOT merge when unauthorized (gate green)", async () => {
    const { deliver, card } = await makeCard();
    wire();
    const out = await deliver.deliver(card.id, { branch: "dev" }); // authorized omitted
    expect(out).toMatchObject({ merged: false, reason: "unauthorized", prUrl: PR });
    expect(mergeRan()).toBe(false);
  });

  it("unauthorized, then the user's OK on the same clean commit: the gate runs once, the merge still happens", async () => {
    const { deliver, card } = await makeCard();
    const probe = [`head=${"c".repeat(40)}`, "clean=1", "__VIBEHUB_GATE_JSON__", '{"checks":["npm test"]}'].join("\n");
    wire({ probe });
    expect(await deliver.deliver(card.id, { branch: "dev" })).toMatchObject({ reason: "unauthorized" });
    expect(await deliver.deliver(card.id, { branch: "dev", authorized: true })).toMatchObject({ merged: true });
    expect(scripts().filter((s) => s.includes('echo "__VIBEHUB_GATE__ pass"'))).toHaveLength(1);
  });

  it("authorized:true is the ONLY thing that merges — a truthy-but-not-true value does not", async () => {
    const { deliver, card } = await makeCard();
    wire();
    // @ts-expect-error — deliberately passing a non-boolean to prove it is not coerced
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: "yes" });
    expect(out.merged).toBe(false);
    expect(out.reason).toBe("unauthorized");
    expect(mergeRan()).toBe(false);
  });

  it("a push failure stops before the gate", async () => {
    const { deliver, card } = await makeCard();
    wire({ push: "fatal: rejected\n__VIBEHUB_DELIVER__ error push" });
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "push_failed" });
    expect(runScript).toHaveBeenCalledOnce(); // push only — no gate, no merge
  });

  it("a LOCKED card opens the PR against its OWN base, ignoring the branch it was asked for", async () => {
    const { deliver, registry, project, card } = await makeCard();
    await registry.updateProject(project.id, { baseBranch: "dev" });
    await registry.updateCard(card.id, { base: "dev", locked: true });
    wire();
    // The agent read "sobe pra prod" and passed it along, authorized and all. Neither word counts.
    const out = await deliver.deliver(card.id, { branch: "prod", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "locked", locked: true, branch: "dev", prUrl: PR });
    expect(mergeRan()).toBe(false);
    expect(scripts().some((s) => s.includes("--base 'dev'"))).toBe(true);
    expect(scripts().some((s) => s.includes("prod"))).toBe(false);
  });

  it("a LOCKED card still runs the gate — the PR arrives already measured", async () => {
    const { deliver, registry, card } = await makeCard();
    await registry.updateCard(card.id, { locked: true });
    wire({ run: "1 failing test\n__VIBEHUB_GATE__ fail\n" });
    const out = await deliver.deliver(card.id, { authorized: true });
    // A red gate is the more useful answer than "locked": it says what to FIX.
    expect(out).toMatchObject({ merged: false, reason: "gate", locked: true });
    expect(out.output).toContain("1 failing test");
    expect(mergeRan()).toBe(false);
  });

  it("unlocking the card gives the merge back", async () => {
    const { deliver, registry, card } = await makeCard();
    await registry.updateCard(card.id, { locked: true });
    await registry.updateCard(card.id, { locked: null });
    wire();
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true });
    expect(out).toMatchObject({ merged: true, reason: "merged" });
    expect(out.locked).toBeUndefined();
    expect(mergeRan()).toBe(true);
  });

  it("defaults the target to the project's base branch", async () => {
    const { deliver, registry, project, card } = await makeCard();
    await registry.updateProject(project.id, { baseBranch: "main" });
    wire();
    const out = await deliver.deliver(card.id, { authorized: true });
    expect(out.branch).toBe("main");
    expect(scripts().some((s) => s.includes("--base 'main'"))).toBe(true);
  });
});

describe("deliver sobe na conta de QUEM trabalhou o card", () => {
  it("o PR usa a conexão do ATOR, não a do projeto", async () => {
    const { deliver, registry } = await load();
    const { addGithubConnection } = registry;
    const cesar = await addGithubConnection({ label: "pessoal", login: "cesarvcanal" });
    const mussa = await addGithubConnection({ label: "mussa", login: "wellesley-mussolini" });
    const p = await registry.createProject({ name: "billing", githubConnectionId: cesar.id });
    const card = await registry.createCard({ projectId: p.id, title: "the fix" });

    const { setUserGit } = await import("../../auth/userGit.js");
    await setUserGit("u-mussa", {
      githubConnectionId: mussa.id, gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com",
    });
    await registry.stampCardActor(card.id, "u-mussa");

    wire();
    await deliver.deliver(card.id, { branch: "dev" });
    expect(tokenFor).toHaveBeenCalledWith(mussa.id);
    expect(tokenFor).not.toHaveBeenCalledWith(cesar.id);
  });

  it("card sem ator mantém o comportamento de sempre: a conexão do projeto", async () => {
    const { deliver, registry } = await load();
    const cesar = await registry.addGithubConnection({ label: "pessoal", login: "cesarvcanal" });
    const p = await registry.createProject({ name: "billing", githubConnectionId: cesar.id });
    const card = await registry.createCard({ projectId: p.id, title: "the fix" });

    wire();
    await deliver.deliver(card.id, { branch: "dev" });
    expect(tokenFor).toHaveBeenCalledWith(cesar.id);
  });

  it("ator SEM identidade própria também cai na conexão do projeto", async () => {
    const { deliver, registry } = await load();
    const cesar = await registry.addGithubConnection({ label: "pessoal", login: "cesarvcanal" });
    const p = await registry.createProject({ name: "billing", githubConnectionId: cesar.id });
    const card = await registry.createCard({ projectId: p.id, title: "the fix" });
    await registry.stampCardActor(card.id, "u-sem-nada");

    wire();
    await deliver.deliver(card.id, { branch: "dev" });
    expect(tokenFor).toHaveBeenCalledWith(cesar.id);
  });
});

describe("deliver grava o PR no card (revisão de PR)", () => {
  const prUrl = (n: number) => `https://github.com/acme/repo/pull/${n}`;
  const pushOut = (n: number) => `pushed\n__VIBEHUB_DELIVER__ pr ${prUrl(n)}`;

  it("deliver grava o PR no card, um por base", async () => {
    const { deliver, registry, card } = await makeCard();

    wire({ push: pushOut(7) });
    await deliver.deliver(card.id, { branch: "dev" });
    wire({ push: pushOut(8) });
    await deliver.deliver(card.id, { branch: "prod" });

    const prs = (await registry.getCard(card.id))?.prs;
    expect(prs).toHaveLength(2);
    // a head é a branch do card; a base é o alvo da entrega; o número sai da URL do PR
    expect(prs?.find((p) => p.base === "dev")).toMatchObject({ number: 7, url: prUrl(7), branch: card.branch ?? `card/${card.worktreeSlug}` });
    expect(prs?.find((p) => p.base === "prod")).toMatchObject({ number: 8, url: prUrl(8) });

    // repetir `dev` (o PR foi fechado e outro aberto) atualiza o item em vez de empilhar
    const firstOpenedAt = prs!.find((p) => p.base === "dev")!.openedAt;
    wire({ push: pushOut(9) });
    await deliver.deliver(card.id, { branch: "dev" });
    const again = (await registry.getCard(card.id))?.prs;
    expect(again).toHaveLength(2);
    expect(again?.find((p) => p.base === "dev")).toMatchObject({ number: 9, url: prUrl(9), openedAt: firstOpenedAt });
  });

  it("o PR fica gravado mesmo com o gate vermelho e mesmo sem autorização", async () => {
    const { deliver, registry, card } = await makeCard();
    wire({ push: pushOut(7), run: "1 failing test\n__VIBEHUB_GATE__ fail\n" });
    expect(await deliver.deliver(card.id, { branch: "dev", authorized: true })).toMatchObject({ reason: "gate" });
    expect((await registry.getCard(card.id))?.prs).toMatchObject([{ number: 7, base: "dev" }]);

    wire({ push: pushOut(8) });
    expect(await deliver.deliver(card.id, { branch: "prod" })).toMatchObject({ reason: "unauthorized" });
    expect((await registry.getCard(card.id))?.prs).toHaveLength(2);
  });

  it("push que falha não grava PR nenhum", async () => {
    const { deliver, registry, card } = await makeCard();
    wire({ push: "boom\n__VIBEHUB_DELIVER__ error push" });
    await deliver.deliver(card.id, { branch: "dev" });
    expect((await registry.getCard(card.id))?.prs).toBeUndefined();
  });

  it("card trancado grava o PR contra a própria base, não a pedida", async () => {
    const { deliver, registry, card } = await makeCard();
    await registry.updateCard(card.id, { base: "dev", locked: true });
    wire({ push: pushOut(7) });
    await deliver.deliver(card.id, { branch: "prod" });
    expect((await registry.getCard(card.id))?.prs).toMatchObject([{ number: 7, base: "dev" }]);
  });

  it("uma URL de PR sem número não derruba a entrega: segue sem gravar", async () => {
    const { deliver, registry, card } = await makeCard();
    wire({ push: "pushed\n__VIBEHUB_DELIVER__ pr https://example.test/sem-numero" });
    const out = await deliver.deliver(card.id, { branch: "dev" });
    expect(out).toMatchObject({ reason: "unauthorized", prUrl: "https://example.test/sem-numero" });
    expect((await registry.getCard(card.id))?.prs).toBeUndefined();
  });

  it("merge grava mergedAt no PR do card", async () => {
    const { deliver, registry, card } = await makeCard();
    wire({ push: pushOut(7) });
    const before = Date.now();
    expect(await deliver.deliver(card.id, { branch: "dev", authorized: true })).toMatchObject({ merged: true, reason: "merged" });

    const dev = (await registry.getCard(card.id))?.prs?.find((p) => p.base === "dev");
    expect(dev).toMatchObject({ number: 7 });
    expect(dev?.mergedAt).toBeGreaterThanOrEqual(before);

    // o próximo PR da mesma base é outro PR: nasce sem a marca do anterior
    wire({ push: pushOut(8) });
    await deliver.deliver(card.id, { branch: "dev" });
    expect((await registry.getCard(card.id))?.prs?.find((p) => p.base === "dev")).toMatchObject({ number: 8 });
    expect((await registry.getCard(card.id))?.prs?.find((p) => p.base === "dev")?.mergedAt).toBeUndefined();
  });

  it("só marca o PR que foi mergeado: sem autorização, gate vermelho e merge que falha não gravam mergedAt", async () => {
    const { deliver, registry, card } = await makeCard();
    const merged = async () => (await registry.getCard(card.id))?.prs?.[0]?.mergedAt;

    wire({ push: pushOut(7) });
    await deliver.deliver(card.id, { branch: "dev" });
    expect(await merged()).toBeUndefined();

    wire({ push: pushOut(7), run: "1 failing test\n__VIBEHUB_GATE__ fail\n" });
    await deliver.deliver(card.id, { branch: "dev", authorized: true });
    expect(await merged()).toBeUndefined();

    wire({ push: pushOut(7), merge: "boom\n__VIBEHUB_DELIVER__ error merge\n" });
    expect(await deliver.deliver(card.id, { branch: "dev", authorized: true })).toMatchObject({ merged: false, reason: "merge_failed" });
    expect(await merged()).toBeUndefined();
  });

  it("o card do revisor NUNCA empurra: devolve locked antes de qualquer script", async () => {
    const { deliver, registry, project, card } = await makeCard();
    await registry.createAccount({ name: "Mussa" });
    const reviewer = await registry.createReviewerCard({
      authorCard: card, reviewerAccountSlug: "mussa", prBranch: "card/the-fix-ab12", title: "Revisão: the fix",
    });
    wire({ push: pushOut(7) });
    // nem a autorização do agente nem o alvo pedido mudam nada: o revisor não tem saída
    const out = await deliver.deliver(reviewer.id, { branch: "prod", authorized: true });
    expect(out).toMatchObject({
      merged: false,
      reason: "locked",
      locked: true,
      branch: "card/the-fix-ab12",
      cardBranch: `review/${reviewer.worktreeSlug}`,
    });
    expect(out.prUrl).toBeUndefined();
    expect(runScript).not.toHaveBeenCalled();
    expect(tokenFor).not.toHaveBeenCalled();
    expect((await registry.getCard(reviewer.id))?.prs).toBeUndefined();
    expect(project.id).toBe(reviewer.projectId);
  });
});

describe("deliver no modo só-merge (botão de merge da revisão de PR)", () => {
  const REVIEWED = "a".repeat(40);
  const MOVED = "b".repeat(40);
  /** O runner do modo só-merge: resolver o PR (sem push), CI, merge. */
  function wireMergeOnly(head: string, over: { ci?: string; merge?: string; resolve?: string } = {}) {
    runScript.mockImplementation(async (script: string) => {
      if (script.includes("gh pr merge")) return { stdout: over.merge ?? "Merged\n__VIBEHUB_DELIVER__ merged\n", stderr: "" };
      if (script.includes("gh pr checks")) return { stdout: `${over.ci ?? '[{"name":"back","bucket":"pass"}]'}\n__VIBEHUB_CI__ done\n`, stderr: "" };
      if (script.includes("gh pr list")) return { stdout: over.resolve ?? `__VIBEHUB_DELIVER__ head ${PR} ${head}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    });
  }

  it("mergeOnly não dá push e recusa head_moved", async () => {
    const { deliver, card } = await makeCard();
    wireMergeOnly(MOVED);
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED });
    expect(out).toMatchObject({ merged: false, reason: "head_moved", prUrl: PR, branch: "dev" });
    expect(out.output).toContain(MOVED.slice(0, 7));
    // nenhum script empurra: o push carregaria um commit que ninguém revisou
    expect(scripts().some((s) => s.includes("git push"))).toBe(false);
    // o PR é achado pela branch do card E pela base pedida (dois PRs da mesma branch não se confundem)
    const resolve = scripts().find((s) => s.includes("gh pr list"))!;
    expect(resolve).toContain(`--head '${card.branch ?? `card/${card.worktreeSlug}`}'`);
    expect(resolve).toContain("--base 'dev'");
    expect(resolve).toContain("headRefOid");
    expect(mergeRan()).toBe(false);
    expect(localGateRan()).toBe(false);
  });

  it("mergeOnly com o head igual ao revisado: CI lido contra o sha revisado e merge preso a ele", async () => {
    const { deliver, registry, card } = await makeCard();
    wireMergeOnly(REVIEWED.toUpperCase());
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED });
    expect(out).toMatchObject({ merged: true, reason: "merged", prUrl: PR, branch: "dev" });
    expect(scripts().some((s) => s.includes("git push"))).toBe(false);
    // o CI espera o PR apontar para o sha REVISADO (não para o HEAD do worktree do autor)
    const ci = scripts().find((s) => s.includes("gh pr checks"))!;
    expect(ci).toContain(`HEAD='${REVIEWED}'`);
    expect(ci).not.toContain("git rev-parse HEAD");
    // e o merge só passa se o GitHub ainda vir esse head (um push entre o gate e o merge é recusado lá)
    const merge = scripts().find((s) => s.includes("gh pr merge"))!;
    expect(merge).toContain(`--merge --match-head-commit '${REVIEWED}'`);
    expect(merge).not.toContain("--squash");
    // só-merge não regrava o PR do card (não abriu nem empurrou nada)
    expect((await registry.getCard(card.id))?.prs).toBeUndefined();
    // e o token segue fora do argv em todos os scripts, o de achar o PR inclusive
    for (const s of scripts()) {
      for (const line of s.split("\n").filter((l) => l.startsWith("docker exec"))) expect(line).not.toContain(TOKEN);
    }
  });

  it("mergeOnly: o merge grava mergedAt no PR do card (o PR #7 gravado pela entrega); head movido não grava", async () => {
    const { deliver, registry, card } = await makeCard();
    // a entrega que abriu o PR gravou o slot da base
    wire({ push: `pushed\n__VIBEHUB_DELIVER__ pr ${PR}` });
    await deliver.deliver(card.id, { branch: "dev" });
    const mergedAt = async () => (await registry.getCard(card.id))?.prs?.[0]?.mergedAt;
    expect(await mergedAt()).toBeUndefined();

    wireMergeOnly(MOVED);
    await deliver.deliver(card.id, { branch: "dev", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED });
    expect(await mergedAt()).toBeUndefined();

    wireMergeOnly(REVIEWED);
    const before = Date.now();
    expect(await deliver.deliver(card.id, { branch: "dev", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED }))
      .toMatchObject({ merged: true });
    expect(await mergedAt()).toBeGreaterThanOrEqual(before);
  });

  it("mergeOnly: gate vermelho continua barrando", async () => {
    const { deliver, card } = await makeCard();
    wireMergeOnly(REVIEWED, { ci: '[{"name":"back","bucket":"fail"}]' });
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED });
    expect(out).toMatchObject({ merged: false, reason: "gate" });
    expect(mergeRan()).toBe(false);
  });

  it("mergeOnly sem PR aberto para a base para em pr_failed, sem merge", async () => {
    const { deliver, card } = await makeCard();
    wireMergeOnly(REVIEWED, { resolve: "__VIBEHUB_DELIVER__ error nopr\n" });
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED });
    expect(out).toMatchObject({ merged: false, reason: "pr_failed" });
    expect(runScript).toHaveBeenCalledOnce();
  });

  it("card locked mergeia pelo botão do responsável quando a base é a do card", async () => {
    const { deliver, registry, card } = await makeCard();
    await registry.updateCard(card.id, { base: "dev", locked: true });
    wireMergeOnly(REVIEWED);
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED });
    // o merge de um card trancado é de quem revisa: o botão do responsável é essa saída
    expect(out).toMatchObject({ merged: true, reason: "merged", branch: "dev", locked: true });
    expect(mergeRan()).toBe(true);
  });

  it("card locked: PR de outra base que não a do card continua locked, sem script nenhum", async () => {
    const { deliver, registry, card } = await makeCard();
    await registry.updateCard(card.id, { base: "dev", locked: true });
    wireMergeOnly(REVIEWED);
    const out = await deliver.deliver(card.id, { branch: "prod", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED });
    expect(out).toMatchObject({ merged: false, reason: "locked", locked: true, branch: "dev" });
    expect(runScript).not.toHaveBeenCalled();
  });

  it("connectionId: o só-merge sai com o token dessa conexão, não com o do ator do card", async () => {
    const { deliver, registry, card } = await makeCard();
    const ator = await registry.addGithubConnection({ label: "autor", login: "autor-gh" });
    const merger = await registry.addGithubConnection({ label: "merger", login: "merger-gh" });
    const { setUserGit } = await import("../../auth/userGit.js");
    await setUserGit("u-autor", { githubConnectionId: ator.id });
    await registry.stampCardActor(card.id, "u-autor");
    wireMergeOnly(REVIEWED);
    const out = await deliver.deliver(card.id, {
      branch: "dev", authorized: true, mergeOnly: true, expectedHeadSha: REVIEWED, connectionId: merger.id,
    });
    expect(out.merged).toBe(true);
    expect(tokenFor).toHaveBeenCalledWith(merger.id);
    expect(tokenFor).not.toHaveBeenCalledWith(ator.id);
  });

  it("mergeOnly exige o sha completo do commit revisado", async () => {
    const { deliver, card } = await makeCard();
    wireMergeOnly(REVIEWED);
    await expect(deliver.deliver(card.id, { authorized: true, mergeOnly: true })).rejects.toThrow(/expectedHeadSha/);
    await expect(deliver.deliver(card.id, { authorized: true, mergeOnly: true, expectedHeadSha: "abc1234" })).rejects.toThrow(/expectedHeadSha/);
    expect(runScript).not.toHaveBeenCalled();
  });
});

describe("a branch do card sai do GitHub depois do merge (o trabalho já está na base)", () => {
  /** The delete-branch step answers with this; the rest of the wiring as usual. */
  function wireDelete(answer: string) {
    wire();
    const merged = runScript.getMockImplementation()!;
    runScript.mockImplementation(async (script: string) => {
      if (script.includes("git/refs/heads/")) return { stdout: `${answer}\n`, stderr: "" };
      return await merged(script);
    });
  }
  const deleteScript = () => scripts().find((s) => s.includes("git/refs/heads/"));

  it("merge apaga a branch do card quando não sobra PR aberto saindo dela", async () => {
    const { deliver, card } = await makeCard();
    wireDelete("__VIBEHUB_DELIVER__ branch deleted");
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true });
    expect(out).toMatchObject({ merged: true, reason: "merged", headBranch: "deleted" });
    const script = deleteScript()!;
    expect(script).toContain(`git/refs/heads/${out.cardBranch}`);
    expect(script).toContain("repos/acme/repo/");
    // o token vai pelo stdin, nunca no argv do docker exec
    for (const line of script.split("\n").filter((l) => l.startsWith("docker exec"))) expect(line).not.toContain(TOKEN);
  });

  it("branch com outro PR aberto (o mesmo card com PR pra outra base) fica: apagar fecharia esse PR", async () => {
    const { deliver, card } = await makeCard();
    wireDelete("__VIBEHUB_DELIVER__ branch kept");
    expect(await deliver.deliver(card.id, { branch: "dev", authorized: true })).toMatchObject({ merged: true, headBranch: "kept" });
  });

  it("falha ao apagar não desfaz o merge: volta merged, com a branch marcada como falha", async () => {
    const { deliver, card } = await makeCard();
    wireDelete("boom\n__VIBEHUB_DELIVER__ branch error delete");
    expect(await deliver.deliver(card.id, { branch: "dev", authorized: true })).toMatchObject({ merged: true, reason: "merged", headBranch: "failed" });
  });

  it("sem merge, nada é apagado: sem autorização, gate vermelho ou merge que falha", async () => {
    const { deliver, card } = await makeCard();
    wireDelete("__VIBEHUB_DELIVER__ branch deleted");
    expect((await deliver.deliver(card.id, { branch: "dev" })).headBranch).toBeUndefined();
    wire({ merge: "nope\n__VIBEHUB_DELIVER__ error merge\n" });
    expect(await deliver.deliver(card.id, { branch: "dev", authorized: true })).toMatchObject({ merged: false });
    expect(deleteScript()).toBeUndefined();
  });
});

describe("buildDeleteBranchScript / parseDeleteBranch", () => {
  it("guarda a branch padrão e a que ainda tem PR aberto; apaga pela API com o token do stdin", async () => {
    const { deliver } = await load();
    const script = deliver.buildDeleteBranchScript("vibehub-runner", "c1", TOKEN, "/work/x", PR, "card/the-fix-ab12");
    expect(script).toContain("defaultBranchRef");
    expect(script).toContain("gh pr list --repo 'acme/repo' --head 'card/the-fix-ab12' --state open");
    expect(script).toContain("gh api -X DELETE 'repos/acme/repo/git/refs/heads/card/the-fix-ab12'");
    for (const line of script.split("\n").filter((l) => l.startsWith("docker exec"))) expect(line).not.toContain(TOKEN);
    expect(() => deliver.buildDeleteBranchScript("vibehub-runner", "c1", TOKEN, "/work/x", "https://example.com/x", "b")).toThrow(/PR/);
  });

  it("lê o resultado: apagada, mantida ou falha (uma branch que já não existe conta como apagada)", async () => {
    const { deliver } = await load();
    expect(deliver.parseDeleteBranch("__VIBEHUB_DELIVER__ branch deleted")).toBe("deleted");
    expect(deliver.parseDeleteBranch("__VIBEHUB_DELIVER__ branch kept")).toBe("kept");
    expect(deliver.parseDeleteBranch("x\n__VIBEHUB_DELIVER__ branch error delete")).toBe("failed");
    expect(deliver.parseDeleteBranch("")).toBe("failed");
  });
});

describe("deliver com revisão de PR ativa no card", () => {
  async function withActiveReview(phase: "reviewing" | "fixing" | "ready" | "merged" | "cancelled" = "reviewing") {
    const made = await makeCard();
    const store = await import("../review/store.js");
    const now = Date.now();
    await store.insertReview({
      id: "rev-1", cardId: made.card.id, projectId: made.project.id, prNumber: 7, prUrl: PR, prBranch: "card/x", base: "dev",
      reviewerUserId: "u-r", authorUserId: "u-a", mergerUserId: "u-m", reviewerCardId: "card-r",
      round: 1, phase, findings: [], log: [], nudges: 0, createdAt: now, updatedAt: now,
    });
    return made;
  }

  it("deliver autorizado com revisão ativa é recusado", async () => {
    const { deliver, card } = await withActiveReview("ready");
    wire();
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "review_active", branch: "dev" });
    // recusado antes de qualquer script: nem push, nem gate, nem merge
    expect(runScript).not.toHaveBeenCalled();
  });

  it("revisão iniciada durante a espera do CI barra o merge autorizado", async () => {
    const { deliver, project, card } = await makeCard();
    const store = await import("../review/store.js");
    runScript.mockImplementation(async (script: string) => {
      if (script.includes("gh pr merge")) return { stdout: "__VIBEHUB_DELIVER__ merged\n", stderr: "" };
      if (script.includes("gh pr checks")) {
        // alguém pede revisão enquanto o deliver espera o CI
        const now = Date.now();
        await store.insertReview({
          id: "rev-late", cardId: card.id, projectId: project.id, prNumber: 7, prUrl: PR, prBranch: "card/x", base: "dev",
          reviewerUserId: "u-r", authorUserId: "u-a", mergerUserId: "u-m", reviewerCardId: "card-r",
          round: 1, phase: "reviewing", findings: [], log: [], nudges: 0, createdAt: now, updatedAt: now,
        });
        return { stdout: '[{"name":"back","bucket":"pass"}]\n__VIBEHUB_CI__ done\n', stderr: "" };
      }
      if (script.includes("git push --force-with-lease")) return { stdout: `__VIBEHUB_DELIVER__ pr ${PR}`, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const out = await deliver.deliver(card.id, { branch: "dev", authorized: true });
    expect(out).toMatchObject({ merged: false, reason: "review_active", prUrl: PR });
    expect(mergeRan()).toBe(false);
  });

  it("sem autorização o autor segue empurrando e atualizando o PR durante a revisão", async () => {
    const { deliver, card } = await withActiveReview("fixing");
    wire();
    const out = await deliver.deliver(card.id, { branch: "dev" });
    expect(out).toMatchObject({ merged: false, reason: "unauthorized", prUrl: PR });
    expect(scripts().some((s) => s.includes("git push --force-with-lease"))).toBe(true);
  });

  it("revisão encerrada (mergeada ou cancelada) não segura o deliver autorizado", async () => {
    for (const phase of ["merged", "cancelled"] as const) {
      const { deliver, card } = await withActiveReview(phase);
      runScript.mockClear();
      wire();
      expect(await deliver.deliver(card.id, { branch: "dev", authorized: true })).toMatchObject({ merged: true, reason: "merged" });
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "vibehub-deliver-"));
    }
  });
});
