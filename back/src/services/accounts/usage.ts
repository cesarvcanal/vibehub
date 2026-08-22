import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { listAccounts } from "../board/registry.js";
import { DEFAULT_ACCOUNT_SLUG, profileDirFor } from "./profiles.js";
import { logger } from "../../utils/logger.js";

/**
 * PLAN USAGE PER CLAUDE ACCOUNT — "how much of this account's plan is gone, and when does it come
 * back", so the operator picks the account BEFORE opening a card instead of discovering the limit
 * halfway through a turn.
 *
 * WHERE THE NUMBER COMES FROM. `GET /api/oauth/usage` on api.anthropic.com, with the OAuth beta
 * header, answers the three windows Claude Code itself is metered on: the 5-hour session, the
 * 7-day window, and the 7-day window of the strongest model. The ONLY credential it accepts is the
 * Claude Code access token — `claudeAiOauth.accessToken` inside a profile's `.credentials.json`,
 * which Claude Code writes on `/login` and refreshes on its own. The long-lived `setup-token` in
 * our vault does NOT carry the `user:profile` scope and is rejected, which is why this module never
 * touches it: an account logged in ONLY by setup-token has no `claudeAiOauth` block at all and is
 * reported as `no_credentials` (the UI then says which command fixes it).
 *
 * WHERE THE TOKEN LIVES, AND FOR HOW LONG. It is read out of the runner with a READ-ONLY
 * `docker exec … cat` (every path validated and shell-quoted, nothing user-supplied reaching the
 * shell), held in a local variable for exactly one HTTPS call, and dropped. It is NEVER logged,
 * NEVER returned by the API, NEVER written to disk on the vibehub side. The call is made from the
 * vibehub process rather than by a `curl` inside the container so that HTTP status handling (401 vs
 * 429 vs unreachable) is real code with real tests instead of exit-code archaeology, and so the
 * runner image needs no extra tool.
 *
 * WHY THE CACHE IS AGGRESSIVE. The endpoint rate-limits hard and by IP: during development it
 * answered `429 {"error":{"type":"rate_limit_error"}}` to every probe for ten minutes, including
 * one with an EMPTY bearer. A 429 therefore says nothing about the account — it is a property of
 * the caller. So: 60s of freshness on success, exponential back-off from 2min to 30min on a 429,
 * the last good value served with `stale: true` while backed off, and accounts polled in SERIES
 * with a pause between them. A board with six accounts must never turn into six simultaneous calls.
 */

/** The usage endpoint. Not configurable: it is the Claude plan, not an install setting. */
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Beta header the endpoint requires alongside the OAuth bearer. */
export const OAUTH_BETA = "oauth-2025-04-20";

/** Claude Code's own credential file inside a profile directory. */
export const CREDENTIALS_FILE = ".credentials.json";

/** How long a successful reading stays fresh. Matches the front-end's 60s poll. */
export const FRESH_MS = 60_000;

/** First back-off after a rate limit, doubling per consecutive strike. */
export const BACKOFF_BASE_MS = 120_000;

/** Ceiling for the back-off — beyond this, waiting longer buys nothing. */
export const BACKOFF_MAX_MS = 1_800_000;

/** Pause between accounts in `allAccountsUsage`, so a listing is a queue and not a fan-out. */
export const SERIAL_DELAY_MS = 250;

/** A single HTTPS call gets this long; the UI is polling and would rather have "unreachable". */
const REQUEST_TIMEOUT_MS = 10_000;

/** One metered window as the UI needs it: how much is gone, and when it comes back. */
export interface UsageWindow {
  /** 0..100. Clamped — a bad payload must not paint a bar off the end of the row. */
  utilization: number;
  /** ISO instant the window resets, or null when the endpoint did not say. */
  resetsAt: string | null;
}

/**
 * Why there is no number. Each one maps to a DIFFERENT sentence in the UI, which is the entire
 * point of splitting them:
 *  - `no_credentials` — the profile never had an interactive `/login` (a setup-token leaves no
 *    `claudeAiOauth` block). Fixable by the operator, and the UI says how.
 *  - `rate_limited`   — the usage endpoint is throttling US. Says nothing about the plan.
 *  - `unauthorized`   — there IS a token, but it cannot read usage (wrong scope, or expired).
 *  - `unreachable`    — runner down, network down, or the endpoint answered something else.
 */
export type UsageError = "no_credentials" | "rate_limited" | "unauthorized" | "unreachable";

export interface AccountUsage {
  /** true = the three windows are present. The UI branches on exactly this. */
  available: boolean;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  /** When these numbers were actually read from the endpoint (not when they were served). */
  fetchedAt: number;
  /** true = served from the last good reading while backed off. `fetchedAt` says how old it is. */
  stale?: boolean;
  /** Epoch ms the back-off lifts, so the UI can say "trying again in N min". */
  retryAt?: number;
  error?: UsageError;
}

