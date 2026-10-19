import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * SHARING — what a member can reach once a card (or a project) has been handed to them, and what
 * they still cannot.
 *
 * Every test boots a server and scrypt-hashes several passwords; the budget is wide on purpose.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let dir = "";
let app: FastifyInstance;
const accountUsage = vi.fn();

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
  // Creating a card pre-provisions its workspace in the background; there is no Docker here.
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>(
      "../services/board/workspace.js",
    );
    return {
      ...actual,
      prepareCard: vi.fn(async () => undefined),
      openCard: vi.fn(async () => undefined),
      applySessionChange: vi.fn(async () => null),
      killCardSession: vi.fn(async () => undefined),
    };
  });
  // The plan usage reads a credential out of the runner and calls Anthropic; neither exists here.
  vi.doMock("../services/accounts/usage.js", async () => {
    const actual = await vi.importActual<typeof import("../services/accounts/usage.js")>("../services/accounts/usage.js");
    return { ...actual, accountUsage };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

interface World {
  owner: string;
  member: string;
  memberId: string;
  projectId: string;
  cardId: string;
}

/** An owner with one project and one card, plus a member who has been given nothing yet. */
async function world(): Promise<World> {
  const owner = cookieOf(await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  }));
  const created = await app.inject({
    method: "POST", url: "/api/users", headers: { cookie: owner },
    payload: { username: "alex", password: "supersecret", role: "member" },
  });
  const memberId = created.json().user.id as string;
  const member = cookieOf(await app.inject({
    method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" },
  }));
  const projectId = (await app.inject({
    method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "erp-aux" },
  })).json().project.id as string;
  const cardId = (await app.inject({
    method: "POST", url: "/api/cards", headers: { cookie: owner },
    payload: { projectId, title: "conciliação" },
  })).json().card.id as string;
  return { owner, member, memberId, projectId, cardId };
}

async function share(w: World, path: string, id: string, level = "work") {
  return await app.inject({
    method: "POST", url: `/api/${path}/${id}/shares`, headers: { cookie: w.owner },
    payload: { userId: w.memberId, level },
  });
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-shares-")); app = await boot(); });
afterEach(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("a card shared to work on", () => {
  it("puts the card — and the project that holds it — on the member's board", async () => {
    const w = await world();
    expect((await share(w, "cards", w.cardId)).statusCode).toBe(200);

    const cards = await app.inject({ method: "GET", url: "/api/cards", headers: { cookie: w.member } });
    expect(cards.json().cards.map((c: { id: string }) => c.id)).toEqual([w.cardId]);

    // The card has to appear somewhere, and where it appears is under its project.
    const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: w.member } });
    expect(projects.json().projects.map((p: { id: string }) => p.id)).toEqual([w.projectId]);
  });

  it("lets them read it and change it", async () => {
    const w = await world();
    await share(w, "cards", w.cardId);
    expect((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}`, headers: { cookie: w.member } })).statusCode)
      .toBe(200);
    const patched = await app.inject({
      method: "PATCH", url: `/api/cards/${w.cardId}`, headers: { cookie: w.member }, payload: { title: "conciliação v2" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().card.title).toBe("conciliação v2");
  });

  it("does not hand them the OTHER cards of the same project", async () => {
    const w = await world();
    const other = (await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: w.owner },
      payload: { projectId: w.projectId, title: "outra coisa" },
    })).json().card.id as string;
    await share(w, "cards", w.cardId);

    const cards = await app.inject({ method: "GET", url: "/api/cards", headers: { cookie: w.member } });
    expect(cards.json().cards.map((c: { id: string }) => c.id)).toEqual([w.cardId]);
    expect((await app.inject({ method: "GET", url: `/api/cards/${other}`, headers: { cookie: w.member } })).statusCode)
      .toBe(404);
  });

  it("stops the moment it is unshared", async () => {
    const w = await world();
    await share(w, "cards", w.cardId);
    const removed = await app.inject({
      method: "DELETE", url: `/api/cards/${w.cardId}/shares/${w.memberId}`, headers: { cookie: w.owner },
    });
    expect(removed.json()).toMatchObject({ removed: true });
    expect((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}`, headers: { cookie: w.member } })).statusCode)
      .toBe(404);
  });

  it("is idempotent — sharing again only sets the level", async () => {
    const w = await world();
    await share(w, "cards", w.cardId);
    await share(w, "cards", w.cardId, "view");
    const list = await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/shares`, headers: { cookie: w.owner } });
    expect(list.json().shares).toHaveLength(1);
    expect(list.json().shares[0]).toMatchObject({ level: "view", username: "alex" });
  });
});

describe("a card shared read-only", () => {
  it("reads but does not touch", async () => {
    const w = await world();
    await share(w, "cards", w.cardId, "view");

    expect((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}`, headers: { cookie: w.member } })).statusCode)
      .toBe(200);

    for (const [method, url] of [
      ["PATCH", `/api/cards/${w.cardId}`],
      ["POST", `/api/cards/${w.cardId}/messages`],
      ["POST", `/api/cards/${w.cardId}/pause`],
      ["POST", `/api/cards/${w.cardId}/restart`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: w.member }, payload: { title: "x", text: "oi" } });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });

  it("is beaten by a work share on the same card", async () => {
    const w = await world();
    await share(w, "projects", w.projectId, "view");
    await share(w, "cards", w.cardId, "work");
    const patched = await app.inject({
      method: "PATCH", url: `/api/cards/${w.cardId}`, headers: { cookie: w.member }, payload: { title: "meu agora" },
    });
    expect(patched.statusCode).toBe(200);
  });
});

