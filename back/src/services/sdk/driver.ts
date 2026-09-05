import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { cardWorkPaths } from "../board/workspace.js";
import { accountConfigDir } from "../accounts/profiles.js";
import { oauthTokenPath, DEFAULT_CLAUDE_DIR } from "../accounts/profiles.js";
import { effectiveAccountSlug, isValidModel, assertSessionId, type Card, type Project } from "../board/registry.js";
import { cardCdpEndpoint } from "../browser/ports.js";
import { statusUrl } from "../../runtime/runner.js";
import { getSettings } from "../settings/settings.js";
import type { SdkPermissionGateMode } from "./protocol.js";

/**
 * SDK DRIVER (service) — spawns and addresses the per-card Agent-SDK driver process inside the runner.
 *
 * ADDITIVE and gated: nothing here runs unless the `sdkDriver` setting is on (the route enforces it).
 * It never touches the TUI/tmux path — it is a SEPARATE process (`sdk-driver.mjs`) reached over a
 * SEPARATE websocket, mirroring how `workspace.ts` reaches the runner (`docker exec` through the host
 * executor) and how the VNC bridge spawns a long-lived duplex child with piped stdio.
 *
 * SHADOWING NOTE (the PoC's finding #1): the runner's generated `settings.json` allowlist can
 * auto-approve a tool BEFORE any callback fires. The driver does NOT rely on that allowlist for
 * safety — it passes its OWN PreToolUse hook (see `sdk-driver.mjs` + `protocol.ts`), which fires
 * regardless of what the allowlist says. Auditing/rewriting that allowlist is a LATER increment.
 */

/** Directory in the runner holding the driver script and its own `node_modules` (the SDK lives here). */
export const SDK_DRIVER_DIR = "/root/.vibehub-sdk";
/** The driver script's path inside the runner. */
export const SDK_DRIVER_PATH = `${SDK_DRIVER_DIR}/sdk-driver.mjs`;

/**
 * The Agent SDK version the driver runs against — the one the spike proved. Bumping it is a
 * deliberate act: change the constant and the next connect reinstalls (the `.sdk-version` marker
 * no longer matches).
 */
export const SDK_PACKAGE_VERSION = "0.3.246";
/** Marker file recording which SDK version is installed — what makes the install a no-op on every open after the first. */
export const SDK_VERSION_MARKER = `${SDK_DRIVER_DIR}/.sdk-version`;

/** Reserved heredoc delimiters — never derived from input. */
const INSTALL_DELIM = "VIBEHUB_SDK_INSTALL";
const SOURCE_DELIM = "VIBEHUB_SDK_DRIVER_SRC";
const ENSURE_DELIM = "VIBEHUB_SDK_ENSURE";

/** The driver source, read from the sibling asset (copied into dist by scripts/build-assets.mjs). */
const DRIVER_SOURCE_FILE = join(dirname(fileURLToPath(import.meta.url)), "sdk-driver.mjs");

let cachedSource: string | null = null;
/** The driver .mjs source shipped into the runner. PURE-ish (memoised file read). */
export function sdkDriverSource(): string {
  if (cachedSource === null) cachedSource = readFileSync(DRIVER_SOURCE_FILE, "utf8");
  return cachedSource;
}

/**
 * Script that plants the driver .mjs INSIDE the runner container (atomic tmp+mv, mode 755),
 * idempotent. The source travels in a QUOTED heredoc (no expansion). PURE.
 */
export function buildInstallDriverScript(containerName: string, source: string): string {
  const tmp = `${SDK_DRIVER_PATH}.tmp`;
  const inner = [
    "set -e",
    "umask 077",
    `mkdir -p ${shQuote(SDK_DRIVER_DIR)}`,
    `cat > ${shQuote(tmp)} <<'${SOURCE_DELIM}'`,
    source,
    SOURCE_DELIM,
    `chmod 755 ${shQuote(tmp)}`,
    `mv -f ${shQuote(tmp)} ${shQuote(SDK_DRIVER_PATH)}`,
  ].join("\n");
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${INSTALL_DELIM}'`,
    inner,
    INSTALL_DELIM,
  ].join("\n");
}

