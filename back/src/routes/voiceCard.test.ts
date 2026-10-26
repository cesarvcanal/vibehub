import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * VOZ DENTRO DO CHAT DO CARD — a chamada nasce com o contexto da conversa do card, e os turnos
 * falados entram no MESMO log do chat (idempotentes por `vid`). O fetch da OpenAI é falso.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
const KEY = "sk-test-voice-key-never-leaks";

let dir = "";
let app: FastifyInstance;
let owner = "";
const upstream = vi.fn();

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  env.config.voiceLive = { enabled: true, apiKey: KEY };
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js");
    return { ...actual, prepareCard: vi.fn(async () => undefined), openCard: vi.fn(async () => undefined) };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

async function makeCard(): Promise<string> {
  const projectId = (await app.inject({
    method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "p" },
  })).json().project.id as string;
  return (await app.inject({
    method: "POST", url: "/api/cards", headers: { cookie: owner }, payload: { projectId, title: "voz" },
  })).json().card.id as string;
}

function saveTurns(cardId: string, turns: unknown[], cookie = owner) {
  return app.inject({ method: "POST", url: `/api/cards/${cardId}/voice/turns`, headers: { cookie }, payload: { turns } });
}

async function history(cardId: string) {
  const { readHistory } = await import("../services/sdk/history.js");
  return await readHistory(cardId);
}

