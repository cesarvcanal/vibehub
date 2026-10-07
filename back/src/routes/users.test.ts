import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * ACCESS — the two roles, the routes that manage them, and the cadeado on everything that belongs
 * to the install rather than to a card.
 *
 * The point of most of these is NEGATIVE: a member must not reach the Claude accounts, the vault,
 * the MCP endpoint, the settings, or anybody else's board. Each one is a route that used to answer
 * to "any valid session".
 */

// Every test here boots a whole server and scrypt-hashes a handful of passwords (creating the
// owner, creating a member, signing them in), which is deliberately expensive work. The default
// 5s/10s budget is too tight for that on a busy machine — the assertions are what matter here, not
// the clock.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let dir = "";
let app: FastifyInstance;
/** How many times the GitHub connection list was read (see boot). */
let connectionLookups = 0;

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  // The REAL registry, with its connection list counted: one patch should look the list up once.
  connectionLookups = 0;
  vi.doMock("../services/board/registry.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../services/board/registry.js")>();
    return {
      ...real,
      listGithubConnections: async () => { connectionLookups += 1; return await real.listGithubConnections(); },
    };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

async function signUpOwner(server: FastifyInstance): Promise<string> {
  return cookieOf(await server.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  }));
}

async function addMember(server: FastifyInstance, owner: string, username = "alex"): Promise<string> {
  await server.inject({
    method: "POST", url: "/api/users", headers: { cookie: owner },
    payload: { username, password: "supersecret", role: "member" },
  });
  return cookieOf(await server.inject({
    method: "POST", url: "/api/auth/login", payload: { username, password: "supersecret" },
  }));
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-users-")); app = await boot(); });
afterEach(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("a person's git identity (commit author + GitHub connection)", () => {
  /** Connects a GitHub account so there is a real connection id to point at. */
  async function connect(owner: string, label: string, login: string): Promise<string> {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ login, name: login, email: `${login}@users.noreply.github.com` }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const res = await app.inject({
      method: "POST", url: "/api/github/connections", headers: { cookie: owner },
      payload: { label, token: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().connection.id as string;
  }

  async function memberId(owner: string, username: string): Promise<string> {
    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } });
    return list.json().users.find((u: { username: string }) => u.username === username).id as string;
  }

  it("o owner vincula conexão e autor do commit; a lista passa a devolver junto", async () => {
    const owner = await signUpOwner(app);
    await addMember(app, owner, "mussa");
    const id = await memberId(owner, "mussa");
    const connection = await connect(owner, "mussa", "wellesley-mussolini");

    const res = await app.inject({
      method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner },
      payload: { githubConnectionId: connection, gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().git).toEqual({
      githubConnectionId: connection, gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com",
    });

    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } });
    expect(list.json().users.find((u: { id: string }) => u.id === id).git.gitEmail).toBe("xerif.off@gmail.com");
  });

  it("um PATCH valida a conexão UMA vez — não de novo na hora de gravar", async () => {
    const owner = await signUpOwner(app);
    await addMember(app, owner, "mussa");
    const id = await memberId(owner, "mussa");
    const connection = await connect(owner, "mussa", "wellesley-mussolini");
    connectionLookups = 0;
    const res = await app.inject({
      method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner }, payload: { githubConnectionId: connection },
    });
    expect(res.statusCode).toBe(200);
    expect(connectionLookups).toBe(1);
  });

  it("conexão que não existe é recusada ANTES de gravar qualquer coisa", async () => {
    const owner = await signUpOwner(app);
    await addMember(app, owner, "mussa");
    const id = await memberId(owner, "mussa");
    const res = await app.inject({
      method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner },
      payload: { githubConnectionId: "nao-existe", gitName: "mussa" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/GitHub connection/i);

    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } });
    expect(list.json().users.find((u: { id: string }) => u.id === id).git).toBeUndefined();
  });

  it("e-mail inválido é recusado — ele vai pra dentro de um script no runner", async () => {
    const owner = await signUpOwner(app);
    await addMember(app, owner, "mussa");
    const id = await memberId(owner, "mussa");
    const res = await app.inject({
      method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner },
      payload: { gitEmail: "a$(whoami)@x.com" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("um PATCH com um campo inválido não grava NADA — nem o papel, nem a senha", async () => {
    const owner = await signUpOwner(app);
    await addMember(app, owner, "mussa");
    const id = await memberId(owner, "mussa");
    for (const payload of [
      { role: "owner", password: "brandnewsecret", gitEmail: "a$(whoami)@x.com" },
      { role: "owner", password: "brandnewsecret", githubConnectionId: "nao-existe" },
      { role: "owner", password: "short" },
    ]) {
      const res = await app.inject({ method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner }, payload });
      expect(res.statusCode).toBe(400);
    }
    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } });
    expect(list.json().users.find((u: { id: string }) => u.id === id).role).toBe("member");
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "mussa", password: "supersecret" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("cada um troca a PRÓPRIA identidade sem depender do owner", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner, "mussa");
    const connection = await connect(owner, "mussa", "wellesley-mussolini");

    const res = await app.inject({
      method: "PATCH", url: "/api/me/git", headers: { cookie: member },
      payload: { githubConnectionId: connection, gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().git.gitName).toBe("wellesley-mussolini");

    const mine = await app.inject({ method: "GET", url: "/api/me/git", headers: { cookie: member } });
    expect(mine.json().git.gitEmail).toBe("xerif.off@gmail.com");
  });

  it("o membro NÃO grava a identidade de outro, nem vira owner por essa porta", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner, "mussa");
    const ownerId = await memberId(owner, "owner");

    // A rota do owner continua fechada pra ele...
    const other = await app.inject({
      method: "PATCH", url: `/api/users/${ownerId}`, headers: { cookie: member },
      payload: { gitName: "mussa" },
    });
    expect(other.statusCode).toBe(403);

    // ...e a dele próprio NÃO aceita papel nem senha de carona.
    const escalate = await app.inject({
      method: "PATCH", url: "/api/me/git", headers: { cookie: member },
      payload: { role: "owner", password: "outrasenha123", gitName: "mussa" },
    });
    expect(escalate.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: member } });
    expect(me.json().user.role).toBe("member");
    // a senha antiga continua valendo: o PATCH de identidade não a trocou
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "mussa", password: "supersecret" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("remover o usuário leva a identidade dele embora", async () => {
    const owner = await signUpOwner(app);
    await addMember(app, owner, "mussa");
    const id = await memberId(owner, "mussa");
    await app.inject({
      method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner }, payload: { gitName: "mussa" },
    });
    await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: { cookie: owner } });

    // Recriado com o MESMO nome, ganha id novo e NÃO herda a identidade antiga.
    await addMember(app, owner, "mussa");
    const again = await memberId(owner, "mussa");
    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } });
    expect(list.json().users.find((u: { id: string }) => u.id === again).git).toBeUndefined();
  });
});