/**
 * Script that makes sure the Agent SDK is INSTALLED in the runner (in the driver's own dir, not the
 * card worktrees), idempotent by version marker: when `.sdk-version` already says
 * `SDK_PACKAGE_VERSION` and the package dir exists, it does NOTHING — no npm, no network. This is
 * what turned the manual step in docs/sdk-driver.md §"Live smoke test" into part of the connect
 * path. The runner is NEVER recreated by this; it only writes under /root/.vibehub-sdk. PURE.
 */
export function buildEnsureSdkScript(containerName: string, version: string = SDK_PACKAGE_VERSION): string {
  if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error(`invalid SDK version: '${version}'`);
  const pkgDir = `${SDK_DRIVER_DIR}/node_modules/@anthropic-ai/claude-agent-sdk`;
  const inner = [
    "set -e",
    "umask 077",
    `mkdir -p ${shQuote(SDK_DRIVER_DIR)}`,
    `if [ "$(cat ${shQuote(SDK_VERSION_MARKER)} 2>/dev/null || true)" != ${shQuote(version)} ] || [ ! -d ${shQuote(pkgDir)} ]; then`,
    `  cd ${shQuote(SDK_DRIVER_DIR)}`,
    `  npm install --no-audit --no-fund --loglevel=error ${shQuote(`@anthropic-ai/claude-agent-sdk@${version}`)}`,
    `  printf '%s' ${shQuote(version)} > ${shQuote(SDK_VERSION_MARKER)}`,
    "fi",
  ].join("\n");
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${ENSURE_DELIM}'`,
    inner,
    ENSURE_DELIM,
  ].join("\n");
}

export interface SdkDriverCommandOpts {
  containerName: string;
  /** cwd of the driver (the card's worktree). */
  cwd: string;
  /** Profile dir whose `.oauth-token` the driver exports CLAUDE_CODE_OAUTH_TOKEN from. */
  profileDir: string;
  /** Non-default account: the driver's Claude uses this CLAUDE_CONFIG_DIR. */
  configDir?: string;
  /** Stored session id to resume on the first message. */
  resumeSessionId?: string;
  /** The card's model (validated against the whitelist; invalid = account default). */
  model?: string;
  /**
   * CDP endpoint of the CARD's live Chromium (the one on the noVNC canvas). Exported as
   * PW_CDP_ENDPOINT so the injected `navegador` MCP — whose stored config carries the literal
   * `${PW_CDP_ENDPOINT:-…}` reference — resolves to THIS card's browser, exactly like the tmux
   * session does for the TUI. Without it the MCP would fall back to the base port and drive the
   * wrong (or no) browser.
   */
  cdpEndpoint?: string;
  /** Card id + status URL for the runner settings' status hooks (VIBEHUB_CARD_ID / VIBEHUB_STATUS_URL). */
  cardId?: string;
  statusUrl?: string;
  /** Gate mode for the driver's PreToolUse hook (`--permission-gate`). Default: ask-sensitive. */
  permissionGate?: SdkPermissionGateMode;
}

/** http(s) URL safe to place (shQuoted) in the exec line — no quotes, spaces or control chars. */
const SAFE_URL_RE = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/;
function assertSafeUrl(url: string): string {
  if (!SAFE_URL_RE.test(url)) throw new Error(`unsafe URL for the driver environment: '${url}'`);
  return url;
}
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The remote command line that runs the driver in the runner: `docker exec -i <c> bash -c '<guard>;
 * exec node <driver> ...'`. Mirrors the TUI's token guard (export CLAUDE_CODE_OAUTH_TOKEN from the
 * profile file, IS_SANDBOX=1). `-i` (no tty) keeps stdin/stdout as CLEAN pipes for the NDJSON
 * protocol. NODE_PATH points at the driver dir's own node_modules (where the SDK is installed). PURE.
 */
