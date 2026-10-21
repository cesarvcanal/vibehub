import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Webhook } from "standardwebhooks";
import { echoChallenge, startTestReceiver, type TestReceiver } from "../testkit/webhookReceiver.js";

/**
 * MCP 2026-07-28 ON THE SAME /mcp — END TO END. A real vibehub listening on a port, spoken to over
 * HTTP exactly as a modern client (ChatGPT in a Work chat) does: no initialize, every request with
 * `MCP-Protocol-Version` + `Mcp-Method` headers and the version in `_meta`. Then the whole webhook
 * lifecycle against a real local HTTPS receiver, every delivery checked with the official Standard
 * Webhooks verifier. Legacy clients (initialize handshake) must not notice any of it.
 */

const RUNNER = "runner-token-for-the-mcp";
const OWNER = "vhm_owner_token_aaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBER = "vhm_member_token_bbbbbbbbbbbbbbbbbbbbbbb";
const V = "2026-07-28";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let dir = "";
let app: FastifyInstance;
let base = "";
let receiver: TestReceiver;
const revoked = new Set<string>();

beforeAll(async () => { receiver = await startTestReceiver(); });
afterAll(async () => { await receiver.close(); });

async function boot() {
  vi.resetModules();
  revoked.clear();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined), startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => RUNNER), statusUrl: () => "http://vibehub:3010/api/runner/status",
    runnerStatus: vi.fn(async () => ({ running: true, exists: true, claudeInstalled: true, dockerReachable: true, container: "r", host: "h" })),
  }));
  const users = await import("../auth/users.js");
  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  const byToken = (t: string | undefined) => (t && revoked.has(t) ? null : t === OWNER ? owner : t === MEMBER ? member : null);
  vi.doMock("../auth/oauth.js", async (original) => ({
    ...(await original<typeof import("../auth/oauth.js")>()),
    userForAccessToken: vi.fn(async (t: string | undefined) => byToken(t)),
    userForAccessTokenHash: vi.fn(async (h: string) => byToken([OWNER, MEMBER].find((t) => sha(t) === h))),
  }));
  const net = await import("../services/webhooks/net.js");
  Object.assign(net.WEBHOOK_NET, { allowPrivate: true, resolve: async () => ["127.0.0.1"], ca: receiver.cert, timeoutMs: 2_000 });
  const registry = await import("../services/board/registry.js");
  const events = await import("../services/events/cardEvents.js");
  const webhooks = await import("../services/webhooks/subscriptions.js");
  const project = await registry.createProject({ name: "erp" });
  const other = await registry.createProject({ name: "bank" });
  const card = await registry.createCard({ projectId: project.id, title: "login" });
  const hidden = await registry.createCard({ projectId: other.id, title: "extrato" });
  await registry.shareWith({ kind: "project", targetId: project.id, userId: member.id, level: "work" });
  const { buildServer } = await import("../index.js");
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { registry, events, webhooks, owner, member, project, card, hidden };
}

let env: Awaited<ReturnType<typeof boot>>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-mcp-modern-"));
  receiver.received.length = 0;
  receiver.respond = echoChallenge;
  env = await boot();
});
afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

const META = { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } };

