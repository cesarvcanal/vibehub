import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * MCP EVENTS (push) END TO END — a real vibehub listening on a port, a consumer that makes ONE
 * request (`events/stream`) and then only reads the SSE body it holds open. Everything it gets after
 * that was pushed by the server when something happened on the board: no second request, no poll.
 * The card side talks to the same /mcp as a card does (the runner's token); nothing reaches a runner.
 */

const TOKEN = "runner-token-for-the-mcp";
const MEMBER_TOKEN = "oauth-token-of-the-member";
const OWNER_TOKEN = "oauth-token-of-the-owner";

let dir = "";
let app: FastifyInstance;
let base = "";
let sent: { cardId: string; text: string }[] = [];
/** Tokens taken away mid-test (what a revoked or expired OAuth token looks like to the server). */
const revoked = new Set<string>();
/** Every stream a test opened: closed after it, pass or fail (an open one holds app.close()). */
const open: AbortController[] = [];

type Env = Awaited<ReturnType<typeof boot>>;

async function boot() {
  vi.resetModules();
  sent = [];
  revoked.clear();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => TOKEN),
    statusUrl: () => "http://vibehub:3010/api/runner/status",
    runnerStatus: vi.fn(async () => ({ running: true, exists: true, claudeInstalled: true, dockerReachable: true, container: "r", host: "h" })),
  }));
  const users = await import("../auth/users.js");
  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  vi.doMock("../auth/oauth.js", async (original) => ({
    ...(await original<typeof import("../auth/oauth.js")>()),
    userForAccessToken: vi.fn(async (t: string | undefined) =>
      (t && revoked.has(t) ? null : t === OWNER_TOKEN ? owner : t === MEMBER_TOKEN ? member : null)),
  }));
  // A send reaches a terminal; here it is recorded instead (no runner in a test).
  vi.doMock("../services/maestro/maestro.js", async (original) => ({
    ...(await original<typeof import("../services/maestro/maestro.js")>()),
    sendToTerminal: vi.fn(async (cardId: string, text: string) => {
      await new Promise((r) => setTimeout(r, 20)); // a send takes a moment: room for a race
      sent.push({ cardId, text });
      return { cardId, delivered: true };
    }),
  }));
  const registry = await import("../services/board/registry.js");
  const events = await import("../services/events/cardEvents.js");
  const mcpEvents = await import("./events.js");
  mcpEvents.STREAM.heartbeatMs = 60_000;
  const project = await registry.createProject({ name: "erp" });
  const other = await registry.createProject({ name: "bank" });
  const card = await registry.createCard({ projectId: project.id, title: "login" });
  const elsewhere = await registry.createCard({ projectId: other.id, title: "extrato" });
  const { buildServer } = await import("../index.js");
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { registry, events, mcpEvents, owner, member, project, card, elsewhere };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-mcp-events-")); });
afterEach(async () => {
  for (const abort of open.splice(0)) abort.abort();
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

const HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
});

/** One JSON-RPC call answered at once (tools, events/list). */
async function rpc(token: string, method: string, params: unknown = {}) {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: HEADERS(token), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(data ? data.slice(5) : body) as { result?: any; error?: { code: number; message: string } };
}

async function tool(token: string, name: string, args: unknown) {
  const reply = await rpc(token, "tools/call", { name, arguments: args });
  return JSON.parse(reply.result.content[0].text);
}

/**
 * The consumer: ONE POST that stays open. `messages` fills as the server pushes frames; `next`
 * waits for the next one matching. `close` aborts it (how a client unsubscribes).
 */
async function openStream(token: string, params: Record<string, unknown>) {
  const abort = new AbortController();
  open.push(abort);
  const res = await fetch(`${base}/mcp`, {
    method: "POST", headers: HEADERS(token), signal: abort.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 77, method: "events/stream", params: { name: "card.event", ...params } }),
  });
  const messages: any[] = [];
  const ready = (async () => {
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      messages.push(JSON.parse(await res.text()));
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
          if (data) messages.push(JSON.parse(data));
        }
      }
    } catch { /* aborted */ }
  })();
  const next = async (method: string, pred: (m: any) => boolean = () => true) => {
    let found: any;
    await vi.waitFor(() => {
      found = messages.find((m) => m.method === method && pred(m));
      expect(found).toBeDefined();
    }, { timeout: 3000 });
    return found;
  };
  const events = () => messages.filter((m) => m.method === "notifications/events/event");
  return { res, messages, next, events, close: () => abort.abort(), done: ready };
}

