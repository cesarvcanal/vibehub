import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

/**
 * A pristine module graph per test: `client.ts` and `registry.ts` both cache (the vault document and
 * board.json), so the data directory has to be swapped BEFORE they are imported.
 */
async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  const gh = await import("./client.js");
  const registry = await import("../board/registry.js");
  const vault = await import("../../secrets/vault.js");
  return { gh, registry, vault };
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** Every request answers as `login`, with the given classic scopes. */
function stubIdentity(login: string, scopes = ""): void {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
    { login, name: null, email: null },
    scopes ? { headers: { "x-oauth-scopes": scopes } } : {},
  )));
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-gh-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("connect", () => {
  it("validates the token, stores it under the connection's key, and records the identity", async () => {
    const { gh, vault } = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
      { login: "octocat", name: "Octo", email: "o@example.com" },
      { headers: { "x-oauth-scopes": "repo, read:org" } },
    )));
    const { connection, identity } = await gh.connect("personal", "ghp_token");
    expect(identity).toEqual({ login: "octocat", name: "Octo", email: "o@example.com", scopes: ["repo", "read:org"] });
    expect(connection).toMatchObject({ id: "OCTOCAT", label: "personal", login: "octocat", scopes: ["repo", "read:org"] });
    expect(await vault.secretGet(gh.tokenKeyFor(connection.id))).toBe("ghp_token");
    // the legacy single-token key is never written any more
    expect(await vault.secretGet(gh.GITHUB_TOKEN_KEY)).toBeUndefined();
  });

  it("falls back to the login when no label is typed", async () => {
    const { gh } = await fresh();
    stubIdentity("octocat");
    const { connection } = await gh.connect("   ", "ghp_token");
    expect(connection.label).toBe("octocat");
  });

  it("holds two accounts side by side, each with its own token", async () => {
    const { gh, vault } = await fresh();
    stubIdentity("octocat");
    const personal = (await gh.connect("personal", "ghp_personal")).connection;
    stubIdentity("acme-inc");
    const org = (await gh.connect("acme org", "ghp_org")).connection;

    expect((await gh.listConnections()).map((c) => c.id)).toEqual([personal.id, org.id]);
    expect(await vault.secretGet(gh.tokenKeyFor(personal.id))).toBe("ghp_personal");
    expect(await vault.secretGet(gh.tokenKeyFor(org.id))).toBe("ghp_org");
  });

  it("gives two tokens for the SAME login distinct ids", async () => {
    const { gh } = await fresh();
    stubIdentity("octocat");
    const a = (await gh.connect("classic", "ghp_a")).connection;
    const b = (await gh.connect("fine-grained", "ghp_b")).connection;
    expect(a.id).toBe("OCTOCAT");
    expect(b.id).toBe("OCTOCAT_2");
  });

  it("does not store a token GitHub rejects", async () => {
    const { gh } = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials" }, { status: 401 })));
    await expect(gh.connect("personal", "bad")).rejects.toThrow(/401/);
    expect(await gh.listConnections()).toEqual([]);
  });

  it("refuses an empty token without calling GitHub", async () => {
    const { gh } = await fresh();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(gh.connect("personal", "   ")).rejects.toThrow(/cannot be empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the token as a bearer header, never in the URL", async () => {
    const { gh } = await fresh();
    const fetchMock = vi.fn(async () => jsonResponse({ login: "octocat", name: null, email: null }));
    vi.stubGlobal("fetch", fetchMock);
    await gh.connect("personal", "ghp_secret");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("ghp_secret");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_secret");
  });
});

