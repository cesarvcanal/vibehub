import { hostExecutor, shQuote, assertSafeRemotePath, HostExecError } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { statusUrl } from "../../runtime/runner.js";
import { gitAuthHeaderFor, tokenFor } from "../github/client.js";
import {
  getCard, getProject, applyOpenTerminal, markPrepared, pauseCard as registryPauseCard,
  listAllCards, assertBranchName, assertSessionId, effectiveAccountSlug, isValidModel, hasLiveSession,
  markRestartPending,
  type Card, type Project, type RestartReason,
} from "./registry.js";
import { CLAUDE_PROFILES_DIR, DEFAULT_CLAUDE_DIR, accountConfigDir, profileDirFor, oauthTokenPath } from "../accounts/profiles.js";
import { resolveAccountToken, writeTokenLines, ghTokenPath, writeGhTokenLines, removeGhTokenLines } from "../accounts/token.js";
import { cardCdpEndpoint } from "../browser/ports.js";
import { mcpInjectLines, resolveMcpInjections, type McpInjection } from "../mcp/mcp.js";
import { brainInjectLines, resolveBrainText } from "../brain/brain.js";
import { logger } from "../../utils/logger.js";

export { CLAUDE_PROFILES_DIR, DEFAULT_CLAUDE_DIR, accountConfigDir };

/**
 * A CARD'S WORKSPACE inside the runner: the repository clone, the card's own git worktree, and the
 * tmux session with Claude Code running in it.
 *
 * SECURITY INVARIANT: NOTHING the user typed reaches a shell raw. Every value that enters a script
 * is DERIVED or validated in the backend (worktreeSlug / tmuxSession come from the board, the branch
 * is validated, the repo directory is extracted from a validated clone URL) and is shell-quoted on
 * top of that.
 *
 * GITHUB CREDENTIAL (private repositories): EPHEMERAL. The token travels INSIDE the script over
 * STDIN (never argv, which is world-readable in `ps`) as an http header, applied per-command through
 * `GIT_CONFIG_*` on the clone/fetch processes only. The remote URL stays CLEAN: no credential is
 * ever persisted in `/work/<repo>/.git/config`, which any process in the container can read —
 * including the resident Claude Code agent, which processes untrusted repository content and has
 * network egress.
 *
 * ONE RUNNER: the original panel resolved a runner app per server and threaded a server IP through
 * every call. vibehub has exactly one runner (`config.runner.container`) reached through one host
 * executor, so the IP parameter and the per-server lookup are gone.
 */

/** Heredoc delimiters — reserved words, never derived from user input. */
const OPEN_DELIM = "VIBEHUB_OPEN";
const UPLOAD_DELIM = "VIBEHUB_UPLOAD";
const B64_DELIM = "VIBEHUB_B64";

export interface SessionCommandOpts {
  /** true = the card HAS had a session before (openedAt): resume the last conversation (`claude -c`). */
  resume?: boolean;
  /** IMPORTED session (validated uuid): try `claude --resume <id>` first. */
  resumeSessionId?: string;
  /**
   * Directory of the session's EFFECTIVE profile (/root/.claude or the account's) — where the
   * long-lived token's `.oauth-token` lives. Absent = /root/.claude.
   */
  profileDir?: string;
  /**
   * The card's Claude model (one of CLAUDE_MODELS): when VALID, Claude starts with `--model <id>`.
   * Absent/invalid = the account default (no flag at all). Checked against the whitelist
   * (isValidModel) — raw input never reaches the shell.
   */
  model?: string;
  /**
   * Per-card file that MAY hold the project's GitHub token. When set, the guard exports `GH_TOKEN`
   * by reading the file IF it exists (`[ -s <file> ]`) — so `git push`/`gh` in the card act as the
   * project's connection instead of the runner's ambient login. Only ever WRITTEN by the open script
   * (over STDIN); this only READS it, so no token lands in argv. File missing = ambient login.
   */
  ghTokenFile?: string;
}

/**
 * The command a card's tmux session runs (a string executed by tmux's `sh -c`, so the token prefix
 * runs in the session's SHELL, not in tmux's argv).
 *
 * Conditional prefix: if the profile holds an `.oauth-token` (long-lived token from
 * `claude setup-token`), export CLAUDE_CODE_OAUTH_TOKEN read FROM THE FILE — Claude then starts
 * already logged in, no `/login`. With no file nothing changes (the profile's normal login).
 *
 * Then Claude itself: `resumeSessionId` (imported session) → `claude --resume <id> || claude -c ||
 * claude`; else `resume` (the card already had a session: pause, runner restart) → `claude -c ||
 * claude` — the transcript survives in the profile (CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1); else
 * plain `claude`.
 *
 * The trailing `exec bash` is deliberate: when Claude exits the pane must keep a shell instead of
 * dying. It used to be a bare `bash`, and quitting Claude took the tmux window down with it.
 * PURE.
 */
export function sessionCommand(opts: SessionCommandOpts | boolean): string {
  const o: SessionCommandOpts = typeof opts === "boolean" ? { resume: opts } : opts;
  const profileDir = o.profileDir ?? DEFAULT_CLAUDE_DIR;
  assertSafeRemotePath(profileDir);
  const tokenFile = oauthTokenPath(profileDir);
  // IS_SANDBOX=1: the runner is root inside an isolated container; without it Claude refuses to run
  // without permission prompts ("cannot be used with root"). Belt for runners provisioned before the
  // container environment carried the flag.
  // GH_TOKEN, read from the per-card file when the open script wrote one (project has a connection):
  // steers `git push` and `gh` to that identity. Guarded by `[ -s ]` so a card without a connection
  // (no file) keeps the runner's ambient `gh` login. The path is validated; no token in argv.
  let ghGuard = "";
  if (o.ghTokenFile) {
    assertSafeRemotePath(o.ghTokenFile);
    ghGuard = `if [ -s ${o.ghTokenFile} ]; then export GH_TOKEN="$(cat ${o.ghTokenFile})"; fi; `;
  }
  const guard =
    `export IS_SANDBOX=1; ` +
    `if [ -s ${tokenFile} ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${tokenFile})"; fi; ` +
    ghGuard;
  // The pin is a COMMAND-LINE flag, not `ANTHROPIC_DEFAULT_MODEL`: that variable is only the default
  // for when nothing else says anything, and the profile's own settings.json (`"model"`, written by
  // any `/model` typed in ANY card sharing that account profile) beat it — a card pinned to Opus
  // would boot on whatever the last `/model` left behind. `--model` wins over both. Only when the id
  // is VALID (CLAUDE_MODELS whitelist): safe charset, never raw input.
  const model = isValidModel(o.model) ? ` --model ${o.model}` : "";
  let claude: string;
  if (o.resumeSessionId) {
    claude = `claude${model} --resume ${assertSessionId(o.resumeSessionId)} || claude${model} -c || claude${model}`;
  } else if (o.resume) claude = `claude${model} -c || claude${model}`;
  else claude = `claude${model}`;
  return `${guard}${claude}; exec bash`;
}

