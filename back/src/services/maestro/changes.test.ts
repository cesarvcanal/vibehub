import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CHANGES — what a card produced, in git terms, for someone following it from OUTSIDE the board:
 * branch, commits ahead of the base, files touched (committed and not), and the pull request. Read
 * only: nothing here pushes, fetches or writes to the worktree. The token (for `gh`) travels over
 * stdin exactly like deliver's, never in argv.
 */

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
const TOKEN = "ghp_" + "B".repeat(36);
const tokenFor = vi.fn(async () => TOKEN);
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
  return { changes: await import("./changes.js"), registry: await import("../board/registry.js") };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-changes-"));
  runScript.mockReset();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
  tokenFor.mockReset();
  tokenFor.mockResolvedValue(TOKEN);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const M = "__VIBEHUB_CHANGES__";
const OUTPUT = [
  `${M} branch`,
  "card/fix-login-1a2b",
  `${M} base`,
  "origin/dev",
  `${M} status`,
  " M src/app.ts",
  "?? src/new.test.ts",
  `${M} commits`,
  "abc1234\tMussa\t2026-10-19T15:00:00-03:00\tfix(login): trata senha vazia",
  "def5678\tMussa\t2026-10-19T14:00:00-03:00\ttest(login): cobre senha vazia",
  `${M} files`,
  "M\tsrc/login.ts",
  "A\tsrc/login.test.ts",
  `${M} shortstat`,
  " 2 files changed, 40 insertions(+), 3 deletions(-)",
  `${M} pr`,
  '[{"url":"https://github.com/acme/app/pull/9","state":"OPEN","title":"fix(login)","isDraft":false,"baseRefName":"dev"}]',
  `${M} end`,
].join("\n");

describe("parseChanges", () => {
  it("reads every section", async () => {
    const { changes } = await load();
    expect(changes.parseChanges(OUTPUT)).toEqual({
      branch: "card/fix-login-1a2b",
      base: "origin/dev",
      uncommitted: [{ status: "M", path: "src/app.ts" }, { status: "??", path: "src/new.test.ts" }],
      commits: [
        { sha: "abc1234", author: "Mussa", at: "2026-10-19T15:00:00-03:00", subject: "fix(login): trata senha vazia" },
        { sha: "def5678", author: "Mussa", at: "2026-10-19T14:00:00-03:00", subject: "test(login): cobre senha vazia" },
      ],
      files: [{ status: "M", path: "src/login.ts" }, { status: "A", path: "src/login.test.ts" }],
      stat: { files: 2, insertions: 40, deletions: 3 },
      pr: { url: "https://github.com/acme/app/pull/9", state: "OPEN", title: "fix(login)", isDraft: false, baseRefName: "dev" },
    });
  });

  it("an empty branch (nothing done yet) and no PR read as empty, not as an error", async () => {
    const { changes } = await load();
    const out = changes.parseChanges([`${M} branch`, "card/x-1", `${M} base`, "origin/main", `${M} status`, `${M} commits`, `${M} files`, `${M} shortstat`, `${M} pr`, "[]", `${M} end`].join("\n"));
    expect(out).toMatchObject({ uncommitted: [], commits: [], files: [], stat: { files: 0, insertions: 0, deletions: 0 }, pr: null });
  });

  it("a PR lookup that failed (no gh auth, offline) is null with the reason — never a crash", async () => {
    const { changes } = await load();
    const out = changes.parseChanges([`${M} branch`, "card/x-1", `${M} pr`, "gh: not authenticated", `${M} end`].join("\n"));
    expect(out.pr).toBeNull();
    expect(out.prError).toMatch(/not authenticated/);
  });

  it("a missing worktree is a clear error", async () => {
    const { changes } = await load();
    expect(() => changes.parseChanges(`${M} error cwd`)).toThrow(/worktree/);
  });
});

