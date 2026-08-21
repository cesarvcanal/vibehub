import { secretGet, secretSet, secretDelete } from "../../secrets/vault.js";
import { logger } from "../../utils/logger.js";

/**
 * GITHUB — vibehub talks to GitHub for exactly three things: listing the repos you can work on,
 * listing their branches, and handing an EPHEMERAL credential to `git clone/fetch` inside the
 * runner.
 *
 * The token is stored in the local vault and never written to disk inside the runner. In
 * particular it never lands in `/work/<repo>/.git/config`, which any process in the container can
 * read — including the agent itself, which routinely processes untrusted repository content and has
 * network egress. The credential travels per-command, as an http header, through stdin.
 */

export const GITHUB_TOKEN_KEY = "GITHUB_TOKEN";
const API = "https://api.github.com";

export interface GithubIdentity {
  login: string;
  name: string | null;
  email: string | null;
  /** OAuth scopes the token carries, when GitHub reports them (classic tokens only). */
  scopes: string[];
}

export interface GithubState {
  connected: boolean;
  login?: string;
  scopes?: string[];
  /** Set when a stored token stopped working (revoked, expired) — the UI shows "reconnect". */
  error?: string;
}

export interface GithubRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
  description: string | null;
}

async function githubFetch(path: string, token: string): Promise<Response> {
  return await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "vibehub",
    },
  });
}

/** Reads the stored token, or undefined when GitHub was never connected. */
export async function storedToken(): Promise<string | undefined> {
  return await secretGet(GITHUB_TOKEN_KEY);
}

/** The stored token, or a clear error telling the user to connect GitHub first. */
export async function requireToken(): Promise<string> {
  const token = await storedToken();
  if (!token) throw new Error("GitHub is not connected — add a token in Settings");
  return token;
}

/** Checks a token against the API and returns who it belongs to. Throws when it is not usable. */
export async function identify(token: string): Promise<GithubIdentity> {
  const res = await githubFetch("/user", token);
  if (res.status === 401) throw new Error("GitHub rejected this token (401) — is it expired or revoked?");
  if (!res.ok) throw new Error(`GitHub returned ${res.status} while checking the token`);
  const body = (await res.json()) as { login: string; name: string | null; email: string | null };
  const scopeHeader = res.headers.get("x-oauth-scopes") ?? "";
  return {
    login: body.login,
    name: body.name ?? null,
    email: body.email ?? null,
    scopes: scopeHeader.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** Validates a token, then stores it. Returns the identity so the wizard can show who connected. */
export async function connect(token: string): Promise<GithubIdentity> {
  const clean = String(token ?? "").trim();
  if (!clean) throw new Error("token cannot be empty");
  const identity = await identify(clean);
  await secretSet(GITHUB_TOKEN_KEY, clean);
  logger.info({ audit: true, action: "github.connect", login: identity.login }, "GitHub connected");
  return identity;
}

export async function disconnect(): Promise<void> {
  await secretDelete(GITHUB_TOKEN_KEY);
  logger.info({ audit: true, action: "github.disconnect" }, "GitHub disconnected");
}

/** Connection state for the UI. Never throws: a dead token is a state, not a crash. */
export async function state(): Promise<GithubState> {
  const token = await storedToken();
  if (!token) return { connected: false };
  try {
    const identity = await identify(token);
    return { connected: true, login: identity.login, scopes: identity.scopes };
  } catch (err) {
    return { connected: false, error: (err as Error).message };
  }
}

/**
 * Repositories the token can push to, newest first. `q` filters client-side on full name so typing
 * in the picker stays instant and does not burn search API quota.
 */
export async function listRepos(q = "", limit = 100): Promise<GithubRepo[]> {
  const token = await requireToken();
  const repos: GithubRepo[] = [];
  const perPage = 100;
  for (let page = 1; page <= 5 && repos.length < limit; page += 1) {
    const res = await githubFetch(`/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, token);
    if (!res.ok) throw new Error(`GitHub returned ${res.status} while listing repositories`);
    const body = (await res.json()) as {
      full_name: string; clone_url: string; private: boolean; default_branch: string;
      updated_at: string; description: string | null;
    }[];
    for (const r of body) {
      repos.push({
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        private: r.private,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
        description: r.description,
      });
    }
    if (body.length < perPage) break;
  }
  const needle = q.trim().toLowerCase();
  const filtered = needle ? repos.filter((r) => r.fullName.toLowerCase().includes(needle)) : repos;
  return filtered.slice(0, limit);
}

/** Branch names of a repository, default branch first. */
export async function listBranches(owner: string, repo: string): Promise<string[]> {
  assertRepoPart(owner, "owner");
  assertRepoPart(repo, "repository");
  const token = await requireToken();
  const [branchesRes, repoRes] = await Promise.all([
    githubFetch(`/repos/${owner}/${repo}/branches?per_page=100`, token),
    githubFetch(`/repos/${owner}/${repo}`, token),
  ]);
  if (!branchesRes.ok) throw new Error(`GitHub returned ${branchesRes.status} while listing branches`);
  const branches = ((await branchesRes.json()) as { name: string }[]).map((b) => b.name);
  const defaultBranch = repoRes.ok ? ((await repoRes.json()) as { default_branch: string }).default_branch : null;
  if (!defaultBranch) return branches;
  return [defaultBranch, ...branches.filter((b) => b !== defaultBranch)];
}

/** GitHub path segments are `[A-Za-z0-9._-]` — anything else is someone probing the URL. */
export function assertRepoPart(value: string, what: string): string {
  const v = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v)) throw new Error(`invalid ${what}: '${value}'`);
  return v;
}

/**
 * The header git uses to authenticate a single clone/fetch. Built fresh per command and passed via
 * `GIT_CONFIG_*` so it lives only in that process's environment — never in a config file, never in
 * argv, never persisted in the runner.
 */
export async function gitAuthHeader(): Promise<string> {
  const token = await requireToken();
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

/** Splits "owner/repo" into its parts, validating both. */
export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = String(fullName ?? "").trim().split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`invalid repository name: '${fullName}'`);
  return { owner: assertRepoPart(owner, "owner"), repo: assertRepoPart(repo, "repository") };
}
