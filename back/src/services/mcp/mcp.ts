import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { secretGet, secretSet, secretDelete, secretList } from "../../secrets/vault.js";
import { listMcps, getMcp, listAccounts, owedMcpDrops, settleMcpDrops, type McpServer } from "../board/registry.js";
import {
  CLAUDE_PROFILES_DIR, DEFAULT_CLAUDE_DIR, DEFAULT_ACCOUNT_SLUG, accountConfigDir, profileDirFor,
} from "../accounts/profiles.js";
import { CDP_PORT_BASE } from "../browser/ports.js";
import { runnerToken } from "../../runtime/runner.js";
import { logger } from "../../utils/logger.js";

/**
 * MANAGED MCPs — injected into EVERY Claude profile in the runner (`/root/.claude` plus one
 * directory per account), so switching accounts never loses a connection.
 *
 * Division of labour: the board registry owns the SHAPE of an MCP (name, kind, command, url, which
 * env vars and headers it declares). This module owns the two things the board must never hold —
 * the VALUES of those env vars and headers, which live in the vault under `MCP_<ID>_<NAME>`, and
 * the injection of the resulting config into the runner.
 *
 * The resolved JSON travels INSIDE the script over STDIN (quoted heredoc) — never in argv, which is
 * world readable in `ps`, and never in a log line.
 *
 * Per MCP and profile: `claude mcp remove -s user <name>` (error ignored) followed by
 * `claude mcp add-json -s user <name> "$(cat <<'EOF' … EOF)"`. The default profile runs WITHOUT
 * CLAUDE_CONFIG_DIR (claude then writes `/root/.claude.json`, which is what a default session
 * reads); an account profile runs with CLAUDE_CONFIG_DIR=<profile dir>.
 */

// Turning "which account" into "which directory" belongs to ONE module — re-exported here so the
// MCP routes keep a single import, but never redefined: two copies of a path-safety rule is how a
// profile directory quietly drifts apart from the one the token was planted in.
export { CLAUDE_PROFILES_DIR, DEFAULT_CLAUDE_DIR, DEFAULT_ACCOUNT_SLUG, accountConfigDir, profileDirFor };

/** Heredoc delimiters — reserved words, never derived from user input. */
const OUTER_DELIM = "VIBEHUB_MCP";
const JSON_DELIM = "VIBEHUB_MCP_JSON";
/** Shell variable that records a failed `add-json` in {@link mcpInjectLines} — a reserved name. */
const INJECT_FAILED_FLAG = "VIBEHUB_MCPS_FAILED";

/** Board MCP ids are 12 hex chars. They become part of a vault key, so the charset is enforced. */
const MCP_ID_RE = /^[0-9a-f]{12}$/;
/** Env var / header names. Headers may contain '-' (X-Api-Key); vault keys may not. */
const MCP_ENV_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,59}$/;
/** The vault refuses keys longer than this, so fail here with a message that names the cause. */
const MAX_SECRET_KEY_LENGTH = 64;

/**
 * Vault key holding the value of one env var / header of an MCP: `MCP_<ID_UPPER>_<NAME>`. PURE.
 *
 * Dashes in the name become underscores (X-Api-Key -> X_API_KEY) because a vault key is
 * UPPER_SNAKE_CASE only. Both halves are validated first: this string is the ONLY place a caller's
 * id/name reaches the secret store, and an unvalidated one would let a route read or overwrite an
 * unrelated secret (`GITHUB_TOKEN`, the runner token) by choosing the right "variable name".
 */
export function mcpSecretKey(mcpId: string, name: string): string {
  if (!MCP_ID_RE.test(String(mcpId ?? ""))) throw new Error(`invalid MCP id: '${mcpId}'`);
  if (!MCP_ENV_RE.test(String(name ?? ""))) throw new Error(`invalid env/header name: '${name}'`);
  const key = `MCP_${mcpId.toUpperCase()}_${name.toUpperCase().replace(/-/g, "_")}`;
  if (key.length > MAX_SECRET_KEY_LENGTH) {
    throw new Error(`vault key for MCP '${mcpId}' / '${name}' is too long (${key.length} > ${MAX_SECRET_KEY_LENGTH})`);
  }
  return key;
}

/** Env var / header names an MCP declares — the only ones the secret route accepts. PURE. */
export function mcpSecretNames(mcp: Pick<McpServer, "envKeys" | "headerKeys">): string[] {
  return [...(mcp.envKeys ?? []), ...(mcp.headerKeys ?? [])];
}

/** Target profile: undefined = default (no CLAUDE_CONFIG_DIR); a string = the account's directory. */
export type McpProfile = string | undefined;

