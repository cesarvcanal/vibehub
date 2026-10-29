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
