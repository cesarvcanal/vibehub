import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Webhook } from "standardwebhooks";
import { echoChallenge, startTestReceiver, type Received, type TestReceiver } from "../../testkit/webhookReceiver.js";

/**
 * MCP EVENTS WEBHOOK SUBSCRIPTIONS — the server side of `events/subscribe` / `events/unsubscribe`
 * and the deliveries that follow, against a REAL HTTPS receiver: every signature below is checked by
 * the official Standard Webhooks library over the exact bytes the receiver got.
 *
 * Time is passed in (`pumpWebhooks(now)`), so retries and expiry are exact, not slept on.
 */

const TOKEN = "runner-token-for-the-mcp";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => `whsec_${randomBytes(32).toString("base64")}`;

let dir = "";
let receiver: TestReceiver;
/** Credentials the "OAuth server" still honours: hash → user id. */
const live = new Map<string, string>();

beforeAll(async () => { receiver = await startTestReceiver(); });
afterAll(async () => { await receiver.close(); });

async function boot() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  vi.doMock("../../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined), startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => TOKEN), statusUrl: () => "http://vibehub:3010/api/runner/status",
    runnerStatus: vi.fn(async () => ({ running: true })),
  }));
  const users = await import("../../auth/users.js");
  vi.doMock("../../auth/oauth.js", async (original) => ({
    ...(await original<typeof import("../../auth/oauth.js")>()),
    userForAccessTokenHash: vi.fn(async (hash: string) => {
      const id = live.get(hash);
      return id ? await users.findUser(id) : null;
    }),
  }));
  const net = await import("./net.js");
  Object.assign(net.WEBHOOK_NET, { allowPrivate: true, resolve: async () => ["127.0.0.1"], ca: receiver.cert, timeoutMs: 2_000 });
  const webhooks = await import("./subscriptions.js");
  const registry = await import("../board/registry.js");
  const events = await import("../events/cardEvents.js");
  return { users, net, webhooks, registry, events };
}

let env: Awaited<ReturnType<typeof boot>>;
let owner: { id: string; role: string };
let member: { id: string; role: string };
let project: { id: string };
let other: { id: string };
let card: { id: string };
let hidden: { id: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-webhooks-"));
  live.clear();
  receiver.received.length = 0;
  receiver.respond = echoChallenge;
  env = await boot();
  owner = env.users.publicUser(await env.users.createUser("cesar", "senha-forte-123", "owner"));
  member = env.users.publicUser(await env.users.createUser("mussa", "senha-forte-456", "member"));
  project = await env.registry.createProject({ name: "erp" });
  other = await env.registry.createProject({ name: "bank" });
  card = await env.registry.createCard({ projectId: project.id, title: "login" });
  hidden = await env.registry.createCard({ projectId: other.id, title: "extrato" });
  await env.registry.shareWith({ kind: "project", targetId: project.id, userId: member.id, level: "work" });
  live.set(sha("tok-owner"), owner.id);
  live.set(sha("tok-member"), member.id);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const asOwner = () => ({ key: `user:${owner.id}`, user: owner as never, credential: sha("tok-owner") });
const asMember = () => ({ key: `user:${member.id}`, user: member as never, credential: sha("tok-member") });
const asBoard = () => ({ key: "board", user: null, credential: sha(TOKEN) });

function params(over: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) {
  return {
    name: "card.event", arguments: {}, cursor: null,
    ...over,
    delivery: { mode: "webhook", url: receiver.url(), secret: SECRET, ...delivery },
  };
}
let SECRET = secret();
beforeEach(() => { SECRET = secret(); });

/** Event deliveries (not the verification). */
const deliveries = (): Received[] => receiver.received.filter((r) => !JSON.parse(r.body).type);
const verifications = (): Received[] => receiver.received.filter((r) => JSON.parse(r.body).type === "verification");

/** Verifies like a receiver does: official library, exact bytes, the subscription's secret. */
function verify(r: Received, key = SECRET) {
  return new Webhook(key).verify(r.body, {
    "webhook-id": String(r.headers["webhook-id"]), "webhook-timestamp": String(r.headers["webhook-timestamp"]),
    "webhook-signature": String(r.headers["webhook-signature"]),
  }) as { eventId: string; name: string; timestamp: string; data: Record<string, unknown>; cursor: string | null };
}

async function code(p: Promise<unknown>): Promise<{ code: number; data?: any; message: string }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "expected the call to fail").toBeTruthy();
  return err as never;
}