const REPO_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The project's effective clone URL: the explicit one, or derived from repoFullName. PURE. */
export function effectiveCloneUrl(project: Pick<Project, "repoFullName" | "cloneUrl">): string | undefined {
  if (project.cloneUrl?.trim()) return project.cloneUrl.trim();
  if (project.repoFullName?.trim()) return `https://github.com/${project.repoFullName.trim()}.git`;
  return undefined;
}

/**
 * Directory name of the clone under /work: "owner--repo", from the two segments of repoFullName or
 * of the clone URL. The OWNER is part of the name because two owners can have repositories with the
 * same name — with just the repo name they would share one clone and every open would rewrite the
 * other's origin. Validated (safe charset) — THROWS when it does not yield a sane name.
 * undefined = a project with no repository. PURE.
 */
export function repoDirName(project: Pick<Project, "repoFullName" | "cloneUrl">): string | undefined {
  let owner: string | undefined;
  let name: string | undefined;
  if (project.repoFullName?.trim()) {
    [owner, name] = project.repoFullName.trim().split("/");
  } else if (project.cloneUrl?.trim()) {
    const m = /github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(project.cloneUrl.trim());
    owner = m?.[1];
    name = m?.[2];
  }
  if (owner === undefined || name === undefined) return undefined;
  name = name.replace(/\.git$/, "");
  const dir = `${owner}--${name}`;
  if (!REPO_DIR_RE.test(owner) || !REPO_DIR_RE.test(name) || name === "." || name === "..") {
    throw new Error(`invalid repository name: '${dir}'`);
  }
  return dir;
}

export interface CardPaths {
  /** cwd of the card's tmux session (the repo worktree, or the scratch directory). */
  cwd: string;
  /** Main clone directory under /work (absent = project with no repository). */
  repoDir?: string;
}

/** The card's paths INSIDE the runner. Derived from the board — never from the request. PURE. */
export function cardWorkPaths(project: Project, card: Pick<Card, "worktreeSlug">): CardPaths {
  if (!SLUG_RE.test(card.worktreeSlug)) throw new Error(`invalid worktreeSlug: '${card.worktreeSlug}'`);
  const repo = repoDirName(project);
  if (repo) return { repoDir: `/work/${repo}`, cwd: `/work/${repo}-worktrees/${card.worktreeSlug}` };
  return { cwd: `/work/scratch/${card.worktreeSlug}` };
}

export interface OpenScriptOpts {
  containerName: string;
  tmuxSession: string;
  cardId: string;
  statusUrl: string;
  /** Final cwd of the session (worktree or scratch). */
  cwd: string;
  /**
   * CLAUDE_CONFIG_DIR of the card's EFFECTIVE account profile (/root/.claude-profiles/<slug>).
   * ABSENT = the default account (the runner's /root/.claude) — nothing changes in the session env.
   */
  accountConfigDir?: string;
  /** true = the card already had a session (openedAt): the new one resumes it (`claude -c`). */
  resume?: boolean;
  /** Imported session (uuid): the session is born with `claude --resume <id>`. */
  resumeSessionId?: string;
  /** The card's Claude model: Claude starts with `--model <id>`. Absent = account default. */
  model?: string;
  /**
   * The effective account's long-lived token (from the vault): SEEDED into the profile
   * (<profile>/.oauth-token, mode 600) inside the script — over STDIN, never argv. Absent = nothing
   * is written.
   */
  oauthToken?: string;
  /**
   * The PROJECT's GitHub connection token (from the vault) — written to the per-card gh-token file
   * (mode 600) inside the script, over STDIN, never argv. The session then exports `GH_TOKEN` from
   * that file so the card's `git push`/`gh` act as the connection. Absent = the file is REMOVED
   * (kept in sync), so the card falls back to the runner's ambient `gh` login.
   */
  ghToken?: string;
  /** Managed MCPs (JSON already resolved) to inject into the card's effective profile. */
  mcps?: McpInjection[];
  /**
   * The BRAIN (global instructions, markdown) to seed as CLAUDE.md at the root of the card's
   * effective profile. Idempotent by signature (a `.brain-<sig>` marker): the open only rewrites it
   * when the text changed.
   */
  brain?: string;
  /** Present = the project has a repository: clone/fetch/worktree before tmux. */
  repo?: {
    dir: string;
    /** The card's branch (card/<worktreeSlug>, or the card's own when set). */
    branch: string;
    /** Base branch (without the origin/ prefix). */
    base: string;
    /** CLEAN clone URL (no token) — this is what stays persisted as the clone's remote. */
    cloneUrl: string;
    /**
     * http auth header ("AUTHORIZATION: basic <b64>") for a PRIVATE repository — an EPHEMERAL
     * credential: it goes over STDIN inside the script and only onto the clone/fetch commands,
     * NEVER persisted in the clone.
     */
    authHeader?: string;
  };
}

