import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * THE EXTERNAL MCP — an app on the internet (ChatGPT, Claude.ai) connecting through OAuth and
 * driving the board as ONE user: discovery, registration, sign-in, PKCE, and then what that user's
 * token reaches (and does not) on /mcp.
 *
 * Several scrypt hashes per test; the budget is wide on purpose.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const PUBLIC = "https://mcp-vh.example.com";
/** What the edge forwards: the public host, and that the client came in over https. */
const EDGE = { host: "mcp-vh.example.com", "x-forwarded-proto": "https" };
const REDIRECT = "https://chatgpt.com/connector/oauth/abc123";

let dir = "";
let app: FastifyInstance;
const sends: { cardId: string; text: string; opts: Record<string, unknown> }[] = [];
const delivers: { cardId: string; opts: Record<string, unknown> }[] = [];
const opens: string[] = [];

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  env.config.publicUrl = "http://10.0.0.5:3010";
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
    statusUrl: () => "http://vibehub:3010/api/runner/status",
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js");
    return {
      ...actual,
      prepareCard: vi.fn(async () => undefined),
      openCard: vi.fn(async (id: string) => { opens.push(id); return undefined; }),
      reapplyCardIdentity: vi.fn(async () => undefined),
    };
  });
  vi.doMock("../services/maestro/maestro.js", async () => {
    const actual = await vi.importActual<typeof import("../services/maestro/maestro.js")>("../services/maestro/maestro.js");
    return {
      ...actual,
      sendToTerminal: vi.fn(async (cardId: string, text: string, opts: Record<string, unknown>) => {
        sends.push({ cardId, text, opts });
        return { sent: true, cardId, title: "", project: "" };
      }),
      readTerminal: vi.fn(async (cardId: string) => ({ cardId, answers: ["pronto"] })),
    };
  });
  vi.doMock("../services/maestro/deliver.js", () => ({
    deliver: vi.fn(async (cardId: string, opts: Record<string, unknown>) => {
      delivers.push({ cardId, opts });
      return { prUrl: "https://github.com/x/y/pull/1", merged: false, reason: "unauthorized" };
    }),
  }));
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

