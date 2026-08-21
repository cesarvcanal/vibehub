import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config, dataPath } from "../config/env.js";

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

/** Returns the userId when the token is well-formed, correctly signed and unexpired; else null. */
export async function verifyToken(token: string, now: number = Date.now()): Promise<string | null> {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [userId, issuedAt, mac] = parts as [string, string, string];
  if (!userId || !/^\d+$/.test(issuedAt)) return null;
  // Buffer.from(x, "hex") stops at the first invalid nibble and returns a SHORTER buffer instead of
  // failing — so "<valid-mac>x" would decode to the valid mac and compare equal. Demand exact hex.
  if (!/^[0-9a-f]{64}$/.test(mac)) return null;
  const expected = createHmac("sha256", await signingKey()).update(`${userId}.${issuedAt}`).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (now - Number(issuedAt) > SESSION_TTL_MS) return null;
  return userId;
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

/** Reads the session from a request, or null when there is none/it is invalid. */
export async function sessionUserId(req: FastifyRequest): Promise<string | null> {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  return await verifyToken(raw);
}

/**
 * Fastify preHandler: 401s anything without a valid session. Applied to every /api route except the
 * auth and setup endpoints and the runner's status callback (which carries its own service token).
 */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = await sessionUserId(req);
  if (!userId) {
    await reply.code(401).send({ error: "not authenticated" });
    return;
  }
  (req as FastifyRequest & { userId?: string }).userId = userId;
}

export function resetSessionKeyForTesting(): void {
  keyPromise = null;
}
