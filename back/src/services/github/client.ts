import { secretGet, secretSet, secretDelete } from "../../secrets/vault.js";
import { logger } from "../../utils/logger.js";
import {
  addGithubConnection,
  clearGithubConnections,
  getGithubConnection,
  listGithubConnections,
  removeGithubConnection,
  updateGithubConnection,
  type GithubConnection,
  type Project,
} from "../board/registry.js";

/**
 * GITHUB — vibehub talks to GitHub for exactly three things: listing the repos you can work on,
 * listing their branches, and handing an EPHEMERAL credential to `git clone/fetch` inside the
 * runner.
 *
 * MULTIPLE ACCOUNTS. A personal account and an org account are the normal case, so the unit here is
 * a CONNECTION: an identity in the board document (`githubConnections`) plus one token in the vault
 * under `GITHUB_TOKEN_<ID>`. A project names the connection it clones with; a project that names
 * none uses the first one, which is exactly how a single-account install behaves.
 *
 * There is no OAuth flow: you PASTE a token (a fine-grained PAT with Contents read/write, or a
 * classic token with `repo`). That is the whole login story, and the UI says so.
 *
 * The tokens never leave this process except as an http header. In particular they never land in
 * `/work/<repo>/.git/config`, which any process in the container can read — including the agent
 * itself, which routinely processes untrusted repository content and has network egress. The
 * credential travels per-command, as an http header, through stdin.
 */

/** Where the SINGLE token used to live, before connections existed. Migrated away on first load. */
export const GITHUB_TOKEN_KEY = "GITHUB_TOKEN";
const API = "https://api.github.com";

/** Vault key holding the token of a connection. The id is validated by the registry. */
export function tokenKeyFor(connectionId: string): string {
  return `${GITHUB_TOKEN_KEY}_${connectionId}`;
}

export interface GithubIdentity {
  login: string;
  name: string | null;
  email: string | null;
  /** OAuth scopes the token carries, when GitHub reports them (classic tokens only). */
  scopes: string[];
}

/** A connection plus the result of checking its token against GitHub right now. */
export interface GithubConnectionState extends GithubConnection {
  /** The stored token still works. */
  ok: boolean;
  /** Why it does not (revoked, expired, network) — the UI shows "reconnect". */
  error?: string;
}

export interface GithubState {
  connections: GithubConnectionState[];
}

export interface GithubRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
  description: string | null;
}

/** Ceiling for one GitHub call. Nothing here is worth blocking a request on for longer. */
const GITHUB_TIMEOUT_MS = 8_000;

async function githubFetch(path: string, token: string): Promise<Response> {
  return await fetch(`${API}${path}`, {
    // Without this an unreachable github.com does not fail — it HANGS, and it hangs inside whatever
    // request asked (the setup probe used to be one of them, which is a blank app until it gives up).
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "vibehub",
    },
  });
}

// ---------------------------------------------------------------------------
// Migration: the pre-connections single token
// ---------------------------------------------------------------------------

let migration: Promise<void> | null = null;

/**
 * MIGRATION — an install from before multiple accounts has one token under `GITHUB_TOKEN` and no
 * connections. Turn it into connection #1 and MOVE the secret to `GITHUB_TOKEN_<ID>`.
 *
 * Idempotent by construction: it only fires when the old key exists AND the list is empty, and the
 * move deletes the old key, so a second run is a no-op. Serialized through a module promise so two
 * concurrent requests cannot both migrate.
 *
 * The identity comes from GitHub when reachable; when it is not (offline, dead token) the token is
 * STILL migrated — losing a stored credential because a network call failed would be the worse bug.
 */
export async function migrateLegacyToken(): Promise<void> {
  if (!migration) {
    migration = (async () => {
      const legacy = await secretGet(GITHUB_TOKEN_KEY);
      if (!legacy) return;
      if ((await listGithubConnections()).length > 0) return;
      let login = "";
      let scopes: string[] = [];
      try {
        const identity = await identify(legacy);
        login = identity.login;
        scopes = identity.scopes;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "migrating the GitHub token without a live identity check");
      }
      const connection = await addGithubConnection({
        login: login || "github",
        label: login || "GitHub",
        scopes,
      });
      await secretSet(tokenKeyFor(connection.id), legacy);
      await secretDelete(GITHUB_TOKEN_KEY);
      logger.info(
        { audit: true, action: "github.migrate", id: connection.id, login: connection.login },
        "migrated the single GitHub token into a connection",
      );
    })().catch((err) => {
      // A failed migration must not poison every later call — retry on the next one.
      migration = null;
      throw err;
    });
  }
  return await migration;
}

