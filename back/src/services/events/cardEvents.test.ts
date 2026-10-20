import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CARD EVENTS — the board's own record of the moments a person away from it must hear about: a card
 * finished its turn, asked a question, waits for a permission, or declared it needs them. Real
 * registry, users and shares against a temp data dir; nothing reaches a runner.
 */

let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  const registry = await import("../board/registry.js");
  const users = await import("../../auth/users.js");
  const events = await import("./cardEvents.js");
  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  const project = await registry.createProject({ name: "erp" });
  const card = await registry.createCard({ projectId: project.id, title: "login" });
  return { registry, users, events, owner, member, project, card };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-events-warmup-"));
  await load();
  await rm(dir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-events-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const Q = [{ question: "Qual banco?", options: [{ label: "Mongo (recomendado)" }, { label: "MySQL" }] }];

describe("recording and reading", () => {
  it("an event lands in the inbox of whoever reaches the card, with the card's title", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "question:q1", cardId: env.card.id, kind: "question", refId: "q1", questions: Q });
    const inbox = await env.events.inboxFor(env.owner);
    expect(inbox.events).toHaveLength(1);
    expect(inbox.events[0]).toMatchObject({ id: "question:q1", cardId: env.card.id, title: "login", kind: "question", questions: Q });
    expect(inbox.cursor).toBe(inbox.events[0]!.seq);
  });

  it("is idempotent by id: the same moment reported twice is one event", async () => {
    const env = await load();
    const first = await env.events.recordCardEvent({ id: "question:q1", cardId: env.card.id, kind: "question", refId: "q1" });
    const again = await env.events.recordCardEvent({ id: "question:q1", cardId: env.card.id, kind: "question", refId: "q1" });
    expect(first).not.toBeNull();
    expect(again).toBeNull();
    expect((await env.events.inboxFor(env.owner)).events).toHaveLength(1);
  });

  it("an unknown card records nothing", async () => {
    const env = await load();
    expect(await env.events.recordCardEvent({ id: "x", cardId: "nope", kind: "turn_finished" })).toBeNull();
  });

  it("`since` returns only what is newer than a previous cursor", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "a", cardId: env.card.id, kind: "turn_finished" });
    const { cursor } = await env.events.inboxFor(env.owner);
    await env.events.recordCardEvent({ id: "b", cardId: env.card.id, kind: "permission", refId: "p1", tool: "Bash" });
    const newer = await env.events.inboxFor(env.owner, { since: cursor });
    expect(newer.events.map((e) => e.id)).toEqual(["b"]);
  });

  it("survives a restart of the process (it is on disk)", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "a", cardId: env.card.id, kind: "turn_finished" });
    vi.resetModules();
    const config = await import("../../config/env.js");
    config.config.dataDir = dir;
    const fresh = await import("./cardEvents.js");
    expect((await fresh.inboxFor(env.owner)).events.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("resolution — what is no longer waiting leaves the inbox", () => {
  it("answering a question resolves it (by the question's id)", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "question:q1", cardId: env.card.id, kind: "question", refId: "q1" });
    await env.events.recordCardEvent({ id: "turn:1", cardId: env.card.id, kind: "turn_finished" });
    expect(await env.events.resolveCardEvents(env.card.id, { refId: "q1" })).toBe(1);
    expect((await env.events.inboxFor(env.owner)).events.map((e) => e.id)).toEqual(["turn:1"]);
  });

  it("a new turn resolves everything the card had open", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "question:q1", cardId: env.card.id, kind: "question", refId: "q1" });
    await env.events.recordCardEvent({ id: "turn:1", cardId: env.card.id, kind: "turn_finished" });
    expect(await env.events.resolveCardEvents(env.card.id)).toBe(2);
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });

  it("a new declaration of needing the user replaces the previous one", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "state:1", cardId: env.card.id, kind: "needs_me", state: "needs_me", summary: "escolha o banco" });
    await env.events.recordCardEvent({ id: "state:2", cardId: env.card.id, kind: "needs_me", state: "blocked", summary: "sem acesso ao repo" });
    const ids = (await env.events.inboxFor(env.owner)).events.map((e) => e.id);
    expect(ids).toEqual(["state:2"]);
  });

  it("a card concluded or paused no longer shows its events", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "turn:1", cardId: env.card.id, kind: "turn_finished" });
    await env.registry.updateCard(env.card.id, { column: "done" });
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });
});

