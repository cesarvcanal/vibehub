import { hostExecutor, shQuote, assertSafeRemotePath, containerScriptCommand } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { listAccounts } from "../board/registry.js";
import { DEFAULT_ACCOUNT_SLUG, DEFAULT_CLAUDE_DIR, profileDirFor, CREDENTIALS_FILE } from "./profiles.js";
import { resolvedClaudeCommand } from "./claudeCli.js";
import { resolveAccountToken } from "./token.js";
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
 * reported as `no_credentials` (the UI then says which command fixes it) — UNLESS the fallback
 * below can read it.
 *
 * THE FALLBACK: THE PLAN'S OWN HEADERS. Every inference call answered for a Claude plan carries
 * `anthropic-ratelimit-unified-<window>-utilization` / `-reset` — the same numbers Claude Code turns
 * into its "You've used 91% of your session limit". The setup-token DOES carry `user:inference`, so
 * when the profile has no usable interactive login (never had one, or its refresh token expired and
 * Claude Code blanked the access token) we spend ONE minimal call — Haiku, one output token — and
 * read the windows off the headers. Cheaper on the plan than it sounds (a few dozen tokens), and
 * cached for `PROBE_FRESH_MS` so a board left open is a handful of calls an hour, not one a minute.
 *
 * AN EXPIRED LOGIN IS RENEWED BY CLAUDE CODE, NOT BY US. The access token lives 8h and only the
 * CLI renews it, when the account is used; an account left idle held a dead token and the meter
 * read nothing until somebody sent a message (the vault token, the fallback below, can be revoked
 * too — in production it was). So an expired token is handed to `claude auth status` inside the
 * runner first: the CLI renews and rewrites its own `.credentials.json`, and we read it again. We
 * never touch the refresh token: using it from here would rotate it under the CLI. Two reads of one
 * account at once share a single renewal, and a login the CLI could not renew (refresh token
 * revoked) is not retried until the file holds a different one.
 *
 * WHERE THE TOKEN LIVES, AND FOR HOW LONG. It is read out of the runner with a `docker exec … cat`
 * (read-only but for the CLI's own renewal above; every path validated and shell-quoted, nothing
 * user-supplied reaching the shell), held in a local variable for exactly one HTTPS call, and
 * dropped. It is NEVER logged, NEVER returned by the API, NEVER written to disk on the vibehub side. The call is made from the
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

/** Claude Code's own credential file inside a profile directory (owned by profiles.ts). */
export { CREDENTIALS_FILE };

/** How long a successful reading stays fresh. Matches the front-end's 60s poll. */
export const FRESH_MS = 60_000;

/** First back-off after a rate limit, doubling per consecutive strike. */
export const BACKOFF_BASE_MS = 120_000;

/** Ceiling for the back-off — beyond this, waiting longer buys nothing. */
export const BACKOFF_MAX_MS = 1_800_000;

/** Pause between accounts in `allAccountsUsage`, so a listing is a queue and not a fan-out. */
export const SERIAL_DELAY_MS = 250;

/** Inference endpoint the fallback probes for the plan's rate-limit headers. */
export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Cheapest model on every plan: the probe only wants the headers. */
export const PROBE_MODEL = "claude-haiku-4-5";

/** A probe spends (a little) plan, so its reading stays fresh longer than the free endpoint's. */
export const PROBE_FRESH_MS = 300_000;

/** A single HTTPS call gets this long; the UI is polling and would rather have "unreachable". */
const REQUEST_TIMEOUT_MS = 10_000;

/** A token expiring within one call's time is renewed too: it would die on the way. */
const EXPIRY_MARGIN_MS = REQUEST_TIMEOUT_MS;

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

/** The reading in progress per account, so two callers at once share one renewal and one call. */
const inflight = new Map<string, Promise<{ result: AccountUsage; called: boolean }>>();