/** Tests and hot-reload only. */
export function resetMigrationForTesting(): void {
  migration = null;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function listConnections(): Promise<GithubConnection[]> {
  await migrateLegacyToken();
  return await listGithubConnections();
}

/**
 * Adds an account: validate the pasted token against GitHub, record the identity, store the secret.
 * Returns the connection AND the identity, because the caller (the wizard) uses the email to seed
 * the git identity of a fresh install.
 */
export async function connect(
  label: string,
  token: string,
): Promise<{ connection: GithubConnection; identity: GithubIdentity }> {
  await migrateLegacyToken();
  const clean = String(token ?? "").trim();
  if (!clean) throw new Error("token cannot be empty");
  const identity = await identify(clean);
  const connection = await addGithubConnection({
    login: identity.login,
    label: String(label ?? "").trim() || identity.login,
    scopes: identity.scopes,
  });
  await secretSet(tokenKeyFor(connection.id), clean);
  logger.info(
    { audit: true, action: "github.connect", id: connection.id, login: identity.login },
    "GitHub account connected",
  );
  return { connection, identity };
}

/**
 * BACKWARD COMPATIBILITY for the setup wizard's `POST /api/github/token`: create the first
 * connection, or replace the token of the one that already exists. An install that never had more
 * than one account keeps behaving exactly as before.
 */
export async function connectOrReplaceFirst(
  token: string,
  label?: string,
): Promise<{ connection: GithubConnection; identity: GithubIdentity }> {
  await migrateLegacyToken();
  const clean = String(token ?? "").trim();
  if (!clean) throw new Error("token cannot be empty");
  const existing = (await listGithubConnections())[0];
  if (!existing) return await connect(label ?? "", clean);
  const identity = await identify(clean);
  await secretSet(tokenKeyFor(existing.id), clean);
  const connection = await updateGithubConnection(existing.id, {
    login: identity.login,
    scopes: identity.scopes,
    ...(label?.trim() ? { label: label.trim() } : {}),
  });
  logger.info(
    { audit: true, action: "github.replace", id: connection.id, login: identity.login },
    "GitHub token replaced",
  );
  return { connection, identity };
}

/** Removes one account. THROWS while a project still points at it (the registry decides). */
export async function removeConnection(id: string): Promise<GithubConnection> {
  await migrateLegacyToken();
  const removed = await removeGithubConnection(id);
  await secretDelete(tokenKeyFor(removed.id));
  logger.info({ audit: true, action: "github.remove", id: removed.id }, "GitHub account removed");
  return removed;
}

/** Forgets EVERY account — the "disconnect GitHub" button. */
export async function disconnect(): Promise<void> {
  await migrateLegacyToken();
  const gone = await clearGithubConnections();
  for (const c of gone) await secretDelete(tokenKeyFor(c.id));
  await secretDelete(GITHUB_TOKEN_KEY);
  logger.info({ audit: true, action: "github.disconnect", count: gone.length }, "GitHub disconnected");
}

/** State for the UI: every connection with a live identity check. Never throws — a dead token is a state. */
export async function state(): Promise<GithubState> {
  const connections = await listConnections();
  const checked = await Promise.all(
    connections.map(async (c): Promise<GithubConnectionState> => {
      const token = await secretGet(tokenKeyFor(c.id));
      if (!token) return { ...c, ok: false, error: "no token stored for this account — paste it again" };
      try {
        const identity = await identify(token);
        return { ...c, login: identity.login, scopes: identity.scopes, ok: true };
      } catch (err) {
        return { ...c, ok: false, error: (err as Error).message };
      }
    }),
  );
  return { connections: checked };
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * The connection a request means: the one it named, or — when it named none — the first stored
 * account. THROWS with a message the UI can show verbatim when there is nothing to fall back to.
 */
export async function resolveConnection(connectionId?: string | null): Promise<GithubConnection> {
  const connections = await listConnections();
  if (connections.length === 0) throw new Error("GitHub is not connected — paste a token in Settings");
  const wanted = String(connectionId ?? "").trim();
  if (!wanted) return connections[0]!;
  const found = connections.find((c) => c.id === wanted);
  if (!found) throw new Error(`GitHub account '${wanted}' does not exist — pick another one in Settings`);
  return found;
}

/** The token behind a connection. THROWS when the account exists but its secret is gone. */
export async function tokenFor(connectionId?: string | null): Promise<string> {
  const connection = await resolveConnection(connectionId);
  const token = await secretGet(tokenKeyFor(connection.id));
  if (!token) throw new Error(`no token stored for the GitHub account '${connection.label}' — paste it again`);
  return token;
}

/**
 * The header git uses to authenticate a single clone/fetch OF THIS PROJECT. Built fresh per command
 * and passed via `GIT_CONFIG_*` so it lives only in that process's environment — never in a config
 * file, never in argv, never persisted in the runner.
 */
export async function gitAuthHeaderFor(project: Pick<Project, "githubConnectionId">): Promise<string> {
  const token = await tokenFor(project?.githubConnectionId);
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Repos and branches
// ---------------------------------------------------------------------------

/**
 * Repositories the token can push to, newest first. `q` filters client-side on full name so typing
 * in the picker stays instant and does not burn search API quota.
 */
export async function listRepos(connectionId?: string | null, q = "", limit = 100): Promise<GithubRepo[]> {
  const token = await tokenFor(connectionId);
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

export interface BranchesDoRepo {
  branches: string[];
  defaultBranch: string | null;
  /** O repo tem mais branches do que `MAX_PAGINAS_BRANCHES` páginas comportam; a lista veio cortada. */
  truncada: boolean;
}

/** Teto de páginas de 100: um repo com mais de 2000 branches lista as 2000 primeiras. */
const MAX_PAGINAS_BRANCHES = 20;

/** Páginas buscadas ao mesmo tempo: rajada maior aciona o limite secundário do GitHub (403). */
const PAGINAS_SIMULTANEAS = 4;

/**
 * Todas as branches do repositório, na ordem do GitHub, com a padrão à parte (quem ordena para
 * exibir é o front). Lê do GitHub a cada chamada (sem cache), então branch apagada some e branch
 * nova aparece. A página 1 diz no `Link` quantas existem; as demais saem em lotes.
 */
export async function listBranches(connectionId: string | null | undefined, owner: string, repo: string): Promise<BranchesDoRepo> {
  assertRepoPart(owner, "owner");
  assertRepoPart(repo, "repository");
  const token = await tokenFor(connectionId);
  const buscarPagina = (pagina: number) => githubFetch(`/repos/${owner}/${repo}/branches?per_page=100&page=${pagina}`, token);
  const [primeiraPagina, repoRes] = await Promise.all([buscarPagina(1), githubFetch(`/repos/${owner}/${repo}`, token)]);
  const respostas = [primeiraPagina];
  const descartarRespostas = () => Promise.all([repoRes, ...respostas].map((res) => res.body?.cancel()));
  if (!primeiraPagina.ok) {
    await descartarRespostas();
    throw new Error(`GitHub returned ${primeiraPagina.status} while listing branches`);
  }
  const paginasNoGithub = ultimaPaginaDoLink(primeiraPagina.headers.get("link"));
  const ultimaPagina = Math.min(paginasNoGithub, MAX_PAGINAS_BRANCHES);
  for (let inicio = 2; inicio <= ultimaPagina; inicio += PAGINAS_SIMULTANEAS) {
    const fim = Math.min(inicio + PAGINAS_SIMULTANEAS - 1, ultimaPagina);
    const lote = await Promise.all(Array.from({ length: fim - inicio + 1 }, (_, i) => buscarPagina(inicio + i)));
    respostas.push(...lote);
    const falha = lote.find((res) => !res.ok);
    if (falha) {
      await descartarRespostas();
      throw new Error(`GitHub returned ${falha.status} while listing branches`);
    }
  }
  const paginas = await Promise.all(respostas.map((res) => res.json() as Promise<{ name: string }[]>));
  const branches = [...new Set(paginas.flat().map((b) => b.name))];
  const defaultBranch = repoRes.ok ? ((await repoRes.json()) as { default_branch: string }).default_branch : null;
  if (!repoRes.ok) await repoRes.body?.cancel();
  return { branches, defaultBranch, truncada: paginasNoGithub > MAX_PAGINAS_BRANCHES };
}

/** O número da página `rel="last"` do header `Link` do GitHub; sem ele, só existe uma página. */
export function ultimaPaginaDoLink(link: string | null): number {
  const ultima = link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return ultima ? Number(ultima[1]) : 1;
}

/** GitHub path segments are `[A-Za-z0-9._-]` — anything else is someone probing the URL. */
export function assertRepoPart(value: string, what: string): string {
  const v = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v)) throw new Error(`invalid ${what}: '${value}'`);
  return v;
}

/** Splits "owner/repo" into its parts, validating both. */
export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = String(fullName ?? "").trim().split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`invalid repository name: '${fullName}'`);
  return { owner: assertRepoPart(owner, "owner"), repo: assertRepoPart(repo, "repository") };
}