const question = (env: Env) => ({
  card: env.card.id, type: "question", severity: "warning",
  text: "Preciso decidir o banco do módulo de login antes de seguir.",
  context: "O schema de usuários já existe no Mongo; o MySQL só tem o legado.",
  question: "Qual banco uso para as sessões?",
  options: [{ label: "Mongo", description: "mesmo banco do schema novo" }, { label: "MySQL", description: "junto do legado" }],
  recommended: "Mongo",
});

describe("discovery", () => {
  it("initialize advertises the events capability and events/list describes card.event (push)", async () => {
    await boot();
    const init = await rpc(TOKEN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.capabilities).toHaveProperty("events");
    const list = await rpc(TOKEN, "events/list");
    expect(list.result.events).toEqual([expect.objectContaining({ name: "card.event", delivery: ["push"] })]);
    expect(list.result.events[0].inputSchema.properties).toHaveProperty("cardId");
  });
});

describe("push without polling — one open request, events arrive as they happen", () => {
  it("a card's formal question reaches the subscriber as a message with context, options and recommendation", async () => {
    const env = await boot();
    const stream = await openStream(OWNER_TOKEN, { arguments: { projectId: env.project.id } });
    const active = await stream.next("notifications/events/active");
    expect(active.params._meta["io.modelcontextprotocol/subscriptionId"]).toBe(77);

    const posted = await tool(TOKEN, "vibehub_notify", question(env));
    const pushed = await stream.next("notifications/events/event");
    expect(pushed.params).toMatchObject({ eventId: posted.eventId, name: "card.event", cursor: expect.any(String) });
    expect(new Date(pushed.params.timestamp).toISOString()).toBe(pushed.params.timestamp);
    expect(pushed.params.data).toMatchObject({
      type: "question", needsAnswer: true, severity: "warning", kind: "message",
      cardId: env.card.id, projectId: env.project.id, cardTitle: "login",
      question: "Qual banco uso para as sessões?", recommended: "Mongo",
      options: [{ label: "Mongo", description: "mesmo banco do schema novo" }, { label: "MySQL", description: "junto do legado" }],
      context: "O schema de usuários já existe no Mongo; o MySQL só tem o legado.",
      correlationId: posted.eventId,
    });
    expect(pushed.params.data.text).toContain("Qual banco uso para as sessões?");
    expect(pushed.params.data.text).toContain("recomendado: Mongo");
    stream.close();
  });

  it("the subscriber answers with inReplyTo: the card gets the answer tied to its question, and it is resolved", async () => {
    const env = await boot();
    const stream = await openStream(OWNER_TOKEN, {});
    await stream.next("notifications/events/active");
    const posted = await tool(TOKEN, "vibehub_notify", question(env));
    await stream.next("notifications/events/event");

    const answer = await tool(OWNER_TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "Mongo.", inReplyTo: posted.eventId });
    expect(answer.error).toBeUndefined();
    expect(sent).toEqual([{ cardId: env.card.id, text: expect.stringContaining("Mongo.") }]);
    expect(sent[0]!.text).toContain(posted.eventId);
    const { events } = await env.events.eventsAfter(0);
    expect(events.find((e) => e.id === posted.eventId)?.resolvedAt).toEqual(expect.any(Number));
    // Answering it twice is refused: it is no longer waiting on anyone.
    expect((await tool(OWNER_TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "MySQL.", inReplyTo: posted.eventId })).error)
      .toMatch(/not waiting/);
    stream.close();
  });

  it("the board's own moments (turn end, failure, conclusion) are pushed too, typed and readable", async () => {
    const env = await boot();
    const stream = await openStream(TOKEN, { arguments: { cardId: env.card.id } });
    await stream.next("notifications/events/active");
    await env.events.observeCardStatus(env.card.id, "working", "waiting", { state: "ready", summary: "login pronto" });
    await env.events.observeDriverEvent(env.card.id, { type: "result", isError: true, subtype: "error_max_turns" });
    await env.registry.updateCard(env.card.id, { column: "done" });
    await vi.waitFor(() => expect(stream.events()).toHaveLength(3));
    expect(stream.events().map((m) => [m.params.data.kind, m.params.data.type, m.params.data.needsAnswer])).toEqual([
      ["turn_finished", "info", false], ["failed", "error", false], ["concluded", "done", false],
    ]);
    expect(stream.events()[0].params.data.text).toContain("login pronto");
    stream.close();
  });

  it("text with a question mark is NOT a formal question: only type question/approval asks for an answer", async () => {
    const env = await boot();
    const stream = await openStream(TOKEN, {});
    await stream.next("notifications/events/active");
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "Será que o deploy de ontem quebrou o login?" });
    const pushed = await stream.next("notifications/events/event");
    expect(pushed.params.data).toMatchObject({ type: "info", needsAnswer: false });
    expect(pushed.params.data.question).toBeUndefined();
    stream.close();
  });

  it("a question without the question itself, or a recommendation that is not an option, is refused", async () => {
    const env = await boot();
    expect((await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "question", text: "decide aí" })).error).toMatch(/question/);
    expect((await tool(TOKEN, "vibehub_notify", { ...question(env), recommended: "Postgres" })).error).toMatch(/recommended/);
  });

  it("the same message retried with its idempotencyKey is delivered once", async () => {
    const env = await boot();
    const stream = await openStream(TOKEN, {});
    await stream.next("notifications/events/active");
    const msg = { card: env.card.id, type: "info", text: "subi o PR", idempotencyKey: "pr-12" };
    const a = await tool(TOKEN, "vibehub_notify", msg);
    const b = await tool(TOKEN, "vibehub_notify", msg);
    expect(b.eventId).toBe(a.eventId);
    await stream.next("notifications/events/event");
    await env.events.observeDriverEvent(env.card.id, { type: "result", isError: true }); // a later event, as a fence
    await vi.waitFor(() => expect(stream.events()).toHaveLength(2));
    expect(stream.events().map((m) => m.params.data.kind)).toEqual(["message", "failed"]);
    stream.close();
  });
});