interface CacheEntry {
  /** The last reading WITH numbers, kept across failures so a back-off can serve it stale. */
  good?: AccountUsage;
  /** The last reading, whatever it was — what a fresh cache hit returns. */
  last?: AccountUsage;
  /** `last` is served verbatim until this instant. */
  freshUntil: number;
  /** Consecutive rate limits; drives the back-off. Reset by any non-429 answer. */
  strikes: number;
  /** No call is even attempted before this instant. */
  blockedUntil: number;
}

const cache = new Map<string, CacheEntry>();

/** Drops every cached reading. TEST SEAM, and what a token change would call. */
export function resetUsageCache(): void {
  cache.clear();
}

/** Cache key of an account: a missing slug is the default profile. PURE. */
export function usageKey(slug: string | undefined): string {
  return slug && slug !== DEFAULT_ACCOUNT_SLUG ? slug : DEFAULT_ACCOUNT_SLUG;
}

/**
 * Back-off after `strikes` consecutive rate limits: 2min, 4min, 8min, 16min, then 30min forever.
 * `strikes` is 1-based (the first limit already waits `BACKOFF_BASE_MS`). PURE.
 */
export function backoffMs(strikes: number): number {
  const n = Math.max(1, Math.floor(strikes));
  // 2^30 minutes would overflow into nonsense long before the cap matters; clamp the exponent too.
  const raw = BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20);
  return Math.min(raw, BACKOFF_MAX_MS);
}

/**
 * READ-ONLY script that prints a profile's credential file. `cat` and nothing else: this module
 * must never be able to change a byte inside the runner. Both paths are validated and quoted, and
 * a missing file prints nothing instead of failing the exec (a profile with no login is normal).
 * PURE.
 */
export function buildReadCredentialsScript(containerName: string, profileDir: string): string {
  assertSafeRemotePath(profileDir);
  const file = `${profileDir}/${CREDENTIALS_FILE}`;
  assertSafeRemotePath(file);
  const inner = `cat "$1" 2>/dev/null || true`;
  return `docker exec ${shQuote(containerName)} sh -c ${shQuote(inner)} _ ${shQuote(file)}`;
}

/**
 * The Claude Code access token inside a `.credentials.json`, or undefined.
 *
 * Undefined covers three real states that all mean the same thing to the operator: no file, a file
 * that is not JSON, and — the common one — a file holding only `mcpOAuth` because the account was
 * set up with a long-lived token and never went through `/login`. PURE.
 */
export function parseAccessToken(stdout: string): string | undefined {
  const raw = String(stdout ?? "").trim();
  if (!raw) return undefined;
  try {
    const json = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = json?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** One window out of the payload, clamped to 0..100. Unknown shape → undefined. PURE. */
export function parseWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { utilization?: unknown; resets_at?: unknown };
  const utilization = typeof v.utilization === "number" && Number.isFinite(v.utilization) ? v.utilization : null;
  if (utilization === null) return undefined;
  const resetsAt = typeof v.resets_at === "string" && v.resets_at.trim() ? v.resets_at : null;
  return { utilization: Math.min(100, Math.max(0, utilization)), resetsAt };
}

/**
 * The three windows out of a usage payload. A payload with none of them is not usage — the caller
 * turns that into `unreachable` rather than rendering three empty bars. PURE.
 */
export function parseUsage(body: unknown): Pick<AccountUsage, "fiveHour" | "sevenDay" | "sevenDayOpus"> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const fiveHour = parseWindow(b.five_hour);
  const sevenDay = parseWindow(b.seven_day);
  const sevenDayOpus = parseWindow(b.seven_day_opus);
  if (!fiveHour && !sevenDay && !sevenDayOpus) return undefined;
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(sevenDayOpus ? { sevenDayOpus } : {}),
  };
}

/**
 * Classifies an HTTP answer. 429 (or a `rate_limit_error` body at any status) is US being
 * throttled; 401/403 — and a 400 that complains about scope — mean the token cannot read usage.
 * PURE.
 */
export function classifyFailure(status: number, body: unknown): UsageError {
  const type = (body as { error?: { type?: unknown; message?: unknown } })?.error;
  const kind = typeof type?.type === "string" ? type.type : "";
  const message = typeof type?.message === "string" ? type.message : "";
  if (status === 429 || /rate_limit/i.test(kind)) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 400 && /scope|permission|oauth/i.test(`${kind} ${message}`)) return "unauthorized";
  return "unreachable";
}

/** A failure reading, with no numbers attached. PURE. */
function failed(error: UsageError, at: number, retryAt?: number): AccountUsage {
  return { available: false, error, fetchedAt: at, ...(retryAt ? { retryAt } : {}) };
}