/**
 * Per profile, the expiry of a login the CLI could NOT renew (refresh token revoked). Until the file
 * holds a different login, renewing again would only spend a CLI exec per poll on the same answer.
 */
const unrenewable = new Map<string, number>();

/** Drops every cached reading. TEST SEAM, and what a token change would call. */
export function resetUsageCache(): void {
  cache.clear();
  inflight.clear();
  unrenewable.clear();
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
 * READ-ONLY script that prints a profile's credential file. `cat` and nothing else: the only write
 * this module ever causes in the runner is Claude Code renewing its own login
 * (`buildRenewLoginScript`). Both paths are validated and quoted, and a missing file prints nothing
 * instead of failing the exec (a profile with no login is normal).
 * PURE.
 */
export function buildReadCredentialsScript(containerName: string, profileDir: string): string {
  assertSafeRemotePath(profileDir);
  const file = `${profileDir}/${CREDENTIALS_FILE}`;
  assertSafeRemotePath(file);
  const inner = `cat "$1" 2>/dev/null || true`;
  return `docker exec ${shQuote(containerName)} sh -c ${shQuote(inner)} _ ${shQuote(file)}`;
}

/** The interactive login as Claude Code keeps it: the access token and when it stops working. */
interface InteractiveLogin {
  accessToken: string;
  /** Epoch ms the access token expires, or null when the file does not say. */
  expiresAt: number | null;
}

/**
 * The Claude Code login inside a `.credentials.json`, or undefined.
 *
 * Undefined covers three real states that all mean the same thing to the operator: no file, a file
 * that is not JSON, and — the common one — a file holding only `mcpOAuth` because the account was
 * set up with a long-lived token and never went through `/login`. PURE.
 */
export function parseLogin(stdout: string): InteractiveLogin | undefined {
  const raw = String(stdout ?? "").trim();
  if (!raw) return undefined;
  try {
    const json = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const oauth = json?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || !token.trim()) return undefined;
    const expiresAt = oauth?.expiresAt;
    return {
      accessToken: token.trim(),
      expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
    };
  } catch {
    return undefined;
  }
}

/** Heredoc delimiter of the renewal script; never a line of the script itself. */
const RENEW_DELIM = "VIBEHUB_RENEW_LOGIN";

/** Node deadline of the renewal exec; the in-container KILL fires CONTAINER_DEADLINE_MARGIN_MS sooner. */
const RENEW_TIMEOUT_MS = 30_000;

/**
 * Script that has Claude Code renew a profile's login and then prints the credential file, in ONE
 * exec: `claude auth status` refreshes an expired access token and writes the new pair back to
 * `.credentials.json` itself — no inference, under a second. Renewing it from here instead (the
 * refresh token over HTTP) would ROTATE the refresh token and leave the CLI holding a dead one,
 * which is the one way to log a card out from a usage widget. The CLI's own output is discarded so
 * stdout is the file and nothing else; a CLI that hangs is KILLed inside the runner, not orphaned.
 * The default profile runs with no CLAUDE_CONFIG_DIR, exactly as its sessions do. PURE.
 */
