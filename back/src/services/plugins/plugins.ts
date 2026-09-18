import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config, dataPath } from "../../config/env.js";
import { JsonStore } from "../../store/jsonStore.js";
import { allProfiles, type McpProfile } from "../mcp/mcp.js";
import { DEFAULT_CLAUDE_DIR } from "../accounts/profiles.js";
import { logger } from "../../utils/logger.js";

/**
 * OFFICIAL PLUGINS — Anthropic's plugin marketplace, installed into every Claude profile of the
 * runner, so every card can invoke what they bring (skills, commands, agents) from the chat's "/"
 * menu or the terminal.
 *
 * Why a marketplace and not a folder of skill files: the marketplace is the mechanism Claude Code
 * itself ships with. It versions, updates and uninstalls; `code-review`, `code-simplifier`,
 * `superpowers` and the rest are entries in it. vibehub does not reimplement any of that — it
 * drives the SAME `claude plugin …` CLI the terminal would, once per profile, and keeps a list of
 * what the install WANTS so a profile created later (a new Claude account) gets the same set.
 *
 * ONE marketplace, on purpose: `anthropics/claude-plugins-official`. A plugin is code that runs in
 * the runner with the agent's own reach, and "paste a git URL" would make this screen a way to run
 * arbitrary code in every card by typing a name. The official catalogue is a decision, not a
 * limitation of the CLI.
 *
 * Division of labour, mirroring services/mcp/mcp.ts: this module owns the DESIRED list (a tiny
 * JSON store) and the scripts that make a runner match it; the runner itself remains the source of
 * truth about what is actually on disk (`claude plugin list --json`), which is what the screen
 * shows.
 */

/** The only marketplace vibehub installs from, and where the CLI fetches it from. */
export const OFFICIAL_MARKETPLACE = "claude-plugins-official";
export const OFFICIAL_MARKETPLACE_SOURCE = "anthropics/claude-plugins-official";

/** Heredoc-free scripts, but the outer one still needs a delimiter. Reserved word, never input. */
const OUTER_DELIM = "VIBEHUB_PLUGINS";

/** Marketplace plugin names: lowercase-ish slugs. They reach a command line, so the charset is law. */
const PLUGIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * THROWS unless `name` is a plugin name. Every path that reaches the runner goes through here: the
 * name arrives from a request body and ends up as an argument of `claude plugin install`. PURE.
 */
export function assertPluginName(name: string): string {
  const value = String(name ?? "").trim();
  if (!PLUGIN_NAME_RE.test(value)) throw new Error(`invalid plugin name: '${name}'`);
  return value;
}

/** `<name>@<marketplace>` — how the CLI addresses one plugin unambiguously. PURE. */
export function pluginId(name: string): string {
  return `${assertPluginName(name)}@${OFFICIAL_MARKETPLACE}`;
}