describe("buildChangesScript", () => {
  it("is read-only and carries the token over stdin, never in the docker argv", async () => {
    const { changes } = await load();
    const s = changes.buildChangesScript("vibehub-runner", "card-1", TOKEN, "/work/acme-worktrees/fix-1a2b", "card/fix-1a2b", "dev");
    const firstLine = s.split("\n").find((l) => l.startsWith("docker exec"))!;
    expect(firstLine).not.toContain(TOKEN);
    expect(s).toContain("bash -s <<'");
    for (const forbidden of ["git push", "git fetch", "git commit", "git checkout", "git reset", "gh pr create", "gh pr merge"]) {
      expect(s).not.toContain(forbidden);
    }
    expect(s).toContain("gh pr list --head 'card/fix-1a2b'");
  });

  it("without a token it still reads git, and says why there is no PR", async () => {
    const { changes } = await load();
    const s = changes.buildChangesScript("vibehub-runner", "card-1", null, "/work/x-worktrees/a-1a2b", "card/a-1a2b", "main");
    expect(s).not.toContain("gh pr list");
    expect(s).toContain("no GitHub connection");
  });

  it("refuses an unsafe path or branch", async () => {
    const { changes } = await load();
    expect(() => changes.buildChangesScript("vibehub-runner", "card-1", null, "/work/x; rm -rf /", "card/a", "main")).toThrow();
    expect(() => changes.buildChangesScript("vibehub-runner", "card-1", null, "/work/x", "card/a;rm", "main")).toThrow();
  });
});

describe("readCardChanges", () => {
  it("runs the script for the card's own worktree and branch and parses it", async () => {
    const { changes, registry } = await load();
    const p = await registry.createProject({ name: "app" });
    const c = await registry.createCard({ projectId: p.id, title: "fix login" });
    runScript.mockResolvedValueOnce({ stdout: OUTPUT, stderr: "" });
    const out = await changes.readCardChanges(c.id);
    expect(out).toMatchObject({ cardId: c.id, title: "fix login", branch: "card/fix-login-1a2b" });
    const script = (runScript.mock.calls[0] as unknown as string[])[0]!;
    expect(script).toContain(c.worktreeSlug);
  });

  it("still answers (git only) when the project has no GitHub token", async () => {
    const { changes, registry } = await load();
    tokenFor.mockRejectedValueOnce(new Error("no connection"));
    const p = await registry.createProject({ name: "app" });
    const c = await registry.createCard({ projectId: p.id, title: "fix login" });
    runScript.mockResolvedValueOnce({ stdout: OUTPUT.replace(/__VIBEHUB_CHANGES__ pr[\s\S]*/, `${M} pr\nno GitHub connection\n${M} end`), stderr: "" });
    const out = await changes.readCardChanges(c.id);
    expect(out.pr).toBeNull();
    expect(out.commits).toHaveLength(2);
  });

  it("404s an unknown card", async () => {
    const { changes } = await load();
    await expect(changes.readCardChanges("nope")).rejects.toThrow(/card not found/);
  });
});

describe("the script against a REAL repository (git, no docker)", () => {
  it("reports the branch, the commits ahead of origin/<base>, the files and what is not committed", async () => {
    const { changes } = await load();
    const { execFileSync } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    const repo = join(dir, "repo");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "-b", "dev", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "Tester");
    await writeFile(join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/dev", "HEAD"); // what a clone's remote ref looks like
    git("checkout", "-q", "-b", "card/fix-1a2b");
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    await writeFile(join(repo, "b.txt"), "new\n");
    git("add", ".");
    git("commit", "-q", "-m", "fix: two lines");
    await writeFile(join(repo, "c.txt"), "draft\n");

    const script = changes.buildChangesScript("vibehub-runner", "card-1", null, repo, "card/fix-1a2b", "dev")
      .replace(/^docker exec -i \S+ bash -s/m, "bash -s");
    const out = changes.parseChanges(execFileSync("bash", ["-c", script], { encoding: "utf8" }));

    expect(out.branch).toBe("card/fix-1a2b");
    expect(out.base).toBe("origin/dev");
    expect(out.commits.map((c) => [c.author, c.subject])).toEqual([["Tester", "fix: two lines"]]);
    expect(out.files).toEqual([{ status: "M", path: "a.txt" }, { status: "A", path: "b.txt" }]);
    expect(out.stat).toEqual({ files: 2, insertions: 2, deletions: 0 });
    expect(out.uncommitted).toEqual([{ status: "??", path: "c.txt" }]);
    expect(out.pr).toBeNull();
    expect(out.prError).toMatch(/no GitHub connection/);
  });

  it("a worktree that is not there is the clear error, not empty sections", async () => {
    const { changes } = await load();
    const { execFileSync } = await import("node:child_process");
    const script = changes.buildChangesScript("vibehub-runner", "card-1", null, join(dir, "gone"), "card/x-1", "dev")
      .replace(/^docker exec -i \S+ bash -s/m, "bash -s");
    expect(() => changes.parseChanges(execFileSync("bash", ["-c", script], { encoding: "utf8" }))).toThrow(/worktree/);
  });
});
