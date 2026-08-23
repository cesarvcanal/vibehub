import { hostExecutor, shQuote, assertSafeRemotePath, HostExecError } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { secretGet, secretSet, secretDelete, secretList } from "../../secrets/vault.js";
import { listAccounts, assertAccountSlug } from "../board/registry.js";
import { DEFAULT_ACCOUNT_SLUG, profileDirFor, oauthTokenPath } from "./profiles.js";
import { logger } from "../../utils/logger.js";

/**
 * LONG-LIVED TOKEN per Claude account — log in once instead of running `/login` in every card. The
 * user produces it with `claude setup-token` in any card terminal and pastes it into the UI.
 *
 * The value lives in the local vault under `ACCOUNT_TOKEN_<SLUG>` and is written into the runner at
 * `<profile>/.oauth-token` (mode 600) — ALWAYS inside a script travelling over STDIN, NEVER in argv
 * (which is world-readable in `ps`) and never in a log line. The card's session then exports
 * CLAUDE_CODE_OAUTH_TOKEN by reading that file (see `sessionCommand` in board/workspace.ts).
 *
 * "default" is accepted only here and in profiles.ts (it maps to /root/.claude); the board still
 * holds no account by that name.
 */

/** Shape of a `claude setup-token` value (sk-ant-oat01-…): safe charset, no spaces or newlines. */
const TOKEN_RE = /^[A-Za-z0-9._-]{20,1000}$/;

/** Heredoc delimiters — reserved words, never derived from user input. */
const DELIM = "VIBEHUB_TOKEN";

/** Vault key for an account's token: `ACCOUNT_TOKEN_<SLUG>`. Slug validated (or "default"). PURE. */
export function accountTokenKey(slug: string): string {
  const v = slug === DEFAULT_ACCOUNT_SLUG ? slug : assertAccountSlug(slug);
  return `ACCOUNT_TOKEN_${v.toUpperCase().replace(/-/g, "_")}`;
}

/** A token sane enough to go into a script (still shell-quoted). THROWS otherwise. PURE. */
export function assertOauthToken(token: string): string {
  const v = String(token ?? "").trim();
  if (!TOKEN_RE.test(v)) {
    throw new Error("invalid token (expected the value printed by `claude setup-token`, with no spaces)");
  }
  return v;
}

/**
 * GITHUB token per card — lets the card's own `git push` / `gh pr` act as the PROJECT's GitHub
 * connection (`cesarvcanal`) instead of the runner's ambient `gh` login (the org). Same rules as the
 * Claude token: the value is written to a per-card file inside the runner over STDIN (mode 600,
 * never argv, never logged), and the session exports `GH_TOKEN` by reading that file. The runner's
 * git credential helper is already `gh auth git-credential`, so a set `GH_TOKEN` steers BOTH `git`
 * and `gh` to the connection identity — while cards without a connection keep the ambient login.
 */
const GH_TOKEN_DIR = "/root/.vibehub/gh";
/** A card id is a uuid; keep the charset tight so it can name a file safely. PURE. */
const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A GitHub token (ghp_…, github_pat_…, gho_…, or a classic 40-hex): safe charset, no spaces. */
const GH_TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

/** Per-card file that holds the GitHub token inside the runner. THROWS on a bad id. PURE. */
export function ghTokenPath(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id: ${cardId}`);
  return `${GH_TOKEN_DIR}/${cardId}.token`;
}

/** A GitHub token sane enough to go into a script (still shell-quoted). THROWS otherwise. PURE. */
export function assertGhToken(token: string): string {
  const v = String(token ?? "").trim();
  if (!GH_TOKEN_RE.test(v)) throw new Error("invalid GitHub token (unexpected characters)");
  return v;
}

/** Script lines that WRITE the card's GitHub token (mode 600) inside the runner. PURE. */
export function writeGhTokenLines(cardId: string, token: string): string[] {
  const file = ghTokenPath(cardId);
  return [
    `mkdir -p ${shQuote(GH_TOKEN_DIR)}`,
    "umask 077",
    `printf '%s' ${shQuote(assertGhToken(token))} > ${shQuote(file)}`,
    `chmod 600 ${shQuote(file)}`,
  ];
}

/** Script line that REMOVES the card's GitHub token — keeps the file in sync when a project has no
 * connection (or it was cleared), so a stale token can never be exported. Idempotent. PURE. */
export function removeGhTokenLines(cardId: string): string[] {
  return [`rm -f ${shQuote(ghTokenPath(cardId))}`];
}

/**
 * Lines for the BODY of a script running INSIDE the runner: write the token to
 * `<profile>/.oauth-token` with mode 600, creating the profile directory first (a brand new account
 * has none yet). Shared by the card open (seeding from the vault) and the token route. PURE.
 */
export function writeTokenLines(profileDir: string, token: string): string[] {
  assertSafeRemotePath(profileDir);
  const file = oauthTokenPath(profileDir);
  return [
    `mkdir -p ${shQuote(profileDir)}`,
    "umask 077",
    `printf '%s' ${shQuote(assertOauthToken(token))} > ${shQuote(file)}`,
    `chmod 600 ${shQuote(file)}`,
  ];
}

/** Full host script (host → `docker exec -i … bash -s`) that plants the token in a profile. PURE. */
export function buildWriteTokenScript(containerName: string, profileDir: string, token: string): string {
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${DELIM}'`,
    "set -e",
    ...writeTokenLines(profileDir, token),
    DELIM,
  ].join("\n");
}