/** Short, stable signature of the desired SET (djb2), used to name the idempotency marker. PURE. */
export function pluginsSignature(names: string[]): string {
  const base = [...names].sort().join(" ");
  let h = 5381;
  for (let i = 0; i < base.length; i++) h = ((h * 33) ^ base.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** `CLAUDE_CONFIG_DIR=… ` for a named profile; empty for the default one (which writes /root/.claude). */
function profilePrefix(profile: McpProfile): string {
  return profile ? `CLAUDE_CONFIG_DIR=${shQuote(profile)} ` : "";
}

/**
 * Lines that make ONE profile have the marketplace and the wanted plugins.
 *
 * `force=false` is the HOT path (opening a card): the whole block is guarded by a
 * `.plugins-<signature>` marker, so reopening a card costs nothing and a profile created later
 * picks the set up on its first open. Installing is NEVER allowed to break the enclosing script
 * (`|| true`): a plugin that fails to clone must not stop a card from opening — the Plugins screen
 * is where a failure is meant to be seen.
 *
 * It only ADDS. Removing is the explicit apply's job (`reconcileLines`), which knows what a runner
 * actually has. PURE.
 */
export function pluginInstallLines(profiles: McpProfile[], names: string[], force = false): string[] {
  const wanted = names.map(assertPluginName);
  if (wanted.length === 0) return [];
  const signature = pluginsSignature(wanted);
  const lines: string[] = [];
  for (const profile of profiles) {
    const dir = profile || DEFAULT_CLAUDE_DIR;
    assertSafeRemotePath(dir);
    const prefix = profilePrefix(profile);
    const marker = `${dir}/.plugins-${signature}`;
    const inner: string[] = [
      `mkdir -p ${shQuote(dir)}`,
      // Idempotent: an already-known marketplace exits 0 saying so.
      `${prefix}claude plugin marketplace add ${shQuote(OFFICIAL_MARKETPLACE_SOURCE)} >/dev/null 2>&1 || true`,
      ...wanted.map((name) => `${prefix}claude plugin install ${shQuote(pluginId(name))} >/dev/null 2>&1 || true`),
      `rm -f ${shQuote(dir)}/.plugins-* 2>/dev/null || true`,
      `: > ${shQuote(marker)}`,
    ];
    if (force) lines.push(...inner);
    else lines.push(`if [ ! -f ${shQuote(marker)} ]; then`, ...inner, "fi");
  }
  return lines;
}

/**
 * Script that READS what each profile has: one `### <dir>` header per profile followed by the
 * CLI's own JSON. Read-only — it is the state the Plugins screen shows and the input of the
 * reconciliation. PURE.
 */
export function buildPluginReadScript(containerName: string, profiles: McpProfile[]): string {
  const lines: string[] = ["set -e"];
  for (const profile of profiles) {
    const dir = profile || DEFAULT_CLAUDE_DIR;
    assertSafeRemotePath(dir);
    lines.push(`echo "### ${dir}"`, `${profilePrefix(profile)}claude plugin list --json 2>/dev/null || echo '[]'`);
  }
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${OUTER_DELIM}'`,
    ...lines,
    OUTER_DELIM,
  ].join("\n");
}

/**
 * Script that reads the CATALOGUE — every plugin the official marketplace offers, plus what the
 * DEFAULT profile has installed — in one round trip. The marketplace is added first (idempotent),
 * otherwise a fresh runner reports an empty catalogue. PURE.
 */
export function buildPluginCatalogScript(containerName: string): string {
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${OUTER_DELIM}'`,
    `claude plugin marketplace add ${shQuote(OFFICIAL_MARKETPLACE_SOURCE)} >/dev/null 2>&1 || true`,
    "claude plugin list --json --available 2>/dev/null || echo '{}'",
    OUTER_DELIM,
  ].join("\n");
}

/** One plugin as the Plugins screen shows it. */
export interface PluginView {
  name: string;
  description?: string;
  /** Installs reported by the marketplace — the only popularity signal there is, and a good sort. */
  installs?: number;
  /** True when the runner's default profile has it on disk RIGHT NOW (not merely wanted). */
  installed: boolean;
  /** True when it is in vibehub's wanted list (what a new profile will get). */
  enabled: boolean;
}

/** What the screen renders. */
export interface PluginCatalogView {
  marketplace: string;
  plugins: PluginView[];
}