export function buildSdkDriverCommandLine(opts: SdkDriverCommandOpts): string {
  assertSafeRemotePath(opts.cwd);
  assertSafeRemotePath(opts.profileDir);
  if (opts.configDir) assertSafeRemotePath(opts.configDir);
  const tokenFile = oauthTokenPath(opts.profileDir);
  const model = isValidModel(opts.model) ? ` --model ${shQuote(opts.model)}` : "";
  const resume = opts.resumeSessionId ? ` --resume ${shQuote(assertSessionId(opts.resumeSessionId))}` : "";
  const gate = opts.permissionGate ? ` --permission-gate ${shQuote(opts.permissionGate)}` : "";
  // Environment the TUI session also carries, so the driver's Claude behaves like the terminal's:
  // PW_CDP_ENDPOINT points the `navegador` MCP at the card's own Chromium; VIBEHUB_CARD_ID +
  // VIBEHUB_STATUS_URL feed the status hooks in the runner's settings.json (loaded via
  // settingSources), so the activity dot follows the native chat too.
  let cardEnv = "";
  if (opts.cdpEndpoint) cardEnv += `export PW_CDP_ENDPOINT=${shQuote(assertSafeUrl(opts.cdpEndpoint))}; `;
  if (opts.cardId) {
    if (!CARD_ID_RE.test(opts.cardId)) throw new Error(`invalid card id: '${opts.cardId}'`);
    cardEnv += `export VIBEHUB_CARD_ID=${shQuote(opts.cardId)}; `;
  }
  if (opts.statusUrl) cardEnv += `export VIBEHUB_STATUS_URL=${shQuote(assertSafeUrl(opts.statusUrl))}; `;
  const script =
    // AUTH RULE (project rule): the driver signs in with CLAUDE_CODE_OAUTH_TOKEN (the Max
    // subscription's setup-token, same as the TUI) and NEVER with an API key — an inherited
    // ANTHROPIC_API_KEY would silently swallow the token and bill the API, so it is unset first.
    `unset ANTHROPIC_API_KEY; ` +
    `export IS_SANDBOX=1; ` +
    `export NODE_PATH=${shQuote(`${SDK_DRIVER_DIR}/node_modules`)}; ` +
    `if [ -s ${shQuote(tokenFile)} ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shQuote(tokenFile)})"; fi; ` +
    (opts.configDir ? `export CLAUDE_CONFIG_DIR=${shQuote(opts.configDir)}; ` : "") +
    cardEnv +
    `exec node ${shQuote(SDK_DRIVER_PATH)} --cwd ${shQuote(opts.cwd)}${resume}${model}${gate}`;
  const argv = ["docker", "exec", "-i", opts.containerName, "bash", "-c", script];
  return argv.map(shQuote).join(" ");
}

/**
 * Resolve the spawn command for a card's driver, from the board — cwd, account, resume, model,
 * the card's browser endpoint, the status-hook environment and the install's permission-gate mode
 * (read from settings here so every spawn site gets it without plumbing).
 */
export async function sdkDriverCommand(project: Project, card: Card): Promise<{ file: string; args: string[] }> {
  const { cwd } = cardWorkPaths(project, card);
  const slug = effectiveAccountSlug(card, project);
  const configDir = slug ? accountConfigDir(slug) : undefined;
  const profileDir = configDir ?? DEFAULT_CLAUDE_DIR;
  const settings = await getSettings();
  const line = buildSdkDriverCommandLine({
    containerName: config.runner.container,
    cwd,
    profileDir,
    configDir,
    resumeSessionId: card.resumeSessionId,
    model: card.model,
    cdpEndpoint: cardCdpEndpoint(card.id),
    cardId: card.id,
    statusUrl: statusUrl(),
    permissionGate: settings.sdkPermissionMode,
  });
  return hostExecutor().ptyCommand(line);
}

/**
 * Plant the driver script AND make sure the SDK is installed in the runner (both idempotent).
 * Run before spawning. The first ever run pays one `npm install`; every run after that is a marker
 * check — the version marker is what keeps a reconnect from reinstalling anything.
 */
export async function installCardSdkDriver(): Promise<void> {
  await hostExecutor().runScript(buildInstallDriverScript(config.runner.container, sdkDriverSource()));
  await hostExecutor().runScript(buildEnsureSdkScript(config.runner.container));
}
