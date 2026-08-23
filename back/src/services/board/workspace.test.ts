import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardCdpEndpoint } from "../browser/ports.js";
import { firstRunSeedCommand } from "../accounts/firstRun.js";

/**
 * A card's workspace in the runner (open + terminal + pause + restart + drop). The INVARIANTS the
 * reviewers hunt for:
 *  - the GitHub credential travels INSIDE the script over STDIN — NEVER in argv — and is EPHEMERAL:
 *    an http header on the clone/fetch commands only, NEVER embedded in the remote URL (no token
 *    persisted in /work/<repo>/.git/config, which every process in the runner can read) and never in
 *    the tmux session's environment;
 *  - reopening a card whose tmux session is alive must NOT fail (`new-session -A` without a tty
 *    turns into an attach and exits with "open terminal failed" — the script uses a
 *    `has-session ||` guard);
 *  - nothing raw from the user reaches a shell: slug and session come from the board, the branch is
 *    validated, the model is a whitelist.
 * The board and the vault are REAL (temp data dir); the host executor and GitHub are mocked.
 */

const TOKEN = "ghp_SUPERSECRETVALUE123";
const AUTH_HEADER = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
const OAUTH = "sk-ant-oat01-LONGLIVEDTOKEN1234567890abcdef";
const STATUS_URL = "http://vibehub:3010/api/runner/status";
const CONTAINER = "vibehub-runner";

/**
 * The LONG-LIVED TOKEN prefix every Claude session carries: a guard in the session's SHELL (not in
 * tmux's argv) — if the profile has an .oauth-token, export CLAUDE_CODE_OAUTH_TOKEN; otherwise
 * nothing happens. It ends with the FIRST-RUN seed (own unit test in accounts/firstRun.test.ts),
 * which is what keeps a session from opening on Claude's setup wizard or trust dialog.
 */
const guard = (dir = "/root/.claude") =>
  `export IS_SANDBOX=1; ` +
  `if [ -s ${dir}/.oauth-token ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${dir}/.oauth-token)"; fi; ` +
  `${firstRunSeedCommand(dir, '"$PWD"')}; `;
const CLAUDE = `${guard()}claude; exec bash`;
const CLAUDE_C = `${guard()}claude -c || claude; exec bash`;
/** The session command as it appears INSIDE a script: one shell-quoted argument (it contains quotes of its own). */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));
vi.mock("../github/client.js", () => ({ gitAuthHeaderFor: vi.fn(), tokenFor: vi.fn() }));

/**
 * FAULT INJECTION for the staggered restart, opt-in per test (`fresh({ flakyRegistry: true })`): the
 * registry stays the REAL module — same JsonStore, so the cards a test creates are the cards the
 * workspace sees — with two exports wrapped so ONE card id can be made to blow up on each half of the
 * sweep. Empty id = nobody fails, which is why the wrapper is inert for every other test.
 */
let failGetCardFor = "";
let failMarkPendingFor = "";

let dir = "";
let runScript: ReturnType<typeof vi.fn>;
let ptyCommand: ReturnType<typeof vi.fn>;
let reg: typeof import("./registry.js");
let ws: typeof import("./workspace.js");
let host: typeof import("../../runtime/host.js");

async function fresh(opts: { flakyRegistry?: boolean } = {}) {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "test-key";
  env.config.publicUrl = "http://vibehub:3010";
  env.config.runner.container = CONTAINER;
  host = await import("../../runtime/host.js");
  runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
  ptyCommand = vi.fn((line: string) => ({ file: "bash", args: ["-lc", line] }));
  vi.mocked(host.hostExecutor).mockReturnValue({
    kind: "local", label: "this machine", runScript, ptyCommand, writeFile: vi.fn(),
  } as unknown as import("../../runtime/host.js").HostExecutor);
  const gh = await import("../github/client.js");
  vi.mocked(gh.gitAuthHeaderFor).mockResolvedValue(AUTH_HEADER);
  if (opts.flakyRegistry) {
    vi.doMock("./registry.js", async () => {
      const actual = await vi.importActual<typeof import("./registry.js")>("./registry.js");
      return {
        ...actual,
        getCard: async (id: string) =>
          id && id === failGetCardFor ? Promise.reject(new Error("the board is unreadable")) : actual.getCard(id),
        markRestartPending: async (id: string, reason: import("./registry.js").RestartReason) =>
          id && id === failMarkPendingFor
            ? Promise.reject(new Error("the board is unwritable"))
            : actual.markRestartPending(id, reason),
      };
    });
  }
  reg = await import("./registry.js");
  ws = await import("./workspace.js");
}

/** The script of the nth call to the host executor. */
const scriptAt = (i: number): string => String(runScript.mock.calls[i]![0]);
const lastScript = (): string => String(runScript.mock.calls.at(-1)![0]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-ws-"));
  vi.clearAllMocks();
  await fresh();
});
afterEach(async () => {
  // The flaky-registry mock is opt-in: drop it so the next test gets the real module back.
  vi.doUnmock("./registry.js");
  failGetCardFor = "";
  failMarkPendingFor = "";
  await rm(dir, { recursive: true, force: true });
});

