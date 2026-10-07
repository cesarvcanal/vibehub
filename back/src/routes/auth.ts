import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createUser, verifyCredentials, isFreshInstall, isUsername, changePassword, publicUser, InstallAlreadySetUpError,
  findUser,
} from "../auth/users.js";
import {
  setSessionCookie, clearSessionCookie, requireSession, requestUser, currentUser,
  deviceCookieName, SESSION_COOKIE, knownDeviceId, setDeviceCookie, verifyToken,
} from "../auth/session.js";
import { endRevokedSessionSockets } from "../auth/sessionSockets.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * FAILED sign-in tries per username per {@link ACCOUNT_WINDOW_MS}, counted per address — or per
 * known device (see authRoutes): what a brute force gets.
 */
export const LOGIN_ATTEMPTS_PER_ACCOUNT = 10;
const ACCOUNT_WINDOW_MS = 15 * 60_000;
/**
 * Failed scrypt-costing tries (sign-in + setup) per address per {@link ADDRESS_WINDOW_MS}, any
 * username — enforced only when VIBEHUB_TRUST_PROXY says who the client is (see authRoutes).
 */
export const ATTEMPTS_PER_ADDRESS = 30;
const ADDRESS_WINDOW_MS = 60_000;

/**
 * A fixed-window attempt counter per key, in memory. In memory on purpose: one process serves the
 * install, a restart forgetting the counts costs an attacker a restart they cannot trigger, and a
 * dependency (or a table) would be more machinery than "count tries per minute" needs.
 *
 * Expired windows are swept at most once per window length, so a flood of one-off keys (random
 * usernames) does not grow the map past what a single window can hold.
 */
export class AttemptLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Counts one try for `key`. 0 when it is allowed; otherwise the seconds until it would be. */
  hit(key: string, now: number = Date.now()): number {
    this.sweep(now);
    const window = this.windows.get(key);
    if (!window || now >= window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    if (window.count >= this.limit) return Math.ceil((window.resetAt - now) / 1000);
    window.count += 1;
    return 0;
  }

  /**
   * Gives back ONE try counted by {@link hit} — the try turned out not to be a failure. Counting
   * first and refunding after (rather than counting only once a try has failed) is what keeps a
   * burst of concurrent POSTs from all slipping past the ceiling before any of them is recorded.
   * A window that already expired is left alone: there is nothing left in it to give back.
   */
  refund(key: string, now: number = Date.now()): void {
    const window = this.windows.get(key);
    if (!window || now >= window.resetAt) return;
    window.count -= 1;
    if (window.count <= 0) this.windows.delete(key);
  }

  /** Forgets a key — a successful sign-in clears the typos made before it. */
  clear(key: string): void {
    this.windows.delete(key);
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    if (now < this.nextSweep) return;
    for (const [key, window] of this.windows) if (now >= window.resetAt) this.windows.delete(key);
    this.nextSweep = now + this.windowMs;
  }
}

async function tooManyAttempts(reply: FastifyReply, retryAfterSeconds: number): Promise<FastifyReply> {
  return await reply.code(429).header("retry-after", String(retryAfterSeconds))
    .send({ error: "too many attempts — wait a few minutes and try again" });
}