beforeEach(async () => {
  sends.length = 0;
  delivers.length = 0;
  opens.length = 0;
  dir = await mkdtemp(join(tmpdir(), "vibehub-oauth-"));
  app = await boot();
});
afterEach(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

/** Every request arrives through the edge, as in production. */
type InjectOpts = Parameters<FastifyInstance["inject"]>[0] & { headers?: Record<string, string> };
async function inject(opts: InjectOpts) {
  return await app.inject({ ...(opts as object), headers: { ...EDGE, ...(opts.headers ?? {}) } } as Parameters<FastifyInstance["inject"]>[0]);
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

const form = (fields: Record<string, string>) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: new URLSearchParams(fields).toString(),
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(redirect = REDIRECT): Promise<string> {
  const res = await inject({
    method: "POST", url: "/oauth/register", payload: { client_name: "ChatGPT", redirect_uris: [redirect] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().client_id as string;
}

/** Signs in on the consent page; returns the code the page sends the browser back with. */
async function authorize(clientId: string, challenge: string, username: string, password: string, state = "st") {
  const res = await inject({
    method: "POST", url: "/oauth/authorize",
    ...form({
      client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256",
      state, scope: "mcp", resource: `${PUBLIC}/mcp`, username, password,
    }),
  });
  const match = /window\.location\.replace\("([^"]+)"\)/.exec(res.body);
  const code = match ? new URL(JSON.parse(`"${match[1]}"`)).searchParams.get("code") : null;
  return { res, code, back: match ? new URL(JSON.parse(`"${match[1]}"`)) : null };
}

async function token(clientId: string, code: string, verifier: string) {
  return await inject({
    method: "POST", url: "/oauth/token",
    ...form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }),
  });
}

/** The whole dance, as ChatGPT does it: register, sign in, redeem. */
async function connect(username: string, password: string): Promise<string> {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { code } = await authorize(clientId, challenge, username, password);
  expect(code).toBeTruthy();
  const res = await token(clientId, code as string, verifier);
  expect(res.statusCode).toBe(200);
  return res.json().access_token as string;
}

async function mcp(bearer: string, method: string, params: Record<string, unknown> = {}) {
  const res = await inject({
    method: "POST", url: "/mcp",
    headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  const data = res.body.split("\n").find((l) => l.startsWith("data: "));
  return { res, body: data ? JSON.parse(data.slice(6)) : null };
}

/** Calls one tool and returns the JSON it answered with. */
async function call(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await mcp(bearer, "tools/call", { name, arguments: args });
  return JSON.parse(body.result.content[0].text);
}

interface World { owner: string; memberId: string; projectId: string; cardA: string; cardB: string }

/** An owner with one project and two cards, plus a member ("alex") given nothing yet. */
async function world(): Promise<World> {
  const owner = cookieOf(await inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  }));
  const memberId = (await inject({
    method: "POST", url: "/api/users", headers: { cookie: owner },
    payload: { username: "alex", password: "supersecret", role: "member" },
  })).json().user.id as string;
  const projectId = (await inject({
    method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "erp-aux" },
  })).json().project.id as string;
  const newCard = async (title: string) => (await inject({
    method: "POST", url: "/api/cards", headers: { cookie: owner }, payload: { projectId, title },
  })).json().card.id as string;
  return { owner, memberId, projectId, cardA: await newCard("conciliação"), cardB: await newCard("boletos") };
}

async function share(w: World, cardId: string, level: "work" | "view") {
  const res = await inject({
    method: "POST", url: `/api/cards/${cardId}/shares`, headers: { cookie: w.owner },
    payload: { userId: w.memberId, level },
  });
  expect(res.statusCode).toBeLessThan(300);
}

describe("discovery", () => {
  it("announces the public origin, not the internal one, in both metadata documents", async () => {
    const prm = (await inject({ method: "GET", url: "/.well-known/oauth-protected-resource" })).json();
    expect(prm.resource).toBe(`${PUBLIC}/mcp`);
    expect(prm.authorization_servers).toEqual([PUBLIC]);
    const suffixed = (await inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" })).json();
    expect(suffixed).toEqual(prm);

    const as = (await inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })).json();
    expect(as.issuer).toBe(PUBLIC);
    expect(as.authorization_endpoint).toBe(`${PUBLIC}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${PUBLIC}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${PUBLIC}/oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("a 401 on /mcp points at the protected-resource metadata (how a client learns to sign in)", async () => {
    const res = await inject({ method: "POST", url: "/mcp", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`,
    );
  });

  it("answers each origin with its own URLs — the VPN name gets the VPN name, nothing to configure", async () => {
    const vpn = (await app.inject({
      method: "GET", url: "/.well-known/oauth-authorization-server", headers: { host: "dev.multi" },
    })).json();
    expect(vpn.issuer).toBe("http://dev.multi");
    expect(vpn.token_endpoint).toBe("http://dev.multi/oauth/token");
  });

  it("a malformed Host falls back to the configured public URL instead of echoing it", async () => {
    const res = (await app.inject({
      method: "GET", url: "/.well-known/oauth-authorization-server",
      headers: { host: "evil.com\"><script>", "x-forwarded-proto": "https" },
    })).json();
    expect(res.issuer).toBe("http://10.0.0.5:3010");
  });

  it("an unknown .well-known path is a JSON 404, never the app's HTML", async () => {
    const res = await inject({ method: "GET", url: "/.well-known/openid-configuration" });
    expect(res.statusCode).toBe(404);
  });
});