async function seed(withRepo = true) {
  const project = await reg.createProject({
    name: "erp-aux",
    ...(withRepo ? { repoFullName: "acme/erp-aux", cloneUrl: "https://github.com/acme/erp-aux.git" } : {}),
  });
  const card = await reg.createCard({ projectId: project.id, title: "Inventory intake" });
  return { project, card };
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

describe("path derivation (pure)", () => {
  it("repoDirName: owner--repo from repoFullName or from the clone URL; nothing without a repo", () => {
    expect(ws.repoDirName({ repoFullName: "org/erp-aux" })).toBe("org--erp-aux");
    // the owner is part of the name: same-named repos of different owners must not share a clone
    expect(ws.repoDirName({ repoFullName: "other/erp-aux" })).toBe("other--erp-aux");
    expect(ws.repoDirName({ cloneUrl: "https://github.com/org/multi-pdv.git" })).toBe("org--multi-pdv");
    expect(ws.repoDirName({})).toBeUndefined();
  });

  it("repoDirName THROWS on a name that would not be a sane directory", () => {
    expect(() => ws.repoDirName({ repoFullName: "org/../etc" })).toThrow(/invalid repository name/);
    expect(() => ws.repoDirName({ repoFullName: "org/x;rm -rf /" })).toThrow(/invalid repository name/);
  });

  it("effectiveCloneUrl: the explicit one wins, otherwise it is derived from repoFullName", () => {
    expect(ws.effectiveCloneUrl({ cloneUrl: "https://github.com/a/b.git" })).toBe("https://github.com/a/b.git");
    expect(ws.effectiveCloneUrl({ repoFullName: "a/b" })).toBe("https://github.com/a/b.git");
    expect(ws.effectiveCloneUrl({})).toBeUndefined();
  });

  it("cardWorkPaths: worktree under /work/<owner--repo>-worktrees/<slug>; scratch without a repo", async () => {
    const { project, card } = await seed();
    expect(ws.cardWorkPaths(project, card)).toEqual({
      repoDir: "/work/acme--erp-aux",
      cwd: `/work/acme--erp-aux-worktrees/${card.worktreeSlug}`,
    });

    const scratch = await reg.createProject({ name: "loose" });
    const c2 = await reg.createCard({ projectId: scratch.id, title: "Loose idea" });
    expect(ws.cardWorkPaths(scratch, c2)).toEqual({ cwd: `/work/scratch/${c2.worktreeSlug}` });
  });

  it("cardWorkPaths refuses a tampered worktreeSlug (it becomes a shell path)", async () => {
    const { project, card } = await seed();
    expect(() => ws.cardWorkPaths(project, { ...card, worktreeSlug: "../etc" })).toThrow(/invalid worktreeSlug/);
    expect(() => ws.cardWorkPaths(project, { ...card, worktreeSlug: "a b" })).toThrow(/invalid worktreeSlug/);
  });

  it("cardBranch: the card's own (validated) or the derived card/<slug>; metacharacters THROW", async () => {
    const { card } = await seed();
    expect(ws.cardBranch(card)).toBe(`card/${card.worktreeSlug}`);
    expect(ws.cardBranch({ ...card, branch: "feat/imported" })).toBe("feat/imported");
    for (const bad of ["a;b", "a b", "$(id)", "--upload-pack=x", "a..b", "`id`", "a|b"]) {
      expect(() => ws.cardBranch({ ...card, branch: bad })).toThrow(/invalid branch name/);
    }
  });

  it("buildOpenScript refuses a hostile branch or base before producing any script", () => {
    const base = {
      containerName: CONTAINER, tmuxSession: "card-1", cardId: "id", statusUrl: STATUS_URL,
      cwd: "/work/x", repo: { dir: "/work/r", branch: "ok", base: "dev", cloneUrl: "https://github.com/a/b.git" },
    };
    expect(() => ws.buildOpenScript({ ...base, repo: { ...base.repo, branch: "x; rm -rf /" } })).toThrow(/invalid branch/);
    expect(() => ws.buildOpenScript({ ...base, repo: { ...base.repo, base: "$(reboot)" } })).toThrow(/invalid branch/);
  });
});

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

describe("openCard", () => {
  it("clone/fetch/worktree/tmux in the runner — the credential rides IN THE SCRIPT (stdin)", async () => {
    const { card } = await seed();
    const updated = await ws.openCard(card.id, "local:tester");

    expect(runScript).toHaveBeenCalledTimes(1);
    const [script, opts] = runScript.mock.calls[0]!;
    expect((opts as { timeoutMs: number }).timeoutMs).toBeGreaterThan(60_000);

    // runs INSIDE the runner container
    expect(script).toContain(`docker exec -i '${CONTAINER}' bash -s`);
    // the ephemeral credential lives in the script body, which travels over stdin
    expect(script).toContain(`GIT_AUTH='${AUTH_HEADER}'`);
    expect(script).toContain("git clone");
    expect(script).toContain("fetch --prune");
    // worktree on the card's branch, off the inherited base
    expect(script).toContain(`card/${card.worktreeSlug}`);
    expect(script).toContain("'origin/dev'");
    expect(script).toContain(`/work/acme--erp-aux-worktrees/${card.worktreeSlug}`);
    // tmux session with claude and the environment the status hooks need
    expect(script).toContain(`tmux new-session -d -s '${card.tmuxSession}'`);
    expect(script).toContain(`VIBEHUB_CARD_ID='${card.id}'`);
    expect(script).toContain(`VIBEHUB_STATUS_URL='${STATUS_URL}'`);
    expect(script).toContain(`PW_CDP_ENDPOINT='${cardCdpEndpoint(card.id)}'`);
    expect(script).toContain(sq(CLAUDE));

    // the open rule: backlog → waiting
    expect(updated.column).toBe("waiting");
  });

  it("the token is NEVER persisted in the runner: the remote keeps the CLEAN URL, the header is per-command", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    const script = scriptAt(0);

    // no token embedded in a URL (the old x-access-token@github.com shape ended up in .git/config)
    expect(script).not.toContain("x-access-token:");
    expect(script).not.toContain(`${TOKEN}@`);
    expect(script).not.toContain(TOKEN);
    // the remote is ALWAYS re-pointed at the clean URL (which also scrubs a legacy credential)
    expect(script).toContain("CLONE_URL='https://github.com/acme/erp-aux.git'");
    expect(script).toContain(`git -C "$REPO_DIR" remote set-url origin "$CLONE_URL"`);
    // per-command http header (a per-command assignment never leaks into the shell/tmux environment)
    expect(script).toContain(`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="$GIT_AUTH" git clone`);
    expect(script).toContain(`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="$GIT_AUTH" git -C "$REPO_DIR" fetch --prune origin`);
    // the tmux line carries NO credential (otherwise the token would enter the claude session env)
    const tmuxLine = script.split("\n").find((l) => l.includes("tmux"))!;
    expect(tmuxLine).not.toContain("GIT_AUTH");
    expect(tmuxLine).not.toContain(AUTH_HEADER);
  });

  it("the credential never reaches argv: only the host executor spawns, and it gets the script as stdin", async () => {
    const { project, card } = await seed();
    await ws.openCard(card.id);
    // the pty path (the ONLY argv path) is built from the board and carries no credential
    const line = ws.cardTerminalCommandLine(CONTAINER, project, (await reg.getCard(card.id))!);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(AUTH_HEADER);
    expect(ws.cardAttachArgs(CONTAINER, project, card).join(" ")).not.toContain(TOKEN);
  });

  it("reopening a card whose tmux session is ALIVE cannot fail: the has-session guard, no detached -A", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    const script = scriptAt(0);
    // `tmux new-session -d -A` without a tty becomes an attach when the session exists → exit 1
    // ("open terminal failed: not a terminal") and `set -e` kills every open from the second on.
    expect(script).not.toMatch(/new-session[^\n]*-A/);
    // PER-COMMAND UTF-8 before new-session: this command may START the tmux server (non-interactive
    // docker exec, no .profile) — without the prefix the server is born in the C locale and accented
    // characters become "_"; the `-e LANG` only applies inside the session.
    expect(script).toContain(
      `tmux has-session -t '${card.tmuxSession}' 2>/dev/null || LANG=C.UTF-8 LC_ALL=C.UTF-8 tmux new-session -d -s '${card.tmuxSession}'`,
    );
    // idempotent: reopening produces the SAME script except for the Claude command — the second open
    // (openedAt) resumes the conversation with `claude -c || claude`
    await ws.openCard(card.id);
    expect(scriptAt(1).replace(sq(CLAUDE_C), sq(CLAUDE))).toBe(script);
  });

  it("open is idempotent about columns: a card in done does NOT leave done", async () => {
    const { card } = await seed();
    await reg.updateCard(card.id, { column: "done" });
    expect((await ws.openCard(card.id)).column).toBe("done");
  });

  it("a project with NO repository: mkdir of the scratch directory, no git at all", async () => {
    const scratch = await reg.createProject({ name: "loose" });
    const card = await reg.createCard({ projectId: scratch.id, title: "Idea" });
    await ws.openCard(card.id);
    const script = scriptAt(0);
    expect(script).toContain(`mkdir -p "$WT"`);
    expect(script).toContain(`/work/scratch/${card.worktreeSlug}`);
    expect(script).not.toContain("git clone");
  });

  it("reopening does NOT pay for a fetch: the fetch sits inside the missing-worktree guard", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    const lines = scriptAt(0).split("\n");
    const iClone = lines.findIndex((l) => l.includes("git clone"));
    const iSetUrl = lines.findIndex((l) => l.includes("remote set-url"));
    const iGuard = lines.findIndex((l) => l.includes('if [ ! -d "$WT" ]; then'));
    const iFetch = lines.findIndex((l) => l.includes("fetch --prune"));
    const iWorktree = lines.findIndex((l) => l.includes("worktree add"));
    expect(iClone).toBeGreaterThanOrEqual(0);
    // set-url ALWAYS runs (cheap, and it is the legacy-credential scrub) — outside the guard
    expect(iSetUrl).toBeLessThan(iGuard);
    // the fetch only happens when the worktree is missing, before the worktree add
    expect(iFetch).toBeGreaterThan(iGuard);
    expect(iFetch).toBeLessThan(iWorktree);
    // and there is exactly ONE fetch — none unconditional
    expect(scriptAt(0).match(/fetch --prune/g)).toHaveLength(1);
  });

  it("GitHub not connected (gitAuthHeaderFor throws) → carries on with NO credential (public repo)", async () => {
    const gh = await import("../github/client.js");
    vi.mocked(gh.gitAuthHeaderFor).mockRejectedValue(new Error("GitHub is not connected"));
    const { card } = await seed();
    await ws.openCard(card.id);
    const script = scriptAt(0);
    expect(script).toContain("https://github.com/acme/erp-aux.git");
    expect(script).not.toContain("GIT_AUTH");
    expect(script).not.toContain("http.extraheader");
  });

  it("a card or project that does not exist THROWS and nothing runs on the host", async () => {
    await expect(ws.openCard("nope")).rejects.toThrow(/card not found/);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("a host executor failure surfaces a clear error naming the host, and the board is untouched", async () => {
    const { card } = await seed();
    runScript.mockRejectedValue(new host.HostExecError("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"));
    await expect(ws.openCard(card.id)).rejects.toThrow(/the runner on this machine could not run the command: Cannot connect to the Docker daemon/);
    const after = await reg.getCard(card.id);
    expect(after?.column).toBe("backlog");
    expect(after?.openedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Accounts / profiles
// ---------------------------------------------------------------------------

describe("the card's Claude account (CLAUDE_CONFIG_DIR per profile)", () => {
  it("accountConfigDir: /root/.claude-profiles/<slug>; a bad slug THROWS (never becomes a raw path)", () => {
    expect(ws.accountConfigDir("personal")).toBe("/root/.claude-profiles/personal");
    expect(() => ws.accountConfigDir("..")).toThrow(/invalid account slug/);
    expect(() => ws.accountConfigDir("a/b")).toThrow(/invalid account slug/);
    expect(() => ws.accountConfigDir("x; rm -rf /")).toThrow(/invalid account slug/);
  });

  it("default account (no slug anywhere): NO CLAUDE_CONFIG_DIR in the script", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    expect(scriptAt(0)).not.toContain("CLAUDE_CONFIG_DIR");
    expect(scriptAt(0)).not.toContain(".claude-profiles");
  });

  it("the PROJECT account: profile guaranteed BEFORE tmux, settings.json seeded (status hooks), -e CLAUDE_CONFIG_DIR", async () => {
    await reg.createAccount({ name: "Personal" });
    const { project, card } = await seed();
    await reg.updateProject(project.id, { defaultAccountSlug: "personal" });
    await ws.openCard(card.id);

    const script = scriptAt(0);
    expect(script).toContain("CLAUDE_CFG='/root/.claude-profiles/personal'");
    expect(script).toContain(`mkdir -p "$CLAUDE_CFG"`);
    // the status hooks live in the default account's settings.json — the guarded copy (only when it
    // does not exist yet) is what keeps the green/amber mirror alive for a new account
    expect(script).toContain(`if [ ! -f "$CLAUDE_CFG/settings.json" ] && [ -f /root/.claude/settings.json ]; then`);
    expect(script).toContain(`cp /root/.claude/settings.json "$CLAUDE_CFG/settings.json"`);
    const tmuxLine = script.split("\n").find((l) => l.includes("tmux"))!;
    expect(tmuxLine).toContain("-e CLAUDE_CONFIG_DIR='/root/.claude-profiles/personal'");
    // and the profile is ensured BEFORE tmux (otherwise claude would start with no settings/hooks)
    expect(script.indexOf(`mkdir -p "$CLAUDE_CFG"`)).toBeLessThan(script.indexOf("tmux has-session"));
  });

  it("the CARD account overrides the project default", async () => {
    await reg.createAccount({ name: "From Project" });
    await reg.createAccount({ name: "From Card" });
    const { project, card } = await seed();
    await reg.updateProject(project.id, { defaultAccountSlug: "from-project" });
    await reg.updateCard(card.id, { accountSlug: "from-card" });
    await ws.openCard(card.id);

    expect(scriptAt(0)).toContain("-e CLAUDE_CONFIG_DIR='/root/.claude-profiles/from-card'");
    expect(scriptAt(0)).not.toContain("from-project");
  });

  it("an account on a repo-less project applies the profile too", async () => {
    await reg.createAccount({ name: "Personal" });
    const scratch = await reg.createProject({ name: "loose", defaultAccountSlug: "personal" });
    const card = await reg.createCard({ projectId: scratch.id, title: "Idea" });
    await ws.openCard(card.id);
    expect(scriptAt(0)).toContain("-e CLAUDE_CONFIG_DIR='/root/.claude-profiles/personal'");
    expect(scriptAt(0)).not.toContain("git clone");
  });
});

// ---------------------------------------------------------------------------
// Terminal attach
// ---------------------------------------------------------------------------

describe("terminalRemoteArgs / cardAttachArgs (the websocket's COMPLETE attach-or-create)", () => {
  const base = { cardId: "id-1", statusUrl: STATUS_URL };

  it("the attach carries the SAME env and command as the open (a restarted runner keeps its mirror)", () => {
    expect(ws.terminalRemoteArgs(CONTAINER, "card-a1b2c3d4", "/work/x-worktrees/y", base)).toEqual([
      "docker", "exec", "-it", CONTAINER,
      // `env LANG/LC_ALL` BEFORE tmux: if the attach starts the tmux server, it is born in UTF-8
      "env", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
      "tmux", "new-session", "-A", "-s", "card-a1b2c3d4", "-c", "/work/x-worktrees/y",
      "-e", "VIBEHUB_CARD_ID=id-1", "-e", `VIBEHUB_STATUS_URL=${STATUS_URL}`,
      "-e", `PW_CDP_ENDPOINT=${cardCdpEndpoint("id-1")}`,
      "-e", "LANG=C.UTF-8", "-e", "LC_ALL=C.UTF-8",
      CLAUDE,
    ]);
  });

  it("non-default account: -e CLAUDE_CONFIG_DIR of the profile; default: none at all", () => {
    const withAccount = ws.terminalRemoteArgs("c", "card-1", "/w", { ...base, accountConfigDir: "/root/.claude-profiles/personal" });
    expect(withAccount).toContain("CLAUDE_CONFIG_DIR=/root/.claude-profiles/personal");
    // the token guard points at the ACCOUNT profile's .oauth-token
    expect(withAccount.at(-1)).toBe(`${guard("/root/.claude-profiles/personal")}claude; exec bash`);
    expect(ws.terminalRemoteArgs("c", "card-1", "/w", base).join(" ")).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("shell=true: a SEPARATE <tmux>-sh session with a plain bash, same cwd — the suffix is derived here", () => {
    const args = ws.terminalRemoteArgs("c", "card-a1b2c3d4", "/work/x-worktrees/y", { ...base, shell: true });
    expect(args[args.indexOf("-s") + 1]).toBe("card-a1b2c3d4-sh");
    expect(args[args.indexOf("-c") + 1]).toBe("/work/x-worktrees/y");
    expect(args.at(-1)).toBe("exec bash");
    expect(args.join(" ")).not.toContain("claude");
    // still attach-or-create (-A) — reopening the shell returns to the same session
    expect(args).toContain("-A");
  });

  it("cardAttachArgs resolves from the BOARD: worktree cwd, effective account, shell variant", async () => {
    await reg.createAccount({ name: "From Project" });
    await reg.createAccount({ name: "From Card" });
    const { project, card } = await seed();

    const plain = ws.cardAttachArgs(CONTAINER, project, card);
    expect(plain).toContain(`/work/acme--erp-aux-worktrees/${card.worktreeSlug}`);
    expect(plain).toContain(card.tmuxSession);
    expect(plain).toContain(`VIBEHUB_CARD_ID=${card.id}`);
    expect(plain).toContain(`VIBEHUB_STATUS_URL=${STATUS_URL}`);
    expect(plain).toContain(`PW_CDP_ENDPOINT=${cardCdpEndpoint(card.id)}`);
    expect(plain.join(" ")).not.toContain("CLAUDE_CONFIG_DIR");

    const p2 = await reg.updateProject(project.id, { defaultAccountSlug: "from-project" });
    expect(ws.cardAttachArgs(CONTAINER, p2, card)).toContain("CLAUDE_CONFIG_DIR=/root/.claude-profiles/from-project");

    const c2 = await reg.updateCard(card.id, { accountSlug: "from-card" });
    expect(ws.cardAttachArgs(CONTAINER, p2, c2)).toContain("CLAUDE_CONFIG_DIR=/root/.claude-profiles/from-card");

    const sh = ws.cardAttachArgs(CONTAINER, p2, c2, { shell: true });
    expect(sh).toContain(`${card.tmuxSession}-sh`);
    expect(sh.at(-1)).toBe("exec bash");
  });

  it("a project WITH a GitHub connection points the session at the per-card gh-token file — the PATH, never the token", async () => {
    const conn = await reg.addGithubConnection({ login: "cesarvcanal" });
    const { project, card } = await seed();
    const p = await reg.updateProject(project.id, { githubConnectionId: conn.id });

    const cmd = ws.cardAttachArgs(CONTAINER, p, card).at(-1) as string;
    expect(cmd).toContain(`if [ -s /root/.vibehub/gh/${card.id}.token ]`);
    expect(cmd).toContain('export GH_TOKEN="$(cat /root/.vibehub/gh/');
    // a project WITHOUT a connection gets no GH_TOKEN guard at all
    expect(ws.cardAttachArgs(CONTAINER, project, card).at(-1)).not.toContain("GH_TOKEN");
    // and the token itself is NEVER in argv, connection or not
    expect(ws.cardAttachArgs(CONTAINER, p, card).join(" ")).not.toContain(TOKEN);
  });

  it("cardTerminalCommandLine quotes every element, and cardTerminalCommand goes through the host executor", async () => {
    const { project, card } = await seed();
    const line = ws.cardTerminalCommandLine(CONTAINER, project, card);
    expect(line.startsWith("'docker' 'exec' '-it'")).toBe(true);
    // the claude command is ONE argument, whatever is inside it
    expect(line).toContain(sq(CLAUDE));

    const cmd = ws.cardTerminalCommand(project, card);
    expect(ptyCommand).toHaveBeenCalledWith(line);
    expect(cmd).toEqual({ file: "bash", args: ["-lc", line] });
  });
});

// ---------------------------------------------------------------------------
// Model whitelist
// ---------------------------------------------------------------------------

describe("per-card model (`claude --model` — the flag, never the env)", () => {
  it("a VALID model becomes a --model flag; an absent one adds nothing", () => {
    expect(ws.sessionCommand({ model: "claude-opus-5" })).toBe(`${guard()}claude --model claude-opus-5; exec bash`);
    expect(ws.sessionCommand({})).toBe(CLAUDE);
  });

  it("the pin is a FLAG, not ANTHROPIC_DEFAULT_MODEL — the profile's settings.json beats that env", () => {
    // The bug: a card pinned to Opus booted on whatever `/model` last wrote into the SHARED account
    // profile (Fable), because the env is only the default of last resort.
    expect(ws.sessionCommand({ model: "claude-opus-5" })).not.toContain("ANTHROPIC_DEFAULT_MODEL");
  });

  it("an INVALID model is IGNORED (no flag, does not throw) — nothing raw reaches the shell", () => {
    const cmd = ws.sessionCommand({ model: "claude-gpt-9; rm -rf /" });
    expect(cmd).toBe(CLAUDE);
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("rm -rf");
  });

  it("the flag rides EVERY fallback of a resume, so no branch silently drops the pin", () => {
    expect(ws.sessionCommand({ model: "claude-sonnet-5", profileDir: "/root/.claude-profiles/personal", resume: true }))
      .toBe(`${guard("/root/.claude-profiles/personal")}claude --model claude-sonnet-5 -c || claude --model claude-sonnet-5; exec bash`);
    const imported = ws.sessionCommand({ model: "claude-opus-5", resumeSessionId: "a1b2c3d4-e5f6-4a4a-8b8b-000011112222" });
    expect(imported.match(/--model claude-opus-5/g)).toHaveLength(3);
  });

  it("both the attach and the open carry the card's model into the session command", async () => {
    const { project, card } = await seed();
    const c = await reg.updateCard(card.id, { model: "claude-fable-5" });
    expect(ws.cardAttachArgs(CONTAINER, project, c).at(-1)).toContain("claude --model claude-fable-5");

    await ws.openCard(c.id);
    const tmux = lastScript().split("\n").find((l) => l.includes("tmux new-session"))!;
    expect(tmux).toContain("claude --model claude-fable-5");

    // a card with no model (the account default): no flag at all. The board hands back the SAME
    // object it stores, so `card` was mutated by updateCard — clear the field explicitly.
    expect(ws.cardAttachArgs(CONTAINER, project, { ...card, model: undefined }).at(-1)).not.toContain("--model");
  });
});

// ---------------------------------------------------------------------------
// Resume semantics
// ---------------------------------------------------------------------------

describe("pause / resume (the session dies; reopening returns to the SAME conversation)", () => {
  const SID = "a1b2c3d4-e5f6-4a4a-8b8b-000011112222";

  it("sessionCommand: first time = plain `claude`; resume = `claude -c || claude`; imported = `--resume <id>` first", () => {
    expect(ws.sessionCommand(false)).toBe(CLAUDE);
    expect(ws.sessionCommand(true)).toBe(CLAUDE_C);
    expect(ws.sessionCommand({ resume: false })).toBe(CLAUDE);
    expect(ws.sessionCommand({ resumeSessionId: SID, resume: true })).toBe(
      `${guard()}claude --resume ${SID} || claude -c || claude; exec bash`,
    );
    expect(ws.sessionCommand({ profileDir: "/root/.claude-profiles/personal" })).toBe(
      `${guard("/root/.claude-profiles/personal")}claude; exec bash`,
    );
  });

  it("a non-uuid resumeSessionId and a traversal profile never reach the shell", () => {
    expect(() => ws.sessionCommand({ resumeSessionId: "x; rm -rf /" })).toThrow(/invalid resumeSessionId/);
    expect(() => ws.sessionCommand({ profileDir: "/root/../etc" })).toThrow(/\.\./);
  });

  it("open: the FIRST one runs plain `claude`; a REOPEN (openedAt) runs `claude -c || claude`", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    const tmux1 = scriptAt(0).split("\n").find((l) => l.includes("tmux new-session"))!;
    expect(tmux1).toContain(sq(CLAUDE));
    expect(tmux1).not.toContain("claude -c");

    await ws.openCard(card.id); // the board now has openedAt
    const tmux2 = scriptAt(1).split("\n").find((l) => l.includes("tmux new-session"))!;
    expect(tmux2).toContain(sq(CLAUDE_C));
    expect(tmux2).toMatch(/tmux has-session -t '[^']+' 2>\/dev\/null \|\| LANG=C\.UTF-8 LC_ALL=C\.UTF-8 tmux new-session -d/);
  });

  it("attach: `claude -c ||` ONLY once the card has had a session; the shell variant never resumes", async () => {
    const base = { cardId: "id-1", statusUrl: STATUS_URL };
    expect(ws.terminalRemoteArgs("c", "card-1", "/w", base).at(-1)).toBe(CLAUDE);
    expect(ws.terminalRemoteArgs("c", "card-1", "/w", { ...base, resume: true }).at(-1)).toBe(CLAUDE_C);
    expect(ws.terminalRemoteArgs("c", "card-1", "/w", { ...base, resume: true, shell: true }).at(-1)).toBe("exec bash");

    const { project, card } = await seed();
    expect(ws.cardAttachArgs(CONTAINER, project, card).at(-1)).toBe(CLAUDE);
    const opened = (await reg.applyOpenTerminal(card.id))!;
    expect(ws.cardAttachArgs(CONTAINER, project, opened).at(-1)).toBe(CLAUDE_C);
    // a PAUSED card (openedAt stays, pausedAt stamped): the websocket attach already resumes on its own
    const paused = await reg.pauseCard(card.id);
    expect(paused.pausedAt).toBeTypeOf("number");
    expect(ws.cardAttachArgs(CONTAINER, project, paused).at(-1)).toBe(CLAUDE_C);
  });

  it("an IMPORTED session drives both the open and the attach; clearing it goes back to -c", async () => {
    const { project, card } = await seed();
    const c = await reg.updateCard(card.id, { resumeSessionId: SID });
    await ws.openCard(c.id);
    expect(scriptAt(0)).toContain(sq(`${guard()}claude --resume ${SID} || claude -c || claude; exec bash`));
    expect(ws.cardAttachArgs(CONTAINER, project, c).at(-1)).toBe(`${guard()}claude --resume ${SID} || claude -c || claude; exec bash`);
    expect(ws.cardAttachArgs(CONTAINER, project, c, { shell: true }).at(-1)).toBe("exec bash");

    const cleared = await reg.updateCard(card.id, { resumeSessionId: null });
    expect(ws.cardAttachArgs(CONTAINER, project, cleared).at(-1)).toBe(CLAUDE_C);
  });

  it("the card's own branch: origin/<branch> when it already exists remotely, else the base", async () => {
    const { card } = await seed();
    const c = await reg.updateCard(card.id, { branch: "feat/imported" });
    await ws.openCard(c.id);
    const script = scriptAt(0);
    expect(script).not.toContain(`card/${card.worktreeSlug}`);
    // order: local exists → add; origin/<branch> exists → -b from it; otherwise → -b from the base
    const iLocal = script.indexOf("show-ref --verify --quiet 'refs/heads/feat/imported'");
    const iRemote = script.indexOf("show-ref --verify --quiet 'refs/remotes/origin/feat/imported'");
    const iFromRemote = script.indexOf("worktree add \"$WT\" -b 'feat/imported' 'origin/feat/imported'");
    const iFromBase = script.indexOf("worktree add \"$WT\" -b 'feat/imported' 'origin/dev'");
    expect(iLocal).toBeGreaterThan(-1);
    expect(iRemote).toBeGreaterThan(iLocal);
    expect(iFromRemote).toBeGreaterThan(iRemote);
    expect(iFromBase).toBeGreaterThan(iFromRemote);
  });

  it("pauseCard: the board is paused and BOTH sessions (claude and -sh) die in one command", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    runScript.mockClear();

    const paused = await ws.pauseCard(card.id, "tester");
    expect(paused.pausedAt).toBeTypeOf("number");
    expect(paused.column).toBe("paused");
    expect(paused.status).toBeNull();

    expect(runScript).toHaveBeenCalledTimes(1);
    const cmd = scriptAt(0);
    expect(cmd).toContain(`docker exec '${CONTAINER}' tmux kill-session -t '${card.tmuxSession}'`);
    expect(cmd).toContain(`docker exec '${CONTAINER}' tmux kill-session -t '${card.tmuxSession}-sh'`);
    expect(cmd).toMatch(/; true$/); // best-effort: a missing session is not an error
    expect((await reg.getCard(card.id))?.pausedAt).toBe(paused.pausedAt);
  });

  it("pauseCard: a WORKING card is a PENDING pause — it moves, the session STAYS ALIVE, no pausedAt", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    await reg.applyCardStatus(card.id, "working"); // Claude is busy
    runScript.mockClear();

    const pending = await ws.pauseCard(card.id, "tester");
    expect(pending.column).toBe("paused");
    expect(pending.pausedAt ?? null).toBeNull();
    expect(pending.status).toBe("working");
    expect(runScript).not.toHaveBeenCalled();
  });

  it("pauseCard: a card never opened / unknown THROWS and nothing runs; a dead host does not undo the pause", async () => {
    const { card } = await seed();
    await expect(ws.pauseCard(card.id)).rejects.toThrow(/never opened/);
    await expect(ws.pauseCard("nope")).rejects.toThrow(/card not found/);
    expect(runScript).not.toHaveBeenCalled();

    await ws.openCard(card.id);
    runScript.mockRejectedValue(new Error("host is down"));
    expect((await ws.pauseCard(card.id)).pausedAt).toBeTypeOf("number");
  });

  it("resuming: openCard after a pause clears pausedAt and the session is born with `claude -c`", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    await ws.pauseCard(card.id);
    const resumed = await ws.openCard(card.id);
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.column).toBe("waiting");
    expect(lastScript()).toContain(sq(CLAUDE_C));
  });
});

// ---------------------------------------------------------------------------
// Restart / kill / drop
// ---------------------------------------------------------------------------

describe("restart (single and all) — a working card is protected", () => {
  it("cardsToRestart (PURE): only idle cards with a live session", () => {
    const cards = [
      { id: "a", openedAt: 1, pausedAt: null, status: "waiting" as const }, // idle and live → in
      { id: "b", openedAt: 1, pausedAt: null, status: null }, // no status, live → in
      { id: "c", openedAt: 1, pausedAt: null, status: "working" as const }, // busy → OUT
      { id: "d", openedAt: undefined, pausedAt: null, status: "waiting" as const }, // never opened → out
      { id: "e", openedAt: 1, pausedAt: 123, status: "waiting" as const }, // paused → out
    ];
    expect(ws.cardsToRestart(cards).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("cardsToHibernate (PURE): idle live sessions older than the threshold, never a working one", () => {
    const now = 1_700_000_000_000; // a real epoch: the threshold is measured against real stamps
    const old = now - 4 * 60 * 60_000; // four hours ago
    const recent = now - 60_000;
    const cards = [
      { id: "a", openedAt: old, pausedAt: null, status: "waiting" as const, statusAt: old }, // cold → in
      { id: "b", openedAt: old, pausedAt: null, status: null, statusAt: undefined }, // opened, never spoke → in
      { id: "c", openedAt: old, pausedAt: null, status: "waiting" as const, statusAt: recent }, // just spoke → out
      { id: "d", openedAt: old, pausedAt: null, status: "working" as const, statusAt: old }, // busy → OUT
      { id: "e", openedAt: undefined, pausedAt: null, status: null, statusAt: undefined }, // never opened → out
      { id: "f", openedAt: old, pausedAt: old, status: null, statusAt: undefined }, // paused → out
      { id: "g", openedAt: old, pausedAt: null, hibernatedAt: old, status: null, statusAt: undefined }, // already cold → out
    ];
    const threeHours = 3 * 60 * 60_000;
    expect(ws.cardsToHibernate(cards, now, threeHours).map((c) => c.id)).toEqual(["a", "b"]);
    // 0 (or less) is how the setting spells "never".
    expect(ws.cardsToHibernate(cards, now, 0)).toEqual([]);
  });

  it("hibernateCard: kills BOTH sessions and leaves the card in its column", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    await reg.applyCardStatus(card.id, "waiting");
    const before = await reg.getCard(card.id);
    runScript.mockClear();

    const cold = await ws.hibernateCard(card.id, "tester");
    expect(cold?.hibernatedAt).toBeGreaterThan(0);
    expect(cold?.column).toBe(before?.column);
    expect(cold?.position).toBe(before?.position);
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(scriptAt(0)).toContain(`tmux kill-session -t '${card.tmuxSession}'`);
    expect(scriptAt(0)).toContain(`${card.tmuxSession}-sh`);

    // Nothing to hibernate = nothing happens, and no script is run.
    runScript.mockClear();
    expect(await ws.hibernateCard(card.id)).toBeUndefined();
    expect(await ws.hibernateCard("nope")).toBeUndefined();
    expect(runScript).not.toHaveBeenCalled();
  });

  it("sweepIdleCards: hibernates the silent ones, spares the working one, and honours 0 = off", async () => {
    const p = await reg.createProject({ name: "x" });
    const cold = await reg.createCard({ projectId: p.id, title: "cold" });
    const busy = await reg.createCard({ projectId: p.id, title: "busy" });
    await ws.openCard(cold.id);
    await ws.openCard(busy.id);
    await reg.applyCardStatus(cold.id, "waiting");
    await reg.applyCardStatus(busy.id, "working");

    const settings = await import("../settings/settings.js");
    await settings.updateSettings({ idleHibernateMinutes: 180 });

    // Nothing is old enough yet.
    expect(await ws.sweepIdleCards(Date.now())).toBe(0);

    // Four hours later, the idle one goes cold and the working one does not.
    runScript.mockClear();
    const later = Date.now() + 4 * 60 * 60_000;
    expect(await ws.sweepIdleCards(later)).toBe(1);
    expect((await reg.getCard(cold.id))?.hibernatedAt).toBeGreaterThan(0);
    expect((await reg.getCard(busy.id))?.hibernatedAt ?? null).toBeNull();
    expect(lastScript()).toContain(`tmux kill-session -t '${cold.tmuxSession}'`);

    // Turned off: even a card that has been silent for days is left alone.
    await settings.updateSettings({ idleHibernateMinutes: 0 });
    await ws.openCard(cold.id);
    expect(await ws.sweepIdleCards(later + 24 * 60 * 60_000)).toBe(0);
    expect((await reg.getCard(cold.id))?.hibernatedAt ?? null).toBeNull();
  });

  it("restartCard: kills ONLY the claude session (not -sh) and does NOT touch the board", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    const before = await reg.getCard(card.id);
    runScript.mockClear();

    expect((await ws.restartCard(card.id, "tester")).id).toBe(card.id);
    const after = await reg.getCard(card.id);
    expect(after?.column).toBe(before?.column);
    expect(after?.openedAt).toBe(before?.openedAt);
    expect(after?.pausedAt ?? null).toBe(before?.pausedAt ?? null);
    expect(after?.status ?? null).toBe(before?.status ?? null);

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(scriptAt(0)).toContain(`tmux kill-session -t '${card.tmuxSession}'`);
    expect(scriptAt(0)).not.toContain(`${card.tmuxSession}-sh`);

    await expect(ws.restartCard("nope")).rejects.toThrow(/card not found/);
  });

  it("applySessionChange: a model switch on an IDLE live session ends it (the reattach starts Claude on the new model)", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    await reg.applyCardStatus(card.id, "waiting");
    const before = { ...(await reg.getCard(card.id))! }; // a COPY: the registry mutates what it hands back
    const after = await reg.updateCard(card.id, { model: "claude-opus-5" });
    runScript.mockClear();

    expect(await ws.applySessionChange(before, after)).toBe("restarted");
    expect(scriptAt(0)).toContain(`tmux kill-session -t '${card.tmuxSession}'`);
    expect((await reg.getCard(card.id))?.restartPendingAt ?? null).toBeNull();
  });

  it("applySessionChange: switching while Claude WORKS flags the card instead of interrupting the task", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    await reg.applyCardStatus(card.id, "working");
    const before = { ...(await reg.getCard(card.id))! };
    const after = await reg.updateCard(card.id, { model: "claude-opus-5" });
    runScript.mockClear();

    expect(await ws.applySessionChange(before, after)).toBe("pending");
    expect(runScript).not.toHaveBeenCalled();
    const flagged = await reg.getCard(card.id);
    expect(flagged?.restartReason).toBe("config");
    expect(flagged?.restartPendingAt).toBeTruthy();
  });

  it("applySessionChange: an ACCOUNT switch counts too, and an unrelated edit or a dead session changes nothing", async () => {
    const { card } = await seed();
    const account = await reg.createAccount({ name: "Personal" });
    await ws.openCard(card.id);
    await reg.applyCardStatus(card.id, "waiting");

    const beforeAccount = { ...(await reg.getCard(card.id))! };
    const withAccount = await reg.updateCard(card.id, { accountSlug: account.slug });
    runScript.mockClear();
    expect(await ws.applySessionChange(beforeAccount, withAccount)).toBe("restarted");

    // A title edit is not a session change.
    const beforeTitle = { ...(await reg.getCard(card.id))! };
    const renamed = await reg.updateCard(card.id, { title: "renamed" });
    runScript.mockClear();
    expect(await ws.applySessionChange(beforeTitle, renamed)).toBe("none");
    expect(runScript).not.toHaveBeenCalled();

    // No live session (paused): the pin is simply what the next start will use.
    await reg.pauseCard(card.id);
    const beforePaused = { ...(await reg.getCard(card.id))! };
    const pinned = await reg.updateCard(card.id, { model: "claude-haiku-4-5" });
    runScript.mockClear();
    expect(await ws.applySessionChange(beforePaused, pinned)).toBe("none");
    expect(runScript).not.toHaveBeenCalled();
  });

  it("restartAllCards: restarts only the idle ones, SKIPS the working ones, ignores the never-opened", async () => {
    const p = await reg.createProject({ name: "x" });
    const idle = await reg.createCard({ projectId: p.id, title: "idle" });
    const busy = await reg.createCard({ projectId: p.id, title: "busy" });
    await reg.createCard({ projectId: p.id, title: "never opened" });
    await ws.openCard(idle.id);
    await ws.openCard(busy.id);
    await reg.applyCardStatus(idle.id, "waiting");
    await reg.applyCardStatus(busy.id, "working");
    runScript.mockClear();

    expect(await ws.restartAllCards("tester")).toEqual({ restarted: 1, skipped: 1 });
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(scriptAt(0)).toContain(`tmux kill-session -t '${idle.tmuxSession}'`);
    expect(scriptAt(0)).not.toContain(busy.tmuxSession);
  });

  it("restartAllCards: a host failure on one card does not take the others down (best-effort)", async () => {
    const p = await reg.createProject({ name: "y" });
    const c1 = await reg.createCard({ projectId: p.id, title: "c1" });
    const c2 = await reg.createCard({ projectId: p.id, title: "c2" });
    await ws.openCard(c1.id);
    await ws.openCard(c2.id);
    runScript.mockRejectedValue(new Error("host is down"));
    expect(await ws.restartAllCards()).toEqual({ restarted: 2, skipped: 0 });
  });

  it("restartStaggered: idle cards restart NOW, working cards are FLAGGED instead of interrupted", async () => {
    const p = await reg.createProject({ name: "x" });
    const idle = await reg.createCard({ projectId: p.id, title: "idle" });
    const busy = await reg.createCard({ projectId: p.id, title: "busy" });
    const untouched = await reg.createCard({ projectId: p.id, title: "never opened" });
    await ws.openCard(idle.id);
    await ws.openCard(busy.id);
    await reg.applyCardStatus(idle.id, "waiting");
    await reg.applyCardStatus(busy.id, "working");
    runScript.mockClear();

    expect(await ws.restartStaggered("brain", "tester")).toEqual({ restarted: 1, pending: 1 });

    // the idle one had its session killed right away (it reopens with `claude -c`, re-reading the brain)
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(scriptAt(0)).toContain(`tmux kill-session -t '${idle.tmuxSession}'`);
    expect(scriptAt(0)).not.toContain(busy.tmuxSession);
    // ...and the board was NOT touched for it: no flag, no column change
    const idleAfter = await reg.getCard(idle.id);
    expect(idleAfter?.restartPendingAt ?? null).toBeNull();
    expect(idleAfter?.column).toBe("waiting");

    // the working one was flagged, never interrupted
    const busyAfter = await reg.getCard(busy.id);
    expect(busyAfter?.restartPendingAt).toBeGreaterThan(0);
    expect(busyAfter?.restartReason).toBe("brain");
    expect(busyAfter?.status).toBe("working");

    // a card that was never opened has no session and no conversation — it is left out entirely
    expect((await reg.getCard(untouched.id))?.restartPendingAt ?? null).toBeNull();
  });

  it("restartStaggered: a PAUSED card is neither restarted nor flagged (no live session)", async () => {
    const p = await reg.createProject({ name: "x" });
    const parked = await reg.createCard({ projectId: p.id, title: "parked" });
    await ws.openCard(parked.id);
    await ws.pauseCard(parked.id);
    runScript.mockClear();

    expect(await ws.restartStaggered("mcp")).toEqual({ restarted: 0, pending: 0 });
    expect(runScript).not.toHaveBeenCalled();
    expect((await reg.getCard(parked.id))?.restartPendingAt ?? null).toBeNull();
  });

  it("restartStaggered: the reason is recorded per card so the badge can tell brain from MCP", async () => {
    const p = await reg.createProject({ name: "x" });
    const busy = await reg.createCard({ projectId: p.id, title: "busy" });
    await ws.openCard(busy.id);
    await reg.applyCardStatus(busy.id, "working");

    await ws.restartStaggered("mcp");
    expect((await reg.getCard(busy.id))?.restartReason).toBe("mcp");
    // a later brain save on the SAME pending card just relabels it — one flag serves both reasons
    await ws.restartStaggered("brain");
    expect((await reg.getCard(busy.id))?.restartReason).toBe("brain");
  });

  it("restartStaggered: one card failing does not abort the sweep (Promise.allSettled)", async () => {
    await fresh({ flakyRegistry: true });
    const p = await reg.createProject({ name: "x" });
    const doomedIdle = await reg.createCard({ projectId: p.id, title: "doomed idle" });
    const goodIdle = await reg.createCard({ projectId: p.id, title: "good idle" });
    const doomedBusy = await reg.createCard({ projectId: p.id, title: "doomed busy" });
    const goodBusy = await reg.createCard({ projectId: p.id, title: "good busy" });
    for (const c of [doomedIdle, goodIdle, doomedBusy, goodBusy]) await ws.openCard(c.id);
    await reg.applyCardStatus(doomedBusy.id, "working");
    await reg.applyCardStatus(goodBusy.id, "working");
    runScript.mockClear();

    // One card blows up on EACH half of the sweep: the idle half (restartCard reads the board) and
    // the working half (markRestartPending writes to it).
    failGetCardFor = doomedIdle.id;
    failMarkPendingFor = doomedBusy.id;
    const out = await ws.restartStaggered("brain", "tester");

    // The sweep RESOLVES rather than rejecting, and the healthy cards were served.
    expect(out).toEqual({ restarted: 2, pending: 2 });
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(scriptAt(0)).toContain(`tmux kill-session -t '${goodIdle.tmuxSession}'`);
    expect((await reg.getCard(goodBusy.id))?.restartPendingAt).toBeGreaterThan(0);
    expect((await reg.getCard(doomedBusy.id))?.restartPendingAt ?? null).toBeNull();
  });

  it("killCardSession: uses the session FROM THE BOARD and swallows a dead host", async () => {
    const { card } = await seed();
    await ws.killCardSession(card);
    expect(scriptAt(0)).toContain(`tmux kill-session -t '${card.tmuxSession}'`);
    expect(scriptAt(0)).toContain(`docker exec '${CONTAINER}'`);
    expect(scriptAt(0)).not.toContain(`${card.tmuxSession}-sh`);

    runScript.mockRejectedValue(new Error("host is down"));
    await expect(ws.killCardSession(card)).resolves.toBeUndefined();
  });

  it("dropCardWorkspace: kills both sessions, removes the git worktree and the directory", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    runScript.mockClear();
    await ws.dropCardWorkspace(card, "tester");

    expect(scriptAt(0)).toContain(`tmux kill-session -t '${card.tmuxSession}-sh'`);
    const drop = scriptAt(1);
    expect(drop).toContain(`git -C '/work/acme--erp-aux' worktree remove --force '/work/acme--erp-aux-worktrees/${card.worktreeSlug}'`);
    expect(drop).toContain("worktree prune");
    expect(drop).toContain(`rm -rf '/work/acme--erp-aux-worktrees/${card.worktreeSlug}'`);
  });

  it("dropCardWorkspace on a repo-less card removes just the scratch directory; a dead host is swallowed", async () => {
    const scratch = await reg.createProject({ name: "loose" });
    const card = await reg.createCard({ projectId: scratch.id, title: "Idea" });
    await ws.dropCardWorkspace(card);
    expect(lastScript()).toContain(`rm -rf '/work/scratch/${card.worktreeSlug}'`);
    expect(lastScript()).not.toContain("worktree remove");

    runScript.mockRejectedValue(new Error("host is down"));
    await expect(ws.dropCardWorkspace(card)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

describe("image upload into the card", () => {
  it("sanitizeUploadName: lower case, [a-z0-9._-], no '..', no dotfile, with a fallback", () => {
    expect(ws.sanitizeUploadName("Screen Shot 2026-08-14.PNG")).toBe("screen-shot-2026-08-14.png");
    const traversal = ws.sanitizeUploadName("../../etc/passwd");
    expect(traversal).toBe("etc-passwd");
    expect(traversal).not.toContain("..");
    expect(ws.sanitizeUploadName("a..b...png")).toBe("a.b.png");
    expect(ws.sanitizeUploadName(".hidden")).toBe("hidden");
    expect(ws.sanitizeUploadName("💥 !!!")).toBe("image");
    const long = ws.sanitizeUploadName("a".repeat(200) + ".png");
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith(".png")).toBe(true);
  });

  it("the base64 rides INSIDE the script (stdin) — never in argv; the path comes back", async () => {
    const { card } = await seed();
    const b64 = Buffer.from("image-content").toString("base64");
    const { path } = await ws.uploadCardImage(card.id, "Screen Area (1).PNG", b64, "local:tester");

    expect(path).toMatch(new RegExp(`^/work/\\.uploads/${card.id}/\\d+-screen-area-1-\\.png$`));
    expect(runScript).toHaveBeenCalledTimes(1);
    const script = scriptAt(0);
    expect(script).toContain(`docker exec -i '${CONTAINER}' bash -s`);
    expect(script).toContain(`mkdir -p '/work/.uploads/${card.id}'`);
    expect(script).toContain(`base64 -d > '${path}'`);
    // the payload goes into the script's heredoc, delimited by a token outside the base64 alphabet
    expect(script).toContain(`<<'VIBEHUB_B64'\n${b64}\nVIBEHUB_B64`);
  });

  it("refuses: over 10 MB, invalid base64 (injection) and an unknown card — nothing runs on the host", async () => {
    const { card } = await seed();
    const big = "A".repeat(Math.ceil(((ws.UPLOAD_MAX_BYTES + 3) * 4) / 3 / 4) * 4);
    await expect(ws.uploadCardImage(card.id, "g.png", big)).rejects.toThrow(/10 MB/);
    await expect(ws.uploadCardImage(card.id, "x.png", "abc'; rm -rf /; '")).rejects.toThrow(/invalid base64/);
    await expect(ws.uploadCardImage(card.id, "x.png", "$(reboot)")).rejects.toThrow(/invalid base64/);
    await expect(ws.uploadCardImage("nope", "x.png", "aGk=")).rejects.toThrow(/card not found/);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("buildUploadScript refuses a payload that is not strict base64", () => {
    expect(() => ws.buildUploadScript({ containerName: "c", destDir: "/d", destPath: "/d/f", base64: "VIBEHUB_B64" }))
      .toThrow(/invalid base64/);
  });

  it("a host failure during the upload surfaces the clear runner error", async () => {
    const { card } = await seed();
    runScript.mockRejectedValue(new host.HostExecError("no such container"));
    await expect(ws.uploadCardImage(card.id, "x.png", "aGk=")).rejects.toThrow(/the runner on this machine could not run the command: no such container/);
  });
});

// ---------------------------------------------------------------------------
// Long-lived token seeding and MCP injection
// ---------------------------------------------------------------------------

describe("long-lived token seeded on open (from the vault) and the session guard", () => {
  it("default account with a token: the open writes /root/.claude/.oauth-token (600) inside the script", async () => {
    const vault = await import("../../secrets/vault.js");
    await vault.secretSet("ACCOUNT_TOKEN_DEFAULT", OAUTH);
    const { card } = await seed();
    const { logger } = await import("../../utils/logger.js");
    const infoSpy = vi.spyOn(logger, "info");

    await ws.openCard(card.id);
    const script = scriptAt(0);
    expect(script).toContain(`printf '%s' '${OAUTH}' > '/root/.claude/.oauth-token'`);
    expect(script).toContain("chmod 600 '/root/.claude/.oauth-token'");
    // the seed comes BEFORE tmux (the session is born with the file already there)
    expect(script.indexOf(".oauth-token'")).toBeLessThan(script.indexOf("tmux new-session"));
    expect(script).toContain(sq(CLAUDE));
    for (const call of infoSpy.mock.calls) expect(JSON.stringify(call)).not.toContain(OAUTH);
  });

  it("the card's account: seeded into ITS profile, guard pointing there; no token = nothing written", async () => {
    const vault = await import("../../secrets/vault.js");
    await vault.secretSet("ACCOUNT_TOKEN_PERSONAL", OAUTH);
    await reg.createAccount({ name: "Personal" });
    const { card } = await seed();
    await reg.updateCard(card.id, { accountSlug: "personal" });
    await ws.openCard(card.id);
    const script = scriptAt(0);
    expect(script).toContain(`printf '%s' '${OAUTH}' > '/root/.claude-profiles/personal/.oauth-token'`);
    expect(script).toContain(sq(`${guard("/root/.claude-profiles/personal")}claude; exec bash`));
    expect(script).not.toContain("/root/.claude/.oauth-token");

    // another card on the default account with NO token: no printf, but the (harmless) guard stays
    const b = await reg.createCard({ projectId: card.projectId, title: "B" });
    await ws.openCard(b.id);
    expect(scriptAt(1)).not.toContain("printf '%s' 'sk-ant");
    expect(scriptAt(1)).toContain(sq(CLAUDE));
  });
});

describe("managed MCPs injected on open (into the card's effective profile)", () => {
  it("an MCP with no secrets: remove-before + add-json on the default profile, before tmux", async () => {
    await reg.createMcp({ name: "tech_multi", kind: "http", url: "https://example.com/mcp" });
    const { card } = await seed();
    await ws.openCard(card.id);
    const script = scriptAt(0);
    expect(script).toContain("claude mcp remove -s user 'tech_multi' >/dev/null 2>&1 || true");
    expect(script).toContain("claude mcp add-json -s user 'tech_multi' \"$(cat <<'VIBEHUB_MCP_JSON'");
    expect(script).toContain('{"type":"http","url":"https://example.com/mcp"}');
    expect(script.indexOf("mcp add-json")).toBeLessThan(script.indexOf("tmux new-session"));
  });

  it("the card's account: injection with its CLAUDE_CONFIG_DIR; a MISSING secret does not block the open", async () => {
    await reg.createAccount({ name: "Personal" });
    await reg.createMcp({ name: "tm", kind: "sse", url: "https://example.com/sse" });
    const { card } = await seed();
    await reg.updateCard(card.id, { accountSlug: "personal" });
    await ws.openCard(card.id);
    expect(scriptAt(0)).toContain("CLAUDE_CONFIG_DIR='/root/.claude-profiles/personal' claude mcp add-json -s user 'tm'");

    await reg.createMcp({ name: "erp", kind: "stdio", command: "npx", envKeys: ["ERP_TOKEN"] }); // no value in the vault
    const updated = await ws.openCard(card.id);
    expect(updated.openedAt).toBeTypeOf("number"); // the card still opened
    expect(scriptAt(1)).not.toContain("mcp add-json"); // but no MCP was injected
  });
});

describe("the brain (global CLAUDE.md) seeded on open", () => {
  it("written into the card's effective profile, before tmux, behind an idempotency marker", async () => {
    const { card } = await seed();
    await ws.openCard(card.id);
    const script = scriptAt(0);
    expect(script).toContain("cat > '/root/.claude/CLAUDE.md'");
    // guarded by the signature marker: reopening rewrites nothing
    expect(script).toMatch(/if \[ ! -f '\/root\/\.claude\/\.brain-[0-9a-f]+' \]; then/);
    expect(script.indexOf("CLAUDE.md")).toBeLessThan(script.indexOf("tmux new-session"));
  });

  it("an account card gets the brain in ITS profile, not the default one", async () => {
    await reg.createAccount({ name: "Personal" });
    const { card } = await seed();
    await reg.updateCard(card.id, { accountSlug: "personal" });
    await ws.openCard(card.id);
    expect(scriptAt(0)).toContain("cat > '/root/.claude-profiles/personal/CLAUDE.md'");
    expect(scriptAt(0)).not.toContain("'/root/.claude/CLAUDE.md'");
  });

  it("a broken brain does not block the open (best-effort, like the MCPs)", async () => {
    const brain = await import("../brain/brain.js");
    vi.spyOn(brain, "resolveBrainText").mockRejectedValue(new Error("brain is corrupt"));
    const { card } = await seed();
    expect((await ws.openCard(card.id)).column).toBe("waiting");
    expect(scriptAt(0)).not.toContain("CLAUDE.md");
  });
});

// ---------------------------------------------------------------------------
// Pre-provisioning and the per-card lock
// ---------------------------------------------------------------------------

describe("pre-provisioning (prepareCard) and the per-clone lock", () => {
  it("prepareCard runs the SAME script as the open but does NOT apply the open rule", async () => {
    const { card } = await seed();
    const prep = await ws.prepareCard(card.id, "local:tester");

    expect(runScript).toHaveBeenCalledTimes(1);
    const [script, opts] = runScript.mock.calls[0]!;
    expect((opts as { timeoutMs: number }).timeoutMs).toBe(600_000);
    expect(script).toContain("git clone");
    expect(script).toContain("worktree add");
    expect(script).toContain("tmux new-session");
    expect(script).toContain(sq(CLAUDE)); // first session: plain claude, no -c

    expect(prep.preparedAt).toBeTypeOf("number");
    expect(prep.column).toBe("backlog");
    expect(prep.openedAt).toBeUndefined();
    expect(prep.status ?? null).toBeNull();

    // the open that follows (the click) reruns the idempotent script and THEN applies the column
    const opened = await ws.openCard(card.id);
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(scriptAt(1)).toBe(String(script)); // same script (no openedAt yet)
    expect(opened.column).toBe("waiting");
    expect(opened.openedAt).toBeTypeOf("number");
    expect(opened.preparedAt).toBe(prep.preparedAt);
  });

  it("prepareCard on an unknown card THROWS and the board does not change", async () => {
    await expect(ws.prepareCard("nope")).rejects.toThrow(/card not found/);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("LOCK: an open during a running prepare WAITS (never two scripts at once on one card)", async () => {
    const { card } = await seed();
    let releasePrepare: () => void = () => {};
    runScript.mockImplementationOnce(() => new Promise((res) => { releasePrepare = () => res({ stdout: "", stderr: "" }); }));

    const prepareP = ws.prepareCard(card.id);
    await vi.waitFor(() => expect(runScript).toHaveBeenCalledTimes(1));

    let openResolved = false;
    const openP = ws.openCard(card.id).then((c) => { openResolved = true; return c; });
    await new Promise((r) => setTimeout(r, 20));
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(openResolved).toBe(false);
    expect((await reg.getCard(card.id))?.column).toBe("backlog");

    releasePrepare();
    const prep = await prepareP;
    const opened = await openP;
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(prep.preparedAt).toBeTypeOf("number");
    expect(opened.column).toBe("waiting");
  });

  it("LOCK: a prepare that FAILS does not wedge the card; a card of ANOTHER clone does not wait", async () => {
    const { card } = await seed();
    // Another project = another clone directory = another queue.
    const otherProject = await reg.createProject({ name: "bank-api", repoFullName: "acme/bank-api" });
    const other = await reg.createCard({ projectId: otherProject.id, title: "Other" });
    let failPrepare: () => void = () => {};
    runScript.mockImplementationOnce(() => new Promise((_res, rej) => { failPrepare = () => rej(new Error("docker died")); }));
    const prepareP = ws.prepareCard(card.id);
    await vi.waitFor(() => expect(runScript).toHaveBeenCalledTimes(1));

    // a card that writes to a DIFFERENT clone does not wait on this one's lock
    expect((await ws.openCard(other.id)).column).toBe("waiting");
    expect(runScript).toHaveBeenCalledTimes(2);

    failPrepare();
    await expect(prepareP).rejects.toThrow(/docker died/);
    expect((await reg.getCard(card.id))?.preparedAt).toBeUndefined();

    expect((await ws.openCard(card.id)).column).toBe("waiting");
    expect(runScript).toHaveBeenCalledTimes(3);
  });

  /**
   * THE REGRESSION. Two cards of the same project used to hold two DIFFERENT locks, so creating a
   * card while another was being provisioned ran two scripts against one clone: a second `git clone`
   * into a half-populated directory, or a `fetch`/`worktree add` overlapping another. `set -e` then
   * killed the script and the card simply refused to open — until the first clone finished and a
   * retry silently worked, which is what made it look random.
   */
  it("LOCK: two cards of the SAME project NEVER run two scripts at once against the clone", async () => {
    const { card, project } = await seed();
    const sibling = await reg.createCard({ projectId: project.id, title: "Sibling" });
    let live = 0;
    let maxLive = 0;
    runScript.mockImplementation(async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 10));
      live -= 1;
      return { stdout: "", stderr: "" };
    });

    await Promise.all([ws.prepareCard(card.id), ws.openCard(sibling.id)]);

    expect(runScript).toHaveBeenCalledTimes(2);
    expect(maxLive).toBe(1); // serialized, not concurrent
  });

  it("LOCK: a project with NO repository locks per card — nothing is shared, so nothing queues", async () => {
    const project = await reg.createProject({ name: "scratch" });
    const a = await reg.createCard({ projectId: project.id, title: "A" });
    const b = await reg.createCard({ projectId: project.id, title: "B" });
    let live = 0;
    let maxLive = 0;
    runScript.mockImplementation(async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 10));
      live -= 1;
      return { stdout: "", stderr: "" };
    });

    await Promise.all([ws.openCard(a.id), ws.openCard(b.id)]);

    expect(maxLive).toBe(2); // no clone to corrupt: they run together
  });

  it("LOCK: two simultaneous opens on one card serialize and both see the same stamp", async () => {
    const { card } = await seed();
    const order: string[] = [];
    runScript.mockImplementation(async () => {
      order.push("start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("end");
      return { stdout: "", stderr: "" };
    });
    const [a, b] = await Promise.all([ws.openCard(card.id), ws.openCard(card.id)]);
    expect(order).toEqual(["start", "end", "start", "end"]);
    expect(a.openedAt).toBe(b.openedAt);
    expect(b.column).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
// GitHub token per card (push/PR as the project's connection, not the runner's org login)
// ---------------------------------------------------------------------------

describe("card push as the project's GitHub connection (GH_TOKEN)", () => {
  const GH = "ghp_ABCdef1234567890ABCdef1234567890";
  const ghGuard = (f: string) => `if [ -s ${f} ]; then export GH_TOKEN="$(cat ${f})"; fi; `;
  const openOpts = {
    containerName: CONTAINER,
    tmuxSession: "card-abc",
    cardId: "id-1",
    statusUrl: STATUS_URL,
    cwd: "/work/x",
  };

  it("sessionCommand exports GH_TOKEN from the file when given one, right after the Claude-token guard", () => {
    const f = "/root/.vibehub/gh/id-1.token";
    expect(ws.sessionCommand({ ghTokenFile: f })).toBe(`${guard()}${ghGuard(f)}claude; exec bash`);
    // no file given = no GH_TOKEN at all (a card without a connection keeps the ambient gh login)
    expect(ws.sessionCommand({})).toBe(CLAUDE);
    expect(ws.sessionCommand({})).not.toContain("GH_TOKEN");
  });

  it("open WITH a connection token writes it 600 over stdin, and the session reads the FILE (token never in the command)", () => {
    const script = ws.buildOpenScript({ ...openOpts, ghToken: GH });
    expect(script).toContain(`printf '%s' '${GH}' > '/root/.vibehub/gh/id-1.token'`);
    expect(script).toContain("chmod 600 '/root/.vibehub/gh/id-1.token'");
    expect(script).toContain(ghGuard("/root/.vibehub/gh/id-1.token"));
    // the value appears ONLY on the write line — the export reads the file, never inlines the token
    expect(script).not.toContain(`GH_TOKEN="${GH}"`);
  });

  it("open WITHOUT a connection removes the token file (kept in sync) and emits no GH_TOKEN guard", () => {
    const script = ws.buildOpenScript(openOpts);
    expect(script).toContain("rm -f '/root/.vibehub/gh/id-1.token'");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).not.toContain(GH);
  });
});