/**
 * AUTH — sign in, sign out, who am I, and the one-time owner creation that only works while the
 * install has no users at all. There is no sign-up: an install has the accounts its owner creates.
 *
 * The two PUBLIC doors (sign-in, setup) are throttled BEFORE any scrypt runs: each try costs a hash
 * on the libuv threadpool — the same threads every fs call waits on — so an unthrottled loop of
 * POSTs is both a password brute force and a way to stall the whole server. Per address+username
 * stops the brute force; per address caps the cost of rotating usernames. On SIGN-IN only failures
 * are charged: every try is counted up front (so a concurrent burst cannot all pass before one is
 * recorded) and a try that signs in — or that a ceiling refused before any scrypt ran — is refunded.
 * SETUP charges every try to the address ceiling, 409s included: it is a one-shot door, nobody
 * legitimate calls it twice, and what it spends is only the calling client's own budget.
 *
 * The per-account count is keyed on the address, unless the browser carries a KNOWN-DEVICE cookie
 * for that username (session.ts) — left by an earlier successful sign-in — which gets a count of
 * its own. Keyed on the address alone, anyone sharing the owner's address (everyone, behind a
 * gateway VIBEHUB_TRUST_PROXY does not name, or Docker Desktop's port forwarding, which has none to
 * name) could fail ten times every fifteen minutes and keep the owner out for good. Only a browser
 * that never signed in as that user still shares the address's count — and a guesser is one.
 *
 * The per-address ceiling exists only when the operator set VIBEHUB_TRUST_PROXY (a gateway, or `0`
 * for "no gateway: the peer is the client"). Unset, vibehub cannot tell a direct client from a
 * gateway nobody told it about, and behind one every request shares the gateway's address: thirty
 * wrong tries of any name would then turn sign-in off for the WHOLE install, from anywhere. Losing a
 * cap on scrypt cost is the lesser harm — the per-account limit still bounds password guessing.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const perAddress = config.trustProxy === false ? null : new AttemptLimiter(ATTEMPTS_PER_ADDRESS, ADDRESS_WINDOW_MS);
  const perAccount = new AttemptLimiter(LOGIN_ATTEMPTS_PER_ACCOUNT, ACCOUNT_WINDOW_MS);

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
    const { username = "", password = "" } = req.body ?? {};
    const name = String(username).trim().toLowerCase();
    // A name no account can have is refused before it becomes a counter key (or a log line): the
    // counters live for fifteen minutes, and keyed on whatever the body carried, a stream of
    // megabyte-long "usernames" would pin memory until the process falls over. No scrypt runs for
    // it, so there is no cost to cap — and the format of a username is no secret.
    if (!isUsername(name)) {
      logger.warn({ audit: true, action: "auth.login.failed", username: name.slice(0, 64), ip: req.ip }, "failed sign-in");
      return await reply.code(401).send({ error: "invalid username or password" });
    }
    const device = await knownDeviceId(req.cookies?.[deviceCookieName(name)], name);
    const account = device ? `device:${device}|${name}` : `${req.ip}|${name}`;
    // Short-circuit: a try the address ceiling refused is not also charged to the account.
    const addressWait = perAddress?.hit(req.ip) ?? 0;
    const wait = addressWait || perAccount.hit(account);
    if (wait) {
      // Refused by the ACCOUNT ceiling: no scrypt ran, so the address is not charged for it.
      if (!addressWait) perAddress?.refund(req.ip);
      logger.warn({ audit: true, action: "auth.login.throttled", username: name, ip: req.ip }, "sign-in throttled");
      return await tooManyAttempts(reply, wait);
    }
    const user = await verifyCredentials(username, password);
    if (!user) {
      // One message for both failures: which half was wrong is not the caller's business.
      logger.warn({ audit: true, action: "auth.login.failed", username: name }, "failed sign-in");
      return await reply.code(401).send({ error: "invalid username or password" });
    }
    perAccount.clear(account);
    perAddress?.refund(req.ip);
    await setSessionCookie(reply, user.id);
    if (!device) await setDeviceCookie(reply, user.username);
    logger.info({ audit: true, action: "auth.login", user: user.username }, "signed in");
    return await reply.send({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return await reply.send({ ok: true });
  });

  // No `requireSession` here: it answers 401 on its own for a deleted account or a revoked cookie,
  // and this handler is the one place that must ALSO tell the browser to drop that dead cookie —
  // /me is what the app asks on boot.
  app.get("/api/auth/me", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) {
      // Clear a cookie only when NOTHING can ever stand behind it: a forged or expired one, or one
      // whose account is gone — it would be replayed (and refused) on every request until it
      // expires. A cookie that is merely REVOKED (a password change) is left alone: it is refused
      // everywhere anyway, and this answer can be a poll that raced the change of the person's own
      // password — landing after the change's response, its Set-Cookie would erase the fresh cookie
      // the browser just got, and sign out the very person who made the change.
      const token = req.cookies?.[SESSION_COOKIE];
      if (token !== undefined) {
        const userId = await verifyToken(token);
        if (!userId || !(await findUser(userId))) clearSessionCookie(reply);
      }
      return await reply.code(401).send({ error: "not authenticated" });
    }
    return await reply.send({ user });
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/setup/owner", async (req, reply) => {
    const wait = perAddress?.hit(req.ip) ?? 0;
    if (wait) return await tooManyAttempts(reply, wait);
    // The cheap early answer for the common case (an install that was set up long ago) — it spares
    // the scrypt. It is NOT the guard: two racing setups both pass it; `onlyIfEmpty` is the guard.
    if (!(await isFreshInstall())) {
      return await reply.code(409).send({ error: new InstallAlreadySetUpError().message });
    }
    const { username = "", password = "" } = req.body ?? {};
    try {
      const user = await createUser(username, password, "owner", { onlyIfEmpty: true });
      await setSessionCookie(reply, user.id);
      logger.info({ audit: true, action: "setup.owner", user: user.username }, "owner account created");
      return await reply.send({ user: publicUser(user) });
    } catch (err) {
      const code = err instanceof InstallAlreadySetUpError ? 409 : 400;
      return await reply.code(code).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { password?: string } }>("/api/auth/password", { preHandler: requireSession }, async (req, reply) => {
    const userId = (await requestUser(req))?.id;
    if (!userId) return await reply.code(401).send({ error: "not authenticated" });
    try {
      await changePassword(userId, req.body?.password ?? "");
      // The change revoked every session signed before it — this one included. Hand the person who
      // made it a fresh cookie, so it is the OTHER sessions (a stolen cookie) that end, not theirs.
      await setSessionCookie(reply, userId);
      // And end what the old cookies already have open (a terminal, a tunnel): a revocation that
      // only stopped NEW requests would leave a stolen session its shell. This person's own tabs
      // reconnect with the cookie above.
      await endRevokedSessionSockets(userId);
      return await reply.send({ ok: true });
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });
}