/**
 * The card's OPEN script (runs on the HOST through the host executor over stdin; the body runs
 * INSIDE the runner via `docker exec -i … bash -s` with a heredoc). Idempotent: clone only when
 * missing, worktree only when missing, tmux session only when missing (the `has-session ||` guard —
 * `new-session -A` without a tty turns into an attach and FAILS once the session exists).
 * PURE/testable.
 *
 * Credential (private repo): an EPHEMERAL per-command http header (GIT_CONFIG_* on clone/fetch only
 * — a per-command assignment never leaks into the shell environment nor into the tmux server). The
 * remote is always re-pointed at the CLEAN URL — besides picking up a changed project URL, that
 * REMOVES any token an older clone may have persisted in .git/config.
 */
export function buildOpenScript(opts: OpenScriptOpts): string {
  const inner: string[] = ["set -e"];
  if (opts.repo) {
    const branch = assertBranchName(opts.repo.branch);
    const base = assertBranchName(opts.repo.base);
    // git with the ephemeral credential ONLY on the network commands (clone/fetch); no header = plain git.
    const gitAuthed = opts.repo.authHeader
      ? `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="$GIT_AUTH" git`
      : "git";
    inner.push(
      `CLONE_URL=${shQuote(opts.repo.cloneUrl)}`,
      `REPO_DIR=${shQuote(opts.repo.dir)}`,
      `WT=${shQuote(opts.cwd)}`,
    );
    if (opts.repo.authHeader) inner.push(`GIT_AUTH=${shQuote(opts.repo.authHeader)}`);
    inner.push(
      `if [ ! -d "$REPO_DIR/.git" ]; then ${gitAuthed} clone "$CLONE_URL" "$REPO_DIR"; fi`,
      // The remote ALWAYS goes back to the clean URL — this fixes a stale URL AND scrubs a legacy
      // credential (cheap: it does not touch the network).
      `git -C "$REPO_DIR" remote set-url origin "$CLONE_URL"`,
      // Fetch ONLY when the worktree does not exist yet (that is when the base must be fresh). On a
      // REOPEN — the hot "instant open" path — the idempotent open pays no network round trip: the
      // fetch on every reopen used to be the bulk of the latency.
      `if [ ! -d "$WT" ]; then`,
      `  ${gitAuthed} -C "$REPO_DIR" fetch --prune origin`,
      `  if git -C "$REPO_DIR" show-ref --verify --quiet ${shQuote(`refs/heads/${branch}`)}; then`,
      `    git -C "$REPO_DIR" worktree add "$WT" ${shQuote(branch)}`,
      // The branch already exists on the remote (imported session/branch, or a recreated card):
      // start FROM IT, not from the base — otherwise `-b` would fail or the worktree would be born
      // diverged from what was already published.
      `  elif git -C "$REPO_DIR" show-ref --verify --quiet ${shQuote(`refs/remotes/origin/${branch}`)}; then`,
      `    git -C "$REPO_DIR" worktree add "$WT" -b ${shQuote(branch)} ${shQuote(`origin/${branch}`)}`,
      `  else`,
      `    git -C "$REPO_DIR" worktree add "$WT" -b ${shQuote(branch)} ${shQuote(`origin/${base}`)}`,
      `  fi`,
      `fi`,
    );
  } else {
    inner.push(`WT=${shQuote(opts.cwd)}`, `mkdir -p "$WT"`);
  }
  if (opts.accountConfigDir) {
    // The ACCOUNT profile in the runner, guaranteed BEFORE tmux: mkdir plus a settings.json seeded
    // from the default account — the STATUS HOOKS (the board's green/amber dot) live in that
    // settings.json; without the copy a new account is born without hooks and the mirror dies. Only
    // the FIRST time (the -f guard): from then on the profile owns its settings (the account's own
    // login/tweaks are never overwritten).
    inner.push(
      `CLAUDE_CFG=${shQuote(opts.accountConfigDir)}`,
      `mkdir -p "$CLAUDE_CFG"`,
      `if [ ! -f "$CLAUDE_CFG/settings.json" ] && [ -f ${DEFAULT_CLAUDE_DIR}/settings.json ]; then`,
      `  cp ${DEFAULT_CLAUDE_DIR}/settings.json "$CLAUDE_CFG/settings.json"`,
      `fi`,
    );
  }
  const profileDir = opts.accountConfigDir ?? DEFAULT_CLAUDE_DIR;
  // The account's long-lived token (vault): seeded into the profile on every open (idempotent; keeps
  // the runner current when the token was replaced in the UI before a runner/project existed).
  if (opts.oauthToken) inner.push(...writeTokenLines(profileDir, opts.oauthToken));
  // GitHub token file, kept in SYNC with the project's connection: written when present, removed
  // otherwise, so a card can never export a stale token from a connection that was cleared.
  inner.push(
    ...(opts.ghToken ? writeGhTokenLines(opts.cardId, opts.ghToken) : removeGhTokenLines(opts.cardId)),
  );
  // Managed MCPs into the card's effective profile (remove-before + add-json, JSON in a heredoc).
  if (opts.mcps?.length) inner.push(...mcpInjectLines([opts.accountConfigDir], opts.mcps));
  // The brain (global CLAUDE.md) seeded into the card's effective profile — idempotent by signature,
  // so reopening a card rewrites nothing; new text is picked up on the next open.
  if (opts.brain) inner.push(...brainInjectLines([opts.accountConfigDir], opts.brain));
  inner.push(
    // With no tty (bash -s through docker exec -i), `new-session -A` on an existing session becomes
    // an attach and exits with "open terminal failed" — the guard creates the session ONLY when it
    // does not exist yet (reopening is a no-op).
    // The tmux SERVER is born on the first new-session — through a non-interactive `docker exec`
    // (which does not read .profile) it would inherit the C locale and accented characters would
    // degrade to "_" (seen in production). The per-command prefix pins UTF-8 on the server; the
    // `-e LANG` below only covers the environment INSIDE the session. (A fresh runner already has
    // LANG/LC_ALL in the container env — this is the belt for older ones.)
    `tmux has-session -t ${shQuote(opts.tmuxSession)} 2>/dev/null ||` +
      ` LANG=C.UTF-8 LC_ALL=C.UTF-8 tmux new-session -d -s ${shQuote(opts.tmuxSession)} -c "$WT"` +
      ` -e VIBEHUB_CARD_ID=${shQuote(opts.cardId)} -e VIBEHUB_STATUS_URL=${shQuote(opts.statusUrl)}` +
      // CDP endpoint of the card's live browser: the repo's `.mcp.json` points the Playwright MCP at
      // ${PW_CDP_ENDPOINT} (--cdp-endpoint) so Claude drives the SAME Chromium the user watches on
      // the noVNC canvas. Derived from the id (never raw input).
      ` -e PW_CDP_ENDPOINT=${shQuote(cardCdpEndpoint(opts.cardId))}` +
      // Explicit UTF-8 in the session: .profile covers login shells, but tmux decides the encoding
      // from the environment it is given — without this, accents become "_" (seen in production).
      ` -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8` +
      // Non-default account: the session's Claude uses the account profile (isolated credentials/state).
      (opts.accountConfigDir ? ` -e CLAUDE_CONFIG_DIR=${shQuote(opts.accountConfigDir)}` : "") +
      ` ${shQuote(sessionCommand({ resume: !!opts.resume, resumeSessionId: opts.resumeSessionId, profileDir, model: opts.model, ghTokenFile: opts.ghToken ? ghTokenPath(opts.cardId) : undefined }))}`,
  );
  return [
    "set -e",
    `docker exec -i ${shQuote(opts.containerName)} bash -s <<'${OPEN_DELIM}'`,
    ...inner,
    OPEN_DELIM,
  ].join("\n");
}

