import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { JsonStore } from "../store/jsonStore.js";
import { dataPath } from "../config/env.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/**
 * LOCAL ACCOUNTS — vibehub owns its own login. No SSO, no external identity provider: the first
 * person to open a fresh install creates the owner account through the setup wizard, and that is
 * the whole user model until someone asks for more.
 *
 * Passwords are scrypt-hashed with a per-user salt; verification is constant-time.
 */

export interface User {
  id: string;
  username: string;
  /** scrypt hash, hex. */
  hash: string;
  /** per-user salt, hex. */
  salt: string;
  createdAt: string;
}

interface UsersDoc { users: User[] }

const store = new JsonStore<UsersDoc>(
  dataPath("users.json"),
  () => ({ users: [] }),
  (raw) => ({ users: (raw as UsersDoc)?.users ?? [] }),
);

const KEY_LEN = 64;

export function assertUsername(name: string): string {
  const v = String(name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(v)) {
    throw new Error("username must be 2-32 chars: letters, digits, dot, dash or underscore");
  }
  return v;
}

export function assertPassword(password: string): string {
  const v = String(password ?? "");
  if (v.length < 8) throw new Error("password must be at least 8 characters");
  if (v.length > 200) throw new Error("password is too long");
  return v;
}

async function hashPassword(password: string, salt: Buffer): Promise<string> {
  return (await scrypt(password, salt, KEY_LEN)).toString("hex");
}

/** True when nobody has signed up yet — the wizard uses this to decide "setup" vs "login". */
export async function isFreshInstall(): Promise<boolean> {
  return (await store.load()).users.length === 0;
}

export async function listUsers(): Promise<{ id: string; username: string; createdAt: string }[]> {
  const doc = await store.load();
  return doc.users.map(({ id, username, createdAt }) => ({ id, username, createdAt }));
}

/** Creates a user. Usernames are unique. */
export async function createUser(username: string, password: string): Promise<User> {
  const name = assertUsername(username);
  const pw = assertPassword(password);
  const salt = randomBytes(16);
  const user: User = {
    id: randomBytes(8).toString("hex"),
    username: name,
    salt: salt.toString("hex"),
    hash: await hashPassword(pw, salt),
    createdAt: new Date().toISOString(),
  };
  return await store.mutate((doc) => {
    if (doc.users.some((u) => u.username === name)) throw new Error(`user '${name}' already exists`);
    doc.users.push(user);
    return user;
  });
}

/**
 * Verifies credentials. Returns the user or null — never says WHICH half was wrong, and burns the
 * same work on an unknown username so the response time does not leak account existence.
 */
export async function verifyCredentials(username: string, password: string): Promise<User | null> {
  const name = String(username ?? "").trim().toLowerCase();
  const doc = await store.load();
  const user = doc.users.find((u) => u.username === name);
  const salt = Buffer.from(user?.salt ?? randomBytes(16).toString("hex"), "hex");
  const candidate = await hashPassword(String(password ?? ""), salt);
  if (!user) return null;
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(user.hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return user;
}

export async function changePassword(userId: string, password: string): Promise<void> {
  const pw = assertPassword(password);
  const salt = randomBytes(16);
  const hash = await hashPassword(pw, salt);
  await store.mutate((doc) => {
    const user = doc.users.find((u) => u.id === userId);
    if (!user) throw new Error("user not found");
    user.salt = salt.toString("hex");
    user.hash = hash;
  });
}

export function resetUsersForTesting(): void {
  store.resetForTesting();
}
