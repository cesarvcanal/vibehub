import { config } from "../../config/env.js";
import { secretGet } from "../../secrets/vault.js";
import { OPENAI_KEY } from "../transcribe/transcribe.js";
import { logger } from "../../utils/logger.js";
import { VoiceLiveError, upstreamFailure } from "./live.js";

/**
 * READ ALOUD — the speaker button under a finished answer in a card's chat, like ChatGPT's.
 *
 * The browser sends one piece of the answer's text (already stripped of markdown and split into
 * pieces, see the front's readAloud.ts) and gets the spoken audio back as MP3, streamed straight
 * from OpenAI's text-to-speech. Same key as the voice mode (env or vault); unlike the voice mode it
 * does not depend on the GPT-Live POC flag — it is a plain TTS request, not a live session.
 *
 * Never logged: the key and the text.
 */

export const SPEECH_URL = "https://api.openai.com/v1/audio/speech";
export const SPEECH_MODEL = "gpt-4o-mini-tts";
export const SPEECH_VOICE = "marin";
const SPEECH_INSTRUCTIONS = "Fale em português do Brasil, com tom natural, claro e num ritmo confortável de ouvir.";

/** OpenAI's TTS takes at most 4096 characters per request. */
export const SPEECH_MAX_CHARS = 4096;

/** Until the first byte: a TTS that has not started answering by now is not coming back. */
export const SPEECH_TIMEOUT_MS = 30_000;

/**
 * Pieces per person per minute. A long answer is a dozen pieces at most; this stops a stuck button
 * (or a script) from billing in a loop.
 */
export const SPEECH_PER_MINUTE = 40;

async function speechApiKey(): Promise<string | null> {
  return config.voiceLive.apiKey || (await secretGet(OPENAI_KEY)) || null;
}

/** Whether the server can read answers aloud — a key is reachable. Never the key itself. */
export async function speechAvailable(): Promise<boolean> {
  return Boolean(await speechApiKey());
}

/** The text as sent by the browser, or a 400. PURE. */
export function validateSpeechText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) throw new VoiceLiveError(400, "text is required");
  if (text.length > SPEECH_MAX_CHARS) throw new VoiceLiveError(400, `text is longer than ${SPEECH_MAX_CHARS} characters`);
  return text.trim();
}

const recent = new Map<string, number[]>();

/** Records one piece for `user`, or throws 429 past the ceiling. Exported for tests. */
export function takeSpeechSlot(user: string, now: number = Date.now()): void {
  const kept = (recent.get(user) ?? []).filter((at) => now - at < 60_000);
  if (kept.length >= SPEECH_PER_MINUTE) {
    recent.set(user, kept);
    throw new VoiceLiveError(429, "too many read-aloud requests — wait a minute");
  }
  kept.push(now);
  recent.set(user, kept);
}

export function resetSpeechSlots(): void {
  recent.clear();
}

export interface SynthesizeOptions {
  user: string;
  cardId?: string;
  /** Aborted when the browser gives up (stop pressed, tab closed): the upstream call goes with it. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * One piece of text → the upstream response, whose body is the MP3 stream. Throws
 * {@link VoiceLiveError} with the HTTP status the route should answer.
 */
export async function synthesizeSpeech(text: unknown, opts: SynthesizeOptions): Promise<ReadableStream<Uint8Array>> {
  const input = validateSpeechText(text);
  const apiKey = await speechApiKey();
  if (!apiKey) throw new VoiceLiveError(503, "read aloud is not configured — set an OpenAI key");
  takeSpeechSlot(opts.user);

  const signals = [AbortSignal.timeout(SPEECH_TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  let resp: Response;
  try {
    resp = await (opts.fetchImpl ?? fetch)(SPEECH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SPEECH_MODEL,
        voice: SPEECH_VOICE,
        input,
        instructions: SPEECH_INSTRUCTIONS,
        response_format: "mp3",
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new VoiceLiveError(499, "cancelled");
    const timedOut = (err as Error).name === "TimeoutError";
    logger.warn({ timedOut }, "voice: text-to-speech request failed");
    throw new VoiceLiveError(timedOut ? 504 : 502, timedOut ? "OpenAI did not answer in time" : "could not reach OpenAI");
  }
  if (!resp.ok || !resp.body) {
    logger.warn({ status: resp.status }, "voice: text-to-speech refused");
    throw upstreamFailure(resp.ok ? 502 : resp.status);
  }
  logger.info({ audit: true, action: "voice.speech", by: opts.user, card: opts.cardId, chars: input.length }, "read aloud");
  return resp.body;
}