export interface CardAttachOpts {
  cardId: string;
  statusUrl: string;
  /** CLAUDE_CONFIG_DIR of the EFFECTIVE account profile; absent = the runner's default account. */
  accountConfigDir?: string;
  /** true = the card already had a session (openedAt): if the attach has to CREATE, resume with `claude -c`. */
  resume?: boolean;
  /** Imported session (uuid): if the attach has to CREATE, it is born with `claude --resume <id>`. */
  resumeSessionId?: string;
  /** The card's Claude model: Claude starts with `--model <id>`. Absent = account default. */
  model?: string;
  /**
   * Per-card gh-token file the session exports `GH_TOKEN` from (see SessionCommandOpts). The PATH is
   * safe in argv — the token itself is only ever written by the open script over STDIN.
   */
  ghTokenFile?: string;
  /**
   * true = the EXTRA plain-shell terminal (the "Shell" button): a SEPARATE tmux session
   * `<tmuxSession>-sh`, same cwd, `exec bash` with no claude. The suffix is derived HERE — never
   * taken from input.
   */
  shell?: boolean;
}

/**
 * argv of the card TERMINAL's remote command: `tmux new-session -A` = a COMPLETE attach-or-create —
 * it carries the SAME environment and command the open gives the session (VIBEHUB_CARD_ID /
 * VIBEHUB_STATUS_URL for the status hooks, the UTF-8 locale, the account's CLAUDE_CONFIG_DIR,
 * `claude; exec bash`). If the runner restarted and the session vanished, the attach recreates an
 * IDENTICAL one — it used to create one with no environment and the status mirror died silently.
 * Thanks to that, on an already-open card the websocket alone is enough (the /open call becomes
 * background work). Everything is derived from the board. PURE.
 */
export function terminalRemoteArgs(containerName: string, tmuxSession: string, cwd: string, opts: CardAttachOpts): string[] {
  const session = opts.shell ? `${tmuxSession}-sh` : tmuxSession;
  return [
    "docker", "exec", "-it", containerName,
    // `env LANG/LC_ALL` BEFORE tmux: if it is this attach that starts the tmux server (restarted
    // runner), the server is born in UTF-8 — the `-e LANG` only applies inside the session.
    "env", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
    "tmux", "new-session", "-A", "-s", session, "-c", cwd,
    "-e", `VIBEHUB_CARD_ID=${opts.cardId}`, "-e", `VIBEHUB_STATUS_URL=${opts.statusUrl}`,
    // CDP endpoint of the card's live browser (see buildOpenScript) — a session created by the
    // websocket's attach-or-create needs the variable for the card's Playwright MCP too.
    "-e", `PW_CDP_ENDPOINT=${cardCdpEndpoint(opts.cardId)}`,
    "-e", "LANG=C.UTF-8", "-e", "LC_ALL=C.UTF-8",
    ...(opts.accountConfigDir ? ["-e", `CLAUDE_CONFIG_DIR=${opts.accountConfigDir}`] : []),
    opts.shell
      ? "exec bash"
      : sessionCommand({
          resume: !!opts.resume,
          resumeSessionId: opts.resumeSessionId,
          profileDir: opts.accountConfigDir ?? DEFAULT_CLAUDE_DIR,
          model: opts.model,
          ghTokenFile: opts.ghTokenFile,
        }),
  ];
}

/**
 * The websocket attach argv for a card, RESOLVED from the board: the worktree cwd, the effective
 * account (card → project → default) and the shell variant. This is what the terminal route uses.
 */
export function cardAttachArgs(
  containerName: string,
  project: Project,
  card: Card,
  opts: { shell?: boolean } = {},
): string[] {
  const { cwd } = cardWorkPaths(project, card);
  const slug = effectiveAccountSlug(card, project);
  const dir = slug ? accountConfigDir(slug) : undefined;
  if (dir) assertSafeRemotePath(dir);
  return terminalRemoteArgs(containerName, card.tmuxSession, cwd, {
    cardId: card.id,
    statusUrl: statusUrl(),
    accountConfigDir: dir,
    // The card was opened before (INCLUDING a paused one — its session was killed on purpose): the
    // attach-or-create, when it creates, comes back to the SAME conversation. This is the websocket's
    // instant path, with no /open gate.
    resume: !!card.openedAt,
    resumeSessionId: card.resumeSessionId,
    model: card.model,
    // Only when the project has a GitHub connection: the session then exports GH_TOKEN from the
    // per-card file a prior /open wrote (the export is still `[ -s ]`-guarded). The PATH is safe in
    // argv; the token itself never is. No connection = the runner's ambient gh login, unchanged.
    ghTokenFile: project.githubConnectionId ? ghTokenPath(card.id) : undefined,
    shell: opts.shell,
  });
}

