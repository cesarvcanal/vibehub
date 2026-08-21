import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Importing existing Claude sessions as cards. INVARIANTS:
 *  - the destination path is the one `claude --resume` will look in — get the sanitisation wrong and
 *    the card opens on an empty conversation with no error anywhere, so it is tested directly;
 *  - the session id is validated as a uuid BEFORE it becomes part of a path in a script: it is the
 *    only field of an item that reaches the runner;
 *  - idempotent by (project, sessionId): re-running does not duplicate a card, skips what is really
 *    there, and RE-SEEDS the orphan cards a half-finished earlier run left behind;
 *  - one bad item never takes the batch down;
 *  - transcript content is never logged.
 *
 * The board registry is REAL against a temp data directory; the host executor and the runner status
 * are mocked. The card cwd comes in as a stub, the way the route passes the workspace derivation.
 */

const runScript = vi.fn();
vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: () => ({ kind: "local", label: "this machine", runScript, ptyCommand: vi.fn(), writeFile: vi.fn() }),
}));

const runnerStatus = vi.fn();
vi.mock("../../runtime/runner.js", () => ({ runnerStatus }));

let dir = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "test-master-key";
  const reg = await import("../board/registry.js");
  const mod = await import("./import.js");
  const { logger } = await import("../../utils/logger.js");
  return { reg, mod, logger, container: env.config.runner.container };
}

/** Stands in for the workspace module: the same shape of path a card's terminal opens in. */
const cardCwd = (project: { repoFullName?: string }, card: { worktreeSlug: string }) =>
  `/work/${(project.repoFullName ?? "scratch").replace("/", "--")}-worktrees/${card.worktreeSlug}`;

