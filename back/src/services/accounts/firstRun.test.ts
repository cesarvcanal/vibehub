import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, readFile, writeFile, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstRunSeedCommand, claudeJsonPath, CLAUDE_JSON } from "./firstRun.js";

/**
 * The seed that keeps a card from opening on Claude Code's first-run walls. The command is a string
 * that will be run by a shell inside the runner, so the tests RUN IT FOR REAL (bash + node, both of
 * which the runner image has): a shape-only test would pass on a program that never writes anything,
 * which is precisely the bug this fixes.
 */

let dir = "";
let profile = "";
let cwd = "";

/** Runs the seed the way the session command does: a shell, in the worktree, with `$PWD` live. */
function runSeed(atCwd = cwd, atProfile = profile): void {
  execFileSync("bash", ["-c", firstRunSeedCommand(atProfile, '"$PWD"')], { cwd: atCwd });
}

/**
 * The profile path as the SHELL spells it. On Linux that is the path itself; on a Windows dev box the
 * temp dir is `C:\…`, which the remote-path guard rightly refuses — Git Bash's `/c/…` form is the same
 * directory, and bash hands node the native path back.
 */
function shellPath(p: string): string {
  if (process.platform !== "win32") return p;
  return p.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\\/g, "/");
}

const readConfig = async (p = profile) => JSON.parse(await readFile(claudeJsonPath(p), "utf8"));

beforeEach(async () => {
  // realpath: on macOS the tmpdir is a symlink (/var → /private/var) and bash's `$PWD` resolves it
  dir = await realpath(await mkdtemp(join(tmpdir(), "vibehub-firstrun-")));
  profile = join(dir, "profile");
  cwd = join(dir, "worktree");
  await mkdir(profile);
  await mkdir(cwd);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the command (pure)", () => {
  it("targets the profile's .claude.json, quoted, and never aborts the session", () => {
    const cmd = firstRunSeedCommand("/root/.claude-profiles/personal", '"$PWD"');
    expect(claudeJsonPath("/root/.claude-profiles/personal")).toBe(`/root/.claude-profiles/personal/${CLAUDE_JSON}`);
    expect(cmd).toContain("node -e ");
    expect(cmd).toContain("'/root/.claude-profiles/personal/.claude.json'");
    expect(cmd).toContain('"$PWD"');
    // a runner without node, or an unreadable file, must not stop a card from opening
    expect(cmd.endsWith(">/dev/null 2>&1 || true")).toBe(true);
  });

  it("no cwd = a profile-only seed (the login terminal has no project to trust)", () => {
    expect(firstRunSeedCommand("/root/.claude")).not.toContain("$PWD");
  });

  it("the temp file is per PROCESS — two seeds of the same profile never write the same tmp", () => {
    // Two cards of one account opening at once run two seeds on one `.claude.json`: with a fixed tmp
    // name one rename could move the other's half-written file into place.
    expect(firstRunSeedCommand("/root/.claude")).toContain("process.pid");
  });

  it("a traversal profile THROWS instead of reaching the shell", () => {
    expect(() => firstRunSeedCommand("/root/../etc")).toThrow(/\.\./);
  });
});

describe("what it writes (really running it)", () => {
  it("no .claude.json at all: onboarding done, dark theme, THIS worktree trusted", async () => {
    runSeed();
    expect(await readConfig()).toEqual({
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    });
    // the file holds credentials-adjacent state: not world-readable
    expect((await stat(claudeJsonPath(profile))).mode & 0o077).toBe(0);
  });

  it("a profile Claude already used (the bug): the missing flags are added, everything else survives", async () => {
    // exactly the shape found in production: 25 projects, no hasCompletedOnboarding → the setup
    // wizard on every single open
    await writeFile(
      claudeJsonPath(profile),
      JSON.stringify({ userID: "abc", projects: { "/work/old": { hasTrustDialogAccepted: true } } }),
    );
    runSeed();
    const c = await readConfig();
    expect(c.hasCompletedOnboarding).toBe(true);
    expect(c.userID).toBe("abc");
    expect(c.projects["/work/old"]).toEqual({ hasTrustDialogAccepted: true });
    expect(c.projects[cwd]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("keeps the account's own choices: a chosen theme is NOT overwritten", async () => {
    await writeFile(claudeJsonPath(profile), JSON.stringify({ hasCompletedOnboarding: true, theme: "light" }));
    runSeed();
    expect((await readConfig()).theme).toBe("light");
  });

  it("an existing project entry is completed, not replaced", async () => {
    await writeFile(claudeJsonPath(profile), JSON.stringify({ projects: { [cwd]: { lastCost: 42 } } }));
    runSeed();
    expect((await readConfig()).projects[cwd]).toEqual({ lastCost: 42, hasTrustDialogAccepted: true });
  });

  it("IDEMPOTENT: a second run on a seeded profile rewrites nothing", async () => {
    runSeed();
    const before = await stat(claudeJsonPath(profile));
    runSeed();
    const after = await stat(claudeJsonPath(profile));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("each card's worktree is trusted on its own — the others stay as they were", async () => {
    const other = join(dir, "worktree-2");
    await mkdir(other);
    runSeed();
    runSeed(other);
    const c = await readConfig();
    expect(Object.keys(c.projects).sort()).toEqual([cwd, other].sort());
  });

  it("a .claude.json that is NOT VALID JSON is left alone — never replaced by a minimal one", async () => {
    // Half-written by Claude itself (it does not write through a rename), or damaged: either way it
    // holds the account's oauthAccount, mcpServers and every project's history. Rewriting it from
    // `{}` erased all of that; skipping the seed only costs a wizard Claude itself can recover from.
    const broken = '{"oauthAccount":{"emailAddress":"a@b.c"},"mcpServers":{"gh":{"command":"x"';
    await writeFile(claudeJsonPath(profile), broken);
    execFileSync("bash", ["-c", firstRunSeedCommand(shellPath(profile))], { cwd });
    expect(await readFile(claudeJsonPath(profile), "utf8")).toBe(broken);
  });

  it("an EMPTY .claude.json (0 bytes, or only whitespace) is seeded — there is nothing in it to lose", async () => {
    // `JSON.parse("")` throws a SyntaxError with no `code`, the same as a half-written file. But an
    // empty file holds no login, no MCPs, no history: leaving it alone would only show the
    // onboarding wizard on every card forever.
    await writeFile(claudeJsonPath(profile), " \n");
    execFileSync("bash", ["-c", firstRunSeedCommand(shellPath(profile))], { cwd });
    expect((await readConfig()).hasCompletedOnboarding).toBe(true);
  });

  it("a MISSING .claude.json is still created (the only case that starts from nothing)", async () => {
    execFileSync("bash", ["-c", firstRunSeedCommand(shellPath(profile))], { cwd });
    expect((await readConfig()).hasCompletedOnboarding).toBe(true);
  });

  it("profile-only seed (no cwd): the flags land, no project is trusted", async () => {
    execFileSync("bash", ["-c", firstRunSeedCommand(profile)], { cwd });
    const c = await readConfig();
    expect(c.hasCompletedOnboarding).toBe(true);
    expect(c.projects).toBeUndefined();
  });
});