describe("events/subscribe — validation before anything is stored", () => {
  it("needs an authenticated principal (Forbidden)", async () => {
    expect((await code(env.webhooks.subscribeWebhook(null, params()))).code).toBe(env.webhooks.ERR.FORBIDDEN);
  });

  it("unknown event → NotFound with data.kind = event", async () => {
    const err = await code(env.webhooks.subscribeWebhook(asOwner(), params({ name: "card.nope" })));
    expect(err.code).toBe(env.webhooks.ERR.NOT_FOUND);
    expect(err.data).toEqual({ kind: "event" });
  });

  it("arguments outside the inputSchema → InvalidParams", async () => {
    expect((await code(env.webhooks.subscribeWebhook(asOwner(), params({ arguments: { color: "red" } })))).code).toBe(-32602);
    expect((await code(env.webhooks.subscribeWebhook(asOwner(), params({ arguments: { kinds: ["bogus"] } })))).code).toBe(-32602);
  });

  it("a delivery mode other than webhook → Unsupported", async () => {
    const err = await code(env.webhooks.subscribeWebhook(asOwner(), params({}, { mode: "push" })));
    expect(err.code).toBe(env.webhooks.ERR.UNSUPPORTED);
    expect(err.data).toEqual({ feature: "deliveryMode", value: "push" });
  });

  it.each([
    ["no prefix", () => randomBytes(32).toString("base64")],
    ["too short (16 bytes)", () => `whsec_${randomBytes(16).toString("base64")}`],
    ["too long (65 bytes)", () => `whsec_${randomBytes(65).toString("base64")}`],
    ["not base64", () => "whsec_!!!!not-base64!!!!not-base64!!!!"],
  ])("a secret that is not whsec_ + base64 of 24–64 bytes → InvalidParams (%s)", async (_why, make) => {
    expect((await code(env.webhooks.subscribeWebhook(asOwner(), params({}, { secret: make() })))).code).toBe(-32602);
    expect(receiver.received).toHaveLength(0);
  });

  it("http, credentials in the URL or a malformed URL → InvalidParams, nothing sent", async () => {
    env.net.WEBHOOK_NET.allowPrivate = false;
    for (const url of ["http://receiver.test/x", "https://u:p@receiver.example.com/x", "nope", "https://127.0.0.1/x", "https://localhost/x"]) {
      expect((await code(env.webhooks.subscribeWebhook(asOwner(), params({}, { url })))).code).toBe(-32602);
    }
    expect(receiver.received).toHaveLength(0);
  });

  it("a hostname that resolves to a private address is refused (CallbackEndpointError), no POST leaves", async () => {
    env.net.WEBHOOK_NET.allowPrivate = false;
    const err = await code(env.webhooks.subscribeWebhook(asOwner(), params()));
    expect(err.code).toBe(env.webhooks.ERR.CALLBACK_ENDPOINT);
    expect(err.data.reason).toBe("connection_refused");
    expect(receiver.received).toHaveLength(0);
  });

  it("ACL: a member cannot subscribe to a card or project they cannot see (Forbidden)", async () => {
    expect((await code(env.webhooks.subscribeWebhook(asMember(), params({ arguments: { cardId: hidden.id } })))).code).toBe(env.webhooks.ERR.FORBIDDEN);
    expect((await code(env.webhooks.subscribeWebhook(asMember(), params({ arguments: { projectId: other.id } })))).code).toBe(env.webhooks.ERR.FORBIDDEN);
    expect((await code(env.webhooks.subscribeWebhook(asMember(), params({ arguments: { cardId: "does-not-exist" } })))).code).toBe(env.webhooks.ERR.FORBIDDEN);
    await expect(env.webhooks.subscribeWebhook(asMember(), params({ arguments: { cardId: card.id } }))).resolves.toBeTruthy();
  });

  it("a revoked credential cannot subscribe (Forbidden)", async () => {
    live.delete(sha("tok-member"));
    expect((await code(env.webhooks.subscribeWebhook(asMember(), params()))).code).toBe(env.webhooks.ERR.FORBIDDEN);
  });

  it("a per-principal ceiling → ResourceExhausted with data.limit", async () => {
    env.webhooks.WEBHOOKS.maxPerPrincipal = 2;
    await env.webhooks.subscribeWebhook(asOwner(), params({}, { url: receiver.url("receiver.test", "/a") }));
    await env.webhooks.subscribeWebhook(asOwner(), params({}, { url: receiver.url("receiver.test", "/b") }));
    const err = await code(env.webhooks.subscribeWebhook(asOwner(), params({}, { url: receiver.url("receiver.test", "/c") })));
    expect(err.code).toBe(env.webhooks.ERR.RESOURCE_EXHAUSTED);
    expect(err.data).toMatchObject({ limit: "subscriptions", max: 2 });
  });
});

