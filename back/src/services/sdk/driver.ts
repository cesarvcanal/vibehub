import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { cardWorkPaths } from "../board/workspace.js";
import { accountConfigDir } from "../accounts/profiles.js";
import { oauthTokenPath, DEFAULT_CLAUDE_DIR } from "../accounts/profiles.js";
import { effectiveAccountSlug, isValidModel, assertSessionId, type Card, type Project } from "../board/registry.js";

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

/** Reserved heredoc delimiters — never derived from input. */
const INSTALL_DELIM = "VIBEHUB_SDK_INSTALL";
const SOURCE_DELIM = "VIBEHUB_SDK_DRIVER_SRC";

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
}

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
  const script =
    `export IS_SANDBOX=1; ` +
    `export NODE_PATH=${shQuote(`${SDK_DRIVER_DIR}/node_modules`)}; ` +
    `if [ -s ${shQuote(tokenFile)} ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shQuote(tokenFile)})"; fi; ` +
    (opts.configDir ? `export CLAUDE_CONFIG_DIR=${shQuote(opts.configDir)}; ` : "") +
    `exec node ${shQuote(SDK_DRIVER_PATH)} --cwd ${shQuote(opts.cwd)}${resume}${model}`;
  const argv = ["docker", "exec", "-i", opts.containerName, "bash", "-c", script];
  return argv.map(shQuote).join(" ");
}

/** Resolve the spawn command for a card's driver, from the board — cwd, account, resume, model. */
export function sdkDriverCommand(project: Project, card: Card): { file: string; args: string[] } {
  const { cwd } = cardWorkPaths(project, card);
  const slug = effectiveAccountSlug(card, project);
  const configDir = slug ? accountConfigDir(slug) : undefined;
  const profileDir = configDir ?? DEFAULT_CLAUDE_DIR;
  const line = buildSdkDriverCommandLine({
    containerName: config.runner.container,
    cwd,
    profileDir,
    configDir,
    resumeSessionId: card.resumeSessionId,
    model: card.model,
  });
  return hostExecutor().ptyCommand(line);
}

/** Plant the driver script in the runner (idempotent). Run once before spawning. */
export async function installCardSdkDriver(): Promise<void> {
  await hostExecutor().runScript(buildInstallDriverScript(config.runner.container, sdkDriverSource()));
}
