import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config, dataPath } from "../config/env.js";
import { sessionUser, type PublicUser } from "./users.js";

/**
 * SESSIONS — a signed cookie holding "<userId>.<issuedAt>.<hmac>". Stateless on purpose: the server
 * keeps no session table, so a restart does not log everybody out and there is nothing to prune.
 *
 * The signing key lives in <dataDir>/session.key unless VIBEHUB_SESSION_SECRET is set. Rotating it
 * invalidates every session, which is exactly what you want after a leak.
 */

export const SESSION_COOKIE = "vibehub_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let keyPromise: Promise<Buffer> | null = null;

async function signingKey(): Promise<Buffer> {
  if (!keyPromise) keyPromise = loadOrCreateKey();
  return await keyPromise;
}

async function loadOrCreateKey(): Promise<Buffer> {
  if (config.sessionSecret) return Buffer.from(config.sessionSecret, "utf8");
  const file = dataPath("session.key");
  try {
    const stored = (await readFile(file, "utf8")).trim();
    if (stored) return Buffer.from(stored, "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return key;
}

/** Builds the signed token for a user. PURE apart from reading the key. */
export async function issueToken(userId: string, now: number = Date.now()): Promise<string> {
  const payload = `${userId}.${now}`;
  const mac = createHmac("sha256", await signingKey()).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

/**
 * Constant-time comparison of two secrets that tolerates different lengths (and absent values: a
 * missing token never matches, not even another missing one). The session HMAC and the runner's
 * service token (status hook, /mcp) are all checked through here.
 */
export function tokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** What a well-formed, correctly signed and unexpired token claims. */
interface TokenClaim { userId: string; issuedAt: number }

async function readToken(token: string, now: number): Promise<TokenClaim | null> {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [userId, issuedAt, mac] = parts as [string, string, string];
  if (!userId || !/^\d+$/.test(issuedAt)) return null;
  // Exact lowercase hex, as issueToken writes it: the mac is compared as the STRING it is, so an
  // uppercase or padded variant of a valid mac is a different token, not the same one decoded.
  if (!/^[0-9a-f]{64}$/.test(mac)) return null;
  const expected = createHmac("sha256", await signingKey()).update(`${userId}.${issuedAt}`).digest("hex");
  if (!tokenMatches(mac, expected)) return null;
  if (now - Number(issuedAt) > SESSION_TTL_MS) return null;
  return { userId, issuedAt: Number(issuedAt) };
}

/**
 * Returns the userId when the token is well-formed, correctly signed and unexpired; else null.
 * The SIGNATURE only: it says nothing about whether that account still exists or still honours
 * this cookie. To authenticate a request use {@link verifySessionUser} (or the helpers built on it).
 */
export async function verifyToken(token: string, now: number = Date.now()): Promise<string | null> {
  return (await readToken(token, now))?.userId ?? null;
}

/**
 * THE check for "is this cookie a session": signed, unexpired, AND the account behind it still
 * exists and has not revoked it (a removed member, a password change). Without the second half a
 * removed person kept every route that only asked for "a session" for up to {@link SESSION_TTL_MS}.
 * Exported for the paths that hold a raw cookie instead of a Fastify request (websocket upgrades).
 */
export async function verifySessionUser(token: string, now: number = Date.now()): Promise<PublicUser | null> {
  const claim = await readToken(token, now);
  return claim ? await sessionUser(claim.userId, claim.issuedAt) : null;
}

export interface CookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

/** Cookie flags. `secure` is on unless the operator opts out for a plain-http LAN install. */
export function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: !config.insecureCookies,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export async function setSessionCookie(reply: FastifyReply, userId: string): Promise<void> {
  reply.setCookie(SESSION_COOKIE, await issueToken(userId), cookieOptions());
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * KNOWN DEVICES — "this browser has signed in as <username> before", for the sign-in throttle
 * (routes/auth.ts) and nothing else: it authenticates nobody. Its tries are counted apart from the
 * address's, so somebody sharing the owner's address (every client does, behind an undeclared
 * gateway or Docker Desktop's port forwarding) cannot lock the owner's browser out by failing on
 * purpose. Minting one takes a successful sign-in, so to a guesser it is worth nothing.
 *
 * "<random id>.<hmac>": the id keeps two browsers of one person on separate counters, and the mac
 * (session key, a domain prefix no session payload can take) binds it to the username.
 *
 * ONE COOKIE PER USERNAME ({@link deviceCookieName}): with a single cookie per browser, signing in
 * there as a second account (a test user, a colleague's) overwrote the first one's token, and that
 * browser was back on the shared address's count for the account it actually depends on.
 */
const DEVICE_COOKIE_PREFIX = "vibehub_device_";
const DEVICE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

async function deviceMac(id: string, username: string): Promise<string> {
  return createHmac("sha256", await signingKey()).update(`device:${id}:${username}`).digest("hex");
}

/**
 * The known-device cookie of `username` (already normalized). A digest, not the name itself: a
 * username may hold characters a cookie name cannot, and the jar need not list who signed in there.
 */
export function deviceCookieName(username: string): string {
  return `${DEVICE_COOKIE_PREFIX}${createHash("sha256").update(username).digest("hex").slice(0, 16)}`;
}

/** A fresh known-device token for `username` (already normalized, as stored). */
export async function issueDeviceToken(username: string): Promise<string> {
  const id = randomBytes(16).toString("hex");
  return `${id}.${await deviceMac(id, username)}`;
}

/** The device id when `token` was issued for `username` by this install; null otherwise. */
export async function knownDeviceId(token: string | undefined, username: string): Promise<string | null> {
  const [id, mac, ...rest] = String(token ?? "").split(".");
  if (!id || !mac || rest.length > 0 || !/^[0-9a-f]{32}$/.test(id)) return null;
  return tokenMatches(mac, await deviceMac(id, username)) ? id : null;
}

/**
 * Sends the known-device cookie. Scoped to the sign-in path: no other request has a use for it, so
 * no other request carries it.
 */
export async function setDeviceCookie(reply: FastifyReply, username: string): Promise<void> {
  reply.setCookie(deviceCookieName(username), await issueDeviceToken(username), {
    ...cookieOptions(),
    path: "/api/auth/login",
    maxAge: Math.floor(DEVICE_TTL_MS / 1000),
  });
}

/**
 * The session token inside a raw Cookie header — the upgrade path has no Fastify to parse it (the
 * preview tunnel's handshake, the open-socket registry in sessionSockets.ts).
 */
export function sessionTokenFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

/**
 * The signed-in user (public shape), or null when there is no session — or when the session is
 * signed correctly but the account behind it is gone (deleted user, restored backup) or revoked it.
 */
export async function currentUser(req: FastifyRequest): Promise<PublicUser | null> {
  const raw = req.cookies?.[SESSION_COOKIE];
  return raw ? await verifySessionUser(raw) : null;
}

/** The id of {@link requestUser}, or null — same rules, for the handlers that only need who. */
export async function sessionUserId(req: FastifyRequest): Promise<string | null> {
  return (await requestUser(req))?.id ?? null;
}

/**
 * Fastify preHandler: 401s anything without a valid session. Applied to every /api route except the
 * auth and setup endpoints and the runner's status callback (which carries its own service token).
 */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await currentUser(req);
  if (!user) {
    await reply.code(401).send({ error: "not authenticated" });
    return;
  }
  stampSessionUser(req, user);
}

/**
 * Fastify preHandler for everything that belongs to the INSTALL rather than to a piece of work:
 * the Claude accounts, the vault, the MCP servers, the brain, the settings, the runner, the user
 * list. 401 without a session, 403 for a member.
 *
 * The rule of thumb for which gate a route gets: if the answer to "whose is this?" is "the
 * install's", it is `requireOwner`; if it is "this card's", it is `requireCardAccess`.
 */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await currentUser(req);
  if (!user) {
    await reply.code(401).send({ error: "not authenticated" });
    return;
  }
  if (user.role !== "owner") {
    await reply.code(403).send({ error: "owner only" });
    return;
  }
  stampSessionUser(req, user);
}

/** What a gate leaves on the request for the handler: who the caller is. */
type StampedRequest = FastifyRequest & { userId?: string; sessionUser?: PublicUser };

/**
 * Records, on the request, the user a gate just resolved (`requireSession`, `requireOwner`, the card
 * gates in access.ts). `userId` is what the websockets already read; `sessionUser` is for
 * {@link requestUser}.
 */
export function stampSessionUser(req: FastifyRequest, user: PublicUser): void {
  const r = req as StampedRequest;
  r.userId = user.id;
  r.sessionUser = user;
}

/**
 * The caller, for a HANDLER: the user its gate already resolved, or — on a route without one —
 * {@link currentUser}. Asking `currentUser` again behind a gate verified the HMAC and reloaded the
 * user store a second time per request, for an answer the gate had just given.
 */
export async function requestUser(req: FastifyRequest): Promise<PublicUser | null> {
  return (req as StampedRequest).sessionUser ?? (await currentUser(req));
}

export function resetSessionKeyForTesting(): void {
  keyPromise = null;
}