function answer() {
  return new Response(JSON.stringify({ session: { id: "live_9" }, transport: { type: "webrtc", sdp: "v=0 answer" } }), {
    status: 201, headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-voice-card-"));
  upstream.mockReset();
  vi.stubGlobal("fetch", upstream);
  app = await boot();
  owner = cookieOf(await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("POST /api/cards/:id/voice/turns", () => {
  it("writes the spoken turns into the card's chat log, in order, stamped with who held the call", async () => {
    const id = await makeCard();
    const at = Date.now();
    const res = await saveTurns(id, [
      { vid: "turn-user-1", role: "user", text: "  qual o status do deploy?  ", at },
      { vid: "turn-ai-1", role: "assistant", text: "O agente terminou o build.", at: at + 900 },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: ["turn-user-1", "turn-ai-1"], duplicate: [] });
    const log = (await history(id)).filter((e) => e.type === "voice_turn");
    expect(log).toEqual([
      { type: "voice_turn", vid: "turn-user-1", role: "user", text: "qual o status do deploy?", at, from: { kind: "owner", name: "owner" } },
      { type: "voice_turn", vid: "turn-ai-1", role: "assistant", text: "O agente terminou o build.", at: at + 900, from: { kind: "owner", name: "owner" } },
    ]);
  });

  it("is idempotent on vid: a retry, or two saves racing, writes the turn once", async () => {
    const id = await makeCard();
    const turn = { vid: "turn-user-2", role: "user", text: "oi", at: Date.now() };
    const [a, b] = await Promise.all([saveTurns(id, [turn]), saveTurns(id, [turn])]);
    expect([...a.json().saved, ...b.json().saved]).toEqual(["turn-user-2"]);
    expect((await saveTurns(id, [turn])).json()).toEqual({ saved: [], duplicate: ["turn-user-2"] });
    expect((await history(id)).filter((e) => e.type === "voice_turn")).toHaveLength(1);
  });

  it("remembers the ids already on disk after a restart", async () => {
    const id = await makeCard();
    const turn = { vid: "turn-user-3", role: "user", text: "persistiu", at: Date.now() };
    await saveTurns(id, [turn]);
    await app.close();
    app = await boot();
    owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "supersecret" } }));
    expect((await saveTurns(id, [turn])).json()).toEqual({ saved: [], duplicate: ["turn-user-3"] });
  });

  it("a retry after a long conversation (past the replay window) still finds its turn", async () => {
    const id = await makeCard();
    const turn = { vid: "turn-early-1", role: "user", text: "lá atrás", at: Date.now() };
    await saveTurns(id, [turn]);
    const { appendHistoryReported } = await import("../services/sdk/history.js");
    for (let i = 0; i < 600; i++) await appendHistoryReported(id, { type: "user", text: `msg ${i}` });
    await app.close();
    app = await boot();
    owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "supersecret" } }));
    expect((await saveTurns(id, [turn])).json()).toEqual({ saved: [], duplicate: ["turn-early-1"] });
  });

  it("drops blank turns and clamps a skewed clock to the server's", async () => {
    const id = await makeCard();
    const res = await saveTurns(id, [
      { vid: "turn-blank", role: "user", text: "   ", at: Date.now() },
      { vid: "turn-skew", role: "assistant", text: "ok", at: 1 },
    ]);
    expect(res.json().saved).toEqual(["turn-skew"]);
    const [turn] = (await history(id)).filter((e) => e.type === "voice_turn");
    expect(Math.abs((turn.at ?? 0) - Date.now())).toBeLessThan(60_000);
  });

  it.each([
    [{ vid: "x", role: "user", text: "a", at: 1 }, "short id"],
    [{ vid: "turn-ok-1", role: "system", text: "a", at: 1 }, "bad role"],
    [{ vid: "turn-ok-1", role: "user", text: 3, at: 1 }, "no text"],
    [{ vid: "turn-ok-1", role: "user", text: "a".repeat(8_001), at: 1 }, "too long"],
  ])("400s a bad turn (%j: %s) and writes nothing", async (turn) => {
    const id = await makeCard();
    expect((await saveTurns(id, [turn])).statusCode).toBe(400);
    expect((await history(id)).filter((e) => e.type === "voice_turn")).toHaveLength(0);
  });

  it("401s without a session, 404s an unknown card", async () => {
    const id = await makeCard();
    expect((await saveTurns(id, [{ vid: "turn-x-1", role: "user", text: "a", at: 1 }], "")).statusCode).toBe(401);
    expect((await saveTurns("ghost", [{ vid: "turn-x-1", role: "user", text: "a", at: 1 }])).statusCode).toBe(404);
  });

  it("refuses a read-only share: reading the chat is not holding a call in it", async () => {
    const id = await makeCard();
    const memberId = (await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: owner },
      payload: { username: "alex", password: "supersecret", role: "member" },
    })).json().user.id as string;
    await app.inject({ method: "POST", url: `/api/cards/${id}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level: "view" } });
    const member = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" } }));
    expect((await saveTurns(id, [{ vid: "turn-ro-1", role: "user", text: "a", at: Date.now() }], member)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: member }, payload: { sdp: OFFER } })).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("POST /api/cards/:id/voice/sessions", () => {
  it("opens the call knowing the card's recent thread — typed, answered and spoken", async () => {
    const id = await makeCard();
    const { appendHistoryReported } = await import("../services/sdk/history.js");
    await appendHistoryReported(id, { type: "user", text: "corrige o teste do login", at: 1 });
    await appendHistoryReported(id, { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env" } });
    await appendHistoryReported(id, { type: "assistant_text", text: "Corrigido, 12 testes verdes." } as never);
    await saveTurns(id, [{ vid: "turn-ctx-1", role: "user", text: "e o deploy?", at: Date.now() }]);
    upstream.mockResolvedValueOnce(answer());

    const res = await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ sessionId: "live_9", sdp: "v=0 answer" });
    const sent = JSON.parse(String((upstream.mock.calls[0] as [string, RequestInit])[1].body));
    const instructions = sent.session.instructions as string;
    expect(instructions).toContain("agente do card");
    expect(instructions).toContain("Pessoa (digitou): corrige o teste do login");
    expect(instructions).toContain("Agente do card (Claude): Corrigido, 12 testes verdes.");
    expect(instructions).toContain("Pessoa (falou): e o deploy?");
    // Tool calls never reach the voice: noise, and sometimes secrets the agent printed.
    expect(instructions).not.toContain(".env");
    expect(instructions.indexOf("corrige")).toBeLessThan(instructions.indexOf("e o deploy?"));
  });

  it("still 404s while the mode is off, without calling OpenAI", async () => {
    const id = await makeCard();
    const env = await import("../config/env.js");
    env.config.voiceLive = { enabled: false, apiKey: KEY };
    expect((await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } })).statusCode).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("formatVoiceContext", () => {
  it("keeps the newest lines inside the budget and clips a long answer", async () => {
    const { formatVoiceContext, CONTEXT_ITEM_MAX_CHARS } = await import("../services/voice/context.js");
    const events = [
      { type: "user", text: "primeira" },
      { type: "assistant_text", text: "x".repeat(5_000) },
      { type: "voice_turn", vid: "v1", role: "assistant", text: "última" },
    ] as never[];
    const all = formatVoiceContext(events);
    expect(all).toContain("primeira");
    expect(all).toContain(`${"x".repeat(CONTEXT_ITEM_MAX_CHARS - 1)}…`);
    const tight = formatVoiceContext(events, 40);
    expect(tight).toBe("Você (voz): última");
    expect(formatVoiceContext([])).toBe("");
  });
});