describe("callback verification (challenge)", () => {
  it("sends ONE signed verification with a fresh challenge and accepts the echo", async () => {
    const res = await env.webhooks.subscribeWebhook(asOwner(), params());
    expect(verifications()).toHaveLength(1);
    const v = verifications()[0]!;
    const body = verify(v) as unknown as { type: string; challenge: string };
    expect(body.type).toBe("verification");
    expect(body.challenge.length).toBeGreaterThanOrEqual(32);
    expect(String(v.headers["webhook-id"])).toMatch(/^msg_verification_/);
    expect(v.headers["x-mcp-subscription-id"]).toBe(res.id);
    expect(v.headers["content-type"]).toBe("application/json");
  });

  it("a wrong echo → CallbackEndpointError challenge_failed, nothing stored", async () => {
    receiver.respond = () => ({ status: 200, body: JSON.stringify({ challenge: "not-the-one" }) });
    const err = await code(env.webhooks.subscribeWebhook(asOwner(), params()));
    expect(err.code).toBe(env.webhooks.ERR.CALLBACK_ENDPOINT);
    expect(err.data).toEqual({ reason: "challenge_failed" });
    expect(await env.webhooks.listSubscriptionsForTesting()).toHaveLength(0);
  });

  it("a non-2xx answer (even echoing) → challenge_failed; the raw reply is never surfaced", async () => {
    receiver.respond = (got) => ({ status: 500, body: JSON.stringify({ challenge: JSON.parse(got.body).challenge, secret: "internal-detail" }) });
    const err = await code(env.webhooks.subscribeWebhook(asOwner(), params()));
    expect(err.data).toEqual({ reason: "challenge_failed" });
    expect(JSON.stringify(err)).not.toContain("internal-detail");
  });

  it("a receiver that never answers → timeout", async () => {
    env.net.WEBHOOK_NET.timeoutMs = 150;
    receiver.respond = () => new Promise(() => undefined);
    const err = await code(env.webhooks.subscribeWebhook(asOwner(), params()));
    expect(err.data).toEqual({ reason: "timeout" });
  });

  it("is cached per (principal, url): a refresh or other arguments do not challenge again; another principal does", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params());
    await env.webhooks.subscribeWebhook(asOwner(), params());
    await env.webhooks.subscribeWebhook(asOwner(), params({ arguments: { cardId: card.id } }));
    expect(verifications()).toHaveLength(1);
    await env.webhooks.subscribeWebhook(asMember(), params());
    expect(verifications()).toHaveLength(2);
  });
});

