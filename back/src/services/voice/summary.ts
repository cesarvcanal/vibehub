import { createHash } from "node:crypto";
import type { HistoryEvent } from "../sdk/history.js";
import { clipLine } from "../../utils/clipLine.js";
import { logger } from "../../utils/logger.js";
import { formatVoiceContext } from "./context.js";

// external: Responses API, raw HTTP — the text is in output[].content[] of type "output_text"; `output_text` at the top is SDK-only (developers.openai.com/api/reference/resources/responses/methods/create)
const RESPONSES_URL = "https://api.openai.com/v1/responses";
// external: the cheapest current text model, reasoning.effort "none" supported (developers.openai.com/api/docs/models/gpt-6-luna)
export const SUMMARY_MODEL = "gpt-6-luna";

export const SUMMARY_TIMEOUT_MS = 6_000;
const SUMMARY_INPUT_MAX_CHARS = 60_000;
const SUMMARY_INPUT_ITEM_MAX_CHARS = 4_000;
export const SUMMARY_MAX_CHARS = 2_000;
const SUMMARY_OUTPUT_TOKENS = 700;
const CACHED_SUMMARIES_MAX = 200;

const SUMMARY_INSTRUCTIONS = [
  "Você prepara a assistente de voz que vai atender agora uma pessoa num card do vibehub. A pessoa conversou " +
    "por texto com o agente do card (Claude Code), que programa no projeto, e talvez já tenha falado com a voz antes.",
  "Leia a conversa abaixo e escreva um resumo para a voz se situar: o objetivo do card; o que já foi feito e " +
    "decidido; o que está em andamento; o que está pendente ou esperando decisão da pessoa; e a última coisa que " +
    "o agente respondeu.",
  "Português do Brasil, texto corrido, no máximo 1.500 caracteres, sem markdown e sem listas. Use só o que está " +
    "na conversa e não invente. Deixe de fora hashes, caminhos de arquivo e detalhes que não servem numa conversa falada.",
  "Na conversa, \"Você (voz)\" é a própria assistente de voz em chamadas anteriores.",
].join("\n\n");

const cachedSummaries = new Map<string, { threadHash: string; summary: string }>();

export interface SummarizeConversationOptions {
  cardId: string;
  events: HistoryEvent[];
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function outputText(body: unknown): string | null {
  const output = (body as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return null;
  const parts = output
    .filter((item): item is { type: "message"; content: unknown[] } => item?.type === "message" && Array.isArray(item.content))
    .flatMap((message) => message.content)
    .filter((part): part is { type: "output_text"; text: string } => (part as { type?: unknown })?.type === "output_text" && typeof (part as { text?: unknown }).text === "string");
  const text = parts.map((part) => part.text).join("").trim();
  return text === "" ? null : text;
}

export async function summarizeConversation(opts: SummarizeConversationOptions): Promise<string | null> {
  const thread = formatVoiceContext(opts.events, SUMMARY_INPUT_MAX_CHARS, SUMMARY_INPUT_ITEM_MAX_CHARS);
  if (thread === "") return null;
  const threadHash = createHash("sha256").update(thread).digest("hex");
  const cached = cachedSummaries.get(opts.cardId);
  if (cached?.threadHash === threadHash) return cached.summary;

  const signals = [AbortSignal.timeout(SUMMARY_TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  try {
    const resp = await (opts.fetchImpl ?? fetch)(RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        instructions: SUMMARY_INSTRUCTIONS,
        input: `Conversa do card (mais antiga primeiro):\n${thread}`,
        reasoning: { effort: "none" },
        max_output_tokens: SUMMARY_OUTPUT_TOKENS,
        store: false,
      }),
      signal: AbortSignal.any(signals),
    });
    if (!resp.ok) {
      logger.warn({ card: opts.cardId, status: resp.status }, "voice: OpenAI refused the conversation summary");
      return null;
    }
    const text = outputText(await resp.json());
    if (!text) {
      logger.warn({ card: opts.cardId }, "voice: the conversation summary came back without text");
      return null;
    }
    const summary = clipLine(text, SUMMARY_MAX_CHARS);
    cachedSummaries.delete(opts.cardId);
    cachedSummaries.set(opts.cardId, { threadHash, summary });
    if (cachedSummaries.size > CACHED_SUMMARIES_MAX) cachedSummaries.delete(cachedSummaries.keys().next().value!);
    return summary;
  } catch (err) {
    if (!opts.signal?.aborted) {
      logger.warn({ card: opts.cardId, timedOut: (err as Error).name === "TimeoutError" }, "voice: the conversation summary failed");
    }
    return null;
  }
}
