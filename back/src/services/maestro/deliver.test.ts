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
function wire(over: { push?: string; probe?: string; run?: string; merge?: string } = {}) {
  const push = over.push ?? `pushed\n__VIBEHUB_DELIVER__ pr ${PR}`;
  const probe = over.probe ?? ['pkg=0', 'test=0', 'tsconfig=0', 'localtsc=0', '__VIBEHUB_GATE_JSON__', '{"checks":["npm test"]}'].join("\n");
  const run = over.run ?? "ran\n__VIBEHUB_GATE__ pass\n";
  const merge = over.merge ?? "Merged\n__VIBEHUB_DELIVER__ merged\n";
  runScript.mockImplementation(async (script: string) => {
    if (script.includes("gh pr merge")) return { stdout: merge, stderr: "" };
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
    // the token is only ever written by printf (a bash builtin — no argv), inside the heredoc body
    const tokenLines = s.split("\n").filter((l) => l.includes(TOKEN));
    expect(tokenLines.length).toBe(1);
    expect(tokenLines[0]).toContain("printf '%s'");
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

  it("defaults the target to the project's base branch", async () => {
    const { deliver, registry, project, card } = await makeCard();
    await registry.updateProject(project.id, { baseBranch: "main" });
    wire();
    const out = await deliver.deliver(card.id, { authorized: true });
    expect(out.branch).toBe("main");
    expect(scripts().some((s) => s.includes("--base 'main'"))).toBe(true);
  });
});
