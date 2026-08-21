import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { secretGet, secretSet, secretList } from "../../secrets/vault.js";
import { listMcps, listAccounts } from "../board/registry.js";
import { logger } from "../../utils/logger.js";

/**
 * MANAGED MCPs — injected into EVERY Claude profile in the runner (/root/.claude plus one directory
 * per account), so switching accounts never loses a connection.
 *
 * The SHAPE of an MCP lives in the board document; the VALUES of its env vars / headers live in the
 * vault under `MCP_<ID>_<NAME>` and are resolved HERE, at the moment the JSON is built. That JSON
 * then travels INSIDE the script over STDIN (quoted heredoc) — never in argv, which is world
 * readable in `ps`, and never in a log line.
 *
 * Per MCP and profile: `claude mcp remove -s user <name>` (error ignored) followed by
 * `claude mcp add-json -s user <name> "$(cat <<'EOF' … EOF)"`. The default profile runs WITHOUT
 * CLAUDE_CONFIG_DIR (claude then writes /root/.claude.json, which is what a default session reads);
 * an account profile runs with CLAUDE_CONFIG_DIR=<profile dir>.
 */

/** Root of the per-ACCOUNT Claude profiles in the runner (the default account is /root/.claude). */
export const CLAUDE_PROFILES_DIR = "/root/.claude-profiles";

/** Profile directory of the runner's DEFAULT Claude account. */
export const DEFAULT_CLAUDE_DIR = "/root/.claude";

/** Slug the token/MCP routes accept to address the default account (which has no board entry). */
export const DEFAULT_ACCOUNT_SLUG = "default";

/** Heredoc delimiters — reserved words, never derived from user input. */
const OUTER_DELIM = "VIBEHUB_MCP";
const JSON_DELIM = "VIBEHUB_MCP_JSON";

/**
 * Account slugs become directory names in the runner, so they are validated as such — lowercase,
 * no dots, no slashes. This is a path-safety guard, which is why this module owns it rather than
 * trusting whatever the caller hands over.
 */
export function assertAccountSlug(slug: string): string {
  const v = String(slug ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(v)) throw new Error(`invalid account slug: '${slug}'`);
  return v;
}

/** Board ids are generated, not typed by a human — but they end up in a vault key, so validate. */
const MCP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
/** Env var / header names. Headers may contain '-' (X-Api-Key); vault keys may not. */
const MCP_ENV_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,59}$/;
/** The vault refuses keys longer than this, so fail here with a message that names the cause. */
const MAX_SECRET_KEY_LENGTH = 64;

/**
 * Vault key holding the value of one env var / header of an MCP: `MCP_<ID>_<NAME>`. PURE.
 *
 * Dashes are dropped from the id (a uuid would otherwise blow the vault's 64-char key budget) and
 * turned into underscores in the name (X-Api-Key → X_API_KEY). Ids are machine-generated, so the
 * theoretical "a-b" / "ab" collision cannot be reached from the UI.
 */
export function mcpSecretKey(mcpId: string, name: string): string {
  if (!MCP_ID_RE.test(String(mcpId ?? ""))) throw new Error(`invalid MCP id: '${mcpId}'`);
  if (!MCP_ENV_RE.test(String(name ?? ""))) throw new Error(`invalid env/header name: '${name}'`);
  const key = `MCP_${mcpId.toUpperCase().replace(/-/g, "")}_${name.toUpperCase().replace(/-/g, "_")}`;
  if (key.length > MAX_SECRET_KEY_LENGTH) {
    throw new Error(`vault key for MCP '${mcpId}' / '${name}' is too long (${key.length} > ${MAX_SECRET_KEY_LENGTH})`);
  }
  return key;
}

export type McpTransport = "stdio" | "http" | "sse";

/**
 * The shape this module needs from an MCP entry. Declared here rather than imported so the board
 * document stays free to carry extra fields, and so a malformed entry fails loudly at the boundary
 * instead of producing a nonsense `claude mcp add-json` payload.
 */
export interface McpSpec {
  id: string;
  name: string;
  type: McpTransport;
  /** stdio only. */
  command?: string;
  args?: string[];
  /** http/sse only. */
  url?: string;
  /** Names of env vars (stdio) whose values live in the vault. */
  envKeys?: string[];
  /** Names of headers (http/sse) whose values live in the vault. */
  headerKeys?: string[];
}

