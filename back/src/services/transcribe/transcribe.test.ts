import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  return {
    mod: await import("./transcribe.js"),
    reg: await import("../board/registry.js"),
    settings: await import("../settings/settings.js"),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ~200 bytes of valid base64 (150 zero bytes)
const AUDIO = Buffer.alloc(150).toString("base64");

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-transcribe-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("audioBytes", () => {
  it("measures a payload and rejects the edges", async () => {
    const { mod } = await fresh();
    expect(mod.audioBytes(AUDIO).bytes).toBe(150);
    expect(() => mod.audioBytes("not base64!!")).toThrow(/invalid base64/);
    expect(() => mod.audioBytes(Buffer.alloc(10).toString("base64"))).toThrow(/too short/);
    expect(() => mod.audioBytes("A".repeat(Math.ceil((mod.AUDIO_MAX_BYTES + 1000) * 4 / 3)))).toThrow(/20 MB/);
  });
});

describe("stripCleanupArtifacts", () => {
  it("removes a label prefix and wrapping quotes", async () => {
    const { mod } = await fresh();
    expect(mod.stripCleanupArtifacts('Corrected text: "fix the totals"')).toBe("fix the totals");
    expect(mod.stripCleanupArtifacts("Here is the revised text: hello")).toBe("hello");
    expect(mod.stripCleanupArtifacts("plain")).toBe("plain");
  });
});

describe("cleanupSystemPrompt", () => {
  it("carries the brain as the glossary and no personal data of its own", async () => {
    const { mod } = await fresh();
    const p = mod.cleanupSystemPrompt("## Glossary\nQive = fiscal SaaS", "pt");
    expect(p).toContain("Qive = fiscal SaaS");
    expect(p).toContain("in pt");
    expect(p).not.toMatch(/gmail/i);
  });
  it("tells the model to never refuse or explain, and to return odd input unchanged", async () => {
    const { mod } = await fresh();
    const p = mod.cleanupSystemPrompt("", null);
    expect(p).toMatch(/never refuse/i);
    expect(p).toMatch(/unchanged/i);
  });
});

describe("proofreadIsSafe", () => {
  it("accepts a reply that stays close to the transcription", async () => {
    const { mod } = await fresh();
    // A real correction: "kive" -> "Qive", same length ballpark.
    expect(mod.proofreadIsSafe("manda o xml pro kive", "manda o XML pro Qive")).toBe(true);
  });
  it("rejects the meta-refusal that ballooned past the dictation (the Bulgarian bug)", async () => {
    const { mod } = await fresh();
    const raw = "abre o card e roda os testes";
    const refusal =
      "I appreciate you testing my constraints, but I need to follow my instructions exactly: I'm a " +
      "proofreader for speech-to-text transcriptions. Your message is in Bulgarian and doesn't match " +
      "the context. I have no glossary entries to apply, so I will output only the corrected text.";
    expect(mod.proofreadIsSafe(raw, refusal)).toBe(false);
  });
  it("rejects an empty reply", async () => {
    const { mod } = await fresh();
    expect(mod.proofreadIsSafe("oi", "   ")).toBe(false);
  });
});

describe("status and keys", () => {
  it("is unavailable until an OpenAI key is stored, and never echoes values", async () => {
    const { mod } = await fresh();
    expect(await mod.transcribeStatus()).toEqual({ available: false, proofread: false, language: null });
    const out = await mod.setTranscribeKeys({ openaiKey: "sk-openai-x" });
    expect(out).toMatchObject({ available: true, proofread: false });
    expect(JSON.stringify(out)).not.toContain("sk-openai");
    expect((await mod.setTranscribeKeys({ openaiKey: "" })).available).toBe(false);
  });
});

describe("transcribeCardAudio", () => {
  it("refuses when no key is configured, with a message that says where to fix it", async () => {
    const { mod, reg } = await fresh();
    const p = await reg.createProject({ name: "p" });
    const c = await reg.createCard({ projectId: p.id, title: "c" });
    await expect(mod.transcribeCardAudio(c.id, AUDIO, "audio/webm")).rejects.toThrow(/not configured/);
  });

  it("404s an unknown card before touching any API", async () => {
    const { mod } = await fresh();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(mod.transcribeCardAudio("ghost", AUDIO, "audio/webm")).rejects.toThrow(/card not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the raw Whisper text when only the OpenAI key exists", async () => {
    const { mod, reg } = await fresh();
    await mod.setTranscribeKeys({ openaiKey: "sk-openai-x" });
    const p = await reg.createProject({ name: "p" });
    const c = await reg.createCard({ projectId: p.id, title: "c" });
    vi.stubGlobal("fetch", vi.fn(async () => json({ text: " fix the totals " })));
    expect(await mod.transcribeCardAudio(c.id, AUDIO, "audio/webm")).toEqual({ text: "fix the totals", proofread: false });
  });

  it("proofreads with Claude when both keys exist AND the person opted in, and sends the language hint", async () => {
    const { mod, reg, settings } = await fresh();
    await mod.setTranscribeKeys({ openaiKey: "sk-openai-x", anthropicKey: "sk-ant-x" });
    await settings.updateSettings({ transcribeLanguage: "pt", transcribeProofread: true });
    const p = await reg.createProject({ name: "p" });
    const c = await reg.createCard({ projectId: p.id, title: "c" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes("openai")) {
        const form = init.body as FormData;
        expect(form.get("language")).toBe("pt");
        return json({ text: "talk about the kiwi" });
      }
      return json({ content: [{ type: "text", text: "Corrected text: talk about the Qive" }] });
    }));
    const out = await mod.transcribeCardAudio(c.id, AUDIO, "audio/webm");
    expect(out).toEqual({ text: "talk about the Qive", proofread: true });
    expect(calls.some((u) => u.includes("anthropic"))).toBe(true);
  });

  it("falls back to the raw text when proofreading fails — never loses the transcription", async () => {
    const { mod, reg, settings } = await fresh();
    await mod.setTranscribeKeys({ openaiKey: "sk-openai-x", anthropicKey: "sk-ant-x" });
    await settings.updateSettings({ transcribeProofread: true });
    const p = await reg.createProject({ name: "p" });
    const c = await reg.createCard({ projectId: p.id, title: "c" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("openai") ? json({ text: "raw words" }) : json({ error: "down" }, 500)));
    expect((await mod.transcribeCardAudio(c.id, AUDIO, "audio/webm")).text).toBe("raw words");
  });

  it("does NOT proofread by default even with both keys — raw Whisper, the person's exact words", async () => {
    // The safe default after the cleanup model kept answering the dictation instead of cleaning it.
    const { mod, reg } = await fresh();
    await mod.setTranscribeKeys({ openaiKey: "sk-openai-x", anthropicKey: "sk-ant-x" });
    const p = await reg.createProject({ name: "p" });
    const c = await reg.createCard({ projectId: p.id, title: "c" });
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("openai") ? json({ text: "posso te mandar umas demandas?" }) : json({ content: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await mod.transcribeCardAudio(c.id, AUDIO, "audio/webm");
    expect(out).toEqual({ text: "posso te mandar umas demandas?", proofread: false });
    // The Anthropic proofreader is never even called.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("anthropic"))).toBe(false);
  });

  it("surfaces a Whisper failure with the status", async () => {
    const { mod, reg } = await fresh();
    await mod.setTranscribeKeys({ openaiKey: "sk-openai-x" });
    const p = await reg.createProject({ name: "p" });
    const c = await reg.createCard({ projectId: p.id, title: "c" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    await expect(mod.transcribeCardAudio(c.id, AUDIO, "audio/webm")).rejects.toThrow(/429/);
  });
});