/**
 * A single shell line for the card terminal, ready for `hostExecutor().ptyCommand()`: the argv,
 * quoted element by element (ssh concatenates argv and re-parses it remotely, so the quoting has to
 * be in the string already). PURE.
 */
export function cardTerminalCommandLine(
  containerName: string,
  project: Project,
  card: Card,
  opts: { shell?: boolean } = {},
): string {
  return cardAttachArgs(containerName, project, card, opts).map(shQuote).join(" ");
}

/**
 * argv the websocket route spawns for a card terminal, resolved through the host executor —
 * `bash -lc …` when Docker is local, `ssh … <command>` when it is across a hop.
 */
export function cardTerminalCommand(
  project: Project,
  card: Card,
  opts: { shell?: boolean } = {},
): { file: string; args: string[] } {
  return hostExecutor().ptyCommand(cardTerminalCommandLine(config.runner.container, project, card, opts));
}

/** The card worktree's branch: its own (validated) or the derived `card/<worktreeSlug>`. PURE. */
export function cardBranch(card: Pick<Card, "branch" | "worktreeSlug">): string {
  return card.branch ? assertBranchName(card.branch) : `card/${card.worktreeSlug}`;
}

/** Turns a host failure into a message that names the host and tells the user where to look. */
function runnerUnreachable(err: unknown): Error {
  const detail = err instanceof HostExecError ? err.message : String((err as Error)?.message ?? err);
  return new Error(`the runner on ${hostExecutor().label} could not run the command: ${detail}`);
}

/**
 * In-memory LOCK, keyed by the CLONE the script is going to touch: the pre-provisioning (on
 * creation) and the open (on click) run the SAME script in the runner, and everything it does to a
 * repository — `git clone` into the directory, `fetch --prune`, `worktree add` — is a write to ONE
 * shared clone under /work. Two of those at once do not merely race: a second clone into a
 * half-populated directory dies with "destination path already exists", and a fetch that overlaps
 * another fetch or a worktree add dies on `index.lock`/`cannot lock ref`. `set -e` then fails the
 * whole script, so what the user sees is a card that refuses to open — and, because the clone that
 * came first carries on, the same card opening fine a couple of minutes later.
 *
 * A per-CARD key would not cover that: the cards that collide are DIFFERENT cards of the SAME
 * project, which is exactly what creating two cards in a row does. So the key is the clone
 * directory, and cards with no repository (scratch projects, which touch nothing shared) fall back
 * to their own id and never queue behind anyone.
 *
 * The cost is small: the script is idempotent, so a card that waited for a neighbour's clone only
 * pays for the verification (tenths of a second, no network — the fetch only runs when the worktree
 * is missing). One backend process = a Map is enough (no other process touches this runner).
 */
const provisionLocks = new Map<string, Promise<unknown>>();

async function withProvisionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = provisionLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  provisionLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (provisionLocks.get(key) === tail) provisionLocks.delete(key);
  }
}

/**
 * The lock key for a card: the project's clone directory when it has a repository (shared with
 * every other card of that project), the card itself otherwise. PURE.
 */
export function provisionLockKey(project: Project, card: Card): string {
  return cardWorkPaths(project, card).repoDir ?? `card:${card.id}`;
}

/** Result of provisioning: the loaded card/project and the effective account (for the audit line). */
interface ProvisionResult {
  card: Card;
  project: Project;
  accountSlug?: string;
}

/**
 * Guarantees the card's WORKSPACE in the runner: clone + worktree + tmux session with Claude Code
 * (an idempotent script, under the card's lock). It does NOT touch the board — the caller decides
 * what to stamp (open → applyOpenTerminal; prepare → markPrepared). The card is read INSIDE the
 * lock: the state the script uses (openedAt/pausedAt/account) is the one in force after any earlier
 * provisioning.
 */