describe("subscription identity, TTL and unsubscribe", () => {
  it("returns a deterministic id over (principal, url, name, canonical arguments) — key order does not matter", async () => {
    const a = await env.webhooks.subscribeWebhook(asOwner(), params({ arguments: { projectId: project.id, cardId: card.id } }));
    const b = await env.webhooks.subscribeWebhook(asOwner(), params({ arguments: { cardId: card.id, projectId: project.id } }));
    expect(a.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(b.id).toBe(a.id);
    expect(await env.webhooks.listSubscriptionsForTesting()).toHaveLength(1);
    const c = await env.webhooks.subscribeWebhook(asMember(), params({ arguments: { projectId: project.id, cardId: card.id } }));
    expect(c.id).not.toBe(a.id);
  });

  it("grants the default TTL, never more than asked, clamps up to the floor, and a finite one for ttlMs: null", async () => {
    const now = Date.now();
    const W = env.webhooks.WEBHOOKS;
    const def = await env.webhooks.subscribeWebhook(asOwner(), params(), now);
    expect(Date.parse(def.refreshBefore!)).toBe(now + W.defaultTtlMs);
    const asked = await env.webhooks.subscribeWebhook(asOwner(), params({ ttlMs: W.minTtlMs * 3 }), now);
    expect(Date.parse(asked.refreshBefore!)).toBe(now + W.minTtlMs * 3);
    const tiny = await env.webhooks.subscribeWebhook(asOwner(), params({ ttlMs: 10 }), now);
    expect(Date.parse(tiny.refreshBefore!)).toBe(now + W.minTtlMs);
    const forever = await env.webhooks.subscribeWebhook(asOwner(), params({ ttlMs: null }), now);
    expect(Date.parse(forever.refreshBefore!)).toBe(now + W.maxTtlMs);
  });

  it("answers the spec's result shape: id, refreshBefore, cursor (string — the log replays), truncated", async () => {
    const res = await env.webhooks.subscribeWebhook(asOwner(), params());
    expect(Object.keys(res).sort()).toEqual(expect.arrayContaining(["cursor", "id", "refreshBefore", "truncated"]));
    expect(typeof res.cursor).toBe("string");
    expect(res.truncated).toBe(false);
  });

  it("unsubscribe stops the subscription, returns {} and is idempotent", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params());
    const p = { name: "card.event", arguments: {}, delivery: { mode: "webhook", url: receiver.url() } };
    expect(await env.webhooks.unsubscribeWebhook(asOwner(), p)).toEqual({});
    expect(await env.webhooks.unsubscribeWebhook(asOwner(), p)).toEqual({});
    expect(await env.webhooks.listSubscriptionsForTesting()).toHaveLength(0);
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "after unsubscribe" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(0);
  });

  it("wrong owner: another principal's unsubscribe with the same tuple touches nothing", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params());
    const p = { name: "card.event", arguments: {}, delivery: { mode: "webhook", url: receiver.url() } };
    expect(await env.webhooks.unsubscribeWebhook(asMember(), p)).toEqual({});
    expect(await env.webhooks.listSubscriptionsForTesting()).toHaveLength(1);
  });

  it("unsubscribe needs a principal too", async () => {
    const p = { name: "card.event", arguments: {}, delivery: { mode: "webhook", url: receiver.url() } };
    expect((await code(env.webhooks.unsubscribeWebhook(null, p))).code).toBe(env.webhooks.ERR.FORBIDDEN);
  });
});

