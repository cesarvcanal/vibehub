import { JsonStore } from "../store/jsonStore.js";
import { dataPath } from "../config/env.js";
import { assertAccountSlug, listAccounts } from "../services/board/registry.js";

/**
 * GIT IDENTITY PER USER — who a card's commits are authored by, and which GitHub connection its
 * pushes use, decided by the PERSON doing the work instead of by the install.
 *
 * Why it exists: an install has ONE `settings.git` and a project has ONE GitHub connection, so a
 * second person working a card commits and pushes as the first one. The board said "mussa" while
 * every commit said "César Canal".
 *
 * Kept OUT of `users.json` on purpose: that document's records travel to the front as `PublicUser`,
 * and the connection a person pushes with is not part of their login. A user with no record here
 * behaves exactly like before this file existed — the project's connection and `settings.git`.
 *
 * Two doors write it: the owner (for anybody) and each person (for themselves). A PAT expires, and
 * if only the owner could store it, every rotation would be the owner's task — whose workaround is
 * the member sending their token to the owner, which is the thing to avoid.
 *
 * The values land in a bash script inside the runner, so both strings are validated HERE, at the
 * door, and shell-quoted at the other end.
 */

export interface UserGitIdentity {
  userId: string;
  /** This person's GitHub connection (an id in `githubConnections`). Absent = the project's. */
  githubConnectionId?: string;
  /** Commit author. Absent = `settings.git`. */
  gitName?: string;
  gitEmail?: string;
  /**
   * This person's CLAUDE ACCOUNT (a slug in the board's accounts) — the profile a card they create
   * runs on. Absent = the card inherits the project's, then the runner's default (`~/.claude`).
   * Only the owner writes it: a member pointing themselves at someone else's account would be
   * running on that person's credentials, memory and quota.
   */
  claudeAccountSlug?: string;
}

interface UserGitDoc { identities: UserGitIdentity[] }

const store = new JsonStore<UserGitDoc>(
  dataPath("userGit.json"),
  () => ({ identities: [] }),
  (raw) => ({ identities: (raw as UserGitDoc)?.identities ?? [] }),
);

/** No control characters, no quote, no shell expansion — it ends up inside a bash script. PURE. */
const GIT_NAME_RE = /^[^\p{C}'"`$\\]{1,80}$/u;
/** Deliberately stricter than RFC 5322: an address, nothing a shell could read. PURE. */
const GIT_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function assertGitName(name: string): string {
  const v = String(name ?? "").trim();
  if (!GIT_NAME_RE.test(v)) throw new Error("invalid commit name (1-80 chars, no quotes or shell characters)");
  return v;
}

export function assertGitEmail(email: string): string {
  const v = String(email ?? "").trim();
  if (!GIT_EMAIL_RE.test(v)) throw new Error(`invalid commit e-mail: '${email}'`);
  return v;
}

export async function getUserGit(userId: string): Promise<UserGitIdentity | null> {
  const id = String(userId ?? "");
  if (!id) return null;
  return (await store.load()).identities.find((i) => i.userId === id) ?? null;
}

/**
 * Writes one person's identity. A field left out is UNTOUCHED; a field set to null is CLEARED (back
 * to inheriting). The connection id is NOT validated here — the route checks it against the
 * connections that exist, which is where the registry lives.
 */
export async function setUserGit(
  userId: string,
  patch: {
    githubConnectionId?: string | null; gitName?: string | null; gitEmail?: string | null; claudeAccountSlug?: string | null;
  },
): Promise<UserGitIdentity> {
  const id = String(userId ?? "");
  if (!id) throw new Error("user id is required");
  // Validate BEFORE mutating: the document lives in a cache shared with the next mutation, so a
  // half-applied patch whose last field throws would survive in memory and get persisted later.
  const name = patch.gitName === undefined || patch.gitName === null ? patch.gitName : assertGitName(patch.gitName);
  const email = patch.gitEmail === undefined || patch.gitEmail === null ? patch.gitEmail : assertGitEmail(patch.gitEmail);
  const account = patch.claudeAccountSlug === undefined || patch.claudeAccountSlug === null
    ? patch.claudeAccountSlug
    : assertAccountSlug(patch.claudeAccountSlug);
  return await store.mutate((doc) => {
    let entry = doc.identities.find((i) => i.userId === id);
    if (!entry) {
      entry = { userId: id };
      doc.identities.push(entry);
    }
    if (patch.githubConnectionId !== undefined) {
      if (patch.githubConnectionId === null) delete entry.githubConnectionId;
      else entry.githubConnectionId = patch.githubConnectionId;
    }
    if (name !== undefined) {
      if (name === null) delete entry.gitName;
      else entry.gitName = name;
    }
    if (email !== undefined) {
      if (email === null) delete entry.gitEmail;
      else entry.gitEmail = email;
    }
    if (account !== undefined) {
      if (account === null) delete entry.claudeAccountSlug;
      else entry.claudeAccountSlug = account;
    }
    return { ...entry };
  });
}

/** Drops a person's identity with the person — a removed user leaves nothing behind. Idempotent. */
export async function removeUserGit(userId: string): Promise<void> {
  const id = String(userId ?? "");
  if (!id) return;
  await store.mutate((doc) => {
    const index = doc.identities.findIndex((i) => i.userId === id);
    if (index >= 0) doc.identities.splice(index, 1);
  });
}

/**
 * The account a card created by this person is BORN on: theirs, when it still exists. A slug whose
 * account is gone (removal refuses while a person holds it, but a hand-edited file does not) falls
 * back to inheriting instead of failing the creation.
 */
export async function creatorAccountSlug(userId: string | undefined): Promise<string | undefined> {
  const slug = userId ? (await getUserGit(userId))?.claudeAccountSlug : undefined;
  if (!slug) return undefined;
  return (await listAccounts()).some((a) => a.slug === slug) ? slug : undefined;
}

/** Who is tied to a Claude account — what removing that account would leave dangling. */
export async function usersOnClaudeAccount(slug: string): Promise<string[]> {
  return (await store.load()).identities.filter((i) => i.claudeAccountSlug === slug).map((i) => i.userId);
}

export function resetUserGitForTesting(): void {
  store.resetForTesting();
}