async function provisionWorkspace(cardId: string): Promise<ProvisionResult> {
  // The KEY is resolved before the queue is entered (it names the clone this script will write to);
  // the card and the project are read AGAIN inside, because what matters to the script is the state
  // in force after whoever was ahead in the queue has finished.
  const pending = await getCard(cardId);
  if (!pending) throw new Error("card not found");
  const pendingProject = await getProject(pending.projectId);
  if (!pendingProject) throw new Error("project for this card not found");

  return withProvisionLock(provisionLockKey(pendingProject, pending), async () => {
    const card = await getCard(cardId);
    if (!card) throw new Error("card not found");
    const project = await getProject(card.projectId);
    if (!project) throw new Error("project for this card not found");

    const paths = cardWorkPaths(project, card);
    let repo: OpenScriptOpts["repo"];
    const cloneUrl = effectiveCloneUrl(project);
    if (cloneUrl && paths.repoDir) {
      // Private repository: an EPHEMERAL credential (http header) built in the backend — it travels
      // over STDIN inside the script, never in argv, and is NEVER embedded in the remote URL (no
      // token in .git/config inside the runner). The credential is the one of THIS PROJECT's GitHub
      // account (`githubConnectionId`; absent = the first connected account). GitHub not connected =
      // no header (a public repo clones without a credential).
      let authHeader: string | undefined;
      try {
        authHeader = await gitAuthHeaderFor(project);
      } catch {
        /* no GitHub integration → public repository */
      }
      repo = { dir: paths.repoDir, branch: cardBranch(card), base: card.base, cloneUrl, authHeader };
    }

    // The card's EFFECTIVE account (card → project default → runner default). The slug comes from
    // the BOARD and is re-validated while deriving the path; assertSafeRemotePath is the extra belt.
    const accountSlug = effectiveAccountSlug(card, project);
    const accountDir = accountSlug ? accountConfigDir(accountSlug) : undefined;
    if (accountDir) assertSafeRemotePath(accountDir);
    assertSafeRemotePath(profileDirFor(accountSlug));

    // The account's long-lived token (vault) — seeded into the profile inside the script (stdin).
    const oauthToken = await resolveAccountToken(accountSlug);
    // The PROJECT's GitHub connection token, so the card's own git push / gh pr act as that identity
    // (e.g. a personal repo the runner's org login can only read). BEST-EFFORT: a missing/unconfigured
    // connection must not stop a card from opening — absent means the token file is removed and the
    // card falls back to the runner's ambient gh login.
    let ghToken: string | undefined;
    if (project.githubConnectionId) {
      try {
        ghToken = await tokenFor(project.githubConnectionId);
      } catch (e) {
        logger.warn({ card: card.worktreeSlug, detail: (e as Error).message }, "GitHub connection token not resolved on open (ambient gh login)");
      }
    }
    // Managed MCPs: BEST-EFFORT on open (a missing secret must not stop a card from opening — the
    // "apply" button in the UI is the path that fails loudly and names what is missing).
    let mcps: McpInjection[] = [];
    try {
      mcps = await resolveMcpInjections();
    } catch (e) {
      logger.warn({ card: card.worktreeSlug, detail: (e as Error).message }, "managed MCPs not injected on open (continuing)");
    }
    // The brain (global CLAUDE.md): BEST-EFFORT on open (malformed text must not stop a card from
    // opening — the UI's save is the path that validates and fails loudly).
    let brain: string | undefined;
    try {
      brain = await resolveBrainText();
    } catch (e) {
      logger.warn({ card: card.worktreeSlug, detail: (e as Error).message }, "brain not seeded on open (continuing)");
    }

    const script = buildOpenScript({
      containerName: config.runner.container,
      tmuxSession: card.tmuxSession,
      cardId: card.id,
      statusUrl: statusUrl(),
      cwd: paths.cwd,
      accountConfigDir: accountDir,
      resume: !!card.openedAt,
      resumeSessionId: card.resumeSessionId,
      model: card.model,
      oauthToken,
      ghToken,
      mcps,
      brain,
      repo,
    });
    try {
      // Cloning a big repository: 10 minutes of headroom (the rest of the script is fast).
      await hostExecutor().runScript(script, { timeoutMs: 600_000 });
    } catch (err) {
      throw runnerUnreachable(err);
    }
    return { card, project, accountSlug };
  });
}

/**
 * OPENS the card (POST /api/cards/:id/open — idempotent): guarantees clone + worktree + a tmux
 * session with Claude Code in the runner, then applies the open rule (backlog → waiting; done stays
 * done). If the pre-provisioning from card creation is still running, it WAITS for it (the card
 * lock) instead of racing — and the idempotent script that runs afterwards only confirms what is
 * already there.
 */
export async function openCard(cardId: string, by?: string): Promise<Card> {
  const { card, accountSlug } = await provisionWorkspace(cardId);
  const updated = (await applyOpenTerminal(card.id)) ?? card;
  logger.info(
    {
      audit: true, action: "card.open", card: card.worktreeSlug, session: card.tmuxSession,
      account: accountSlug ?? "default", by,
    },
    "card opened in the runner",
  );
  return updated;
}

/**
 * PRE-PROVISIONS the card in the background (fired by card creation): the SAME script as the open
 * (clone, worktree, tmux with Claude, token/MCPs) but WITHOUT applying the open rule — the card
 * stays in the backlog with no status and no `openedAt`; only `preparedAt` is stamped at the end.
 * That way, when the user clicks, the websocket connects immediately and the open merely confirms.
 * A failure here is best-effort (the caller logs a warning): a normal open covers it later.
 */
export async function prepareCard(cardId: string, by?: string): Promise<Card> {
  const { card, accountSlug } = await provisionWorkspace(cardId);
  const updated = (await markPrepared(card.id)) ?? card;
  logger.info(
    {
      audit: true, action: "card.prepare", card: card.worktreeSlug, session: card.tmuxSession,
      account: accountSlug ?? "default", by,
    },
    "card workspace pre-provisioned in the runner",
  );
  return updated;
}

// ---- Image upload into a card (paste/drag on the terminal) ----

/** Ceiling for the DECODED file (the route's bodyLimit covers the base64+JSON envelope). */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * STRICT base64 (the payload already has its whitespace stripped). This is what makes it safe to
 * embed the content in a heredoc: the alphabet has no quotes, `$`, backticks or `_` — it cannot
 * escape a quoted heredoc and can never collide with the VIBEHUB_* delimiters.
 */
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Sanitizes an uploaded file name: lower case, only [a-z0-9._-], no `..` (assertSafeRemotePath would
 * reject it), never starting with `.`/`-` (no dotfiles, no flags), at most 80 characters (keeping
 * the END — that is where the extension lives). Empty after the cleanup → "image". PURE.
 */
export function sanitizeUploadName(name: string): string {
  let s = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  if (s.length > 80) s = s.slice(-80).replace(/^[.-]+/, "");
  return s || "image";
}

export interface UploadScriptOpts {
  containerName: string;
  destDir: string;
  destPath: string;
  /** The file's base64, ALREADY validated against B64_RE (the caller's invariant). */
  base64: string;
}

/**
 * Script that writes the file INSIDE the runner: a docker exec with the base64 in a heredoc (the
 * whole script travels over STDIN — the content NEVER passes through argv). The delimiters contain
 * `_`, which is not in the base64 alphabet, so the payload can never close them. PURE/testable.
 */
export function buildUploadScript(opts: UploadScriptOpts): string {
  if (!B64_RE.test(opts.base64)) throw new Error("invalid base64 content");
  return [
    "set -e",
    `docker exec -i ${shQuote(opts.containerName)} bash -s <<'${UPLOAD_DELIM}'`,
    "set -e",
    `mkdir -p ${shQuote(opts.destDir)}`,
    `base64 -d > ${shQuote(opts.destPath)} <<'${B64_DELIM}'`,
    opts.base64,
    B64_DELIM,
    UPLOAD_DELIM,
  ].join("\n");
}