export function buildRenewLoginScript(containerName: string, profileDir: string): string {
  assertSafeRemotePath(profileDir);
  const file = `${profileDir}/${CREDENTIALS_FILE}`;
  assertSafeRemotePath(file);
  return [
    `${containerScriptCommand(containerName, RENEW_TIMEOUT_MS)} <<'${RENEW_DELIM}'`,
    ...(profileDir === DEFAULT_CLAUDE_DIR ? [] : [`export CLAUDE_CONFIG_DIR=${shQuote(profileDir)}`]),
    `{ ${resolvedClaudeCommand("auth status --json")}; } >/dev/null 2>&1`,
    `cat ${shQuote(file)} 2>/dev/null || true`,
    RENEW_DELIM,
  ].join("\n");
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

/**
 * Header claim → the window it fills. `5h`/`7d` are what the API sends today; the strongest-model
 * window is matched under both spellings its claim name has had.
 */
const HEADER_WINDOWS: readonly (readonly [claim: string, field: "fiveHour" | "sevenDay" | "sevenDayOpus"])[] = [
  ["5h", "fiveHour"],
  ["7d", "sevenDay"],
  ["7d_opus", "sevenDayOpus"],
  ["7d-opus", "sevenDayOpus"],
];

/**
 * The windows out of the `anthropic-ratelimit-unified-*` headers of an inference answer, or
 * undefined when there are none. Utilization comes as a FRACTION (0.07) and the reset as epoch
 * SECONDS; both are converted to the units of the usage endpoint (0..100, ISO). PURE.
 */
export function parseRateLimitHeaders(
  headers: { get(name: string): string | null },
): Pick<AccountUsage, "fiveHour" | "sevenDay" | "sevenDayOpus"> | undefined {
  const out: Pick<AccountUsage, "fiveHour" | "sevenDay" | "sevenDayOpus"> = {};
  for (const [claim, field] of HEADER_WINDOWS) {
    if (out[field]) continue;
    const raw = headers.get(`anthropic-ratelimit-unified-${claim}-utilization`);
    const fraction = raw === null || raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(fraction)) continue;
    const resetRaw = Number(headers.get(`anthropic-ratelimit-unified-${claim}-reset`));
    const resetsAt = Number.isFinite(resetRaw) && resetRaw > 0 ? new Date(resetRaw * 1000).toISOString() : null;
    // Two decimals: 0.07 * 100 is 7.000000000000001 in floating point.
    const pct = Math.round(fraction * 10_000) / 100;
    out[field] = { utilization: Math.min(100, Math.max(0, pct)), resetsAt };
  }
  return out.fiveHour || out.sevenDay || out.sevenDayOpus ? out : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a script that prints a profile's credential file and parses the login out of it. Returns no
 * login when there is none AND when the runner cannot be reached — the caller separates those two
 * by `runnerDown`.
 */
async function readLogin(script: string, timeoutMs: number): Promise<{ login?: InteractiveLogin; runnerDown: boolean }> {
  try {
    const { stdout } = await hostExecutor().runScript(script, { timeoutMs });
    return { login: parseLogin(stdout), runnerDown: false };
  } catch {
    // Deliberately swallowed: the detail could only ever be about docker, and a usage widget must
    // not be the thing that fails a page. The UI shows "unreachable".
    return { runnerDown: true };
  }
}

/**
 * The profile's access token, renewed by Claude Code first when it has expired. Only the CLI
 * renews it, and only when the account is used — so an account idle for its 8h lifetime held a
 * dead token, the endpoint refused it, and the meter said "sem leitura" until somebody sent a
 * message. A renewal that does not produce a live token keeps the expired one (the endpoint then
 * says what is wrong) and is not tried again for that same login.
 */
async function readFreshAccessToken(profileDir: string, now: number): Promise<{ token?: string; runnerDown: boolean }> {
  const { login, runnerDown } = await readLogin(buildReadCredentialsScript(config.runner.container, profileDir), 15_000);
  const live = (l: InteractiveLogin) => l.expiresAt === null || l.expiresAt > now + EXPIRY_MARGIN_MS;
  if (!login || live(login) || unrenewable.get(profileDir) === login.expiresAt) {
    return { token: login?.accessToken, runnerDown };
  }
  const renewal = await readLogin(buildRenewLoginScript(config.runner.container, profileDir), RENEW_TIMEOUT_MS);
  if (renewal.runnerDown) return { runnerDown: true };
  if (renewal.login && live(renewal.login)) {
    unrenewable.delete(profileDir);
    return { token: renewal.login.accessToken, runnerDown: false };
  }
  logger.warn({ action: "account.usage", profileDir }, "login renewal failed");
  unrenewable.set(profileDir, login.expiresAt!);
  return { token: login.accessToken, runnerDown: false };
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
 * The fallback: one minimal inference call with the long-lived token, read for its headers. A 429
 * still counts when it carries the headers — that is exactly "this plan is out", at 100%. The token
 * is a parameter and dies with the frame, like the endpoint's.
 */
async function probeViaInference(token: string, at: number): Promise<AccountUsage> {
  let res: Response;
  try {
    res = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        // An OAuth plan token is only served as Claude Code; this is the line Claude Code sends.
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return failed("unreachable", at);
  }
  const windows = res.headers ? parseRateLimitHeaders(res.headers) : undefined;
  // The body is not wanted either way; drain it so the socket goes back to the pool.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (windows) return { available: true, ...windows, fetchedAt: at };
  return failed(res.ok ? "unreachable" : classifyFailure(res.status, body), at);
}

/**
 * Usage of ONE account, cache first; a caller arriving while a read is under way waits for it.
 *
 * Returns `{ result, called }` so the serial walk in `allAccountsUsage` only pauses when a real
 * HTTPS call happened — a listing served entirely from cache is instant.
 */
function usageFor(slug: string | undefined): Promise<{ result: AccountUsage; called: boolean }> {
  const key = usageKey(slug);
  const pending = inflight.get(key);
  if (pending) return pending;
  const read = readUsage(slug).finally(() => inflight.delete(key));
  inflight.set(key, read);
  return read;
}

async function readUsage(slug: string | undefined): Promise<{ result: AccountUsage; called: boolean }> {
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

  const { token, runnerDown } = await readFreshAccessToken(profileDirFor(slug), now);
  let result: AccountUsage | undefined = token ? await callUsageEndpoint(token, now) : undefined;
  let freshMs = FRESH_MS;

  // No usable interactive login — none at all, or one the endpoint refuses — and the account has a
  // long-lived token: read the plan off an inference call's headers instead of giving up.
  if (!runnerDown && (!result || result.error === "unauthorized")) {
    const longLived = await resolveAccountToken(key).catch(() => undefined);
    if (longLived) {
      result = await probeViaInference(longLived, now);
      freshMs = PROBE_FRESH_MS;
    }
  }

  if (!result) {
    result = failed(runnerDown ? "unreachable" : "no_credentials", now);
    cache.set(key, { ...entry, last: result, freshUntil: now + FRESH_MS, strikes: 0, blockedUntil: 0 });
    return { result, called: false };
  }

  if (result.error === "rate_limited") {
    const strikes = entry.strikes + 1;
    const blockedUntil = now + backoffMs(strikes);
    logger.warn({ action: "account.usage", account: key, strikes, blockedUntil }, "usage endpoint rate-limited");
    // Throttled with nothing to show — every deploy empties this cache, so the first poll after one
    // used to paint "sem leitura" for the whole back-off. The inference headers are not throttled
    // with the endpoint. The login's own token comes first: it carries `user:inference` and is the
    // one Claude Code keeps refreshed, while a vault token can sit there revoked.
    if (!entry.good && token) {
      let probed = await probeViaInference(token, now);
      if (!probed.available) {
        const longLived = await resolveAccountToken(key).catch(() => undefined);
        if (longLived) probed = await probeViaInference(longLived, now);
      }
      if (probed.available) {
        cache.set(key, { good: probed, last: probed, freshUntil: now + PROBE_FRESH_MS, strikes, blockedUntil });
        return { result: probed, called: true };
      }
    }
    const served = entry.good ? stale(entry.good, "rate_limited", blockedUntil) : { ...result, retryAt: blockedUntil };
    cache.set(key, { ...entry, last: served, freshUntil: 0, strikes, blockedUntil });
    return { result: served, called: true };
  }

  cache.set(key, {
    good: result.available ? result : entry.good,
    last: result,
    freshUntil: now + freshMs,
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