describe("who hears about it", () => {
  it("a member hears nothing about a card that was not shared with them", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "turn:1", cardId: env.card.id, kind: "turn_finished" });
    expect((await env.events.inboxFor(env.member)).events).toEqual([]);
    await env.registry.shareWith({ kind: "card", targetId: env.card.id, userId: env.member.id, level: "view" });
    expect((await env.events.inboxFor(env.member)).events).toHaveLength(1);
  });

  it("a card someone else is working hears only to them, not to everyone who can see it", async () => {
    const env = await load();
    await env.registry.shareWith({ kind: "card", targetId: env.card.id, userId: env.member.id, level: "work" });
    await env.registry.stampCardActor(env.card.id, env.member.id);
    await env.events.recordCardEvent({ id: "turn:1", cardId: env.card.id, kind: "turn_finished" });
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
    expect((await env.events.inboxFor(env.member)).events).toHaveLength(1);
  });
});

describe("takeUndelivered — each event is handed to a person once", () => {
  it("returns what is new for that person and then nothing, until something else happens", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "a", cardId: env.card.id, kind: "turn_finished" });
    expect((await env.events.takeUndelivered(env.owner)).map((e) => e.id)).toEqual(["a"]);
    expect(await env.events.takeUndelivered(env.owner)).toEqual([]);
    await env.events.recordCardEvent({ id: "b", cardId: env.card.id, kind: "permission", refId: "p1" });
    expect((await env.events.takeUndelivered(env.owner)).map((e) => e.id)).toEqual(["b"]);
  });

  it("one person taking their events does not take them from another", async () => {
    const env = await load();
    await env.registry.shareWith({ kind: "card", targetId: env.card.id, userId: env.member.id, level: "view" });
    await env.events.recordCardEvent({ id: "a", cardId: env.card.id, kind: "turn_finished" });
    expect(await env.events.takeUndelivered(env.owner)).toHaveLength(1);
    expect(await env.events.takeUndelivered(env.member)).toHaveLength(1);
  });

  it("two calls at the same time hand an event over once, not twice", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "a", cardId: env.card.id, kind: "turn_finished" });
    const [x, y] = await Promise.all([env.events.takeUndelivered(env.owner), env.events.takeUndelivered(env.owner)]);
    expect(x.length + y.length).toBe(1);
  });

  it("markDelivered counts what the person was shown up to a position as heard", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "a", cardId: env.card.id, kind: "turn_finished" });
    const { events } = await env.events.inboxFor(env.owner);
    await env.events.recordCardEvent({ id: "b", cardId: env.card.id, kind: "permission", refId: "p1" });
    await env.events.markDelivered(env.owner, events[0]!.seq);
    expect((await env.events.takeUndelivered(env.owner)).map((e) => e.id)).toEqual(["b"]);
  });

  it("the inbox still lists what was already handed over (delivered is not resolved)", async () => {
    const env = await load();
    await env.events.recordCardEvent({ id: "a", cardId: env.card.id, kind: "turn_finished" });
    await env.events.takeUndelivered(env.owner);
    expect((await env.events.inboxFor(env.owner)).events).toHaveLength(1);
  });
});

describe("pruneCardEvents (retention) — PURE", () => {
  it("drops resolved events past the retention and keeps open ones", async () => {
    const { pruneCardEvents, RESOLVED_RETENTION_MS } = await import("./cardEvents.js");
    const now = 1_800_000_000_000;
    const base = { cardId: "c", kind: "turn_finished" as const, title: "t" };
    const kept = pruneCardEvents([
      { ...base, seq: 1, id: "old-resolved", at: now - RESOLVED_RETENTION_MS - 10, resolvedAt: now - RESOLVED_RETENTION_MS - 1 },
      { ...base, seq: 2, id: "old-open", at: now - RESOLVED_RETENTION_MS - 10 },
      { ...base, seq: 3, id: "fresh-resolved", at: now - 10, resolvedAt: now - 5 },
    ], now);
    expect(kept.map((e) => e.id)).toEqual(["old-open", "fresh-resolved"]);
  });

  it("caps the log at the newest MAX_EVENTS", async () => {
    const { pruneCardEvents, MAX_EVENTS } = await import("./cardEvents.js");
    const now = 1_800_000_000_000;
    const many = Array.from({ length: MAX_EVENTS + 3 }, (_, i) => ({
      seq: i + 1, id: `e${i + 1}`, cardId: "c", kind: "turn_finished" as const, title: "t", at: now,
    }));
    const kept = pruneCardEvents(many, now);
    expect(kept).toHaveLength(MAX_EVENTS);
    expect(kept[0]!.id).toBe("e4");
  });
});