describe("delivery — one signed event per POST", () => {
  it("POSTs the EventOccurrence, Standard Webhooks headers, webhook-id = eventId, X-MCP-Subscription-Id", async () => {
    const sub = await env.webhooks.subscribeWebhook(asOwner(), params());
    const e = await env.events.recordMessage({ cardId: card.id, type: "info", text: "deploy feito" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(1);
    const r = deliveries()[0]!;
    const body = verify(r);
    expect(r.headers["webhook-id"]).toBe(e.id);
    expect(body.eventId).toBe(e.id);
    expect(r.headers["x-mcp-subscription-id"]).toBe(sub.id);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(Math.abs(Number(r.headers["webhook-timestamp"]) - Date.now() / 1000)).toBeLessThan(10);
    expect(body.name).toBe("card.event");
    expect(body.timestamp).toMatch(/Z$/);
    expect(body.data).toMatchObject({ type: "info", kind: "message", cardId: card.id, projectId: project.id, cardTitle: "login" });
    expect(typeof body.cursor).toBe("string");
    expect(Object.keys(body)).not.toContain("type"); // a top-level type is a control envelope
  });

  it("an AskUserQuestion (native menu) and a vibehub_notify question both arrive as questions that need an answer", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params());
    await env.events.observeDriverEvent(card.id, {
      type: "user_question", id: "q-native",
      questions: [{ question: "Qual banco?", options: [{ label: "Sicoob" }, { label: "Inter" }] }],
    } as never);
    await env.events.recordMessage({
      cardId: card.id, type: "question", text: "Preciso decidir", question: "Pode mergear?",
      options: [{ label: "Sim" }, { label: "Não" }], recommended: "Sim",
    });
    await env.webhooks.pumpWebhooks();
    const [native, notify] = deliveries().map((r) => verify(r).data);
    expect(native).toMatchObject({ kind: "question", type: "question", needsAnswer: true, question: "Qual banco?" });
    expect((native!.options as unknown[]).length).toBe(2);
    expect(notify).toMatchObject({ kind: "message", type: "question", needsAnswer: true, question: "Pode mergear?", recommended: "Sim" });
  });

  it("filters on the server: card, project and kinds/types — a non-matching event is not delivered", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params({ arguments: { cardId: card.id, kinds: ["permission", "question"] } }));
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "not a question kind" });
    await env.events.recordMessage({ cardId: hidden.id, type: "info", text: "other card" });
    await env.events.observeDriverEvent(card.id, { type: "permission_request", id: "p1", tool: "Bash", reason: "rm" } as never);
    await env.webhooks.pumpWebhooks();
    expect(deliveries().map((r) => verify(r).data.kind)).toEqual(["permission"]);
  });

  it("ACL is applied at SEND time: a member never gets a card they cannot see, even unfiltered", async () => {
    await env.webhooks.subscribeWebhook(asMember(), params());
    await env.events.recordMessage({ cardId: hidden.id, type: "info", text: "secret project" });
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "shared project" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries().map((r) => verify(r).data.cardId)).toEqual([card.id]);
  });

  it("a share taken away after subscribing stops the deliveries of that card", async () => {
    await env.webhooks.subscribeWebhook(asMember(), params({ arguments: { cardId: card.id } }));
    await env.registry.unshare("project", project.id, member.id);
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "after unshare" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(0);
  });

  it("a revoked token: nothing more is delivered and the subscription is gone", async () => {
    await env.webhooks.subscribeWebhook(asMember(), params());
    live.delete(sha("tok-member"));
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "after revoke" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(0);
    expect(await env.webhooks.listSubscriptionsForTesting()).toHaveLength(0);
  });

  it("the board principal is re-checked against the runner token", async () => {
    await env.webhooks.subscribeWebhook(asBoard(), params());
    await env.events.recordMessage({ cardId: hidden.id, type: "info", text: "board hears all" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(1);
    const stale = { key: "board", user: null, credential: sha("an-old-runner-token") };
    expect((await code(env.webhooks.subscribeWebhook(stale, params({}, { url: receiver.url("receiver.test", "/z") }))))).toMatchObject({ code: env.webhooks.ERR.FORBIDDEN });
  });

  it("an expired subscription stops delivering and is reclaimed", async () => {
    const now = Date.now();
    await env.webhooks.subscribeWebhook(asOwner(), params({ ttlMs: env.webhooks.WEBHOOKS.minTtlMs }), now);
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "late" });
    await env.webhooks.pumpWebhooks(now + env.webhooks.WEBHOOKS.minTtlMs + 1);
    expect(deliveries()).toHaveLength(0);
    expect(await env.webhooks.listSubscriptionsForTesting()).toHaveLength(0);
  });

  it("delivers each event ONCE per subscription, however many pumps run (dedup)", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params());
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "once" });
    await Promise.all([env.webhooks.pumpWebhooks(), env.webhooks.pumpWebhooks(), env.webhooks.pumpWebhooks()]);
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(1);
  });

  it("an event over 256 KiB is summarized to fit: one POST under the limit, same eventId, marked truncated", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params());
    const e = await env.events.recordMessage({ cardId: card.id, type: "info", text: "x".repeat(300 * 1024), context: "y".repeat(100 * 1024) });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(1);
    const r = deliveries()[0]!;
    expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(256 * 1024);
    const body = verify(r);
    expect(body.eventId).toBe(e.id);
    expect(body.data).toMatchObject({ cardId: card.id, truncated: true });
    expect(String(body.data.text).length).toBeLessThan(300 * 1024);
  });

  it("logs never carry the signing secret, the credential or the callback path", async () => {
    const { logger } = await import("../../utils/logger.js");
    const lines: string[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { lines.push(JSON.stringify(args)); }) as never);
    }
    receiver.respond = () => ({ status: 200, body: "{}" });
    await env.webhooks.subscribeWebhook(asOwner(), params({}, { url: receiver.url("receiver.test", "/hooks/private-path-123") })).catch(() => undefined);
    receiver.respond = echoChallenge;
    await env.webhooks.subscribeWebhook(asOwner(), params({}, { url: receiver.url("receiver.test", "/hooks/private-path-456") }));
    receiver.respond = () => ({ status: 500, body: "{}" });
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "x".repeat(300 * 1024) });
    await env.webhooks.pumpWebhooks();
    live.delete(sha("tok-owner"));
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "revoked now" });
    await env.webhooks.pumpWebhooks(Date.now() + 60 * 60_000);
    vi.restoreAllMocks();
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(SECRET.slice(6, 30));
    expect(all).not.toContain("private-path");
    expect(all).not.toContain(sha("tok-owner"));
  });
});