describe("registration", () => {
  it("refuses a plain-http redirect that is not loopback, and an empty list", async () => {
    for (const redirect_uris of [["http://evil.example.com/cb"], [], "https://x"]) {
      const res = await inject({ method: "POST", url: "/oauth/register", payload: { client_name: "x", redirect_uris } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_redirect_uri");
    }
  });

  it("accepts a loopback http redirect (desktop clients)", async () => {
    const res = await inject({
      method: "POST", url: "/oauth/register", payload: { client_name: "cli", redirect_uris: ["http://127.0.0.1:53111/cb"] },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("authorize", () => {
  it("shows the sign-in page naming the client, and never redirects an unregistered redirect_uri", async () => {
    await world();
    const clientId = await register();
    const { challenge } = pkce();
    const q = (redirect: string) => new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
      code_challenge_method: "S256", state: "s",
    }).toString();

    const page = await inject({ method: "GET", url: `/oauth/authorize?${q(REDIRECT)}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("ChatGPT");
    expect(page.body).toContain('name="password"');

    const evil = await inject({ method: "GET", url: `/oauth/authorize?${q("https://evil.example.com/cb")}` });
    expect(evil.statusCode).toBe(400);
    expect(evil.body).not.toContain("evil.example.com/cb?code");

    const posted = await inject({
      method: "POST", url: "/oauth/authorize",
      ...form({ client_id: clientId, redirect_uri: "https://evil.example.com/cb", code_challenge: challenge,
        code_challenge_method: "S256", username: "owner", password: "supersecret" }),
    });
    expect(posted.statusCode).toBe(400);
    expect(posted.body).not.toContain("code=");
  });

  it("refuses an authorization without PKCE S256, or for another resource", async () => {
    await world();
    const clientId = await register();
    const base = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s" };
    const plain = await inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({ ...base, code_challenge: "x".repeat(43), code_challenge_method: "plain" })}`,
    });
    expect(plain.statusCode).toBe(400);
    const none = await inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams(base)}` });
    expect(none.statusCode).toBe(400);
    const other = await inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({ ...base, code_challenge: pkce().challenge, resource: "https://other.example.com/mcp" })}`,
    });
    expect(other.statusCode).toBe(400);
  });

  it("a wrong password re-renders the page with an error and issues no code", async () => {
    await world();
    const clientId = await register();
    const { res, code } = await authorize(clientId, pkce().challenge, "owner", "wrong-password");
    expect(res.statusCode).toBe(401);
    expect(code).toBeNull();
    expect(res.body).toContain('name="password"');
  });

  it("sends the browser back with the code, the state and the issuer", async () => {
    await world();
    const clientId = await register();
    const { back } = await authorize(clientId, pkce().challenge, "owner", "supersecret", "xyz");
    expect(back?.origin + (back?.pathname ?? "")).toBe(REDIRECT);
    expect(back?.searchParams.get("state")).toBe("xyz");
    expect(back?.searchParams.get("iss")).toBe(PUBLIC);
  });

  it("throttles repeated failures for the same account", async () => {
    await world();
    const clientId = await register();
    const { challenge } = pkce();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await authorize(clientId, challenge, "owner", "nope")).res.statusCode;
    expect(last).toBe(429);
  });
});

describe("token", () => {
  it("redeems a code once, with the right verifier only", async () => {
    await world();
    const clientId = await register();
    const { verifier, challenge } = pkce();

    const first = await authorize(clientId, challenge, "owner", "supersecret");
    const wrong = await token(clientId, first.code as string, pkce().verifier);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("invalid_grant");
    // The failed try burned the code: the right verifier is too late now.
    expect((await token(clientId, first.code as string, verifier)).statusCode).toBe(400);

    const second = await authorize(clientId, challenge, "owner", "supersecret");
    const good = await token(clientId, second.code as string, verifier);
    expect(good.statusCode).toBe(200);
    expect(good.headers["cache-control"]).toBe("no-store");
    expect(good.json()).toMatchObject({ token_type: "Bearer", scope: "mcp" });
    expect(good.json().access_token).toMatch(/^vhm_/);
    // Replay of a redeemed code.
    expect((await token(clientId, second.code as string, verifier)).statusCode).toBe(400);
  });

  it("refuses a code redeemed by another client, and a grant type it does not speak", async () => {
    await world();
    const clientId = await register();
    const otherId = await register();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(clientId, challenge, "owner", "supersecret");
    expect((await token(otherId, code as string, verifier)).statusCode).toBe(400);

    const refresh = await inject({ method: "POST", url: "/oauth/token", ...form({ grant_type: "refresh_token" }) });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json().error).toBe("unsupported_grant_type");
  });

  it("stores the token hashed — the file never holds a usable credential", async () => {
    await world();
    const access = await connect("owner", "supersecret");
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(dir, "oauth.json"), "utf8");
    expect(raw).not.toContain(access);
    expect(raw).toContain(createHash("sha256").update(access).digest("hex"));
  });
});

describe("/mcp with an OAuth token", () => {
  it("serves the external tools — and none of the card-only ones", async () => {
    await world();
    const access = await connect("owner", "supersecret");
    const { res, body } = await mcp(access, "tools/list");
    expect(res.statusCode).toBe(200);
    const names = (body.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual([
      "vibehub_create_card", "vibehub_deliver", "vibehub_list_projects", "vibehub_list_terminals",
      "vibehub_move_cards", "vibehub_open_card", "vibehub_read_terminal", "vibehub_send_to_terminal",
    ]);
    const init = await mcp(access, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chatgpt", version: "1" },
    });
    expect(init.body.result.instructions).toContain("on behalf of the signed-in user");
  });

  it("dies when the user changes the password (every session of theirs ends), and when they are removed", async () => {
    const w = await world();
    const access = await connect("alex", "supersecret");
    expect((await mcp(access, "tools/list")).res.statusCode).toBe(200);

    const alex = cookieOf(await inject({
      method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" },
    }));
    // A password change revokes sessions issued before it; make sure "before" is strictly earlier.
    await new Promise((r) => setTimeout(r, 5));
    const changed = await inject({
      method: "POST", url: "/api/auth/password", headers: { cookie: alex },
      payload: { password: "evenmoresecret" },
    });
    expect(changed.statusCode).toBeLessThan(300);
    expect((await mcp(access, "tools/list")).res.statusCode).toBe(401);

    const again = await connect("alex", "evenmoresecret");
    expect((await mcp(again, "tools/list")).res.statusCode).toBe(200);
    await inject({ method: "DELETE", url: `/api/users/${w.memberId}`, headers: { cookie: w.owner } });
    expect((await mcp(again, "tools/list")).res.statusCode).toBe(401);
  });

  it("a random vhm_ token is refused", async () => {
    expect((await mcp(`vhm_${"a".repeat(43)}`, "tools/list")).res.statusCode).toBe(401);
  });
});