/** Full host script that REMOVES the token from a profile. Idempotent. PURE. */
export function buildRemoveTokenScript(containerName: string, profileDir: string): string {
  assertSafeRemotePath(profileDir);
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${DELIM}'`,
    `rm -f ${shQuote(oauthTokenPath(profileDir))}`,
    DELIM,
  ].join("\n");
}

/** The slug exists on the board (or is "default"). THROWS "not found" (→ 404) otherwise. */
async function requireSlug(slug: string): Promise<string> {
  if (slug === DEFAULT_ACCOUNT_SLUG) return slug;
  const v = assertAccountSlug(slug);
  if (!(await listAccounts()).some((a) => a.slug === v)) throw new Error(`account '${v}' not found`);
  return v;
}

/**
 * The account's token from the vault, or undefined when it was never configured (or the stored
 * value no longer looks like a token). NEVER logged, never returned to the UI.
 */
export async function resolveAccountToken(slug: string | undefined): Promise<string | undefined> {
  const value = await secretGet(accountTokenKey(slug ?? DEFAULT_ACCOUNT_SLUG));
  return value && TOKEN_RE.test(value) ? value : undefined;
}

/**
 * `hasToken` per account plus the default one, derived from the vault key listing — the values are
 * never read here, so this can safely feed the UI.
 */
export async function accountsTokenStatus(): Promise<{ bySlug: Record<string, boolean>; defaultHasToken: boolean }> {
  const keys = new Set((await secretList()).map((s) => s.key));
  const bySlug: Record<string, boolean> = {};
  for (const a of await listAccounts()) bySlug[a.slug] = keys.has(accountTokenKey(a.slug));
  return { bySlug, defaultHasToken: keys.has(accountTokenKey(DEFAULT_ACCOUNT_SLUG)) };
}

export interface TokenWriteResult {
  /** true = the file inside the runner was written/removed too, not just the vault. */
  runnerUpdated: boolean;
}

/**
 * Runs a token script against THE runner. Best-effort BY DESIGN: the vault is the source of truth
 * and every card open re-seeds the profile from it, so a runner that is down (or not provisioned
 * yet) must not stop the user from saving a token. The original panel looped over one runner per
 * server here; vibehub has exactly one.
 */
async function applyOnRunner(script: string, action: string, slug: string): Promise<boolean> {
  try {
    await hostExecutor().runScript(script, { timeoutMs: 60_000 });
    return true;
  } catch (err) {
    const detail = err instanceof HostExecError ? err.message : String(err);
    logger.warn({ action, account: slug, detail }, "runner not updated with the account token (kept in the vault)");
    return false;
  }
}

/**
 * Stores the account's token: vault first (that is what survives a runner rebuild), then the file
 * in the runner profile so sessions already running pick it up on their next start.
 */
export async function setAccountToken(slug: string, token: string, by?: string): Promise<TokenWriteResult> {
  const v = await requireSlug(slug);
  const value = assertOauthToken(token);
  await secretSet(accountTokenKey(v), value);
  const runnerUpdated = await applyOnRunner(
    buildWriteTokenScript(config.runner.container, profileDirFor(v), value),
    "account.token.set",
    v,
  );
  logger.info({ audit: true, action: "account.token.set", account: v, runnerUpdated, by }, "account token stored");
  return { runnerUpdated };
}

/** Removes the account's token: vault plus the file in the runner profile. Idempotent. */
export async function removeAccountToken(slug: string, by?: string): Promise<TokenWriteResult> {
  const v = await requireSlug(slug);
  await secretDelete(accountTokenKey(v));
  const runnerUpdated = await applyOnRunner(
    buildRemoveTokenScript(config.runner.container, profileDirFor(v)),
    "account.token.remove",
    v,
  );
  logger.info({ audit: true, action: "account.token.remove", account: v, runnerUpdated, by }, "account token removed");
  return { runnerUpdated };
}
