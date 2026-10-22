import { config } from "../../config/env.js";
import { secretGet } from "../../secrets/vault.js";
import { OPENAI_KEY } from "../transcribe/transcribe.js";
import { logger } from "../../utils/logger.js";

/**
 * VOICE MODE (POC) — a spoken conversation with OpenAI's GPT-Live, like ChatGPT's voice mode.
 *
 * The browser owns the media: it opens a WebRTC peer connection with the microphone track and the
 * `oai-events` data channel, and builds the SDP offer. GPT-Live has no ephemeral client keys, so the
 * one step that needs the API key — trading that offer for an answer with `POST /v1/live/sessions` —
 * happens HERE. After that, audio flows browser ↔ OpenAI directly; this server never sees it.
 * Turn-taking and barge-in are the model's (GPT-Live is full duplex): there is nothing to configure.
 *
 * Off unless `VIBEHUB_VOICE_LIVE=1`. Not wired to Claude Code: it is a plain conversation.
 * Never logged: the key, the SDP (it carries the client's network candidates) and any audio.
 */

export const LIVE_MODEL = "gpt-live-1";
export const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";

/** A browser offer is a few KB; the official sample caps the body at 64 KB. */
export const SDP_MAX_BYTES = 64 * 1024;

/** Session creation is a single SDP exchange — anything slower than this is not coming back. */
export const LIVE_TIMEOUT_MS = 20_000;

/**
 * Each creation bills 15 s of voice up front, so a stuck "start" button (or a script) must not open
 * sessions in a loop. Generous for a person, tight for a loop.
 */
export const CREATES_PER_MINUTE = 6;

const INSTRUCTIONS =
  "Você é o assistente de voz do vibehub. Converse em português do Brasil, de forma natural e breve: " +
  "respostas curtas, faladas, sem listas nem markdown. Se não souber, diga que não sabe.";

export class VoiceLiveError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface VoiceLiveStatus {
  /** The operator turned the POC on (VIBEHUB_VOICE_LIVE=1). */
  enabled: boolean;
  /** An OpenAI key is reachable by the server — env or vault. Never the key itself. */
  available: boolean;
  model: string;
}

async function liveApiKey(): Promise<string | null> {
  return config.voiceLive.apiKey || (await secretGet(OPENAI_KEY)) || null;
}

export async function voiceLiveStatus(): Promise<VoiceLiveStatus> {
  const enabled = config.voiceLive.enabled;
  return { enabled, available: enabled && Boolean(await liveApiKey()), model: LIVE_MODEL };
}

/** The offer as sent by the browser, or a 400. PURE. */
export function validateOffer(sdp: unknown): string {
  if (typeof sdp !== "string" || !sdp.trim()) throw new VoiceLiveError(400, "an SDP offer is required");
  if (Buffer.byteLength(sdp) > SDP_MAX_BYTES) throw new VoiceLiveError(400, "SDP offer is too large");
  if (!sdp.trimStart().startsWith("v=0")) throw new VoiceLiveError(400, "not an SDP offer");
  return sdp;
}

/** Creation timestamps per user, for {@link CREATES_PER_MINUTE}. In memory: a POC on one process. */
const recentCreates = new Map<string, number[]>();

/** Records one creation for `user`, or throws 429 past the ceiling. Exported for tests. */
export function takeCreateSlot(user: string, now: number = Date.now()): void {
  const recent = (recentCreates.get(user) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= CREATES_PER_MINUTE) {
    recentCreates.set(user, recent);
    throw new VoiceLiveError(429, "too many voice sessions — wait a minute");
  }
  recent.push(now);
  recentCreates.set(user, recent);
}

export function resetCreateSlots(): void {
  recentCreates.clear();
}

/** What the upstream said, reduced to what is safe to log: status and error code, never the body. */
async function upstreamCode(resp: Response): Promise<string | null> {
  try {
    const body = (await resp.json()) as { error?: { code?: unknown; type?: unknown } };
    const code = body.error?.code ?? body.error?.type;
    return typeof code === "string" ? code.slice(0, 80) : null;
  } catch {
    return null;
  }
}

/** The upstream's failure as the browser should hear it. PURE. */
export function upstreamFailure(status: number): VoiceLiveError {
  if (status === 401 || status === 403) return new VoiceLiveError(502, "OpenAI rejected the API key");
  if (status === 429) return new VoiceLiveError(429, "OpenAI rate limit or quota reached");
  if (status >= 500) return new VoiceLiveError(502, "OpenAI is unavailable — try again");
  return new VoiceLiveError(502, "OpenAI refused to create the voice session");
}

export interface LiveSessionAnswer {
  sessionId: string;
  sdp: string;
}

export interface CreateLiveSessionOptions {
  /** Who asked — the rate ceiling and the audit line. */
  user: string;
  /** Aborted when the browser gives up (cancel, tab closed): the upstream call goes with it. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Trades the browser's SDP offer for GPT-Live's answer. Throws {@link VoiceLiveError} with the
 * HTTP status the route should answer.
 */
export async function createLiveSession(offer: unknown, opts: CreateLiveSessionOptions): Promise<LiveSessionAnswer> {
  if (!config.voiceLive.enabled) throw new VoiceLiveError(404, "voice mode is disabled");
  const sdp = validateOffer(offer);
  const apiKey = await liveApiKey();
  if (!apiKey) throw new VoiceLiveError(503, "voice mode is not configured — set VIBEHUB_VOICE_OPENAI_API_KEY");
  takeCreateSlot(opts.user);

  const signals = [AbortSignal.timeout(LIVE_TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  let resp: Response;
  try {
    resp = await (opts.fetchImpl ?? fetch)(LIVE_SESSIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: { model: LIVE_MODEL, instructions: INSTRUCTIONS },
        transport: { type: "webrtc", sdp },
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new VoiceLiveError(499, "cancelled");
    const timedOut = (err as Error).name === "TimeoutError";
    logger.warn({ timedOut }, "voice: GPT-Live session request failed");
    throw new VoiceLiveError(timedOut ? 504 : 502, timedOut ? "OpenAI did not answer in time" : "could not reach OpenAI");
  }

  if (!resp.ok) {
    logger.warn({ status: resp.status, code: await upstreamCode(resp) }, "voice: GPT-Live refused the session");
    throw upstreamFailure(resp.status);
  }
  const body = (await resp.json().catch(() => null)) as
    | { session?: { id?: unknown }; transport?: { sdp?: unknown } }
    | null;
  const sessionId = body?.session?.id;
  const answer = body?.transport?.sdp;
  if (typeof sessionId !== "string" || typeof answer !== "string" || !answer) {
    logger.warn("voice: GPT-Live answered without a session id or SDP answer");
    throw new VoiceLiveError(502, "OpenAI returned an unexpected answer");
  }
  logger.info({ audit: true, action: "voice.live.session", session: sessionId, by: opts.user }, "voice session created");
  return { sessionId, sdp: answer };
}
