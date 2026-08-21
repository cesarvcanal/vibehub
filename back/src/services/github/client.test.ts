import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  return await import("./client.js");
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-gh-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("connect", () => {
  it("validates the token, stores it, and returns the identity", async () => {
    const gh = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
      { login: "octocat", name: "Octo", email: "o@example.com" },
      { headers: { "x-oauth-scopes": "repo, read:org" } },
    )));
    const identity = await gh.connect("ghp_token");
    expect(identity).toEqual({ login: "octocat", name: "Octo", email: "o@example.com", scopes: ["repo", "read:org"] });
    expect(await gh.storedToken()).toBe("ghp_token");
  });

  it("does not store a token GitHub rejects", async () => {
    const gh = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials" }, { status: 401 })));
    await expect(gh.connect("bad")).rejects.toThrow(/401/);
    expect(await gh.storedToken()).toBeUndefined();
  });

  it("refuses an empty token without calling GitHub", async () => {
    const gh = await fresh();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(gh.connect("   ")).rejects.toThrow(/cannot be empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the token as a bearer header, never in the URL", async () => {
    const gh = await fresh();
    const fetchMock = vi.fn(async () => jsonResponse({ login: "octocat", name: null, email: null }));
    vi.stubGlobal("fetch", fetchMock);
    await gh.connect("ghp_secret");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("ghp_secret");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_secret");
  });
});

describe("state", () => {
  it("reports disconnected when there is no token", async () => {
    const gh = await fresh();
    expect(await gh.state()).toEqual({ connected: false });
  });

  it("reports the failure instead of throwing when a stored token died", async () => {
    const gh = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ login: "octocat", name: null, email: null })));
    await gh.connect("ghp_token");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Bad credentials" }, { status: 401 })));
    const s = await gh.state();
    expect(s.connected).toBe(false);
    expect(s.error).toMatch(/401/);
  });

  it("forgets the token on disconnect", async () => {
    const gh = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ login: "octocat", name: null, email: null })));
    await gh.connect("ghp_token");
    await gh.disconnect();
    expect(await gh.storedToken()).toBeUndefined();
  });
});

describe("listRepos", () => {
  const repo = (name: string) => ({
    full_name: name, clone_url: `https://github.com/${name}.git`, private: false,
    default_branch: "main", updated_at: "2026-08-01T00:00:00Z", description: null,
  });

  it("explains itself when GitHub was never connected", async () => {
    const gh = await fresh();
    await expect(gh.listRepos()).rejects.toThrow(/not connected/);
  });

  it("maps the payload and filters by query", async () => {
    const gh = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ login: "octocat", name: null, email: null })));
    await gh.connect("ghp_token");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([repo("octocat/hello"), repo("octocat/world")])));
    expect((await gh.listRepos()).map((r) => r.fullName)).toEqual(["octocat/hello", "octocat/world"]);
    expect((await gh.listRepos("WOR")).map((r) => r.fullName)).toEqual(["octocat/world"]);
  });
});

describe("listBranches", () => {
  it("puts the default branch first", async () => {
    const gh = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ login: "octocat", name: null, email: null })));
    await gh.connect("ghp_token");
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/branches")
        ? jsonResponse([{ name: "feature" }, { name: "main" }])
        : jsonResponse({ default_branch: "main" })));
    expect(await gh.listBranches("octocat", "hello")).toEqual(["main", "feature"]);
  });

  it("rejects path segments that are not repository names", async () => {
    const gh = await fresh();
    await expect(gh.listBranches("../../etc", "repo")).rejects.toThrow(/invalid owner/);
    await expect(gh.listBranches("octocat", "a b")).rejects.toThrow(/invalid repository/);
  });
});

describe("gitAuthHeader / splitRepo", () => {
  it("builds a basic header from the token", async () => {
    const gh = await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ login: "octocat", name: null, email: null })));
    await gh.connect("ghp_token");
    const header = await gh.gitAuthHeader();
    expect(header.startsWith("AUTHORIZATION: basic ")).toBe(true);
    expect(Buffer.from(header.split(" ")[2] ?? "", "base64").toString()).toBe("x-access-token:ghp_token");
  });

  it("splits and validates owner/repo", async () => {
    const gh = await fresh();
    expect(gh.splitRepo("octocat/hello")).toEqual({ owner: "octocat", repo: "hello" });
    expect(() => gh.splitRepo("octocat")).toThrow(/invalid repository name/);
    expect(() => gh.splitRepo("a/b/c")).toThrow(/invalid repository name/);
  });
});