/** A modern request: headers mirrored from the body, as the 2026-07-28 Streamable HTTP binding asks. */
async function modern(token: string | null, method: string, params: Record<string, unknown> = {}, opts: { headers?: Record<string, string>; meta?: Record<string, unknown>; id?: number | null } = {}) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params: { ...params, _meta: opts.meta ?? META } };
  if (opts.id !== null) body.id = opts.id ?? 1;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": V, "mcp-method": method,
      ...(typeof params.name === "string" && method === "tools/call" ? { "mcp-name": params.name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** A legacy (2025-era) request through the SDK transport. */
async function legacy(token: string, method: string, params: unknown = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, body: JSON.parse(data ? data.slice(5) : text) };
}

const secret = () => `whsec_${randomBytes(32).toString("base64")}`;
const deliveries = () => receiver.received.filter((r) => !JSON.parse(r.body).type);
function verify(r: { body: string; headers: Record<string, unknown> }, key: string) {
  return new Webhook(key).verify(r.body, {
    "webhook-id": String(r.headers["webhook-id"]), "webhook-timestamp": String(r.headers["webhook-timestamp"]),
    "webhook-signature": String(r.headers["webhook-signature"]),
  }) as { eventId: string; name: string; data: Record<string, any>; cursor: string | null };
}

describe("version negotiation on the same authenticated /mcp", () => {
  it("server/discover: resultType complete, 2026-07-28, capabilities tools + events, serverInfo", async () => {
    const res = await modern(OWNER, "server/discover");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(res.body.result).toMatchObject({
      resultType: "complete", supportedVersions: expect.arrayContaining([V]), capabilities: { tools: {}, events: {} },
    });
    expect(res.body.result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: "vibehub" });
    expect(typeof res.body.result.ttlMs).toBe("number");
    expect(res.body.result.cacheScope).toBe("private");
  });

  it("still needs the credential first: 401 + OAuth resource metadata", async () => {
    const res = await modern(null, "server/discover");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("an unsupported modern version → 400 UnsupportedProtocolVersionError (-32022) listing what is supported", async () => {
    const res = await modern(OWNER, "server/discover", {}, {
      headers: { "mcp-protocol-version": "2099-01-01" }, meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: -32022, data: { supported: expect.arrayContaining([V]), requested: "2099-01-01" } });
  });

  it("headers that disagree with the body → 400 HeaderMismatch (-32020)", async () => {
    const wrongMethod = await modern(OWNER, "server/discover", {}, { headers: { "mcp-method": "tools/list" } });
    expect(wrongMethod.status).toBe(400);
    expect(wrongMethod.body.error.code).toBe(-32020);
    const wrongVersion = await modern(OWNER, "server/discover", {}, { meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } });
    expect(wrongVersion.status).toBe(400);
    expect(wrongVersion.body.error.code).toBe(-32020);
    const wrongName = await modern(OWNER, "tools/call", { name: "vibehub_list_projects", arguments: {} }, { headers: { "mcp-name": "vibehub_deliver" } });
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.code).toBe(-32020);
  });

  it("an unknown method → 404 + -32601", async () => {
    const res = await modern(OWNER, "subscriptions/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32601);
  });

  it("a notification is accepted with 202 and no body", async () => {
    const res = await modern(OWNER, "notifications/whatever", {}, { id: null });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  it("tools/list and tools/call work in the modern era (same tools as the user's legacy session)", async () => {
    const list = await modern(OWNER, "tools/list");
    expect(list.status).toBe(200);
    expect(list.body.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
    expect(typeof list.body.result.ttlMs).toBe("number");
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["vibehub_list_projects", "vibehub_send_to_terminal", "vibehub_inbox"]));
    const call = await modern(OWNER, "tools/call", { name: "vibehub_list_projects", arguments: {} });
    expect(call.status).toBe(200);
    expect(call.body.result.resultType).toBe("complete");
    expect(call.body.result.content[0].text).toContain("erp");
  });

  it("a member's modern tools see only what is shared (same ACL as legacy)", async () => {
    const call = await modern(MEMBER, "tools/call", { name: "vibehub_list_projects", arguments: {} });
    expect(call.body.result.content[0].text).toContain("erp");
    expect(call.body.result.content[0].text).not.toContain("bank");
  });

  it("events/list: card.event, webhook delivery, inputSchema + payloadSchema", async () => {
    const res = await modern(OWNER, "events/list");
    expect(res.body.result.resultType).toBe("complete");
    const [def] = res.body.result.events;
    expect(def).toMatchObject({ name: "card.event", delivery: ["webhook"] });
    expect(def.inputSchema.properties).toHaveProperty("cardId");
    expect(def.inputSchema.properties).toHaveProperty("projectId");
    expect(def.inputSchema.properties).toHaveProperty("kinds");
    expect(def.payloadSchema.required).toContain("cardId");
  });

  it("legacy clients are untouched: initialize, tools/list and push events/list as before", async () => {
    const init = await legacy(RUNNER, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    const tools = await legacy(OWNER, "tools/list");
    expect(tools.body.result.tools.length).toBeGreaterThan(3);
    const ev = await legacy(OWNER, "events/list");
    expect(ev.body.result.events[0].delivery).toEqual(["push"]);
  });
});

describe("webhook lifecycle over /mcp (2026-07-28)", () => {
  const sub = (key: string, args: Record<string, unknown> = {}, url = receiver.url()) => ({
    name: "card.event", arguments: args, delivery: { mode: "webhook", url, secret: key }, cursor: null,
  });

  it("subscribe → challenge → event → signed POST → unsubscribe → no more POSTs", async () => {
    const key = secret();
    const res = await modern(OWNER, "events/subscribe", sub(key));
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ resultType: "complete", id: expect.stringMatching(/^sub_/), truncated: false });
    expect(Date.parse(res.body.result.refreshBefore)).toBeGreaterThan(Date.now());
    expect(receiver.received.filter((r) => JSON.parse(r.body).type === "verification")).toHaveLength(1);

    const e = await env.events.recordMessage({
      cardId: env.card.id, type: "question", text: "Preciso de você", question: "Pode mergear?",
      options: [{ label: "Sim" }, { label: "Não" }], recommended: "Sim",
    });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(1);
    const body = verify(deliveries()[0]!, key);
    expect(body.eventId).toBe(e.id);
    expect(deliveries()[0]!.headers["x-mcp-subscription-id"]).toBe(res.body.result.id);
    expect(body.data).toMatchObject({ type: "question", needsAnswer: true, question: "Pode mergear?" });

    const off = await modern(OWNER, "events/unsubscribe", { name: "card.event", arguments: {}, delivery: { mode: "webhook", url: receiver.url() } });
    expect(off.body.result.resultType).toBe("complete");
    expect(Object.keys(off.body.result).sort()).toEqual(["_meta", "resultType"]); // the empty result
    await env.events.recordMessage({ cardId: env.card.id, type: "info", text: "after" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(1);
  });

  it("errors come back as JSON-RPC errors with the spec's codes, HTTP 200", async () => {
    const bad = await modern(OWNER, "events/subscribe", sub("whsec_short"));
    expect(bad.status).toBe(200);
    expect(bad.body.error.code).toBe(-32602);
    receiver.respond = () => ({ status: 200, body: "{}" });
    const unverified = await modern(OWNER, "events/subscribe", sub(secret()));
    expect(unverified.body.error).toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
    const forbidden = await modern(MEMBER, "events/subscribe", sub(secret(), { cardId: env.hidden.id }));
    expect(forbidden.body.error.code).toBe(-32012);
  });

  it("the runner's service token may subscribe as the board", async () => {
    const res = await modern(RUNNER, "events/subscribe", sub(secret()));
    expect(res.body.result.id).toMatch(/^sub_/);
  });

  it("a member hears only shared cards; their revoked token ends the subscription", async () => {
    const key = secret();
    await modern(MEMBER, "events/subscribe", sub(key));
    await env.events.recordMessage({ cardId: env.hidden.id, type: "info", text: "not yours" });
    await env.events.recordMessage({ cardId: env.card.id, type: "info", text: "yours" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries().map((r) => verify(r, key).data.cardId)).toEqual([env.card.id]);
    revoked.add(MEMBER);
    await env.events.recordMessage({ cardId: env.card.id, type: "info", text: "after revoke" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries()).toHaveLength(1);
    expect(await env.webhooks.listSubscriptionsForTesting()).toHaveLength(0);
  });

  it("every kind of moment reaches the subscriber, each with its kind", async () => {
    const key = secret();
    await modern(OWNER, "events/subscribe", sub(key));
    const { events, card } = env;
    await events.observeDriverEvent(card.id, { type: "user_question", id: "q1", questions: [{ question: "Qual?", options: [{ label: "A" }, { label: "B" }] }] } as never);
    await events.observeDriverEvent(card.id, { type: "permission_request", id: "p1", tool: "Bash", reason: "rm -rf build" } as never);
    await events.observeDeclaredState(card.id, "needs_me", "decidir o banco");
    await events.observeCardStatus(card.id, "working", "waiting", { state: "needs_me", summary: "fim" });
    await events.observeDriverEvent(card.id, { type: "result", isError: true, subtype: "error_during_execution" } as never);
    await events.recordMessage({ cardId: card.id, type: "done", text: "pronto" });
    await env.webhooks.pumpWebhooks();
    expect(deliveries().map((r) => verify(r, key).data.kind)).toEqual(["question", "permission", "needs_me", "turn_finished", "failed", "message"]);
  });
});