describe("filters, isolation and lifecycle", () => {
  it("filters by project, card and type: what does not match is never sent", async () => {
    const env = await boot();
    const stream = await openStream(TOKEN, { arguments: { cardId: env.card.id, types: ["error"] } });
    await stream.next("notifications/events/active");
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "info" });
    await tool(TOKEN, "vibehub_notify", { card: env.elsewhere.id, type: "error", text: "erro do outro card" });
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "error", text: "erro deste card" });
    const pushed = await stream.next("notifications/events/event");
    expect(pushed.params.data.text).toContain("erro deste card");
    expect(stream.events()).toHaveLength(1);
    stream.close();
  });

  it("a person only hears cards they may see — and loses them the moment the share is taken away", async () => {
    const env = await boot();
    const stream = await openStream(MEMBER_TOKEN, {});
    await stream.next("notifications/events/active");
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "não compartilhado" });
    await env.registry.shareWith({ kind: "card", targetId: env.card.id, userId: env.member.id, level: "view" });
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "compartilhado" });
    await env.registry.unshare("card", env.card.id, env.member.id);
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "revogado" });
    await env.events.observeDriverEvent(env.elsewhere.id, { type: "result", isError: true }); // fence
    await stream.next("notifications/events/event", (m) => m.params.data.text.includes("compartilhado"));
    await new Promise((r) => setTimeout(r, 200));
    expect(stream.events().map((m) => m.params.data.text)).toEqual([expect.stringContaining("compartilhado")]);
    stream.close();
  });

  it("a token revoked while the stream is open ends it: terminated, nothing more delivered, listener gone", async () => {
    const env = await boot();
    await env.registry.shareWith({ kind: "card", targetId: env.card.id, userId: env.member.id, level: "view" });
    const stream = await openStream(MEMBER_TOKEN, {});
    await stream.next("notifications/events/active");
    revoked.add(MEMBER_TOKEN);
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "depois da revogação" });
    const end = await stream.next("notifications/events/terminated");
    expect(end.params.error.code).toBe(-32024);
    await stream.done;
    expect(stream.events()).toEqual([]);
    expect(env.events.cardEventListenerCount()).toBe(0);
  });

  it("two answers to the same question at the same time: one reaches the card, the other is refused", async () => {
    const env = await boot();
    const posted = await tool(TOKEN, "vibehub_notify", question(env));
    const [a, b] = await Promise.all([
      tool(OWNER_TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "Mongo", inReplyTo: posted.eventId }),
      tool(TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "MySQL", inReplyTo: posted.eventId }),
    ]);
    expect([a.error, b.error].filter(Boolean)).toEqual([expect.stringMatching(/not waiting/)]);
    expect(sent).toHaveLength(1);
  });

  it("a send that fails leaves the question open, to be answered again", async () => {
    const env = await boot();
    const posted = await tool(TOKEN, "vibehub_notify", question(env));
    const maestro = await import("../services/maestro/maestro.js");
    vi.mocked(maestro.sendToTerminal).mockRejectedValueOnce(new Error("no live session"));
    expect((await tool(OWNER_TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "Mongo", inReplyTo: posted.eventId })).error).toMatch(/no live session/);
    expect((await tool(OWNER_TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "Mongo", inReplyTo: posted.eventId })).error).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("a failed send does not reopen a question the card already moved past while the answer was in flight", async () => {
    const env = await boot();
    const posted = await tool(TOKEN, "vibehub_notify", question(env));
    const maestro = await import("../services/maestro/maestro.js");
    let fail!: () => void;
    vi.mocked(maestro.sendToTerminal).mockImplementationOnce(() => new Promise((_, reject) => { fail = () => reject(new Error("no live session")); }));
    const answer = tool(OWNER_TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "Mongo", inReplyTo: posted.eventId });
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    await env.events.observeCardStatus(env.card.id, "waiting", "working"); // the card moved on meanwhile
    fail();
    expect((await answer).error).toMatch(/no live session/);
    const { events } = await env.events.eventsAfter(0);
    expect(events.find((e) => e.id === posted.eventId)?.resolvedAt).toEqual(expect.any(Number));
    expect((await tool(OWNER_TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "Mongo", inReplyTo: posted.eventId })).error).toMatch(/not waiting/);
  });

  it("caps the open streams per subscriber", async () => {
    const env = await boot();
    env.mcpEvents.STREAM.maxPerPrincipal = 2;
    const a = await openStream(MEMBER_TOKEN, {});
    const b = await openStream(MEMBER_TOKEN, {});
    await a.next("notifications/events/active");
    await b.next("notifications/events/active");
    const c = await rpc(MEMBER_TOKEN, "events/stream", { name: "card.event" });
    expect(c.error?.code).toBe(-32025);
    const owner = await openStream(OWNER_TOKEN, {}); // someone else is not counted against them
    await owner.next("notifications/events/active");
  });

  it("a member cannot answer a card shared read-only", async () => {
    const env = await boot();
    await env.registry.shareWith({ kind: "card", targetId: env.card.id, userId: env.member.id, level: "view" });
    const posted = await tool(TOKEN, "vibehub_notify", question(env));
    expect((await tool(MEMBER_TOKEN, "vibehub_send_to_terminal", { cardId: env.card.id, text: "Mongo", inReplyTo: posted.eventId })).error).toMatch(/read-only/);
    expect(sent).toEqual([]);
  });

  it("reconnecting with the last cursor replays what was missed, in order, once — then goes live", async () => {
    const env = await boot();
    const first = await openStream(TOKEN, {});
    await first.next("notifications/events/active");
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "um" });
    const seen = await first.next("notifications/events/event");
    first.close();
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "dois" });
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "três" });

    const again = await openStream(TOKEN, { cursor: seen.params.cursor });
    const active = await again.next("notifications/events/active");
    expect(active.params.truncated).toBe(false);
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "quatro" });
    await vi.waitFor(() => expect(again.events()).toHaveLength(3));
    expect(again.events().map((m) => m.params.data.text)).toEqual(['Card "login": dois', 'Card "login": três', 'Card "login": quatro']);
    const cursors = again.events().map((m) => Number(m.params.cursor));
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    again.close();
  });

  it("cursor null starts from now: nothing from before is replayed", async () => {
    const env = await boot();
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "antigo" });
    const stream = await openStream(TOKEN, { cursor: null });
    await stream.next("notifications/events/active");
    await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: "novo" });
    await stream.next("notifications/events/event");
    expect(stream.events().map((m) => m.params.data.text)).toEqual(['Card "login": novo']);
    stream.close();
  });

  it("a burst recorded while the stream is replaying arrives once each, in order", async () => {
    const env = await boot();
    for (let i = 0; i < 5; i++) await tool(TOKEN, "vibehub_notify", { card: env.card.id, type: "info", text: `antes ${i}` });
    const stream = await openStream(TOKEN, { cursor: "0" });
    await Promise.all(Array.from({ length: 5 }, (_, i) => env.events.observeDriverEvent(env.card.id, { type: "result", isError: true, subtype: `e${i}` })));
    await vi.waitFor(() => expect(stream.events()).toHaveLength(10));
    const ids = stream.events().map((m) => m.params.eventId);
    expect(new Set(ids).size).toBe(10);
    const cursors = stream.events().map((m) => Number(m.params.cursor));
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    stream.close();
  });

  it("closing the request unsubscribes: the listener is gone", async () => {
    const env = await boot();
    const before = env.events.cardEventListenerCount();
    const stream = await openStream(TOKEN, {});
    await stream.next("notifications/events/active");
    expect(env.events.cardEventListenerCount()).toBe(before + 1);
    stream.close();
    await vi.waitFor(() => expect(env.events.cardEventListenerCount()).toBe(before));
  });

  it("sends a heartbeat carrying the cursor while nothing happens", async () => {
    const env = await boot();
    env.mcpEvents.STREAM.heartbeatMs = 50;
    const stream = await openStream(TOKEN, {});
    const beat = await stream.next("notifications/events/heartbeat");
    expect(beat.params).toMatchObject({ cursor: expect.any(String), _meta: { "io.modelcontextprotocol/subscriptionId": 77 } });
    stream.close();
  });

  it("an unknown event or bad arguments are a JSON-RPC error and open no stream", async () => {
    const env = await boot();
    const before = env.events.cardEventListenerCount();
    const unknown = await rpc(TOKEN, "events/stream", { name: "nope", arguments: {} });
    expect(unknown.error?.code).toBe(-32023);
    const bad = await rpc(TOKEN, "events/stream", { name: "card.event", arguments: { types: ["gossip"] } });
    expect(bad.error?.code).toBe(-32602);
    const badCursor = await rpc(TOKEN, "events/stream", { name: "card.event", cursor: "abc" });
    expect(badCursor.error?.code).toBe(-32602);
    expect(env.events.cardEventListenerCount()).toBe(before);
  });
});