/**
 * Uploads an image into the card's workspace: validates the base64 and the size, writes it to
 * /work/.uploads/<cardId>/<timestamp>-<sanitized-name> inside the runner and returns the path — the
 * front-end types that path into the terminal and Claude Code reads the image from there.
 */
export async function uploadCardImage(
  cardId: string,
  originalName: string,
  base64: string,
  by?: string,
): Promise<{ path: string }> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");

  const b64 = String(base64 ?? "").replace(/\s+/g, ""); // tolerate line breaks from encoders
  if (!B64_RE.test(b64)) throw new Error("invalid base64 content");
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (bytes > UPLOAD_MAX_BYTES) throw new Error("image is larger than 10 MB");

  const name = sanitizeUploadName(originalName);
  const destDir = `/work/.uploads/${card.id}`;
  const destPath = `${destDir}/${Date.now()}-${name}`;
  assertSafeRemotePath(destPath); // belt: the id comes from the board (uuid), the name is sanitized

  try {
    await hostExecutor().runScript(
      buildUploadScript({ containerName: config.runner.container, destDir, destPath, base64: b64 }),
      { timeoutMs: 120_000 },
    );
  } catch (err) {
    throw runnerUnreachable(err);
  }
  logger.info(
    { audit: true, action: "card.upload", card: card.worktreeSlug, file: name, bytes, by },
    "image uploaded into the card workspace",
  );
  return { path: destPath };
}

/**
 * Kills the card's tmux session in the runner (BEST-EFFORT — used by card deletion and by the
 * pause). The session name comes from the BOARD (derived from the id), never from input.
 * `includeShell` also kills the `-sh` session of the Shell button (the suffix is derived HERE).
 * A runner that is missing or a host that is down is simply ignored.
 */
export async function killCardSession(card: Card, opts: { includeShell?: boolean } = {}): Promise<void> {
  try {
    const sessions = opts.includeShell ? [card.tmuxSession, `${card.tmuxSession}-sh`] : [card.tmuxSession];
    const cmd = sessions
      .map((s) => `docker exec ${shQuote(config.runner.container)} tmux kill-session -t ${shQuote(s)} 2>/dev/null`)
      .join("; ");
    await hostExecutor().runScript(`${cmd}; true`, { timeoutMs: 30_000 });
  } catch (e) {
    logger.warn({ card: card.worktreeSlug, detail: (e as Error).message }, "kill-session failed (best-effort, continuing)");
  }
}

/**
 * PAUSES the card (POST /api/cards/:id/pause and the drag into the "paused" column): the board goes
 * first (registryPauseCard — a card that does not exist or was never opened THROWS before the host
 * is touched), and the tmux session only dies NOW if the pause was EFFECTIVE (idle card → `pausedAt`
 * stamped): both sessions are killed (claude and shell), the Claude process dies, zero consumption.
 * A `working` card is a PENDING pause (registryPauseCard does not stamp `pausedAt`): the session
 * stays ALIVE and the status hook ends it when Claude finishes — "let it finish, then pause", so
 * work in progress is never interrupted. Resuming is just opening the card: the attach recreates the
 * session with `claude -c` and comes back to the same conversation.
 */
export async function pauseCard(cardId: string, by?: string): Promise<Card> {
  const card = await registryPauseCard(cardId);
  if (card.pausedAt) {
    // EFFECTIVE pause (the card was idle): end the sessions right away.
    await killCardSession(card, { includeShell: true });
    logger.info(
      { audit: true, action: "card.pause", card: card.worktreeSlug, session: card.tmuxSession, by },
      "card paused — tmux sessions ended in the runner",
    );
  } else {
    // PENDING pause (working card): the session lives on until Claude finishes; the hook ends it.
    logger.info(
      { audit: true, action: "card.pause.pending", card: card.worktreeSlug, session: card.tmuxSession, by },
      "card moved to paused as a pending pause — the session runs until Claude finishes",
    );
  }
  return card;
}

/**
 * PURE selection of the cards to restart in a "restart everything": the IDLE ones with a live
 * session. Idle = live session (openedAt and not paused) and NOT `working` — restarting a `working`
 * card would INTERRUPT Claude mid-task, so it is left out (only `waiting`/no-status qualify).
 * `preparedAt` alone does not count: the workspace was pre-provisioned but the card was never
 * opened — there is no conversation in progress. PURE/testable.
 */
export function cardsToRestart<T extends Pick<Card, "openedAt" | "pausedAt" | "status">>(cards: T[]): T[] {
  return cards.filter((c) => hasLiveSession(c) && c.status !== "working");
}

/**
 * RESTARTS the card's session (POST /api/cards/:id/restart): kills Claude's tmux session in the
 * runner — it does NOT change the column or the status and does not touch the board. The next
 * terminal connection (attach-or-create) recreates the session with `claude -c`, resuming the SAME
 * conversation — and it is on that start that Claude re-reads the MCPs and the model from the
 * profile (they are only read at startup). An unknown card THROWS (→ 404).
 */
export async function restartCard(cardId: string, by?: string): Promise<Card> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  await killCardSession(card);
  logger.info(
    { audit: true, action: "card.restart", card: card.worktreeSlug, session: card.tmuxSession, by },
    "card restarted — tmux session ended in the runner (reopens with claude -c)",
  );
  return card;
}

/**
 * What a model/account switch did to the LIVE session, so the screen can say the truth instead of
 * promising a switch that never reached Claude.
 */
export type SessionChange = "none" | "restarted" | "pending";