describe("retries — transient only, bounded, same eventId, fresh signature", () => {
  it("retries a 503 with backoff, keeping the eventId and re-signing with a new timestamp", async () => {
    const t0 = Date.now();
    await env.webhooks.subscribeWebhook(asOwner(), params(), t0);
    let n = 0;
    receiver.respond = () => ({ status: ++n === 1 ? 503 : 200, body: "{}" });
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "flaky" });
    await env.webhooks.pumpWebhooks(t0);
    expect(deliveries()).toHaveLength(1);
    await env.webhooks.pumpWebhooks(t0 + 1); // not due yet
    expect(deliveries()).toHaveLength(1);
    await env.webhooks.pumpWebhooks(t0 + env.webhooks.WEBHOOKS.retryBaseMs + 1);
    expect(deliveries()).toHaveLength(2);
    const [a, b] = deliveries();
    expect(b!.headers["webhook-id"]).toBe(a!.headers["webhook-id"]);
    expect(verify(b!).eventId).toBe(verify(a!).eventId);
    expect(await env.webhooks.pendingForTesting()).toHaveLength(0);
  });

  it.each([410, 413, 400])("does not retry a %i", async (status) => {
    const t0 = Date.now();
    await env.webhooks.subscribeWebhook(asOwner(), params(), t0);
    receiver.respond = () => ({ status, body: "{}" });
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "rejected" });
    await env.webhooks.pumpWebhooks(t0);
    await env.webhooks.pumpWebhooks(t0 + 60 * 60_000);
    expect(deliveries()).toHaveLength(1);
    expect(await env.webhooks.pendingForTesting()).toHaveLength(0);
  });

  it("gives up after maxAttempts", async () => {
    let t = Date.now();
    await env.webhooks.subscribeWebhook(asOwner(), params(), t);
    receiver.respond = () => ({ status: 500, body: "{}" });
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "down" });
    for (let i = 0; i < 10; i++) {
      await env.webhooks.pumpWebhooks(t);
      t += 60 * 60_000;
    }
    expect(deliveries()).toHaveLength(env.webhooks.WEBHOOKS.maxAttempts);
    expect(await env.webhooks.pendingForTesting()).toHaveLength(0);
  });

  it("refresh after failures reports deliveryStatus with a category, never the raw reply", async () => {
    const t0 = Date.now();
    await env.webhooks.subscribeWebhook(asOwner(), params(), t0);
    receiver.respond = () => ({ status: 503, body: "{\"internal\":\"stack trace\"}" });
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "x" });
    await env.webhooks.pumpWebhooks(t0);
    const res = await env.webhooks.subscribeWebhook(asOwner(), params(), t0 + 10);
    expect(res.deliveryStatus).toMatchObject({ active: true, lastError: "http_5xx" });
    expect(JSON.stringify(res)).not.toContain("stack trace");
  });
});