describe("a whole project shared", () => {
  it("carries the cards that exist and the ones created later", async () => {
    const w = await world();
    await share(w, "projects", w.projectId);
    const later = (await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie: w.owner },
      payload: { projectId: w.projectId, title: "criado depois" },
    })).json().card.id as string;

    const cards = await app.inject({ method: "GET", url: "/api/cards", headers: { cookie: w.member } });
    expect(cards.json().cards.map((c: { id: string }) => c.id).sort()).toEqual([w.cardId, later].sort());
  });
});

describe("what sharing never does", () => {
  it("refuses to share with an owner — they already see everything", async () => {
    const w = await world();
    const ownerId = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: w.owner } }))
      .json().users.find((u: { role: string }) => u.role === "owner").id;
    const res = await app.inject({
      method: "POST", url: `/api/cards/${w.cardId}/shares`, headers: { cookie: w.owner }, payload: { userId: ownerId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a share pointing at nothing", async () => {
    const w = await world();
    const res = await app.inject({
      method: "POST", url: "/api/cards/nope/shares", headers: { cookie: w.owner }, payload: { userId: w.memberId },
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not let a member share their own card onwards", async () => {
    const w = await world();
    await share(w, "cards", w.cardId);
    const res = await app.inject({
      method: "POST", url: `/api/cards/${w.cardId}/shares`, headers: { cookie: w.member },
      payload: { userId: w.memberId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not survive the card, the project, or the person", async () => {
    const w = await world();
    await share(w, "cards", w.cardId);
    await share(w, "projects", w.projectId);

    await app.inject({ method: "DELETE", url: `/api/projects/${w.projectId}`, headers: { cookie: w.owner } });
    const list = await app.inject({ method: "GET", url: "/api/cards", headers: { cookie: w.member } });
    expect(list.json().cards).toEqual([]);
    const shares = await app.inject({
      method: "GET", url: `/api/projects/${w.projectId}/shares`, headers: { cookie: w.owner },
    });
    expect(shares.json().shares).toEqual([]);
  });

  it("drops the shares of a removed person", async () => {
    const w = await world();
    await share(w, "cards", w.cardId);
    await app.inject({ method: "DELETE", url: `/api/users/${w.memberId}`, headers: { cookie: w.owner } });
    const shares = await app.inject({
      method: "GET", url: `/api/cards/${w.cardId}/shares`, headers: { cookie: w.owner },
    });
    expect(shares.json().shares).toEqual([]);
  });
});

/**
 * The plan usage of the account a card runs on: a member does not pick the account, but the limit
 * stops their work just the same — so the card's own reading is theirs to see, and nothing more.
 */
describe("the plan usage of a card's account", () => {
  const reading = { available: true, fiveHour: { utilization: 91, resetsAt: "2026-10-19T20:00:00Z" }, fetchedAt: 1 };

  it("is readable by a member the card was shared with, for that card's account only", async () => {
    const w = await world();
    accountUsage.mockResolvedValue(reading);
    // Not shared yet: the card does not exist for them.
    expect((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/usage`, headers: { cookie: w.member } })).statusCode)
      .toBe(404);

    await share(w, "cards", w.cardId);
    const res = await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/usage`, headers: { cookie: w.member } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slug: "default", usage: reading });
    // No pin on the card nor on the project: the runner's built-in profile.
    expect(accountUsage).toHaveBeenCalledWith(undefined);
    // The install-wide listing stays the owner's.
    expect((await app.inject({ method: "GET", url: "/api/accounts/usage", headers: { cookie: w.member } })).statusCode)
      .toBe(403);
  });

  it("answers 401 without a session", async () => {
    const w = await world();
    expect((await app.inject({ method: "GET", url: `/api/cards/${w.cardId}/usage` })).statusCode).toBe(401);
  });
});