describe("interop — the official MCP SDK client, over Streamable HTTP", () => {
  it("receives the pushed event as a notification while its events/stream request is still open", async () => {
    const env = await boot();
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { ResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const client = new Client({ name: "consumer", version: "1" });
    const got: any[] = [];
    client.fallbackNotificationHandler = async (n) => { got.push(n); };
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${OWNER_TOKEN}` } },
    }));
    const abort = new AbortController();
    open.push(abort);
    const pending = client.request(
      { method: "events/stream", params: { name: "card.event", arguments: { cardId: env.card.id } } } as never,
      ResultSchema, { signal: abort.signal, timeout: 60_000 },
    ).catch(() => "closed");
    await vi.waitFor(() => expect(got.map((n) => n.method)).toContain("notifications/events/active"));
    await tool(TOKEN, "vibehub_notify", question(env));
    await vi.waitFor(() => expect(got.map((n) => n.method)).toContain("notifications/events/event"));
    expect(got.find((n) => n.method === "notifications/events/event").params.data).toMatchObject({ type: "question", needsAnswer: true, recommended: "Mongo" });
    // The SDK's per-request abort only sends `notifications/cancelled` in ANOTHER POST, which a
    // stateless /mcp (one server per request) cannot tie to this stream: the stream stays until the
    // client closes its HTTP request — what the draft names as the way to stop on Streamable HTTP.
    abort.abort();
    expect(await pending).toBe("closed");
    await new Promise((r) => setTimeout(r, 200));
    expect(env.events.cardEventListenerCount()).toBe(1);
    await client.close();
    await vi.waitFor(() => expect(env.events.cardEventListenerCount()).toBe(0));
  });
});