/** Validates and narrows a board entry into an McpSpec. Fail-closed: a bad entry throws. */
export function mcpSpecOf(raw: unknown): McpSpec {
  const m = (raw ?? {}) as Partial<McpSpec>;
  const id = String(m.id ?? "");
  const name = String(m.name ?? "");
  if (!id) throw new Error("MCP entry has no id");
  if (!name) throw new Error(`MCP '${id}' has no name`);
  const type = m.type ?? "stdio";
  if (type !== "stdio" && type !== "http" && type !== "sse") throw new Error(`MCP '${name}': unknown type '${type}'`);
  if (type === "stdio" && !m.command) throw new Error(`MCP '${name}': stdio needs a command`);
  if (type !== "stdio" && !m.url) throw new Error(`MCP '${name}': ${type} needs a url`);
  return {
    id,
    name,
    type,
    ...(m.command ? { command: m.command } : {}),
    ...(m.args?.length ? { args: [...m.args] } : {}),
    ...(m.url ? { url: m.url } : {}),
    ...(m.envKeys?.length ? { envKeys: [...m.envKeys] } : {}),
    ...(m.headerKeys?.length ? { headerKeys: [...m.headerKeys] } : {}),
  };
}

/** Env var / header names an MCP declares — the only ones the secret route accepts. PURE. */
export function mcpSecretNames(mcp: McpSpec): string[] {
  return [...(mcp.envKeys ?? []), ...(mcp.headerKeys ?? [])];
}

/** Target profile: undefined = default (no CLAUDE_CONFIG_DIR); a string = the account's dir. */
export type McpProfile = string | undefined;

