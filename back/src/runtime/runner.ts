import { randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import { hostExecutor, shQuote, HostExecError } from "./host.js";
import { secretEnsure, secretGet } from "../secrets/vault.js";
import { logger } from "../utils/logger.js";

/**
 * THE RUNNER — one container where every card's terminal lives. It is a plain Docker container
 * (node image, `sleep infinity`) with two persistent bind mounts:
 *
 *   /root  → Claude Code config: settings.json with the status hooks, account profiles, tokens
 *   /work  → repository clones, per-card git worktrees, and /work/scratch for repo-less projects
 *
 * Provisioning is `docker run` + a setup script, both idempotent: run it again and it re-aligns.
 * Nothing here knows whether Docker is local or across an SSH hop — that is the host executor's job.
 */

/** Where the service token lives inside the runner. /root is a bind mount, so it persists. */
export const RUNNER_TOKEN_FILE = "/root/.vibehub-token";

/** Vault key holding the service token the runner uses to report card status back to vibehub. */
export const RUNNER_TOKEN_KEY = "VIBEHUB_RUNNER_TOKEN";

/** Where the runner's status hooks POST. Derived from the configured public URL. */
export function statusUrl(): string {
  return `${config.publicUrl.replace(/\/+$/, "")}/api/runner/status`;
}

/**
 * The hook command: report card status over HTTP. `$VIBEHUB_STATUS_URL` and `$VIBEHUB_CARD_ID` come
 * from the tmux session environment (set when the card is opened); the token is READ FROM THE FILE
 * at call time so it never gets baked into settings.json. PURE.
 */
export function hookCommand(status: "working" | "waiting"): string {
  return (
    `curl -s -m 3 -X POST "$VIBEHUB_STATUS_URL" -H "x-vibehub-token: $(cat /root/.vibehub-token)"` +
    ` -H "content-type: application/json" -d "{\\"card\\":\\"$VIBEHUB_CARD_ID\\",\\"status\\":\\"${status}\\"}" || true`
  );
}

export interface RunnerSettingsOpts {
  /**
   * Let the agent work without permission prompts. The runner is an isolated container that only
   * reaches what you gave it, so this is the useful default — but it IS a real choice, made in the
   * wizard, and it is stored per install rather than assumed.
   */
  autonomous: boolean;
}

/**
 * Claude Code settings.json inside the runner: status hooks + forced session persistence. PURE.
 *
 * SessionStart and Notification are in the list because of a bug seen in production: a card showed
 * GREEN from a hook fired days earlier while a NEW Claude — the tmux session had been recreated —
 * sat idle at the prompt, having never fired a hook (the others only fire after a prompt). A new
 * session means "waiting for the human" (SessionStart); Notification is what Claude emits when it
 * goes idle waiting for input or permission.
 *
 * PreToolUse → working comes from a second production bug: after a Notification (an idle nudge, a
 * retry), a session can resume ON ITS OWN — auto mode, a loop — without ever passing through
 * UserPromptSubmit. Since that was the only hook returning the card to "working", the dot stayed
 * AMBER while the agent was visibly running tools. PreToolUse fires on every tool call, so the
 * status is corrected at the first real action after a resume.
 */
export function runnerSettingsJson(opts: RunnerSettingsOpts = { autonomous: true }): string {
  const hook = (status: "working" | "waiting") => [{ hooks: [{ type: "command", command: hookCommand(status) }] }];
  return JSON.stringify(
    {
      env: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" },
      ...(opts.autonomous
        ? { permissions: { defaultMode: "bypassPermissions" }, skipDangerousModePermissionPrompt: true }
        : {}),
      // Project-scoped .mcp.json files committed in a repo are honoured without a prompt.
      enableAllProjectMcpServers: true,
      hooks: {
        SessionStart: hook("waiting"),
        UserPromptSubmit: hook("working"),
        PreToolUse: hook("working"),
        Stop: hook("waiting"),
        PermissionRequest: hook("waiting"),
        StopFailure: hook("waiting"),
        Notification: hook("waiting"),
      },
    },
    null,
    2,
  );
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * `docker run` for the runner, as an idempotent script: if a container with that name already
 * exists it is started (not recreated — recreating would wipe anything installed in the image
 * layer), otherwise it is created. PURE.
 */
export function buildRunScript(opts: { container: string; image: string; baseDir: string; network?: string }): string {
  const { container, image, baseDir, network = "" } = opts;
  if (network && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(network)) {
    throw new Error(`invalid docker network name: '${network}'`);
  }
  return [
    "set -e",
    `mkdir -p ${shQuote(`${baseDir}/root`)} ${shQuote(`${baseDir}/work/scratch`)}`,
    `if [ -n "$(docker ps -aq -f name=^${container}$)" ]; then`,
    `  docker start ${shQuote(container)} >/dev/null 2>&1 || true`,
    // A runner created before the network was configured (or by an older version) is attached in
    // place: `network connect` is a no-op when already joined, so re-provisioning stays idempotent.
    ...(network ? [`  docker network connect ${shQuote(network)} ${shQuote(container)} >/dev/null 2>&1 || true`] : []),
    "else",
    `  docker run -d --name ${shQuote(container)} \\`,
    "    --restart unless-stopped \\",
    // The compose network, so `http://vibehub:3010` resolves from inside the runner. Without this
    // the runner lands on the default bridge, the status hooks post into the void, and a fresh
    // install looks alive while no card ever changes column.
    ...(network ? [`    --network ${shQuote(network)} \\`] : []),
    // The tmux server is started by a non-interactive `docker exec`, which does not read .profile,
    // and decides UTF-8 from the environment it is born into. Without these, accented characters
    // degrade to "_" in the web terminal.
    "    -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 \\",
    // The runner is root inside an isolated container — that is the sandbox premise. IS_SANDBOX=1 is
    // the official flag that allows prompt-free mode under root; without it Claude refuses to start
    // with "cannot be used with root/sudo".
    "    -e IS_SANDBOX=1 \\",
    `    -v ${shQuote(`${baseDir}/root`)}:/root \\`,
    `    -v ${shQuote(`${baseDir}/work`)}:/work \\`,
    `    ${shQuote(image)} sleep infinity >/dev/null`,
    "fi",
  ].join("\n");
}

/**
 * Setup script: installs everything INSIDE the runner through `docker exec -i ... bash -s`, and
 * plants the service token there too. Idempotent. PURE.
 *
 * The token is written through the SAME `docker exec`, not by the outer shell, because the outer
 * shell is not necessarily the Docker host: with `VIBEHUB_RUNNER_KIND=local` vibehub itself runs in
 * a container and only reaches Docker through the mounted socket, so a plain `printf > path` there
 * writes into vibehub's own filesystem — which is exactly where the token silently went the first
 * time, leaving every status hook and the maestro MCP unauthenticated. Writing it inside the runner
 * still survives a container recreate: /root is a bind mount on the host.
 *
 * The token travels over STDIN — never argv, which is world-readable in `ps`.
 */
export function buildSetupScript(opts: {
  container: string;
  baseDir: string;
  token: string;
  settingsJson: string;
  git: GitIdentity;
}): string {
  const { container, baseDir, token, settingsJson, git } = opts;
  return [
    "set -e",
    "umask 077",
    `docker exec -i ${shQuote(container)} bash -s <<'VIBEHUB_SETUP'`,
    "set -e",
    "umask 077",
    `printf '%s' ${shQuote(token)} > ${shQuote(RUNNER_TOKEN_FILE)}`,
    `chmod 600 ${shQuote(RUNNER_TOKEN_FILE)}`,
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    // tmux/git/ripgrep/curl = the card terminal. xvfb/x11vnc/novnc/websockify/socat = the card's
    // live browser: virtual display + RFB + bridge. apt is idempotent, so re-runs are cheap.
    "apt-get install -y -qq tmux git ripgrep curl xvfb x11vnc novnc websockify socat >/dev/null",
    // gh CLI from the official repo — the agent opens PRs and checks CI. Auth is the user's own.
    'if ! command -v gh >/dev/null; then mkdir -p /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update -qq && apt-get install -y -qq gh >/dev/null; fi',
    "npm i -g @anthropic-ai/claude-code >/dev/null 2>&1",
    // Headful Chromium for the card browser (the same binary the Playwright MCP drives over CDP).
    "npx --yes playwright install --with-deps chromium >/dev/null 2>&1 || true",
    "mkdir -p /root/.claude /work/scratch /work/.browser",
    "grep -q C.UTF-8 /root/.profile 2>/dev/null || printf 'export LANG=C.UTF-8\\nexport LC_ALL=C.UTF-8\\n' >> /root/.profile",
    "grep -q C.UTF-8 /root/.bashrc 2>/dev/null || printf 'export LANG=C.UTF-8\\nexport LC_ALL=C.UTF-8\\n' >> /root/.bashrc",
    // tmux: truecolor (otherwise Claude's orange degrades to ANSI red), focus events, scrollback,
    // and no status bar — vibehub already shows card state, the green bar was just noise.
    // window-size latest: a session may have two clients at once (a second tab, the phone). tmux's
    // default sizes the window to the SMALLEST of them, which shows up as a dead band of empty space
    // at the bottom of the big one. Size to whoever touched it last instead.
    "printf 'set -g default-terminal \"tmux-256color\"\\nset -ga terminal-overrides \",xterm*:Tc\"\\nset -g focus-events on\\nset -g history-limit 50000\\nset -g status off\\nset -g window-size latest\\nset -g aggressive-resize on\\n' > /root/.tmux.conf",
    `git config --global user.name ${shQuote(git.name)}`,
    `git config --global user.email ${shQuote(git.email)}`,
    "git config --global --add safe.directory '*'",
    "cat > /root/.claude/settings.json <<'VIBEHUB_SETTINGS'",
    settingsJson,
    "VIBEHUB_SETTINGS",
    "VIBEHUB_SETUP",
  ].join("\n");
}

/** The service token, generated once and kept in the vault. */
export async function ensureRunnerToken(): Promise<string> {
  return await secretEnsure(RUNNER_TOKEN_KEY, () => randomBytes(32).toString("hex"));
}

/** The stored token, or undefined when the runner was never provisioned. */
export async function runnerToken(): Promise<string | undefined> {
  return await secretGet(RUNNER_TOKEN_KEY);
}

export interface ProvisionOpts {
  git: GitIdentity;
  autonomous?: boolean;
  onChunk?: (chunk: string) => void;
}

/**
 * Creates (or re-aligns) the runner. Idempotent: run it again after an upgrade and it re-installs
 * what is missing, rewrites settings.json and re-plants the token.
 */
export async function provisionRunner(opts: ProvisionOpts): Promise<void> {
  const host = hostExecutor();
  const { container, image, baseDir, network } = config.runner;
  const token = await ensureRunnerToken();
  await host.runScript(buildRunScript({ container, image, baseDir, network }), { timeoutMs: 300_000, onChunk: opts.onChunk });
  await host.runScript(
    buildSetupScript({
      container,
      baseDir,
      token,
      settingsJson: runnerSettingsJson({ autonomous: opts.autonomous ?? true }),
      git: opts.git,
    }),
    // apt + npm global + playwright chromium: minutes, not seconds, on a cold image.
    { timeoutMs: 900_000, onChunk: opts.onChunk },
  );
  logger.info({ audit: true, action: "runner.provision", container, host: host.label }, "runner provisioned");
}

export interface RunnerStatusView {
  /** The container exists and is running. */
  running: boolean;
  /** The container exists at all (maybe stopped). */
  exists: boolean;
  /** `claude` is installed inside it. */
  claudeInstalled: boolean;
  /** Docker itself is reachable on the host — false means the install is not usable yet. */
  dockerReachable: boolean;
  container: string;
  host: string;
  /** Human-readable reason when something is off. */
  detail?: string;
}

/**
 * Last answer, so a burst of callers does not turn into a burst of `docker exec`.
 *
 * The status is read by three different surfaces (the boot probe on every page load, the board's
 * runner chip every 20s, the wizard) and it costs a round trip to the Docker host — the same host
 * that is, at that very moment, cloning a repository for a new card. Under that load the probe is
 * the slowest thing in the request, so callers that can live with a slightly stale answer say so
 * (`maxAgeMs`) and get the previous one for free. No argument = always fresh.
 */
let lastStatus: { at: number; view: RunnerStatusView } | null = null;
/** In-flight probe, so N concurrent callers share ONE `docker exec` instead of starting N. */
let statusInFlight: Promise<RunnerStatusView> | null = null;

export interface RunnerStatusOpts {
  /** Accept a cached answer up to this old (ms). Absent/0 = probe the host now. */
  maxAgeMs?: number;
}

/** Health of the runner: is Docker there, is the container up, is Claude installed? */
export async function runnerStatus(opts: RunnerStatusOpts = {}): Promise<RunnerStatusView> {
  const maxAge = opts.maxAgeMs ?? 0;
  if (maxAge > 0 && lastStatus && Date.now() - lastStatus.at <= maxAge) return lastStatus.view;
  if (statusInFlight) return await statusInFlight;
  statusInFlight = probeRunnerStatus().finally(() => { statusInFlight = null; });
  return await statusInFlight;
}

async function probeRunnerStatus(): Promise<RunnerStatusView> {
  const view = await readRunnerStatus();
  lastStatus = { at: Date.now(), view };
  return view;
}

async function readRunnerStatus(): Promise<RunnerStatusView> {
  const host = hostExecutor();
  const { container } = config.runner;
  const base: RunnerStatusView = {
    running: false, exists: false, claudeInstalled: false, dockerReachable: false,
    container, host: host.label,
  };
  try {
    const { stdout } = await host.runScript(
      [
        "set -e",
        "docker version --format '{{.Server.Version}}' >/dev/null",
        `echo "exists=$(docker ps -aq -f name=^${container}$ | head -1 | wc -l | tr -d ' ')"`,
        `echo "running=$(docker ps -q -f name=^${container}$ | head -1 | wc -l | tr -d ' ')"`,
        `echo "claude=$(docker exec ${shQuote(container)} sh -lc 'command -v claude >/dev/null && echo 1 || echo 0' 2>/dev/null || echo 0)"`,
      ].join("\n"),
      // Bounded on purpose: this probe sits in front of the app's first paint, so "the Docker host
      // is not answering" has to become an answer in seconds, not half a minute.
      { timeoutMs: 15_000 },
    );
    const read = (key: string): string => new RegExp(`^${key}=(.*)$`, "m").exec(stdout)?.[1]?.trim() ?? "";
    return {
      ...base,
      dockerReachable: true,
      exists: read("exists") === "1",
      running: read("running") === "1",
      claudeInstalled: read("claude") === "1",
    };
  } catch (err) {
    const detail = err instanceof HostExecError ? err.message : String(err);
    return { ...base, detail };
  }
}

/** Drops the cached status — tests and hot-reload only. */
export function resetRunnerStatusCacheForTesting(): void {
  lastStatus = null;
  statusInFlight = null;
}

/** Starts a stopped runner (after a host reboot, say). */
export async function startRunner(): Promise<void> {
  await hostExecutor().runScript(`docker start ${shQuote(config.runner.container)} >/dev/null`, { timeoutMs: 60_000 });
}