/** The last good reading, re-labelled as stale. PURE. */
function stale(good: AccountUsage, error: UsageError, retryAt?: number): AccountUsage {
  return { ...good, stale: true, error, ...(retryAt ? { retryAt } : {}) };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads a profile's access token out of the runner. Returns undefined when there is none AND when
 * the runner cannot be reached — the caller separates those two by `runnerDown`.
 */
async function readAccessToken(profileDir: string): Promise<{ token?: string; runnerDown: boolean }> {
  try {
    const { stdout } = await hostExecutor().runScript(
      buildReadCredentialsScript(config.runner.container, profileDir),
      { timeoutMs: 15_000 },
    );
    return { token: parseAccessToken(stdout), runnerDown: false };
  } catch {
    // Deliberately swallowed: the detail could only ever be about docker, and a usage widget must
    // not be the thing that fails a page. The UI shows "unreachable".
    return { runnerDown: true };
  }
}

/** One HTTPS call. The token is a parameter and dies with the frame. */
async function callUsageEndpoint(token: string, at: number): Promise<AccountUsage> {
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return failed("unreachable", at);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) return failed(classifyFailure(res.status, body), at);
  // A 200 can still carry an error envelope; classify it the same way.
  if (body && typeof body === "object" && "error" in (body as Record<string, unknown>)) {
    return failed(classifyFailure(res.status, body), at);
  }
  const windows = parseUsage(body);
  if (!windows) return failed("unreachable", at);
  return { available: true, ...windows, fetchedAt: at };
}

/**
 * Usage of ONE account, cache first.
 *
 * Returns `{ result, called }` so the serial walk in `allAccountsUsage` only pauses when a real
 * HTTPS call happened — a listing served entirely from cache is instant.
 */
async function usageFor(slug: string | undefined): Promise<{ result: AccountUsage; called: boolean }> {
  const key = usageKey(slug);
  const now = Date.now();
  const entry = cache.get(key) ?? { freshUntil: 0, strikes: 0, blockedUntil: 0 };

  // Still fresh: hand back exactly what was decided last time, without touching runner or network.
  if (entry.last && now < entry.freshUntil) return { result: entry.last, called: false };

  // Backed off after a rate limit: serve the last good numbers as stale rather than nothing.
  if (now < entry.blockedUntil) {
    const result = entry.good
      ? stale(entry.good, "rate_limited", entry.blockedUntil)
      : failed("rate_limited", now, entry.blockedUntil);
    return { result, called: false };
  }

  const { token, runnerDown } = await readAccessToken(profileDirFor(slug));
  if (!token) {
    const result = failed(runnerDown ? "unreachable" : "no_credentials", now);
    cache.set(key, { ...entry, last: result, freshUntil: now + FRESH_MS, strikes: 0, blockedUntil: 0 });
    return { result, called: false };
  }

  const result = await callUsageEndpoint(token, now);

  if (result.error === "rate_limited") {
    const strikes = entry.strikes + 1;
    const blockedUntil = now + backoffMs(strikes);
    const served = entry.good ? stale(entry.good, "rate_limited", blockedUntil) : { ...result, retryAt: blockedUntil };
    cache.set(key, { ...entry, last: served, freshUntil: 0, strikes, blockedUntil });
    logger.warn({ action: "account.usage", account: key, strikes, blockedUntil }, "usage endpoint rate-limited");
    return { result: served, called: true };
  }

  cache.set(key, {
    good: result.available ? result : entry.good,
    last: result,
    freshUntil: now + FRESH_MS,
    strikes: 0,
    blockedUntil: 0,
  });
  return { result, called: true };
}

/** Usage of one account (a missing slug = the runner's default profile). */
export async function accountUsage(slug: string | undefined): Promise<AccountUsage> {
  return (await usageFor(slug)).result;
}

/**
 * Usage of the default profile plus every registered account, keyed by slug ("default" for the
 * built-in one). Walked in SERIES with a pause after each call that actually went out, because the
 * endpoint throttles by caller and a parallel fan-out is the fastest way to earn a 429.
 */
export async function allAccountsUsage(): Promise<{ bySlug: Record<string, AccountUsage>; fetchedAt: number }> {
  const slugs = [DEFAULT_ACCOUNT_SLUG, ...(await listAccounts()).map((a) => a.slug)];
  const bySlug: Record<string, AccountUsage> = {};
  for (const slug of slugs) {
    const { result, called } = await usageFor(slug);
    bySlug[slug] = result;
    if (called && slug !== slugs[slugs.length - 1]) await sleep(SERIAL_DELAY_MS);
  }
  return { bySlug, fetchedAt: Date.now() };
}