describe("the owner's user list", () => {
  it("two setup requests racing on a fresh install create ONE owner — the other gets 409", async () => {
    // Both pass a "nobody exists yet" check made BEFORE the scrypt hash unless the check lives in
    // the same serialized mutation that writes the user.
    const [a, b] = await Promise.all(["first", "second"].map((username) => app.inject({
      method: "POST", url: "/api/setup/owner", payload: { username, password: "supersecret" },
    })));
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 409]);
    const { listUsers } = await import("../auth/users.js");
    expect(await listUsers()).toHaveLength(1);
  });

  it("makes the setup wizard's account an owner", async () => {
    const owner = await signUpOwner(app);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } });
    expect(me.json()).toMatchObject({ user: { username: "owner", role: "owner" } });
  });

  it("creates a member who can then sign in", async () => {
    const owner = await signUpOwner(app);
    const created = await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: owner },
      payload: { username: "alex", password: "supersecret" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ user: { username: "alex", role: "member" } });

    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { role: "member" } });
  });

  it("never answers with a password hash", async () => {
    const owner = await signUpOwner(app);
    await addMember(app, owner);
    const res = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toMatch(/hash|salt/);
  });

  it("resets a password and changes a role", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const id = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } }))
      .json().users.find((u: { username: string }) => u.username === "alex").id;

    const res = await app.inject({
      method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner },
      payload: { password: "brandnewsecret", role: "owner" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { role: "owner" } });
    expect(member).toBeTruthy();
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "brandnewsecret" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("removes a member", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const id = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } }))
      .json().users.find((u: { username: string }) => u.username === "alex").id;

    expect((await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: { cookie: owner } })).statusCode)
      .toBe(200);
    // The session of a removed user stops working, because there is no account behind it any more.
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: member } });
    expect(me.statusCode).toBe(401);
    // ...and /me — the route the app asks on boot — tells the browser to drop the dead cookie,
    // instead of it being replayed (and refused) on every request until it expires.
    expect(String(me.headers["set-cookie"])).toMatch(/vibehub_session=;/);
  });

  it("/me with NO cookie is a plain 401 — nothing to clear", async () => {
    const me = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(401);
    expect(me.headers["set-cookie"]).toBeUndefined();
  });

  it("a removed member's cookie opens NO session route — and cannot recreate their records", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const id = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } }))
      .json().users.find((u: { username: string }) => u.username === "alex").id;
    await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: { cookie: owner } });

    const write = await app.inject({
      method: "PATCH", url: "/api/me/git", headers: { cookie: member }, payload: { gitName: "ghost" },
    });
    expect(write.statusCode).toBe(401);
    const { getUserGit } = await import("../auth/userGit.js");
    expect(await getUserGit(id)).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: member } })).statusCode)
      .toBe(401);
  });

  it("a password reset by the owner ends the sessions that were already open", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const id = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } }))
      .json().users.find((u: { username: string }) => u.username === "alex").id;
    await app.inject({
      method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner }, payload: { password: "brandnewsecret" },
    });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: member } })).statusCode)
      .toBe(401);
    // The owner did it to somebody else: the owner's own session is untouched.
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } })).statusCode)
      .toBe(200);
  });

  it("changing YOUR OWN password keeps you signed in on the new cookie, and the old one stops", async () => {
    const owner = await signUpOwner(app);
    const res = await app.inject({
      method: "POST", url: "/api/auth/password", headers: { cookie: owner }, payload: { password: "anothersecret" },
    });
    expect(res.statusCode).toBe(200);
    const fresh = cookieOf(res);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: fresh } })).statusCode)
      .toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } })).statusCode)
      .toBe(401);
  });

  it("refuses to demote or remove the last owner", async () => {
    const owner = await signUpOwner(app);
    const id = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: owner } }))
      .json().users[0].id;

    const demote = await app.inject({
      method: "PATCH", url: `/api/users/${id}`, headers: { cookie: owner }, payload: { role: "member" },
    });
    expect(demote.statusCode).toBe(400);
    expect(demote.json().error).toMatch(/last owner/i);

    const removed = await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: { cookie: owner } });
    expect(removed.statusCode).toBe(400);
  });

  it("rejects an unknown role", async () => {
    const owner = await signUpOwner(app);
    const res = await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: owner },
      payload: { username: "ghost", password: "supersecret", role: "admin" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("what a member cannot reach", () => {
  it("cannot see or manage the user list", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    expect((await app.inject({ method: "GET", url: "/api/users", headers: { cookie: member } })).statusCode).toBe(403);
    const created = await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: member },
      payload: { username: "mole", password: "supersecret", role: "owner" },
    });
    expect(created.statusCode).toBe(403);
  });

  it("cannot reach the install: settings, accounts, mcps, brain, github, runner", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    for (const url of ["/api/settings", "/api/accounts", "/api/accounts/tokens", "/api/mcps", "/api/brain",
      "/api/github", "/api/runner"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: member } });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });

  it("cannot create or delete projects", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const created = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: member }, payload: { name: "theirs" },
    });
    expect(created.statusCode).toBe(403);
  });

  it("cannot store the install's voice keys", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const res = await app.inject({
      method: "POST", url: "/api/transcribe/keys", headers: { cookie: member }, payload: { openaiKey: "sk-nope" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("sees an empty board while nothing is shared with them", async () => {
    const owner = await signUpOwner(app);
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "mine" },
    });
    const member = await addMember(app, owner);

    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: member } });
    expect(projects.statusCode).toBe(200);
    expect(projects.json().projects).toEqual([]);

    const cards = await app.inject({ method: "GET", url: "/api/cards", headers: { cookie: member } });
    expect(cards.json().cards).toEqual([]);
  });

  it("cannot open a card that is not theirs — and is told it does not exist", async () => {
    const owner = await signUpOwner(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "mine" },
    })).json().project;
    const card = (await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: owner },
      payload: { projectId: project.id, title: "secret work" },
    })).json().card;
    const member = await addMember(app, owner);

    const read = await app.inject({ method: "GET", url: `/api/cards/${card.id}`, headers: { cookie: member } });
    expect(read.statusCode).toBe(404);
    const write = await app.inject({
      method: "PATCH", url: `/api/cards/${card.id}`, headers: { cookie: member }, payload: { title: "mine now" },
    });
    expect(write.statusCode).toBe(404);
  });

  it("cannot drive the board through the MCP endpoint", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const res = await app.inject({
      method: "POST", url: "/mcp", headers: { cookie: member, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("can still ask whether voice input works — it is a boolean, not a key", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const res = await app.inject({ method: "GET", url: "/api/transcribe", headers: { cookie: member } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toMatch(/sk-/);
  });

  it("can still change their own password", async () => {
    const owner = await signUpOwner(app);
    const member = await addMember(app, owner);
    const res = await app.inject({
      method: "POST", url: "/api/auth/password", headers: { cookie: member }, payload: { password: "anothersecret" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("an install that predates roles", () => {
  it("reads its users as owners", async () => {
    // users.json as it was written before the role field existed.
    await writeFile(join(dir, "users.json"), JSON.stringify({
      users: [{ id: "abc", username: "legacy", hash: "00", salt: "00", createdAt: "2026-01-01T00:00:00.000Z" }],
    }), "utf8");
    await app.close();
    app = await boot();
    const { issueToken } = await import("../auth/session.js");
    const cookie = `vibehub_session=${await issueToken("abc")}`;
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { username: "legacy", role: "owner" } });
  });
});
