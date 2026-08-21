import { assertAccountSlug } from "../board/registry.js";

/**
 * CLAUDE CODE PROFILES inside the runner. The DEFAULT account is `/root/.claude` (a session for it
 * simply carries no CLAUDE_CONFIG_DIR); every named account gets `/root/.claude-profiles/<slug>`,
 * with CLAUDE_CONFIG_DIR pointing at it, so credentials and history never bleed between accounts.
 *
 * Everything here is a DERIVATION from a validated slug — never a path that came in raw from a
 * request. That is why the module owns no I/O: it is the one place that turns "which account" into
 * "which directory", and it is trivially testable.
 */

/** Root of the per-ACCOUNT Claude profiles in the runner (the default account lives outside it). */
export const CLAUDE_PROFILES_DIR = "/root/.claude-profiles";

/** Profile directory of the runner's DEFAULT Claude account. */
export const DEFAULT_CLAUDE_DIR = "/root/.claude";

/**
 * The slug the token routes accept to address the DEFAULT account. The board holds no account
 * record called "default" (the default account is the ABSENCE of a slug), so this string exists
 * only at the edge — routes and vault keys — and is mapped to a path right here.
 */
export const DEFAULT_ACCOUNT_SLUG = "default";

/** File inside a profile holding the long-lived token produced by `claude setup-token`. */
export const OAUTH_TOKEN_FILE = ".oauth-token";

/** CLAUDE_CONFIG_DIR of a named account's profile. The slug is re-validated here. PURE. */
export function accountConfigDir(slug: string): string {
  return `${CLAUDE_PROFILES_DIR}/${assertAccountSlug(slug)}`;
}

/**
 * Directory of the EFFECTIVE profile: a missing slug or "default" → `/root/.claude`, otherwise the
 * account's own. This is the ONLY place where "default" becomes a path. PURE.
 */
export function profileDirFor(slug: string | undefined): string {
  return !slug || slug === DEFAULT_ACCOUNT_SLUG ? DEFAULT_CLAUDE_DIR : accountConfigDir(slug);
}

/** Path of a profile's long-lived token file. PURE. */
export function oauthTokenPath(profileDir: string): string {
  return `${profileDir}/${OAUTH_TOKEN_FILE}`;
}
