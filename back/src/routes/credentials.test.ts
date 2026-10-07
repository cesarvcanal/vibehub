import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * COFRE routes — who may turn a captured login into a saved credential, and which captures a card's
 * routes may touch.
 *
 * Credential CRUD is INSTALL-level (owner only): saving a capture CREATES a credential, so it is the
 * owner's call too, whatever share a member holds on the card. And a capture belongs to the card
 * whose browser saw it — the `:id` in the URL is not decoration.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let dir = "";
let app: FastifyInstance;

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
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
  cardA: string;
  cardB: string;
  /** A pending capture seen by card B's browser. */
  captureB: string;
}

/** An owner, a member who WORKS on card A, card B (not theirs) with one pending capture. */
async function world(): Promise<World> {
  const owner = cookieOf(await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  }));
  const created = await app.inject({
    method: "POST", url: "/api/users", headers: { cookie: owner },
    payload: { username: "alex", password: "supersecret", role: "member" },
  });
  const member = cookieOf(await app.inject({
    method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" },
  }));
  const registry = await import("../services/board/registry.js");
  const project = await registry.createProject({ name: "erp" });
  const cardA = (await registry.createCard({ projectId: project.id, title: "A" })).id;
  const cardB = (await registry.createCard({ projectId: project.id, title: "B" })).id;
  await registry.shareWith({ kind: "card", targetId: cardA, userId: created.json().user.id as string, level: "work" });
  const capture = await import("../services/credentials/capture.js");
  capture.recordCapture(cardB, { url: "https://erp.example.com/login", username: "fin", password: "s3cret" });
  const captureB = capture.listCaptures(cardB)[0]!.id;
  return { owner, member, cardA, cardB, captureB };
}

async function credentialNames(owner: string): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: "/api/credentials", headers: { cookie: owner } });
  return (res.json().credentials as { name: string }[]).map((c) => c.name);
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-cred-routes-")); app = await boot(); });
afterEach(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

describe("POST /api/cards/:id/captures/save", () => {
  it("is the owner's: a member working on the card cannot create a credential in the Cofre", async () => {
    const w = await world();
    const capture = await import("../services/credentials/capture.js");
    capture.recordCapture(w.cardA, { url: "https://a.example.com", username: "u", password: "p" });
    const captureA = capture.listCaptures(w.cardA)[0]!.id;

    const res = await app.inject({
      method: "POST", url: `/api/cards/${w.cardA}/captures/save`, headers: { cookie: w.member },
      payload: { captureId: captureA, name: "a-login" },
    });
    expect(res.statusCode).toBe(403);
    expect(await credentialNames(w.owner)).toEqual([]);
    // The capture is still pending for the owner to decide.
    expect(capture.listCaptures(w.cardA).map((c) => c.id)).toEqual([captureA]);
  });

  it("refuses a capture of ANOTHER card, even for the owner — the :id is the capture's card", async () => {
    const w = await world();
    const res = await app.inject({
      method: "POST", url: `/api/cards/${w.cardA}/captures/save`, headers: { cookie: w.owner },
      payload: { captureId: w.captureB, name: "stolen" },
    });
    expect(res.statusCode).toBe(404);
    expect(await credentialNames(w.owner)).toEqual([]);
  });

  it("saves the owner's own card capture", async () => {
    const w = await world();
    const res = await app.inject({
      method: "POST", url: `/api/cards/${w.cardB}/captures/save`, headers: { cookie: w.owner },
      payload: { captureId: w.captureB, name: "erp-fin" },
    });
    expect(res.statusCode).toBe(200);
    expect(await credentialNames(w.owner)).toEqual(["erp-fin"]);
  });
});

describe("POST /api/cards/:id/captures/dismiss", () => {
  it("cannot discard ANOTHER card's capture through a card the caller works on", async () => {
    const w = await world();
    const res = await app.inject({
      method: "POST", url: `/api/cards/${w.cardA}/captures/dismiss`, headers: { cookie: w.member },
      payload: { captureId: w.captureB },
    });
    expect(res.json()).toEqual({ ok: false });
    const capture = await import("../services/credentials/capture.js");
    expect(capture.listCaptures(w.cardB).map((c) => c.id)).toEqual([w.captureB]);
  });

  it("discards a capture of the card in the URL", async () => {
    const w = await world();
    const res = await app.inject({
      method: "POST", url: `/api/cards/${w.cardB}/captures/dismiss`, headers: { cookie: w.owner },
      payload: { captureId: w.captureB },
    });
    expect(res.json()).toEqual({ ok: true });
  });
});