/** The `claude mcp add-json` payload with the secrets ALREADY resolved. Never log this. PURE. */
export function mcpServerJson(mcp: McpSpec, secrets: Record<string, string>): string {
  if (mcp.type === "stdio") {
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
    type: mcp.type,
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
 * `add-json` carries `|| true`: "already exists" is benign and must not abort the enclosing `set -e`.
 * PURE.
 */
export function mcpInjectLines(profiles: McpProfile[], mcps: McpInjection[], force = false): string[] {
  const lines: string[] = [];
  if (mcps.length === 0) return lines;
  const signature = mcpsSignature(mcps);
  for (const profile of profiles) {
    const dir = profile || DEFAULT_CLAUDE_DIR;
    assertSafeRemotePath(dir);
    const prefix = profile ? `CLAUDE_CONFIG_DIR=${shQuote(profile)} ` : "";
    const marker = `${dir}/.mcps-${signature}`;
    const inner: string[] = [`mkdir -p ${shQuote(dir)}`];
    for (const m of mcps) {
      if (/[\r\n]/.test(m.json) || m.json.trim() === JSON_DELIM) throw new Error("invalid MCP JSON");
      inner.push(
        `${prefix}claude mcp remove -s user ${shQuote(m.name)} >/dev/null 2>&1 || true`,
        `${prefix}claude mcp add-json -s user ${shQuote(m.name)} "$(cat <<'${JSON_DELIM}'`,
        m.json,
        JSON_DELIM,
        `)" >/dev/null 2>&1 || true`,
      );
    }
    // One marker per current set: drop the old ones, write the new one (that IS the idempotency).
    inner.push(`rm -f ${shQuote(dir)}/.mcps-* 2>/dev/null || true`, `: > ${shQuote(marker)}`);
    if (force) {
      lines.push(...inner);
    } else {
      lines.push(`if [ ! -f ${shQuote(marker)} ]; then`, ...inner, "fi");
    }
  }
  return lines;
}

/** Short, stable signature of the MCP set (names + json), used to name the marker. PURE. */
function mcpsSignature(mcps: McpInjection[]): string {
  const base = [...mcps].map((m) => `${m.name}=${m.json}`).sort().join(" ");
  let h = 5381;
  for (let i = 0; i < base.length; i++) h = ((h * 33) ^ base.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Full host script (host → `docker exec -i … bash -s`). `force` re-injects despite the marker. PURE. */
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
async function resolveMcpSecrets(mcp: McpSpec): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of mcpSecretNames(mcp)) {
    const value = await secretGet(mcpSecretKey(mcp.id, name));
    // Fail-closed: injecting an MCP with an empty token yields a server that fails at runtime with
    // an opaque auth error. Better to refuse the apply and say exactly which value is missing.
    if (!value) throw new Error(`MCP '${mcp.name}': value for '${name}' is not configured`);
    out[name] = value;
  }
  return out;
}

/** Every registered MCP as a resolved injection (name + JSON). */
export async function resolveMcpInjections(): Promise<McpInjection[]> {
  const out: McpInjection[] = [];
  for (const raw of await listMcps()) {
    const mcp = mcpSpecOf(raw);
    out.push({ name: mcp.name, json: mcpServerJson(mcp, await resolveMcpSecrets(mcp)) });
  }
  return out;
}

/** Every profile in the runner: the default one plus each registered account. */
export async function allProfiles(): Promise<McpProfile[]> {
  const accounts = await listAccounts();
  return [undefined, ...accounts.map((a) => accountConfigDir(a.slug))];
}

/** CLAUDE_CONFIG_DIR of an account's profile. The slug is re-validated — never raw input. PURE. */
export function accountConfigDir(slug: string): string {
  return `${CLAUDE_PROFILES_DIR}/${assertAccountSlug(slug)}`;
}

/** Injection profile from a card's effective account slug (undefined = default). PURE. */
export function profileForSlug(slug: string | undefined): McpProfile {
  return slug && slug !== DEFAULT_ACCOUNT_SLUG ? accountConfigDir(slug) : undefined;
}

/** Physical directory of a profile — the default one is /root/.claude. PURE. */
export function profileDirOf(profile: McpProfile): string {
  return profile ?? DEFAULT_CLAUDE_DIR;
}

/**
 * Directory of the EFFECTIVE profile: a missing slug or "default" → /root/.claude, otherwise the
 * account's. This is the only place where "default" becomes a path (the board still holds no
 * account called "default"). PURE.
 */
export function profileDirFor(slug: string | undefined): string {
  return profileDirOf(profileForSlug(slug));
}

/**
 * Stores the VALUE of one env var / header of an MCP in the vault. Only a name the MCP DECLARES is
 * accepted; the value is never logged.
 */
export async function setMcpSecret(mcp: McpSpec, name: string, value: string, by?: string): Promise<void> {
  if (!mcpSecretNames(mcp).includes(name)) {
    throw new Error(`'${name}' is not an env var or header declared by MCP '${mcp.name}'`);
  }
  if (!value) throw new Error("value is required");
  await secretSet(mcpSecretKey(mcp.id, name), value);
  logger.info({ audit: true, action: "mcp.secret", mcp: mcp.name, name, by }, "MCP secret stored in the vault");
}

/** Looks an MCP up in the board by id and narrows it. Throws when it is not there. */
export async function getMcpSpec(mcpId: string): Promise<McpSpec> {
  const raw = (await listMcps()).find((m) => (m as { id?: string }).id === mcpId);
  if (!raw) throw new Error("MCP not found");
  return mcpSpecOf(raw);
}

/** Same as `setMcpSecret`, addressing the MCP by id (what the HTTP route has in hand). */
export async function setMcpSecretById(mcpId: string, name: string, value: string, by?: string): Promise<void> {
  await setMcpSecret(await getMcpSpec(mcpId), name, value, by);
}

/** Which of an MCP's env vars / headers already have a value (the UI renders "configured"). */
export async function mcpSecretsStatus(mcp: McpSpec): Promise<Record<string, boolean>> {
  const keys = new Set((await secretList()).map((s) => s.key));
  const out: Record<string, boolean> = {};
  for (const name of mcpSecretNames(mcp)) out[name] = keys.has(mcpSecretKey(mcp.id, name));
  return out;
}

/**
 * APPLIES every MCP to every profile of the runner, forcing re-injection (ignoring the marker).
 *
 * The panel this came from looped over one runner per server; vibehub has exactly ONE runner, so
 * the loop is gone — but the return shape keeps `runners` so callers and the UI still read the same
 * field. It is always 1.
 */
export async function applyMcpsEverywhere(by?: string): Promise<{ runners: number; mcps: number }> {
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