/**
 * The `claude mcp add-json` payload with the secrets ALREADY resolved. Never log the return value.
 *
 * `JSON.stringify` is what keeps this safe: a value carrying a quote, a backslash or a newline comes
 * back escaped, so the payload stays a SINGLE line of valid JSON — which is exactly the property
 * `mcpInjectLines` relies on to put it in a heredoc. PURE.
 */
export function mcpServerJson(mcp: McpServer, secrets: Record<string, string>): string {
  if (mcp.kind === "stdio") {
    const env: Record<string, string> = {};
    for (const k of mcp.envKeys ?? []) env[k] = secrets[k] ?? "";
    return JSON.stringify({
      type: "stdio",
      command: mcp.command,
      ...(mcp.args?.length ? { args: mcp.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    });
  }
  const headers: Record<string, string> = {};
  for (const k of mcp.headerKeys ?? []) headers[k] = secrets[k] ?? "";
  return JSON.stringify({
    type: mcp.kind,
    url: mcp.url,
    ...(Object.keys(headers).length ? { headers } : {}),
  });
}

export interface McpInjection {
  name: string;
  /** JSON with the secrets already resolved. */
  json: string;
}

/**
 * Lines for the BODY of the script that runs inside the runner: they inject every MCP into every
 * given profile. Remove-before-add makes it idempotent (no error when it did not exist), and the
 * JSON goes through a quoted heredoc — it is a single line starting with `{`, so it can never
 * collide with the delimiter.
 *
 * `force=false` is the HOT path (opening a card): the whole injection is wrapped in a guard on a
 * `.mcps-<signature>` marker, so reopening a card skips it entirely. That was the bulk of the delay
 * when switching cards, and two concurrent opens used to race into "MCP already exists". The
 * signature changes whenever the SET of MCPs changes, so a newly added MCP is picked up on the next
 * open without anyone pressing a button. `force=true` (the "Apply now" button) always re-injects.
 *
 * `add-json` never aborts the enclosing `set -e` (a card must open even when an MCP does not
 * inject), but a failure is RECORDED and decides what the block leaves behind (markedSetupLines):
 * the marker only over a clean injection, a retry stamp otherwise. PURE.
 */
export function mcpInjectLines(profiles: McpProfile[], mcps: McpInjection[], force = false): string[] {
  const lines: string[] = [];
  if (mcps.length === 0) return lines;
  const signature = mcpsSignature(mcps);
  for (const profile of profiles) {
    const dir = profile || DEFAULT_CLAUDE_DIR;
    assertSafeRemotePath(dir);
    const prefix = profile ? `CLAUDE_CONFIG_DIR=${shQuote(profile)} ` : "";
    const body: string[] = [];
    for (const m of mcps) {
      // Belt and braces on top of JSON.stringify: a multi-line payload, or one that IS the
      // delimiter, would let the heredoc close early and turn the rest into shell commands.
      if (/[\r\n]/.test(m.json) || m.json.trim() === JSON_DELIM) throw new Error("invalid MCP JSON");
      body.push(
        // A remove that finds nothing is the normal case — only the add can really fail.
        `${prefix}claude mcp remove -s user ${shQuote(m.name)} >/dev/null 2>&1 || true`,
        `${prefix}claude mcp add-json -s user ${shQuote(m.name)} "$(cat <<'${JSON_DELIM}'`,
        m.json,
        JSON_DELIM,
        `)" >/dev/null 2>&1 || ${INJECT_FAILED_FLAG}=1`,
      );
    }
    lines.push(...markedSetupLines({ dir, family: ".mcps-", signature, flag: INJECT_FAILED_FLAG, body, force }));
  }
  return lines;
}

/**
 * How long a profile setup that FAILED waits before a card open tries it again, in minutes. Shared
 * by MCPs and plugins (markedSetupLines).
 */
export const SETUP_RETRY_AFTER_MIN = 30;

/**
 * Wraps ONE profile's setup (MCP injection, plugin install) in its idempotency markers — the
 * card-open contract MCPs and plugins share. `body` must never fail on its own (every command that
 * can fail ends in `|| <flag>=1`); this decides what its outcome leaves behind:
 *
 *  - clean: the SET marker `<dir>/<family><signature>`, after dropping every older one of the
 *    family (retry stamps included). The hot path skips the block from then on — that IS the
 *    idempotency, and what keeps reopening a card free.
 *  - failed: no marker (one written over a failed add would keep that MCP/plugin out of the
 *    profile until somebody pressed apply), but a `<marker>.failed` stamp. The hot path skips the
 *    block while the stamp is younger than SETUP_RETRY_AFTER_MIN, then tries again. Without it a
 *    failure that does not go away — a JSON the CLI rejects, a plugin gone from the marketplace —
 *    re-ran the WHOLE setup on every card open, a CLI boot (and a clone) per item, forever; with it
 *    a passing failure (network down) still heals on its own within the window.
 *
 * `force` (the explicit apply) ignores both: it always runs, and what it leaves follows the same
 * rule. PURE.
 */
export function markedSetupLines(opts: {
  dir: string;
  family: string;
  signature: string;
  flag: string;
  body: string[];
  force: boolean;
}): string[] {
  const { dir, family, signature, flag, body, force } = opts;
  const marker = shQuote(`${dir}/${family}${signature}`);
  const failed = shQuote(`${dir}/${family}${signature}.failed`);
  const inner = [
    `mkdir -p ${shQuote(dir)}`,
    `${flag}=0`,
    ...body,
    `if [ "$${flag}" = 0 ]; then`,
    `rm -f ${shQuote(dir)}/${family}* 2>/dev/null || true`,
    `: > ${marker}`,
    "else",
    `: > ${failed}`,
    "fi",
  ];
  if (force) return inner;
  // `find -mmin -N` prints the stamp only while it is younger than N minutes; a missing stamp
  // prints nothing (its complaint goes to /dev/null), so no stamp means "go".
  const recentFailure = `"$(find ${failed} -mmin -${SETUP_RETRY_AFTER_MIN} 2>/dev/null)"`;
  return [`if [ ! -f ${marker} ] && [ -z ${recentFailure} ]; then`, ...inner, "fi"];
}

/** Short, stable signature of the MCP set (names + json), used to name the marker. PURE. */
export function mcpsSignature(mcps: McpInjection[]): string {
  const base = [...mcps].map((m) => `${m.name}=${m.json}`).sort().join(" ");
  let h = 5381;
  for (let i = 0; i < base.length; i++) h = ((h * 33) ^ base.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Full host script (host -> `docker exec -i … bash -s`). `force` re-injects despite the marker. PURE. */
export function buildMcpInjectScript(
  containerName: string,
  profiles: McpProfile[],
  mcps: McpInjection[],
  force = false,
): string {
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${OUTER_DELIM}'`,
    "set -e",
    ...mcpInjectLines(profiles, mcps, force),
    OUTER_DELIM,
  ].join("\n");
}

/** Resolves an MCP's values from the vault. A missing secret THROWS, naming the variable. */
export async function resolveMcpSecrets(mcp: McpServer): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of mcpSecretNames(mcp)) {
    const value = await secretGet(mcpSecretKey(mcp.id, name));
    // Fail-closed: injecting an MCP with an empty token produces a server that fails at runtime with
    // an opaque auth error, days later. Refusing the apply and naming the missing value is cheaper.
    if (!value) throw new Error(`MCP '${mcp.name}': value for '${name}' is not configured`);
    out[name] = value;
  }
  return out;
}

/**
 * The built-in MCP every card gets: vibehub itself.
 *
 * This is what turns a terminal into a maestro — it can list the other cards, delegate to them and
 * read their answers. It is not registered by the user and has no vault entry: the endpoint is
 * derived from `publicUrl` (the same address the status hooks already post to, so it is reachable
 * from inside the runner by construction) and the credential is the runner's own service token.
 *
 * Returns undefined when there is no token yet — a runner that was never provisioned has nothing to
 * authenticate with, and injecting a broken server would just make every card start with an error.
 */
export async function builtinMaestroInjection(): Promise<McpInjection | undefined> {
  const token = await runnerToken();
  if (!token) return undefined;
  const url = `${config.publicUrl.replace(/\/+$/, "")}/mcp`;
  return {
    name: BUILTIN_MAESTRO_NAME,
    json: JSON.stringify({
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
      timeout: MAESTRO_MCP_TIMEOUT_MS,
    }),
  };
}

/**
 * How long the agent's MCP client waits on ONE call to this server before giving up.
 *
 * The client's default is 5 minutes, and `vibehub_deliver` blows through it: before merging, it runs
 * the card's whole gate — a typecheck and the test suites — which on this repo is minutes of work.
 * The call died mid-gate every time, so the branch was pushed and the PR opened but the merge never
 * happened, and the agent could not even see WHY (the tool's own answer never arrived). A delivery
 * that has to wait for the tests is the normal case here, not an edge one, so the ceiling is the
 * gate's honest worst case with room to spare.
 */
export const MAESTRO_MCP_TIMEOUT_MS = 900_000;

/** Reserved name of the built-in server, so a user-registered MCP cannot shadow it. */
export const BUILTIN_MAESTRO_NAME = "vibehub";

/** Reserved name of the built-in browser server, so a user-registered MCP cannot shadow it. */
export const BUILTIN_BROWSER_NAME = "navegador";

/**
 * The built-in BROWSER MCP every card gets: a Playwright MCP wired over CDP to the card's OWN live
 * Chromium — the exact browser the user watches (and can take over) on the card's noVNC canvas —
 * instead of a private headless browser of its own. This is what makes "access site X and do Y"
 * actually happen in the browser on screen.
 *
 * The endpoint is NOT baked in per card: it is the literal `${PW_CDP_ENDPOINT}` shell reference,
 * which Claude Code expands AT MCP LAUNCH from the tmux session's environment (buildOpenScript and
 * terminalRemoteArgs both export `PW_CDP_ENDPOINT=cardCdpEndpoint(id)` per session). That indirection
 * is deliberate and load-bearing: one single injection, shared across every card and every account
 * profile, resolves to a DIFFERENT browser per card. A URL resolved per card and baked into the
 * shared profile would instead make every card on that account drive one card's browser. The `:-`
 * default only guards a session that somehow reaches this without the variable set — a real card
 * session always has it.
 *
 * `$` reaches the runner literally: the JSON is placed in a QUOTED heredoc by `mcpInjectLines`, so
 * the runner's shell never expands it; `claude mcp add-json` stores it verbatim in the profile's
 * `.claude.json`, and the expansion happens only when Claude launches the MCP. PURE.
 */
export function builtinBrowserInjection(): McpInjection {
  const endpoint = `\${PW_CDP_ENDPOINT:-http://127.0.0.1:${CDP_PORT_BASE}}`;
  return {
    name: BUILTIN_BROWSER_NAME,
    json: JSON.stringify({
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", endpoint],
    }),
  };
}

/** Every registered MCP as a resolved injection (name + JSON), plus the built-in servers. */
export async function resolveMcpInjections(): Promise<McpInjection[]> {
  const out: McpInjection[] = [];
  const builtin = await builtinMaestroInjection();
  if (builtin) out.push(builtin);
  // The browser MCP is card-agnostic (its endpoint is resolved per session from PW_CDP_ENDPOINT), so
  // it is a constant injection like the maestro — added to every profile with no per-card state.
  out.push(builtinBrowserInjection());
  for (const mcp of await listMcps()) {
    // Never let a registration shadow a built-in (by name).
    if (mcp.name === BUILTIN_MAESTRO_NAME || mcp.name === BUILTIN_BROWSER_NAME) continue;
    out.push({ name: mcp.name, json: mcpServerJson(mcp, await resolveMcpSecrets(mcp)) });
  }
  return out;
}

/** Every profile in the runner: the default one plus each registered account. */
export async function allProfiles(): Promise<McpProfile[]> {
  const accounts = await listAccounts();
  return [undefined, ...accounts.map((a) => accountConfigDir(a.slug))];
}

/**
 * Injection profile for a card's effective account slug. A missing slug, or the reserved word
 * "default", maps to the default profile (undefined). This is the only place "default" is accepted
 * as a synonym for "no account" — the board itself refuses it as a slug. PURE.
 */
export function profileForSlug(slug: string | undefined): McpProfile {
  return slug && slug !== DEFAULT_ACCOUNT_SLUG ? accountConfigDir(slug) : undefined;
}

/** Physical directory of a profile — the default one is /root/.claude. PURE. */
export function profileDirOf(profile: McpProfile): string {
  return profile ?? DEFAULT_CLAUDE_DIR;
}

/**
 * Stores the VALUE of one env var / header of an MCP in the vault. Only a name the MCP DECLARES is
 * accepted — otherwise the route would be a general-purpose write into the secret store. The value
 * is never logged.
 */
export async function setMcpSecret(mcp: McpServer, name: string, value: string, by?: string): Promise<void> {
  if (!mcpSecretNames(mcp).includes(name)) {
    throw new Error(`'${name}' is not an env var or header declared by MCP '${mcp.name}'`);
  }
  if (!value) throw new Error("value is required");
  await secretSet(mcpSecretKey(mcp.id, name), value);
  // `variable`, not `name`: pino reserves `name` for the logger's own name and would swallow it.
  logger.info({ audit: true, action: "mcp.secret", mcp: mcp.name, variable: name, by }, "MCP secret stored in the vault");
}

/** Same as {@link setMcpSecret}, addressing the MCP by id (what the HTTP route has in hand). */
export async function setMcpSecretById(mcpId: string, name: string, value: string, by?: string): Promise<void> {
  const mcp = await getMcp(mcpId);
  if (!mcp) throw new Error("MCP not found");
  await setMcpSecret(mcp, name, value, by);
}

/** Forgets one stored value. Used when an MCP is deleted, so its secrets do not outlive it. */
export async function deleteMcpSecrets(mcp: McpServer): Promise<number> {
  let removed = 0;
  for (const name of mcpSecretNames(mcp)) {
    if (await secretDelete(mcpSecretKey(mcp.id, name))) removed += 1;
  }
  return removed;
}

/**
 * REMOVES every deleted MCP the runner still owes (`owedMcpDrops`, recorded by `removeMcp`) from
 * every profile, then settles them. Re-injecting the remaining MCPs cannot do it: the injection only
 * removes-then-adds what is still registered, so a deleted one — with its token in clear text inside
 * each profile's `.claude.json` — would stay there, and keep being launched by every new session.
 * The debt is persisted, so a runner that was down at the delete gets it paid by the next apply.
 * A registration carrying a BUILT-IN's name was never injected (resolveMcpInjections skips it), so
 * removing that name would only take the built-in down: it is settled without touching the runner.
 * Each profile's injection marker goes with the removal, so the next card open re-injects the rest.
 * THROWS when the runner could not be reached — and then nothing is settled.
 */
export async function dropDeletedMcps(by?: string): Promise<void> {
  const owed = await owedMcpDrops();
  const names = [...new Set(owed.map((d) => d.name))]
    .filter((n) => n !== BUILTIN_MAESTRO_NAME && n !== BUILTIN_BROWSER_NAME);
  if (names.length > 0) {
    const profiles = await allProfiles();
    const lines = profiles.flatMap((profile) => {
      const dir = profileDirOf(profile);
      assertSafeRemotePath(dir);
      const prefix = profile ? `CLAUDE_CONFIG_DIR=${shQuote(profile)} ` : "";
      return [
        ...names.map((name) => `${prefix}claude mcp remove -s user ${shQuote(name)} >/dev/null 2>&1 || true`),
        // The profile no longer holds the set its `.mcps-<signature>` marker vouches for. Kept, a
        // marker that matches again (the MCP recreated with the same definition while the apply
        // that would re-inject it is refused) lets the card-open hot path skip the injection.
        `rm -f ${shQuote(dir)}/.mcps-* 2>/dev/null || true`,
      ];
    });
    const script = [
      "set -e",
      `docker exec -i ${shQuote(config.runner.container)} bash -s <<'${OUTER_DELIM}'`,
      ...lines,
      "true",
      OUTER_DELIM,
    ].join("\n");
    await hostExecutor().runScript(script, { timeoutMs: 120_000 });
    logger.info(
      { audit: true, action: "mcp.drop", mcps: names, profiles: profiles.length, by },
      "deleted MCPs removed from every profile of the runner",
    );
  }
  await settleMcpDrops(owed);
}

/** Which of an MCP's env vars / headers already have a value (the UI renders "configured"). */
export async function mcpSecretsStatus(mcp: McpServer): Promise<Record<string, boolean>> {
  const keys = new Set((await secretList()).map((s) => s.key));
  const out: Record<string, boolean> = {};
  for (const name of mcpSecretNames(mcp)) out[name] = keys.has(mcpSecretKey(mcp.id, name));
  return out;
}

/**
 * APPLIES every MCP to every profile of the runner, forcing re-injection (ignoring the marker).
 *
 * The panel this came from looped over one runner per server and counted how many it reached;
 * vibehub has exactly ONE runner, so the loop is gone — but the return keeps `runners` so callers
 * and the UI still read the same field. It is always 1.
 */
export async function applyMcpsEverywhere(by?: string): Promise<{ runners: number; mcps: number }> {
  // First what deletes still owe the runner: an MCP the owner removed is an earlier decision, and it
  // must leave the profiles even when a missing secret below refuses the rest of this apply.
  await dropDeletedMcps(by);
  // Resolve BEFORE injecting: a missing secret must fail the whole apply with a message that names
  // it, before a single MCP is (re)injected — only the removals above have touched the runner.
  const injections = await resolveMcpInjections();
  const profiles = await allProfiles();
  const container = config.runner.container;
  await hostExecutor().runScript(buildMcpInjectScript(container, profiles, injections, true), { timeoutMs: 300_000 });
  logger.info(
    { audit: true, action: "mcp.apply", runners: 1, mcps: injections.length, profiles: profiles.length, by },
    "managed MCPs applied to the runner",
  );
  return { runners: 1, mcps: injections.length };
}