describe("persistence — subscriptions and pending deliveries survive a restart", () => {
  it("a delivery pending at shutdown goes out after the restart, the subscription still verified", async () => {
    const t0 = Date.now();
    const sub = await env.webhooks.subscribeWebhook(asOwner(), params(), t0);
    receiver.respond = () => ({ status: 503, body: "{}" });
    const e = await env.events.recordMessage({ cardId: card.id, type: "info", text: "across restart" });
    await env.webhooks.pumpWebhooks(t0);
    receiver.respond = echoChallenge;
    env = await boot(); // a new process on the same data dir
    await env.webhooks.pumpWebhooks(t0 + 60 * 60_000 - 1);
    const last = deliveries().at(-1)!;
    expect(last.headers["webhook-id"]).toBe(e.id);
    expect(last.headers["x-mcp-subscription-id"]).toBe(sub.id);
    // Still verified: the refresh after the restart does not challenge again.
    await env.webhooks.subscribeWebhook(asOwner(), params(), t0 + 1000);
    expect(verifications()).toHaveLength(1);
  });

  it("an event recorded while no pump ran (crash between record and send) is still delivered", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params());
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "recorded, then crash" });
    env = await boot();
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(1);
  });

  it("never stores the signing secret in clear", async () => {
    await env.webhooks.subscribeWebhook(asOwner(), params());
    const raw = await readFile(join(dir, "webhook-subscriptions.json"), "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(SECRET.slice(6));
  });
});

describe("cursor and replay", () => {
  it("a refresh carrying an older cursor on a LAPSED subscription replays what it missed", async () => {
    const t0 = Date.now();
    const first = await env.webhooks.subscribeWebhook(asOwner(), params({ ttlMs: env.webhooks.WEBHOOKS.minTtlMs }), t0);
    await env.webhooks.pumpWebhooks(t0 + env.webhooks.WEBHOOKS.minTtlMs + 1); // lapsed and reclaimed
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "missed while lapsed" });
    const again = await env.webhooks.subscribeWebhook(asOwner(), params({ cursor: first.cursor }), t0 + env.webhooks.WEBHOOKS.minTtlMs + 2);
    expect(again.truncated).toBe(false);
    await env.webhooks.pumpWebhooks(t0 + env.webhooks.WEBHOOKS.minTtlMs + 3);
    expect(deliveries().map((r) => verify(r).data.text)).toEqual([expect.stringContaining("missed while lapsed")]);
  });

  it("a cursor this server never minted → InvalidParams", async () => {
    expect((await code(env.webhooks.subscribeWebhook(asOwner(), params({ cursor: "abc" })))).code).toBe(-32602);
  });
});

describe("secret rotation", () => {
  it("a refresh with a new secret signs with BOTH keys during the grace window, then only the new", async () => {
    const t0 = Date.now();
    const old = SECRET;
    await env.webhooks.subscribeWebhook(asOwner(), params(), t0);
    const fresh = secret();
    await env.webhooks.subscribeWebhook(asOwner(), params({}, { secret: fresh }), t0 + 1);
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "rotating" });
    await env.webhooks.pumpWebhooks(t0 + 2);
    const r = deliveries()[0]!;
    expect(String(r.headers["webhook-signature"]).split(" ")).toHaveLength(2);
    expect(() => verify(r, old)).not.toThrow();
    expect(() => verify(r, fresh)).not.toThrow();
    await env.events.recordMessage({ cardId: card.id, type: "info", text: "after grace" });
    await env.webhooks.pumpWebhooks(t0 + env.webhooks.WEBHOOKS.rotationGraceMs + 10);
    const later = deliveries()[1]!;
    expect(String(later.headers["webhook-signature"]).split(" ")).toHaveLength(1);
    expect(() => verify(later, old)).toThrow();
    expect(() => verify(later, fresh)).not.toThrow();
  });
});
