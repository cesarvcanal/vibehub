import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * LER EM VOZ ALTA — o alto-falante embaixo de uma resposta terminada. O texto vai à TTS da OpenAI
 * com a chave do servidor e o MP3 volta em stream. O fetch da OpenAI é falso.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

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

function speak(cardId: string, text: unknown, cookie = owner) {
  return app.inject({ method: "POST", url: `/api/cards/${cardId}/voice/speech`, headers: { cookie }, payload: { text } });
}

const MP3 = new Uint8Array([0xff, 0xf3, 0x44, 0xc4, 1, 2, 3]);
function audio() {
  return new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-voice-speech-"));
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

describe("POST /api/cards/:id/voice/speech", () => {
  it("streams the spoken answer back as MP3, with the server's key and never the key to the browser", async () => {
    const id = await makeCard();
    upstream.mockResolvedValueOnce(audio());
    const res = await speak(id, "  Corrigido, doze testes verdes.  ");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(new Uint8Array(res.rawPayload)).toEqual(MP3);
    expect(res.body).not.toContain(KEY);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ model: "gpt-4o-mini-tts", input: "Corrigido, doze testes verdes.", response_format: "mp3" });
  });

  it("works with the GPT-Live flag off: reading aloud is plain TTS, it only needs the key", async () => {
    const env = await import("../config/env.js");
    env.config.voiceLive = { enabled: false, apiKey: KEY };
    const id = await makeCard();
    upstream.mockResolvedValueOnce(audio());
    expect((await speak(id, "oi")).statusCode).toBe(200);
    const status = (await app.inject({ method: "GET", url: "/api/voice/live", headers: { cookie: owner } })).json();
    expect(status).toMatchObject({ enabled: false, speech: true });
  });

  it("503s without any key, and the status says so", async () => {
    const env = await import("../config/env.js");
    env.config.voiceLive = { enabled: true, apiKey: "" };
    const id = await makeCard();
    expect((await speak(id, "oi")).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/api/voice/live", headers: { cookie: owner } })).json().speech).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["not a string", 42],
    ["past OpenAI's 4096", "a".repeat(4_097)],
  ])("400s bad text (%s) without calling OpenAI", async (_label, text) => {
    const id = await makeCard();
    expect((await speak(id, text)).statusCode).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [401, 502],
    [429, 429],
    [500, 502],
  ])("maps an upstream %i to %i without leaking its body", async (status, expected) => {
    const id = await makeCard();
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: `bad ${KEY}` } }), { status }));
    const res = await speak(id, "oi");
    expect(res.statusCode).toBe(expected);
    expect(res.body).not.toContain(KEY);
  });

  it("502s when OpenAI cannot be reached", async () => {
    const id = await makeCard();
    upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await speak(id, "oi")).statusCode).toBe(502);
  });

  it("caps the pieces per person per minute — a stuck button does not bill in a loop", async () => {
    const id = await makeCard();
    const { SPEECH_PER_MINUTE } = await import("../services/voice/speech.js");
    upstream.mockImplementation(async () => audio());
    for (let i = 0; i < SPEECH_PER_MINUTE; i++) expect((await speak(id, `parte ${i}`)).statusCode).toBe(200);
    expect((await speak(id, "uma a mais")).statusCode).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(SPEECH_PER_MINUTE);
  });

  it("401s without a session, 404s an unknown card, 403s a read-only share", async () => {
    const id = await makeCard();
    expect((await speak(id, "oi", "")).statusCode).toBe(401);
    expect((await speak("ghost", "oi")).statusCode).toBe(404);
    const memberId = (await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: owner },
      payload: { username: "alex", password: "supersecret", role: "member" },
    })).json().user.id as string;
    await app.inject({ method: "POST", url: `/api/cards/${id}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level: "view" } });
    const member = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" } }));
    expect((await speak(id, "oi", member)).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