/** JSON on a line, ignoring everything the CLI may have printed around it. PURE. */
function parseJsonBlob(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

/**
 * Turn the catalogue command's stdout into the screen's list: only entries FROM the official
 * marketplace, names validated (they come back as ids we will send right back to the CLI),
 * descriptions flattened, sorted by how installed they are in the world. PURE.
 */
export function parsePluginCatalog(stdout: string, wanted: string[] = []): PluginView[] {
  const doc = parseJsonBlob(stdout) as { available?: unknown; installed?: unknown } | undefined;
  if (!doc || typeof doc !== "object") return [];
  const installed = new Set<string>();
  for (const entry of Array.isArray(doc.installed) ? doc.installed : []) {
    const id = (entry as { id?: unknown; pluginId?: unknown })?.id ?? (entry as { pluginId?: unknown })?.pluginId;
    if (typeof id === "string") installed.add(id.split("@")[0] ?? "");
  }
  const enabled = new Set(wanted);
  const out: PluginView[] = [];
  for (const entry of Array.isArray(doc.available) ? doc.available : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { name?: unknown; description?: unknown; marketplaceName?: unknown; installCount?: unknown };
    if (e.marketplaceName !== OFFICIAL_MARKETPLACE) continue;
    if (typeof e.name !== "string" || !PLUGIN_NAME_RE.test(e.name)) continue;
    const description = typeof e.description === "string" ? e.description.replace(/\s+/g, " ").trim() : "";
    out.push({
      name: e.name,
      ...(description ? { description: description.length > 400 ? `${description.slice(0, 399)}…` : description } : {}),
      ...(typeof e.installCount === "number" ? { installs: e.installCount } : {}),
      installed: installed.has(e.name),
      enabled: enabled.has(e.name),
    });
  }
  return out.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0) || a.name.localeCompare(b.name));
}

/**
 * What each profile has installed, from `buildPluginReadScript`'s output: `### <dir>` headers
 * followed by the CLI's JSON array. A profile whose block is unreadable comes back as an empty
 * list — the reconciliation then installs into it, which is the safe direction. PURE.
 */
export function parseInstalledByProfile(stdout: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const blocks = stdout.split(/^### /m).slice(1);
  for (const block of blocks) {
    const nl = block.indexOf("\n");
    if (nl < 0) continue;
    const dir = block.slice(0, nl).trim();
    const parsed = parseJsonBlob(block.slice(nl + 1));
    const names: string[] = [];
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const id = (entry as { id?: unknown })?.id;
      const name = typeof id === "string" ? id.split("@")[0] ?? "" : "";
      const marketplace = typeof id === "string" ? id.split("@")[1] ?? "" : "";
      // Only OUR marketplace: a plugin somebody installed by hand from elsewhere is not vibehub's
      // to uninstall, and removing it behind their back would be the worst kind of surprise.
      if (name && marketplace === OFFICIAL_MARKETPLACE && PLUGIN_NAME_RE.test(name)) names.push(name);
    }
    out[dir] = names;
  }
  return out;
}

/**
 * The commands that make every profile match the wanted set: install what is missing, uninstall
 * what vibehub installed and nobody wants any more, and leave everything else alone. Each command
 * carries `|| true` — one profile that refuses (a clone that failed, a profile mid-creation) must
 * not abort the sweep over the others. PURE.
 */
export function reconcileLines(
  profiles: McpProfile[],
  wanted: string[],
  installedByProfile: Record<string, string[]>,
): string[] {
  const want = wanted.map(assertPluginName);
  const signature = pluginsSignature(want);
  const lines: string[] = [];
  for (const profile of profiles) {
    const dir = profile || DEFAULT_CLAUDE_DIR;
    assertSafeRemotePath(dir);
    const prefix = profilePrefix(profile);
    const have = (installedByProfile[dir] ?? []).filter((n) => PLUGIN_NAME_RE.test(n));
    const missing = want.filter((n) => !have.includes(n));
    const extra = have.filter((n) => !want.includes(n));
    if (want.length > 0) {
      lines.push(`${prefix}claude plugin marketplace add ${shQuote(OFFICIAL_MARKETPLACE_SOURCE)} >/dev/null 2>&1 || true`);
    }
    for (const name of missing) {
      lines.push(`${prefix}claude plugin install ${shQuote(pluginId(name))} >/dev/null 2>&1 || true`);
    }
    for (const name of extra) {
      lines.push(`${prefix}claude plugin uninstall ${shQuote(pluginId(name))} >/dev/null 2>&1 || true`);
    }
    // The marker the card-open path checks: after a reconcile the profile IS the current set.
    lines.push(`rm -f ${shQuote(dir)}/.plugins-* 2>/dev/null || true`);
    if (want.length > 0) lines.push(`: > ${shQuote(dir)}/.plugins-${signature}`);
  }
  return lines;
}