describe("migration of the pre-connections single token", () => {
  it("turns GITHUB_TOKEN into connection #1 and moves the secret", async () => {
    const { gh, vault } = await fresh();
    await vault.secretSet(gh.GITHUB_TOKEN_KEY, "ghp_legacy");
    stubIdentity("octocat", "repo");

    const connections = await gh.listConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ id: "OCTOCAT", label: "octocat", login: "octocat", scopes: ["repo"] });
    expect(await vault.secretGet(gh.tokenKeyFor("OCTOCAT"))).toBe("ghp_legacy");
    expect(await vault.secretGet(gh.GITHUB_TOKEN_KEY)).toBeUndefined();
  });

  it("is idempotent — running it again changes nothing", async () => {
    const { gh, vault } = await fresh();
    await vault.secretSet(gh.GITHUB_TOKEN_KEY, "ghp_legacy");
    stubIdentity("octocat");
    await gh.migrateLegacyToken();
    gh.resetMigrationForTesting();
    await gh.migrateLegacyToken();
    await gh.migrateLegacyToken();
    expect(await gh.listConnections()).toHaveLength(1);
  });

  it("does not touch an install that already has connections", async () => {
    const { gh, vault } = await fresh();
    stubIdentity("octocat");
    await gh.connect("personal", "ghp_new");
    gh.resetMigrationForTesting();
    await vault.secretSet(gh.GITHUB_TOKEN_KEY, "ghp_legacy");
    await gh.migrateLegacyToken();
    expect(await gh.listConnections()).toHaveLength(1);
    expect(await vault.secretGet(gh.GITHUB_TOKEN_KEY)).toBe("ghp_legacy");
  });

  it("migrates anyway when GitHub cannot be reached — a network blip must not lose the token", async () => {
    const { gh, vault } = await fresh();
    await vault.secretSet(gh.GITHUB_TOKEN_KEY, "ghp_legacy");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENETDOWN"); }));
    const connections = await gh.listConnections();
    expect(connections).toHaveLength(1);
    expect(await vault.secretGet(gh.tokenKeyFor(connections[0]!.id))).toBe("ghp_legacy");
    expect(await vault.secretGet(gh.GITHUB_TOKEN_KEY)).toBeUndefined();
  });

  it("does nothing at all when there is no legacy token", async () => {
    const { gh } = await fresh();
    await gh.migrateLegacyToken();
    expect(await gh.listConnections()).toEqual([]);
  });
});

describe("state", () => {
  it("is an empty list when nothing was ever connected", async () => {
    const { gh } = await fresh();
    expect(await gh.state()).toEqual({ connections: [] });
  });

  it("reports each account's live check instead of throwing when a token died", async () => {
    const { gh } = await fresh();
    stubIdentity("octocat");
    await gh.connect("personal", "ghp_ok");
    stubIdentity("acme-inc");
    await gh.connect("acme org", "ghp_dead");

    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).authorization === "Bearer ghp_ok"
        ? jsonResponse({ login: "octocat", name: null, email: null })
        : jsonResponse({ message: "Bad credentials" }, { status: 401 })));

    const { connections } = await gh.state();
    expect(connections.map((c) => c.ok)).toEqual([true, false]);
    expect(connections[1]!.error).toMatch(/401/);
  });

  it("forgets every account on disconnect", async () => {
    const { gh, vault } = await fresh();
    stubIdentity("octocat");
    const { connection } = await gh.connect("personal", "ghp_token");
    await gh.disconnect();
    expect(await gh.listConnections()).toEqual([]);
    expect(await vault.secretGet(gh.tokenKeyFor(connection.id))).toBeUndefined();
  });
});

describe("connectOrReplaceFirst (the wizard's POST /api/github/token)", () => {
  it("creates the first connection when there is none", async () => {
    const { gh } = await fresh();
    stubIdentity("octocat");
    const { connection } = await gh.connectOrReplaceFirst("ghp_token");
    expect(await gh.listConnections()).toHaveLength(1);
    expect(connection.login).toBe("octocat");
  });

  it("replaces the token of the existing one instead of adding a second", async () => {
    const { gh, vault } = await fresh();
    stubIdentity("octocat");
    const first = (await gh.connect("personal", "ghp_old")).connection;
    stubIdentity("octocat-renamed");
    await gh.connectOrReplaceFirst("ghp_new");
    const connections = await gh.listConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.login).toBe("octocat-renamed");
    expect(await vault.secretGet(gh.tokenKeyFor(first.id))).toBe("ghp_new");
  });
});

describe("removeConnection", () => {
  it("removes the account and its secret", async () => {
    const { gh, vault } = await fresh();
    stubIdentity("octocat");
    const { connection } = await gh.connect("personal", "ghp_token");
    await gh.removeConnection(connection.id);
    expect(await gh.listConnections()).toEqual([]);
    expect(await vault.secretGet(gh.tokenKeyFor(connection.id))).toBeUndefined();
  });

  it("REFUSES while a project points at it, and keeps the token", async () => {
    const { gh, registry, vault } = await fresh();
    stubIdentity("octocat");
    const { connection } = await gh.connect("personal", "ghp_token");
    await registry.createProject({ name: "erp", githubConnectionId: connection.id });

    await expect(gh.removeConnection(connection.id)).rejects.toThrow(/in use by 1 project/);
    expect(await gh.listConnections()).toHaveLength(1);
    expect(await vault.secretGet(gh.tokenKeyFor(connection.id))).toBe("ghp_token");
  });

  it("rejects an id that is not shaped like one", async () => {
    const { gh } = await fresh();
    await expect(gh.removeConnection("../../etc")).rejects.toThrow(/invalid GitHub connection id/);
  });
});