describe("observers — where the moments come from", () => {
  it("a turn that ends (working → waiting) is a turn_finished, carrying what the card declared", async () => {
    const env = await load();
    await env.registry.reportCardState(env.card.id, "ready", "login pronto, testes verdes");
    await env.events.observeCardStatus(env.card.id, "working", "waiting");
    const [e] = (await env.events.inboxFor(env.owner)).events;
    expect(e).toMatchObject({ kind: "turn_finished", cardId: env.card.id, state: "ready", summary: "login pronto, testes verdes" });
  });

  it("a status that does not end a turn records nothing", async () => {
    const env = await load();
    await env.events.observeCardStatus(env.card.id, "waiting", "waiting");
    await env.events.observeCardStatus(env.card.id, null, "waiting");
    await env.events.observeCardStatus(env.card.id, "working", "working");
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });

  it("a turn that starts resolves what the card had open", async () => {
    const env = await load();
    await env.events.observeCardStatus(env.card.id, "working", "waiting");
    await env.events.observeCardStatus(env.card.id, "waiting", "working");
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });

  it("the native chat's question card is a question, and its result resolves it", async () => {
    const env = await load();
    await env.events.observeDriverEvent(env.card.id, { type: "user_question", id: "q1", questions: Q });
    expect((await env.events.inboxFor(env.owner)).events[0]).toMatchObject({ kind: "question", refId: "q1", questions: Q });
    await env.events.observeDriverEvent(env.card.id, { type: "question_result", id: "q1", superseded: true });
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });

  it("a permission request is a permission, and its decision resolves it", async () => {
    const env = await load();
    await env.events.observeDriverEvent(env.card.id, { type: "permission_request", id: "p1", tool: "Bash", reason: "git push" });
    expect((await env.events.inboxFor(env.owner)).events[0]).toMatchObject({ kind: "permission", refId: "p1", tool: "Bash", reason: "git push" });
    await env.events.observeDriverEvent(env.card.id, { type: "permission", id: "p1", tool: "Bash", decision: "allow", sensitive: true });
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });

  it("the rest of the chat's stream records nothing", async () => {
    const env = await load();
    await env.events.observeDriverEvent(env.card.id, { type: "assistant_text", text: "oi" } as never);
    await env.events.observeDriverEvent(env.card.id, { type: "permission", tool: "Read", decision: "allow", sensitive: false });
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });

  it("a question and its result arriving together still end resolved (arrival order is kept)", async () => {
    const env = await load();
    await Promise.all([
      env.events.observeDriverEvent(env.card.id, { type: "user_question", id: "q1", questions: Q }),
      env.events.observeDriverEvent(env.card.id, { type: "question_result", id: "q1", superseded: true }),
    ]);
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });

  it("two hooks reporting the same end of turn record it once", async () => {
    const env = await load();
    await Promise.all([
      env.events.observeCardStatus(env.card.id, "working", "waiting"),
      env.events.observeCardStatus(env.card.id, "working", "waiting"),
    ]);
    expect((await env.events.inboxFor(env.owner)).events).toHaveLength(1);
  });

  it("declaring anything else after needs_me closes it — the card moved on", async () => {
    const env = await load();
    await env.events.observeDeclaredState(env.card.id, "needs_me", "qual banco?");
    await env.events.observeDeclaredState(env.card.id, "ready", "pronto");
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
  });

  it("declaring needs_me or blocked is a needs_me; ready or working is not", async () => {
    const env = await load();
    await env.events.observeDeclaredState(env.card.id, "ready", "pronto");
    await env.events.observeDeclaredState(env.card.id, "working", "seguindo");
    expect((await env.events.inboxFor(env.owner)).events).toEqual([]);
    await env.events.observeDeclaredState(env.card.id, "blocked", "sem acesso ao repo");
    expect((await env.events.inboxFor(env.owner)).events[0]).toMatchObject({ kind: "needs_me", state: "blocked", summary: "sem acesso ao repo" });
  });
});