/** Default host behaviour: the transcript is already at its destination, and a seed succeeds. */
function defaultHost(script: string) {
  if (script.includes("VIBEHUB_CHECK")) return Promise.resolve({ stdout: "VIBEHUB_IMPORT_PRESENT\n", stderr: "" });
  return Promise.resolve({ stdout: "VIBEHUB_IMPORT_OK\n", stderr: "" });
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const REPO = "acme/api-space";

beforeEach(async () => {
  vi.clearAllMocks();
  runScript.mockImplementation(defaultHost);
  runnerStatus.mockResolvedValue({ running: true, exists: true, claudeInstalled: true, dockerReachable: true, container: "vibehub-runner", host: "this machine" });
  dir = await mkdtemp(join(tmpdir(), "vibehub-import-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pure path derivation", () => {
  it("claudeProjectsDirName: every non-alphanumeric character becomes '-'", async () => {
    const { mod } = await fresh();
    expect(mod.claudeProjectsDirName("/work/acme--api-space-worktrees/console-errors-a1b2")).toBe(
      "-work-acme--api-space-worktrees-console-errors-a1b2",
    );
    expect(mod.claudeProjectsDirName("/root/.claude")).toBe("-root--claude");
    expect(mod.claudeProjectsDirName("")).toBe("");
  });

  it("seedDestDir: <profile>/projects/<sanitised cwd>", async () => {
    const { mod } = await fresh();
    expect(mod.seedDestDir("/root/.claude", "/work/acme--api-worktrees/x-a1b2")).toBe(
      "/root/.claude/projects/-work-acme--api-worktrees-x-a1b2",
    );
  });

  it("normalizeRepoKey / projectRepoKey: match on the full name or on the clone URL", async () => {
    const { mod } = await fresh();
    expect(mod.normalizeRepoKey("Acme/API-Space.git")).toBe("acme/api-space");
    expect(mod.normalizeRepoKey("  acme/api  ")).toBe("acme/api");
    expect(mod.projectRepoKey({ repoFullName: "Acme/Api" })).toBe("acme/api");
    expect(mod.projectRepoKey({ cloneUrl: "https://github.com/acme/api-space.git" })).toBe("acme/api-space");
    expect(mod.projectRepoKey({ cloneUrl: "git@github.com:acme/api-space.git" })).toBe("acme/api-space");
    expect(mod.projectRepoKey({})).toBeUndefined();
    expect(mod.projectRepoKey({ cloneUrl: "https://example.test/thing" })).toBeUndefined();
  });
});

describe("the scripts", () => {
  it("buildImportSeedScript: conditional copy, both markers, unsafe paths refused", async () => {
    const { mod } = await fresh();
    const s = mod.buildImportSeedScript("vibehub-runner", "/work/import/x.jsonl", "/root/.claude/projects/-work-x");
    expect(s).toContain("docker exec -i 'vibehub-runner' bash -s <<'VIBEHUB_IMPORT'");
    expect(s).toContain("VIBEHUB_IMPORT_MISSING");
    expect(s).toContain("VIBEHUB_IMPORT_OK");
    expect(s).toContain("'/work/import/x.jsonl'");
    expect(s).toContain('cp -f "$SRC" "$DEST/"');
    expect(() => mod.buildImportSeedScript("c", "/work/../etc/passwd", "/root/x")).toThrow(/\.\./);
    expect(() => mod.buildImportSeedScript("c", "/work/x", "relative")).toThrow(/absolute/);
    expect(() => mod.buildImportSeedScript("c", "/work/x;id", "/root/x")).toThrow(/invalid characters/);
  });

  it("buildTranscriptExistsScript: read-only test with PRESENT/ABSENT, unsafe paths refused", async () => {
    const { mod } = await fresh();
    const s = mod.buildTranscriptExistsScript("vibehub-runner", "/root/.claude/projects/-work-x/a.jsonl");
    expect(s).toContain("docker exec -i 'vibehub-runner' bash -s <<'VIBEHUB_CHECK'");
    expect(s).toContain('[ -f "$DEST" ]');
    expect(s).toContain("VIBEHUB_IMPORT_PRESENT");
    expect(s).toContain("VIBEHUB_IMPORT_ABSENT");
    expect(s).not.toContain("cp -f"); // it must not write anything
    expect(() => mod.buildTranscriptExistsScript("c", "/root/../etc/passwd")).toThrow(/\.\./);
  });

  it("quotes a hostile container name into a single argument", async () => {
    const { mod } = await fresh();
    const s = mod.buildImportSeedScript("run'; rm -rf / #", "/work/import/x.jsonl", "/root/x");
    expect(s).toContain(`docker exec -i 'run'\\''; rm -rf / #' bash -s`);
    expect(s).not.toMatch(/\n\s*rm -rf \//);
  });
});

describe("importSessions", () => {
  it("creates the project and the card, patches it, and seeds the transcript", async () => {
    const { mod, reg } = await fresh();
    const out = await mod.importSessions(
      { items: [{ repo: REPO, title: "console errors", sessionId: UUID_A, branch: "feat/x", column: "working" }] },
      cardCwd,
    );

    expect(out).toMatchObject({ created: 1, skipped: 0, failed: 0 });
    const [r] = out.results;
    expect(r!.seeded).toBe(true);
    expect(r!.error).toBeUndefined();

    const [project] = await reg.listProjects();
    expect(project!.repoFullName).toBe(REPO);
    expect(project!.cloneUrl).toBe("https://github.com/acme/api-space.git");
    expect(project!.name).toBe("api-space");

    const [card] = await reg.listCards(project!.id);
    expect(card!.resumeSessionId).toBe(UUID_A);
    expect(card!.branch).toBe("feat/x");
    expect(card!.column).toBe("working");
    // the destination is exactly where `claude --resume` will look
    expect(r!.destPath).toBe(
      `/root/.claude/projects/${mod.claudeProjectsDirName(cardCwd(project!, card!))}/${UUID_A}.jsonl`,
    );
    expect(runScript).toHaveBeenCalledTimes(1); // new card: straight to the seed, no check
  });

  it("lands imported cards in `paused` by default — they were started elsewhere, not just filed", async () => {
    const { mod, reg } = await fresh();
    await mod.importSessions({ items: [{ repo: REPO, title: "a", sessionId: UUID_A }] }, cardCwd);
    const [project] = await reg.listProjects();
    expect((await reg.listCards(project!.id))[0]!.column).toBe(mod.IMPORT_COLUMN);
    expect(mod.IMPORT_COLUMN).toBe("paused");
  });

  it("seeds into the ACCOUNT profile when the card inherits one", async () => {
    const { mod, reg } = await fresh();
    const account = await reg.createAccount({ name: "Work" });
    const created = await reg.createProject({ name: "api-space", repoFullName: REPO, defaultAccountSlug: account.slug });
    const out = await mod.importSessions({ items: [{ repo: REPO, title: "a", sessionId: UUID_A }] }, cardCwd);
    expect(out.results[0]!.projectId).toBe(created.id);
    expect(out.results[0]!.destPath).toContain("/root/.claude-profiles/work/projects/");
  });

  it("reuses a project that matches the repo instead of creating a second one", async () => {
    const { mod, reg } = await fresh();
    const existing = await reg.createProject({ name: "api-space", repoFullName: REPO });
    const out = await mod.importSessions({ items: [{ repo: "Acme/API-Space.git", title: "t", sessionId: UUID_A }] }, cardCwd);
    expect(out.results[0]!.projectId).toBe(existing.id);
    expect((await reg.listProjects()).length).toBe(1);
  });

  it("two items from the same repo share ONE project", async () => {
    const { mod, reg } = await fresh();
    const out = await mod.importSessions(
      { items: [{ repo: REPO, title: "a", sessionId: UUID_A }, { repo: REPO, title: "b", sessionId: UUID_B }] },
      cardCwd,
    );
    expect(out.created).toBe(2);
    expect((await reg.listProjects()).length).toBe(1);
    expect(new Set(out.results.map((r) => r.projectId)).size).toBe(1);
  });

  it("idempotent: re-importing the same session skips it and creates no second card", async () => {
    const { mod, reg } = await fresh();
    const items = [{ repo: REPO, title: "a", sessionId: UUID_A }];
    const first = await mod.importSessions({ items }, cardCwd);
    expect(first.created).toBe(1);

    runScript.mockClear();
    const second = await mod.importSessions({ items }, cardCwd);
    expect(second).toMatchObject({ created: 0, skipped: 1, failed: 0 });
    expect(second.results[0]!.skipped).toBe(true);
    expect(second.results[0]!.seeded).toBe(false);
    expect(second.results[0]!.cardId).toBe(first.results[0]!.cardId);

    const [project] = await reg.listProjects();
    expect((await reg.listCards(project!.id)).length).toBe(1);
    // it asked, and then did NOT copy
    const scripts = runScript.mock.calls.map((c) => String(c[0]));
    expect(scripts.some((s) => s.includes("VIBEHUB_CHECK"))).toBe(true);
    expect(scripts.some((s) => s.includes("<<'VIBEHUB_IMPORT'"))).toBe(false);
  });

  it("re-seeds an ORPHAN card: it exists, but its transcript never made it", async () => {
    const { mod, reg } = await fresh();
    const items = [{ repo: REPO, title: "a", sessionId: UUID_A }];
    await mod.importSessions({ items }, cardCwd);

    runScript.mockClear();
    runScript.mockImplementation((script: string) =>
      script.includes("VIBEHUB_CHECK")
        ? Promise.resolve({ stdout: "VIBEHUB_IMPORT_ABSENT\n", stderr: "" })
        : Promise.resolve({ stdout: "VIBEHUB_IMPORT_OK\n", stderr: "" }),
    );

    const out = await mod.importSessions({ items }, cardCwd);
    expect(out.results[0]!.skipped).toBeFalsy();
    expect(out.results[0]!.seeded).toBe(true);
    const [project] = await reg.listProjects();
    expect((await reg.listCards(project!.id)).length).toBe(1); // still one card
    const scripts = runScript.mock.calls.map((c) => String(c[0]));
    expect(scripts.some((s) => s.includes("VIBEHUB_CHECK"))).toBe(true);
    expect(scripts.some((s) => s.includes("<<'VIBEHUB_IMPORT'"))).toBe(true);
  });

  it("an unrecognised answer from the check is an error, not a silent skip", async () => {
    const { mod } = await fresh();
    const items = [{ repo: REPO, title: "a", sessionId: UUID_A }];
    await mod.importSessions({ items }, cardCwd);
    runScript.mockImplementation(() => Promise.resolve({ stdout: "", stderr: "" }));
    const out = await mod.importSessions({ items }, cardCwd);
    expect(out.failed).toBe(1);
    expect(out.results[0]!.error).toMatch(/did not confirm/);
  });

  it("a missing transcript fails only its own item", async () => {
    const { mod } = await fresh();
    runScript.mockImplementation(() => Promise.resolve({ stdout: "VIBEHUB_IMPORT_MISSING\n", stderr: "" }));
    const out = await mod.importSessions(
      { items: [{ repo: REPO, title: "gone", sessionId: UUID_A }, { repo: "acme/erp", title: "ok", sessionId: UUID_B }] },
      cardCwd,
    );
    expect(out.failed).toBe(2);
    expect(out.created).toBe(0);
    expect(out.results.every((r) => /not in the staging directory/.test(r.error ?? ""))).toBe(true);
  });

  it("a host-executor failure on one item does not take the batch down", async () => {
    const { mod } = await fresh();
    let call = 0;
    runScript.mockImplementation((script: string) => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("host command timed out"));
      return defaultHost(script);
    });
    const out = await mod.importSessions(
      { items: [{ repo: REPO, title: "boom", sessionId: UUID_A }, { repo: "acme/erp", title: "fine", sessionId: UUID_B }] },
      cardCwd,
    );
    expect(out.failed).toBe(1);
    expect(out.created).toBe(1);
    expect(out.results[0]!.error).toBe("host command timed out");
    expect(out.results[1]!.seeded).toBe(true);
  });

  it("rejects a session id that is not a uuid — it never reaches a script", async () => {
    const { mod } = await fresh();
    const hostile = ["not-a-uuid", "", "../../etc/passwd", `${UUID_A}; rm -rf /`, `${UUID_A}\nid`, "*"];
    const out = await mod.importSessions(
      { items: hostile.map((sessionId, i) => ({ repo: REPO, title: `t${i}`, sessionId })) },
      cardCwd,
    );
    expect(out.failed).toBe(hostile.length);
    expect(out.results.every((r) => /invalid resumeSessionId/.test(r.error ?? ""))).toBe(true);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("rejects a hostile repo name at the board boundary", async () => {
    const { mod, reg } = await fresh();
    const out = await mod.importSessions(
      {
        items: [
          { repo: "", title: "empty", sessionId: UUID_A },
          { repo: "acme/../../etc", title: "traversal", sessionId: UUID_A },
          { repo: "acme/repo; rm -rf /", title: "metachar", sessionId: UUID_B },
        ],
      },
      cardCwd,
    );
    expect(out.failed).toBe(3);
    expect(out.results[0]!.error).toMatch(/repo is required/);
    expect(out.results[1]!.error).toMatch(/invalid repoFullName/);
    expect(out.results[2]!.error).toMatch(/invalid repoFullName/);
    expect(await reg.listProjects()).toEqual([]);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("refuses an unsafe staging directory before creating anything", async () => {
    const { mod, reg } = await fresh();
    for (const stageDir of ["/work/../etc", "relative/dir", "/work/x;id"]) {
      await expect(
        mod.importSessions({ items: [{ repo: REPO, title: "a", sessionId: UUID_A }], stageDir }, cardCwd),
      ).rejects.toThrow();
    }
    expect(await reg.listProjects()).toEqual([]);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("honours a custom staging directory", async () => {
    const { mod } = await fresh();
    await mod.importSessions({ items: [{ repo: REPO, title: "a", sessionId: UUID_A }], stageDir: "/work/staged" }, cardCwd);
    expect(String(runScript.mock.calls[0]![0])).toContain(`SRC='/work/staged/${UUID_A}.jsonl'`);
  });

  it("uses the default staging directory when none is given", async () => {
    const { mod } = await fresh();
    await mod.importSessions({ items: [{ repo: REPO, title: "a", sessionId: UUID_A }] }, cardCwd);
    expect(String(runScript.mock.calls[0]![0])).toContain(`SRC='${mod.DEFAULT_STAGE_DIR}/${UUID_A}.jsonl'`);
  });

  it("refuses to run at all when the runner is not there, and creates nothing", async () => {
    const { mod, reg } = await fresh();
    runnerStatus.mockResolvedValue({ running: false, exists: false, claudeInstalled: false, dockerReachable: true, container: "c", host: "h" });
    await expect(mod.importSessions({ items: [{ repo: REPO, title: "a", sessionId: UUID_A }] }, cardCwd))
      .rejects.toThrow(/not provisioned/);

    runnerStatus.mockResolvedValue({ running: false, exists: true, claudeInstalled: true, dockerReachable: true, container: "c", host: "h" });
    await expect(mod.importSessions({ items: [{ repo: REPO, title: "a", sessionId: UUID_A }] }, cardCwd))
      .rejects.toThrow(/not running/);

    expect(await reg.listProjects()).toEqual([]);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("an empty batch is a no-op, not an error", async () => {
    const { mod } = await fresh();
    expect(await mod.importSessions({ items: [] }, cardCwd)).toEqual({ results: [], created: 0, skipped: 0, failed: 0 });
    expect(runScript).not.toHaveBeenCalled();
  });

  it("never logs transcript paths or content — only counts", async () => {
    const { mod, logger } = await fresh();
    const info = vi.spyOn(logger, "info");
    await mod.importSessions({ items: [{ repo: REPO, title: "a", sessionId: UUID_A }] }, cardCwd);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(UUID_A);
    expect(logged).not.toContain(".jsonl");
    expect(logged).toContain("import.sessions");
  });
});