describe("per-project credential resolution", () => {
  async function twoAccounts() {
    const ctx = await fresh();
    stubIdentity("octocat");
    const personal = (await ctx.gh.connect("personal", "ghp_personal")).connection;
    stubIdentity("acme-inc");
    const org = (await ctx.gh.connect("acme org", "ghp_org")).connection;
    return { ...ctx, personal, org };
  }

  function decode(header: string): string {
    return Buffer.from(header.split(" ")[2] ?? "", "base64").toString();
  }

  it("uses the connection the project names", async () => {
    const { gh, org } = await twoAccounts();
    const header = await gh.gitAuthHeaderFor({ githubConnectionId: org.id });
    expect(decode(header)).toBe("x-access-token:ghp_org");
  });

  it("falls back to the FIRST connection when the project names none", async () => {
    const { gh } = await twoAccounts();
    expect(decode(await gh.gitAuthHeaderFor({}))).toBe("x-access-token:ghp_personal");
  });

  it("explains itself when NO account is connected", async () => {
    const { gh } = await fresh();
    await expect(gh.gitAuthHeaderFor({})).rejects.toThrow(/GitHub is not connected/);
  });

  it("names the missing account when a project points at one that is gone", async () => {
    const { gh } = await twoAccounts();
    await expect(gh.gitAuthHeaderFor({ githubConnectionId: "GONE" })).rejects.toThrow(/'GONE' does not exist/);
  });

  it("builds a basic AUTHORIZATION header", async () => {
    const { gh } = await twoAccounts();
    const header = await gh.gitAuthHeaderFor({});
    expect(header.startsWith("AUTHORIZATION: basic ")).toBe(true);
  });
});

describe("listRepos", () => {
  const repo = (name: string) => ({
    full_name: name, clone_url: `https://github.com/${name}.git`, private: false,
    default_branch: "main", updated_at: "2026-08-01T00:00:00Z", description: null,
  });

  it("explains itself when GitHub was never connected", async () => {
    const { gh } = await fresh();
    await expect(gh.listRepos()).rejects.toThrow(/not connected/);
  });

  it("maps the payload and filters by query", async () => {
    const { gh } = await fresh();
    stubIdentity("octocat");
    await gh.connect("personal", "ghp_token");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([repo("octocat/hello"), repo("octocat/world")])));
    expect((await gh.listRepos()).map((r) => r.fullName)).toEqual(["octocat/hello", "octocat/world"]);
    expect((await gh.listRepos("", "WOR")).map((r) => r.fullName)).toEqual(["octocat/world"]);
  });

  it("reads through the account it was asked for", async () => {
    const { gh } = await fresh();
    stubIdentity("octocat");
    await gh.connect("personal", "ghp_personal");
    stubIdentity("acme-inc");
    const org = (await gh.connect("acme org", "ghp_org")).connection;

    const fetchMock = vi.fn(async () => jsonResponse([repo("acme-inc/erp")]));
    vi.stubGlobal("fetch", fetchMock);
    await gh.listRepos(org.id);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_org");
  });
});

describe("listBranches", () => {
  it("puts the default branch first", async () => {
    const { gh } = await fresh();
    stubIdentity("octocat");
    await gh.connect("personal", "ghp_token");
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/branches")
        ? jsonResponse([{ name: "feature" }, { name: "main" }])
        : jsonResponse({ default_branch: "main" })));
    expect(await gh.listBranches("", "octocat", "hello")).toEqual(["main", "feature"]);
  });

  it("rejects path segments that are not repository names", async () => {
    const { gh } = await fresh();
    await expect(gh.listBranches("", "../../etc", "repo")).rejects.toThrow(/invalid owner/);
    await expect(gh.listBranches("", "octocat", "a b")).rejects.toThrow(/invalid repository/);
  });
});

describe("splitRepo", () => {
  it("splits and validates owner/repo", async () => {
    const { gh } = await fresh();
    expect(gh.splitRepo("octocat/hello")).toEqual({ owner: "octocat", repo: "hello" });
    expect(() => gh.splitRepo("octocat")).toThrow(/invalid repository name/);
    expect(() => gh.splitRepo("a/b/c")).toThrow(/invalid repository name/);
  });
});
