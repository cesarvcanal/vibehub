import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { JsonStore } from "../store/jsonStore.js";
import { dataPath } from "../config/env.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/**
 * LOCAL ACCOUNTS — vibehub owns its own login. No SSO, no external identity provider: the first
 * person to open a fresh install creates the owner account through the setup wizard, and from there
 * the owner creates the accounts of everybody else. There is still no sign-up.
 *
 * TWO ROLES, and only two:
 *  - `owner`  — the install belongs to them: every project, every card, the Claude accounts, the
 *               vault, the MCP servers, the brain, the settings, and the user list itself.
 *  - `member` — an invited person (a dev you work with). They see NOTHING by default: no project,
 *               no card, no configuration screen. What they get is what is shared with them.
 *
 * A users.json written before roles existed has no `role` field. Those users are OWNERS: the only
 * way to exist back then was to be the person who ran the setup wizard.
 *
 * Passwords are scrypt-hashed with a per-user salt; verification is constant-time.
 */

export type Role = "owner" | "member";
export const ROLES: readonly Role[] = ["owner", "member"] as const;

/** A whitelisted role. THROWS otherwise — it decides authorization, so it is never taken raw. PURE. */
export function assertRole(role: string): Role {
  const v = String(role ?? "").trim();
  if (v !== "owner" && v !== "member") throw new Error(`invalid role (expected owner or member): '${role}'`);
  return v;
}

export interface User {
  id: string;
  username: string;
  role: Role;
  /** scrypt hash, hex. */
  hash: string;
  /** per-user salt, hex. */
  salt: string;
  createdAt: string;
}

/** A user as it leaves the server: never the hash, never the salt. */
export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
}

interface UsersDoc { users: User[] }

const store = new JsonStore<UsersDoc>(
  dataPath("users.json"),
  () => ({ users: [] }),
  (raw) => ({
    // A record with no role predates roles, and predating roles means being the owner.
    users: ((raw as UsersDoc)?.users ?? []).map((u) => ({ ...u, role: u.role === "member" ? "member" : "owner" })),
  }),
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

/** Strips the credential material off a stored user. PURE. */
export function publicUser(user: User): PublicUser {
  const { id, username, role, createdAt } = user;
  return { id, username, role, createdAt };
}

/** True when nobody has signed up yet — the wizard uses this to decide "setup" vs "login". */
export async function isFreshInstall(): Promise<boolean> {
  return (await store.load()).users.length === 0;
}

export async function listUsers(): Promise<PublicUser[]> {
  const doc = await store.load();
  return doc.users.map(publicUser);
}

/** One user by id, or null. Public shape — the hash never leaves this module. */
export async function findUser(userId: string): Promise<PublicUser | null> {
  const doc = await store.load();
  const user = doc.users.find((u) => u.id === userId);
  return user ? publicUser(user) : null;
}

/**
 * Creates a user. Usernames are unique. Role defaults to `member`: the owner is created by the
 * setup wizard, which asks for it explicitly, and everybody else is an invitee until said otherwise.
 */
export async function createUser(username: string, password: string, role: Role = "member"): Promise<User> {
  const name = assertUsername(username);
  const pw = assertPassword(password);
  const r = assertRole(role);
  const salt = randomBytes(16);
  const user: User = {
    id: randomBytes(8).toString("hex"),
    username: name,
    role: r,
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

/**
 * Changes a role. THE LAST OWNER CANNOT BE DEMOTED: an install with no owner has nobody who can
 * create accounts, reach the vault, or take it back — it would be locked shut with no way in.
 */
export async function setRole(userId: string, role: Role): Promise<PublicUser> {
  const r = assertRole(role);
  return await store.mutate((doc) => {
    const user = doc.users.find((u) => u.id === userId);
    if (!user) throw new Error("user not found");
    if (user.role === "owner" && r !== "owner" && doc.users.filter((u) => u.role === "owner").length === 1) {
      throw new Error("this is the last owner — promote somebody else first");
    }
    user.role = r;
    return publicUser(user);
  });
}

/** Removes a user. Same last-owner guard as {@link setRole}, for the same reason. */
export async function removeUser(userId: string): Promise<PublicUser> {
  return await store.mutate((doc) => {
    const index = doc.users.findIndex((u) => u.id === userId);
    if (index < 0) throw new Error("user not found");
    const user = doc.users[index] as User;
    if (user.role === "owner" && doc.users.filter((u) => u.role === "owner").length === 1) {
      throw new Error("this is the last owner — promote somebody else first");
    }
    doc.users.splice(index, 1);
    return publicUser(user);
  });
}

export function resetUsersForTesting(): void {
  store.resetForTesting();
}