describe("what the token reaches — the owner", () => {
  it("lists every project and card, creates and opens a card, and sends as the owner", async () => {
    const w = await world();
    const access = await connect("owner", "supersecret");

    const projects = await call(access, "vibehub_list_projects");
    expect(projects.canCreateCards).toBe(true);
    expect(projects.projects.map((p: { id: string }) => p.id)).toEqual([w.projectId]);

    const terminals = await call(access, "vibehub_list_terminals");
    expect(terminals.map((t: { cardId: string }) => t.cardId).sort()).toEqual([w.cardA, w.cardB].sort());
    expect(terminals.every((t: { access: string }) => t.access === "work")).toBe(true);

    const created = await call(access, "vibehub_create_card", { projectId: w.projectId, title: "nova tarefa" });
    expect(created).toMatchObject({ title: "nova tarefa", projectId: w.projectId, opened: true });
    expect(opens).toEqual([created.cardId]);

    await call(access, "vibehub_send_to_terminal", { cardId: created.cardId, text: "implemente X" });
    expect(sends).toHaveLength(1);
    expect(sends[0]?.opts).toMatchObject({ origin: { kind: "owner", name: "owner" }, requireAgent: true, guardInteractiveMenu: true });
  });

  it("delivers without merging unless authorized is explicitly true", async () => {
    const w = await world();
    const access = await connect("owner", "supersecret");
    await call(access, "vibehub_deliver", { cardId: w.cardA });
    await call(access, "vibehub_deliver", { cardId: w.cardA, branch: "dev", authorized: true });
    expect(delivers.map((d) => d.opts.authorized)).toEqual([false, true]);
  });
});

describe("what the token reaches — a member", () => {
  it("sees only what was shared, and cannot create cards", async () => {
    const w = await world();
    await share(w, w.cardA, "work");
    const access = await connect("alex", "supersecret");

    const terminals = await call(access, "vibehub_list_terminals");
    expect(terminals.map((t: { cardId: string; access: string }) => [t.cardId, t.access])).toEqual([[w.cardA, "work"]]);

    const projects = await call(access, "vibehub_list_projects");
    expect(projects.canCreateCards).toBe(false);
    expect(projects.projects).toHaveLength(1);

    expect((await call(access, "vibehub_create_card", { projectId: w.projectId, title: "x" })).error).toMatch(/only the owner/);
  });

  it("an unshared card is 'not found' to every tool — no send, read, open, move or deliver reaches it", async () => {
    const w = await world();
    await share(w, w.cardA, "work");
    const access = await connect("alex", "supersecret");

    for (const [name, args] of [
      ["vibehub_send_to_terminal", { cardId: w.cardB, text: "rm -rf" }],
      ["vibehub_read_terminal", { cardId: w.cardB }],
      ["vibehub_open_card", { cardId: w.cardB }],
      ["vibehub_deliver", { cardId: w.cardB, authorized: true }],
    ] as const) {
      expect((await call(access, name, args)).error).toBe("card not found");
    }
    expect(sends).toHaveLength(0);
    expect(delivers).toHaveLength(0);
    expect(opens).toHaveLength(0);

    const moved = await call(access, "vibehub_move_cards", { cards: [w.cardA, w.cardB], column: "done" });
    expect(moved.failed).toBe(1);
    expect(moved.results.find((r: { cardId: string }) => r.cardId === w.cardB)).toMatchObject({ ok: false, error: "card not found" });
    expect(moved.results.find((r: { cardId: string }) => r.cardId === w.cardA)).toMatchObject({ ok: true, column: "done" });
  });

  it("a view share reads but never sends, opens or delivers", async () => {
    const w = await world();
    await share(w, w.cardA, "view");
    const access = await connect("alex", "supersecret");

    expect((await call(access, "vibehub_read_terminal", { cardId: w.cardA })).answers).toEqual(["pronto"]);
    for (const [name, args] of [
      ["vibehub_send_to_terminal", { cardId: w.cardA, text: "oi" }],
      ["vibehub_open_card", { cardId: w.cardA }],
      ["vibehub_deliver", { cardId: w.cardA }],
    ] as const) {
      expect((await call(access, name, args)).error).toMatch(/read-only/);
    }
    expect(sends).toHaveLength(0);
  });

  it("a send on a work share goes out as the member, attributed to them", async () => {
    const w = await world();
    await share(w, w.cardA, "work");
    const access = await connect("alex", "supersecret");
    await call(access, "vibehub_send_to_terminal", { cardId: w.cardA, text: "corrige o teste" });
    expect(sends).toEqual([{ cardId: w.cardA, text: "corrige o teste", opts: expect.objectContaining({
      by: w.memberId, origin: { kind: "user", name: "alex" },
    }) }]);
  });
});