/** Full host script for a reconciliation. PURE. */
export function buildReconcileScript(
  containerName: string,
  profiles: McpProfile[],
  wanted: string[],
  installedByProfile: Record<string, string[]>,
): string {
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${OUTER_DELIM}'`,
    ...reconcileLines(profiles, wanted, installedByProfile),
    OUTER_DELIM,
  ].join("\n");
}

/* ------------------------------------------------------------------ store */

interface PluginsDoc {
  /** The plugin names the install WANTS — what every profile is reconciled to. */
  enabled: string[];
  updatedAt?: string;
  by?: string | null;
}

const store = new JsonStore<PluginsDoc>(
  dataPath("plugins.json"),
  () => ({ enabled: [] }),
  (raw) => {
    const doc = raw as PluginsDoc;
    const enabled = Array.isArray(doc?.enabled)
      ? doc.enabled.filter((n): n is string => typeof n === "string" && PLUGIN_NAME_RE.test(n))
      : [];
    return { enabled: [...new Set(enabled)].sort(), updatedAt: doc?.updatedAt, by: doc?.by ?? null };
  },
);

/** The wanted set — read by the card-open path, so a new profile starts with the same plugins. */
export async function enabledPlugins(): Promise<string[]> {
  return (await store.load()).enabled;
}

/* ----------------------------------------------------------------- actions */

/** Reads the official catalogue from the runner, marked up with what is installed and wanted. */
export async function pluginCatalog(): Promise<PluginCatalogView> {
  const wanted = await enabledPlugins();
  const { stdout } = await hostExecutor().runScript(buildPluginCatalogScript(config.runner.container), {
    timeoutMs: 180_000,
  });
  return { marketplace: OFFICIAL_MARKETPLACE, plugins: parsePluginCatalog(stdout, wanted) };
}

/**
 * Makes every profile match the wanted list — the one place that touches the runner's plugins.
 * READS first (what each profile actually has), then sends exactly the installs and uninstalls
 * that change something. Returns how many plugins are wanted, for the log and the UI.
 */
export async function applyPluginsEverywhere(by?: string): Promise<{ profiles: number; plugins: number }> {
  const wanted = await enabledPlugins();
  const profiles = await allProfiles();
  const host = hostExecutor();
  const container = config.runner.container;
  const { stdout } = await host.runScript(buildPluginReadScript(container, profiles), { timeoutMs: 120_000 });
  const installed = parseInstalledByProfile(stdout);
  // Cloning a plugin repository per profile is minutes on a cold runner, not seconds.
  await host.runScript(buildReconcileScript(container, profiles, wanted, installed), { timeoutMs: 900_000 });
  logger.info(
    { audit: true, action: "plugins.apply", profiles: profiles.length, plugins: wanted.length, by },
    "official plugins applied to the runner",
  );
  return { profiles: profiles.length, plugins: wanted.length };
}

/** Adds one plugin to the wanted list (idempotent) and returns the new list. */
export async function enablePlugin(name: string, by?: string): Promise<string[]> {
  const value = assertPluginName(name);
  await store.mutate((doc) => {
    if (!doc.enabled.includes(value)) doc.enabled = [...doc.enabled, value].sort();
    doc.updatedAt = new Date().toISOString();
    doc.by = by ?? null;
  });
  logger.info({ audit: true, action: "plugins.enable", plugin: value, by }, "plugin added to the install's list");
  return await enabledPlugins();
}

/** Takes one plugin off the wanted list — the apply is what removes it from the runner. */
export async function disablePlugin(name: string, by?: string): Promise<string[]> {
  const value = assertPluginName(name);
  await store.mutate((doc) => {
    doc.enabled = doc.enabled.filter((n) => n !== value);
    doc.updatedAt = new Date().toISOString();
    doc.by = by ?? null;
  });
  logger.info({ audit: true, action: "plugins.disable", plugin: value, by }, "plugin removed from the install's list");
  return await enabledPlugins();
}
