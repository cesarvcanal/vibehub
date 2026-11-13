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
 * Off unless `VIBEHUB_VOICE_LIVE=1`. Held from a card's chat (`/api/cards/:id/voice/sessions`) it
 * knows that chat's recent thread and its turns are saved there (./context.ts, ./turns.ts). It never
 * acts on the card itself: what it cannot answer from that thread it DELEGATES, and delegation is
 * the browser's (`client`) — the chat hands the task to the card's agent and returns the answer
 * (front/src/features/voice/useVoiceDelegation.ts). A session with no `delegation` is client mode
 * too, and nothing answered it: the voice promised "deixa eu recapitular" and waited forever
 * (production, 2026-11-13). The bare `/api/voice/live/sessions` is the plain conversation the
 * calibration lab uses.
 * Never logged: the key, the SDP (it carries the client's network candidates) and any audio.
 */

const LIVE_MODEL = "gpt-live-1";
const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";

/** A browser offer is a few KB; the official sample caps the body at 64 KB. */
export const SDP_MAX_BYTES = 64 * 1024;

/** Session creation is a single SDP exchange — anything slower than this is not coming back. */
const LIVE_TIMEOUT_MS = 20_000;

/**
 * Each creation bills 15 s of voice up front, so a stuck "start" button (or a script) must not open
 * sessions in a loop. Generous for a person, tight for a loop.
 */
export const CREATES_PER_MINUTE = 6;

/** Who delegated work goes to: always this app (see the module comment). */
const DELEGATION = { type: "client" } as const;

const INSTRUCTIONS =
  "Você é o assistente de voz do vibehub. Converse em português do Brasil, de forma natural e breve: " +
  "respostas curtas, faladas, sem listas nem markdown. Se não souber, diga que não sabe.\n\n" +
  "Delegation policy:\nBackend tools: nenhuma nesta conversa. Não gere <|SpawnThinking|>.";

/**
 * A call held INSIDE a card's chat — the person codes by talking. The card's Claude Code agent does
 * the work; the voice converses, asks what is missing and hands the work over (delegation), then
 * says the result. What the person types or attaches during the call goes to the agent through the
 * chat, and reaches the voice only as quiet context (`session.thinking.append`, see the browser's
 * liveVoice.ts). The `Delegation policy` labels and `<|SpawnThinking|>` are GPT-Live's prompt
 * contract (developers.openai.com/api/docs/guides/live-prompting): a spoken "vou ver" does not
 * start any work, the token does.
 */
const CARD_INSTRUCTIONS = [
  "Você é a voz do chat de um card do vibehub: a pessoa programa conversando com você. Fale em português " +
    "do Brasil, de forma natural e breve: respostas curtas, faladas, sem listas nem markdown.",
  "Quem trabalha no projeto é o agente do card (Claude Code): ele tem o histórico inteiro do chat, lê o " +
    "código e os arquivos, roda comandos e testes, edita e commita. Você não vê arquivos nem imagens: você " +
    "conversa, entende o que a pessoa quer, pergunta o que faltar e passa o trabalho para o agente.",
  "Backchannel policy: use poucos sinais de escuta, sem competir com a fala da pessoa.",
  "Interruption policy: pare de falar quando a pessoa interromper e escute.",
  "Delegation policy:\n" +
    "Backend tools:\n" +
    "- Agente do card (Claude Code): responde sobre o projeto, o código e todo o histórico do chat — " +
    "inclusive recapitular a conversa e levantar dúvidas e decisões pendentes; investiga, edita arquivos, " +
    "roda comandos e testes, commita.\n\n" +
    "Generate <|SpawnThinking|> when:\n" +
    "- A pessoa pede informação que não está na conversa recente abaixo: histórico do chat, código, arquivos, testes, PRs.\n" +
    "- A pessoa pede para recapitular ou resumir o chat, ou levantar dúvidas e decisões pendentes.\n" +
    "- A pessoa pede uma ação no projeto: investigar, mudar código, rodar algo, commitar.\n" +
    "- Uma correção muda um trabalho já pedido ao agente.\n\n" +
    "Do not generate <|SpawnThinking|> when:\n" +
    "- Você responde pela conversa recente ou por um resultado do agente que ainda vale.\n" +
    "- Falta um detalhe para entender o pedido: pergunte antes.\n\n" +
    "Generate <|SpawnThinking|> before giving an answer that depends on the agent. Do not guess the result " +
    "while waiting: diga em poucas palavras que pediu ao agente e siga conversando. Quando o resultado " +
    "chegar, conte em poucas frases.",
  "Você recebe, como contexto silencioso, o que for escrito ou respondido no chat durante a chamada. " +
    "Se não souber, diga que não sabe.",
].join("\n\n");

/** The instructions for a call in a card's chat: the base text plus the recent thread. PURE. */
export function cardInstructions(context: string): string {
  if (!context.trim()) return CARD_INSTRUCTIONS;
  return `${CARD_INSTRUCTIONS}\n\nConversa recente deste chat (mais antiga primeiro):\n${context}`;
}

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

/** The OpenAI key the voice features use (live sessions and read-aloud): env first, then the vault. */
export async function voiceApiKey(): Promise<string | null> {
  return config.voiceLive.apiKey || (await secretGet(OPENAI_KEY)) || null;
}

export async function voiceLiveStatus(): Promise<VoiceLiveStatus> {
  const enabled = config.voiceLive.enabled;
  return { enabled, available: enabled && Boolean(await voiceApiKey()), model: LIVE_MODEL };
}

/** The offer as sent by the browser, or a 400. PURE. */
function validateOffer(sdp: unknown): string {
  if (typeof sdp !== "string" || !sdp.trim()) throw new VoiceLiveError(400, "an SDP offer is required");
  if (Buffer.byteLength(sdp) > SDP_MAX_BYTES) throw new VoiceLiveError(400, "SDP offer is too large");
  if (!sdp.trimStart().startsWith("v=0")) throw new VoiceLiveError(400, "not an SDP offer");
  return sdp;
}

/** Creation timestamps per user, for {@link CREATES_PER_MINUTE}. In memory: a POC on one process. */
const recentCreates = new Map<string, number[]>();

/**
 * Records one call for `user` in `log` (timestamps per user, last minute), or throws 429 with
 * `refusal` when `perMinute` calls are already there.
 */
export function takeSlot(log: Map<string, number[]>, user: string, perMinute: number, refusal: string, now: number): void {
  const recent = (log.get(user) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= perMinute) {
    log.set(user, recent);
    throw new VoiceLiveError(429, refusal);
  }
  recent.push(now);
  log.set(user, recent);
}

/** Records one creation for `user`, or throws 429 past the ceiling. Exported for tests. */
export function takeCreateSlot(user: string, now: number = Date.now()): void {
  takeSlot(recentCreates, user, CREATES_PER_MINUTE, "too many voice sessions — wait a minute", now);
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
  /** The card whose chat holds the call — the audit line only. */
  cardId?: string;
  /** Instead of the plain conversation's: the call belongs to a card's chat (see {@link cardInstructions}). */
  instructions?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Trades the browser's SDP offer for GPT-Live's answer. Throws {@link VoiceLiveError} with the
 * HTTP status the route should answer.
 */
export async function createLiveSession(offer: unknown, opts: CreateLiveSessionOptions): Promise<LiveSessionAnswer> {
  if (!config.voiceLive.enabled) throw new VoiceLiveError(404, "voice mode is disabled");
  const sdp = validateOffer(offer);
  const apiKey = await voiceApiKey();
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
        session: { model: LIVE_MODEL, instructions: opts.instructions ?? INSTRUCTIONS, delegation: DELEGATION },
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
  logger.info({ audit: true, action: "voice.live.session", session: sessionId, by: opts.user, card: opts.cardId }, "voice session created");
  return { sessionId, sdp: answer };
}