/**
 * Carries a card's model/account switch INTO the running session.
 *
 * Both are read by Claude only when the PROCESS STARTS (`--model` on the command line, the account's
 * CLAUDE_CONFIG_DIR in the session's environment). Recording the change on the card is therefore
 * only half of it: the terminal reattaches to the very same tmux session (`new-session -A`) and goes
 * on talking to the old model on the old account — which is exactly the bug where a card read "Opus"
 * in the bar while every reply came from Fable.
 *
 * So the session is ended here, the same way `restartCard` does it: the reattach recreates it with
 * the new flag/profile and `claude -c`, in the SAME conversation. A card that is `working` is NOT
 * interrupted — it is flagged (`config`) and the status hook restarts it the moment it goes idle,
 * mirroring what a brain/MCP change does. Nothing to do when the card has no live session: the pin
 * already IS what the next start will use.
 */
export async function applySessionChange(before: Card | undefined, after: Card, by?: string): Promise<SessionChange> {
  const changed =
    (before?.model ?? null) !== (after.model ?? null) || (before?.accountSlug ?? null) !== (after.accountSlug ?? null);
  if (!before || !changed || !hasLiveSession(after)) return "none";
  if (after.status === "working") {
    await markRestartPending(after.id, "config");
    logger.info(
      { audit: true, action: "card.config.pending", card: after.worktreeSlug, model: after.model ?? null, account: after.accountSlug ?? null, by },
      "model/account switched while Claude was working — the session restarts onto it once the card goes idle",
    );
    return "pending";
  }
  await restartCard(after.id, by);
  logger.info(
    { audit: true, action: "card.config.applied", card: after.worktreeSlug, model: after.model ?? null, account: after.accountSlug ?? null, by },
    "model/account switched — the session was ended so the reattach starts Claude with it (claude -c)",
  );
  return "restarted";
}

/**
 * RESTARTS EVERY card with a live session (POST /api/cards/restart-all): kills the tmux session of
 * each selected card in PARALLEL. Best-effort per card (Promise.allSettled): one failure does not
 * take the others down — and `killCardSession` already swallows a host/runner error. Returns how
 * many were restarted. Used by "apply and restart" for MCP changes, so a change takes effect on what
 * is already running without visiting each card.
 */
export async function restartAllCards(by?: string): Promise<{ restarted: number; skipped: number }> {
  const live = (await listAllCards()).filter(hasLiveSession);
  const target = cardsToRestart(live);
  // Skipped = live sessions that are `working` (not restarted, so the task is not interrupted).
  const skipped = live.length - target.length;
  const results = await Promise.allSettled(target.map((c) => killCardSession(c)));
  const restarted = results.filter((r) => r.status === "fulfilled").length;
  logger.info(
    { audit: true, action: "card.restartAll", total: target.length, restarted, skipped, skipReason: "working", by },
    "restart all — idle sessions ended in the runner (working cards preserved)",
  );
  return { restarted, skipped };
}

/**
 * STAGGERED RESTART after the brain/MCPs have been APPLIED to the runner (called by the save that
 * auto-applies, in routes/agent.ts). Rewriting the files is not enough: Claude only re-reads the brain
 * and the MCPs when a session STARTS. So every card with a live session is staggered, precisely so the
 * change never gets in the way of somebody working:
 *  - IDLE (status != "working", via `cardsToRestart`) -> `restartCard` NOW: it reopens with
 *    `claude -c`, already reading the new brain/MCPs, and resumes the SAME conversation.
 *  - WORKING -> `markRestartPending`: NOT interrupted; the status hook (POST /api/runner/status)
 *    restarts the card once it goes idle (shouldRestartOnStatus). One single flag serves both reasons
 *    (brain and MCP) — `reason` is only the badge label.
 * Best-effort per card (Promise.allSettled): a dead host or a card that vanished mid-sweep must not
 * take the rest down. Returns {restarted (idle cards restarted now), pending (working cards flagged)}.
 */
export async function restartStaggered(
  reason: RestartReason,
  by?: string,
): Promise<{ restarted: number; pending: number }> {
  const live = (await listAllCards()).filter(hasLiveSession);
  const idle = cardsToRestart(live); // live session and NOT working
  const working = live.filter((c) => c.status === "working"); // live session AND working
  await Promise.allSettled(idle.map((c) => restartCard(c.id, by)));
  await Promise.allSettled(working.map((c) => markRestartPending(c.id, reason)));
  logger.info(
    { audit: true, action: "card.restartStaggered", reason, restarted: idle.length, pending: working.length, by },
    "staggered restart after applying the brain/MCPs — idle cards restarted now, working cards flagged as pending",
  );
  return { restarted: idle.length, pending: working.length };
}

/**
 * DROPS the card's workspace from the runner (used when a card is deleted): both tmux sessions plus
 * the git worktree and its directory. Best-effort — a card whose project has vanished, or a runner
 * that is down, must not stop the board from deleting the card.
 */
export async function dropCardWorkspace(card: Card, by?: string): Promise<void> {
  try {
    const project = await getProject(card.projectId);
    await killCardSession(card, { includeShell: true });
    if (!project) return;
    const paths = cardWorkPaths(project, card);
    const container = config.runner.container;
    const lines = ["set -e", `docker exec -i ${shQuote(container)} bash -s <<'${OPEN_DELIM}'`];
    if (paths.repoDir) {
      // `worktree remove --force` unregisters it in .git/worktrees; `prune` cleans a stale entry
      // when the directory had already been deleted by hand. Both tolerate absence.
      lines.push(
        `git -C ${shQuote(paths.repoDir)} worktree remove --force ${shQuote(paths.cwd)} 2>/dev/null || true`,
        `git -C ${shQuote(paths.repoDir)} worktree prune 2>/dev/null || true`,
      );
    }
    lines.push(`rm -rf ${shQuote(paths.cwd)}`, OPEN_DELIM);
    await hostExecutor().runScript(lines.join("\n"), { timeoutMs: 120_000 });
    logger.info(
      { audit: true, action: "card.drop", card: card.worktreeSlug, cwd: paths.cwd, by },
      "card workspace dropped from the runner",
    );
  } catch (e) {
    logger.warn({ card: card.worktreeSlug, detail: (e as Error).message }, "dropping the card workspace failed (best-effort)");
  }
}
