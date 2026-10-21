import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * O modo de voz (POC): a rota que troca a oferta SDP do navegador pela resposta do GPT-Live.
 * O fetch da OpenAI é falso — nenhum teste aqui fala com a rede nem gasta crédito.
 */

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
const KEY = "sk-test-voice-key-never-leaks";

let dir = "";
let app: FastifyInstance;
let cookie = "";
let env: typeof import("../config/env.js");
let live: typeof import("../services/voice/live.js");
const upstream = vi.fn();

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  env.config.voiceLive = { enabled: true, apiKey: KEY };
  live = await import("../services/voice/live.js");
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function answer(status = 201, body: unknown = { session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function createSession(payload: unknown = { sdp: OFFER }, headers: Record<string, string> = { cookie }) {
  return app.inject({ method: "POST", url: "/api/voice/live/sessions", headers, payload: payload as object });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-voice-"));
  upstream.mockReset();
  vi.stubGlobal("fetch", upstream);
  app = await boot();
  const res = await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  });
  cookie = `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/voice/live", () => {
  it("reports on/off and whether a key exists — never the key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/voice/live", headers: { cookie } });
    expect(res.json()).toEqual({ enabled: true, available: true, model: "gpt-live-1" });
    expect(res.body).not.toContain(KEY);
  });

  it("off by default: a disabled install is neither enabled nor available", async () => {
    env.config.voiceLive = { enabled: false, apiKey: KEY };
    const res = await app.inject({ method: "GET", url: "/api/voice/live", headers: { cookie } });
    expect(res.json()).toMatchObject({ enabled: false, available: false });
  });

  it("401s without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/voice/live" })).statusCode).toBe(401);
  });
});

describe("POST /api/voice/live/sessions", () => {
  it("trades the offer for GPT-Live's answer, key on the server side only", async () => {
    upstream.mockResolvedValueOnce(answer());
    const res = await createSession();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ sessionId: "live_123", sdp: "v=0 answer" });
    expect(res.body).not.toContain(KEY);

    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(String(init.body));
    expect(sent.session.model).toBe("gpt-live-1");
    expect(sent.transport).toEqual({ type: "webrtc", sdp: OFFER });
    // The HTTP request starts the session: no session.start, no audio format on WebRTC.
    expect(sent.session.audio).toBeUndefined();
  });

  it("falls back to the voice-input key in the vault when the env has none", async () => {
    env.config.voiceLive = { enabled: true, apiKey: "" };
    const { secretSet } = await import("../secrets/vault.js");
    await secretSet("TRANSCRIBE_OPENAI_API_KEY", "sk-vault");
    upstream.mockResolvedValueOnce(answer());
    expect((await createSession()).statusCode).toBe(201);
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-vault");
  });

  it("401s without a session and never calls OpenAI", async () => {
    expect((await createSession({ sdp: OFFER }, {})).statusCode).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("404s while the mode is off, without calling OpenAI", async () => {
    env.config.voiceLive = { enabled: false, apiKey: KEY };
    expect((await createSession()).statusCode).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("503s with no key anywhere", async () => {
    env.config.voiceLive = { enabled: true, apiKey: "" };
    const res = await createSession();
    expect(res.statusCode).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "missing"],
    [{ sdp: "" }, "empty"],
    [{ sdp: 42 }, "not a string"],
    [{ sdp: "hello" }, "not SDP"],
  ])("400s a bad offer (%s: %s)", async (payload) => {
    expect((await createSession(payload)).statusCode).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an offer past the size cap", async () => {
    const res = await createSession({ sdp: "v=0\r\n" + "a".repeat(live.SDP_MAX_BYTES) });
    expect([400, 413]).toContain(res.statusCode);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [401, 502, "rejected the API key"],
    [429, 429, "rate limit"],
    [500, 502, "unavailable"],
    [400, 502, "refused"],
  ])("maps an upstream %i to %i without echoing its body", async (status, expected, message) => {
    upstream.mockResolvedValueOnce(answer(status, { error: { code: "secret_detail", message: `leak ${KEY}` } }));
    const res = await createSession();
    expect(res.statusCode).toBe(expected);
    expect(res.json().error).toContain(message);
    expect(res.body).not.toContain("leak");
  });

  it("502s an answer without session id or SDP", async () => {
    upstream.mockResolvedValueOnce(answer(201, { session: {} }));
    expect((await createSession()).statusCode).toBe(502);
  });

  it("502s when OpenAI cannot be reached, 504 when it times out", async () => {
    upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await createSession()).statusCode).toBe(502);
    upstream.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    expect((await createSession()).statusCode).toBe(504);
  });

  it("caps session creation per person — each one bills 15 s up front", async () => {
    upstream.mockImplementation(async () => answer());
    for (let i = 0; i < live.CREATES_PER_MINUTE; i++) expect((await createSession()).statusCode).toBe(201);
    expect((await createSession()).statusCode).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(live.CREATES_PER_MINUTE);
  });
});

describe("takeCreateSlot", () => {
  it("frees a slot once the minute has passed", () => {
    live.resetCreateSlots();
    for (let i = 0; i < live.CREATES_PER_MINUTE; i++) live.takeCreateSlot("u", 1_000);
    expect(() => live.takeCreateSlot("u", 1_000)).toThrow(/too many/);
    expect(() => live.takeCreateSlot("other", 1_000)).not.toThrow();
    expect(() => live.takeCreateSlot("u", 61_001)).not.toThrow();
  });
});

describe("createLiveSession cancellation", () => {
  it("aborts the upstream call when the browser gives up", async () => {
    live.resetCreateSlots();
    const gone = new AbortController();
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      started();
    }));
    const pending = live.createLiveSession(OFFER, { user: "u", signal: gone.signal, fetchImpl: fetchImpl as unknown as typeof fetch });
    await inFlight;
    gone.abort();
    await expect(pending).rejects.toMatchObject({ status: 499 });
  });
});
