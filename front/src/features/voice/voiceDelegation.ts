import type { SdkRow } from "@/features/board/lib/sdkChat";
import type { VoiceTurn } from "./voiceTurns";

/**
 * WHAT THE VOICE DELEGATES, AND WHAT COMES BACK. GPT-Live hands work to this app with
 * `session.delegation.created`, which carries an id and no task text (client delegation,
 * developers.openai.com/api/docs/guides/live-delegation): the task is whatever the person just said.
 * The card's agent does it, as a message in the chat, and its last word on that message is what
 * the voice says. In Portuguese, like the call's instructions (back/src/services/voice/live.ts).
 */

/** The call's transcript handed over with a request: the newest this many characters. */
export const DELEGATION_TRANSCRIPT_MAX_CHARS = 3_000;

/** Progress, silent: the voice knows the work started and must not invent its result. */
export const DELEGATION_STARTED =
  "Pedido passado ao agente do card (Claude Code), que está trabalhando nele. Não invente o resultado: ele chega como atualização desta tarefa.";
/** Results, spoken: the outcomes that are not the agent's answer. */
export const DELEGATION_UNHEARD = "Você não ouviu um pedido da pessoa: pergunte, em poucas palavras, o que ela quer.";
export const DELEGATION_NOT_SENT =
  "O pedido não chegou ao agente do card: diga à pessoa que não deu para passar o pedido agora e que ela pode tentar de novo ou digitar no chat.";
export const DELEGATION_SILENT = "O agente do card terminou sem responder nada em texto: diga isso à pessoa e pergunte se ela quer conferir no chat.";

/** The message the card's agent gets for one delegation. Null when the person has said nothing yet. PURE. */
export function delegationRequest(turns: VoiceTurn[]): string | null {
  const asked = turns.findLast((t) => t.role === "user" && t.text.trim() !== "");
  if (!asked) return null;
  const lines: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const text = t.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `${t.role === "user" ? "Pessoa" : "Voz"}: ${text}`;
    if (used + line.length + 1 > DELEGATION_TRANSCRIPT_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [
    `[pedido por voz]\n${asked.text.trim()}`,
    `Transcrição recente da chamada de voz (pode ter erros de transcrição):\n${lines.reverse().join("\n")}`,
    "Responda curto e direto: a voz vai falar a sua resposta para a pessoa.",
  ].join("\n\n");
}

/** One of the agent's own answers, finished: what the voice may be told. PURE. */
export function isAgentAnswer(row: SdkRow): row is Extract<SdkRow, { kind: "assistant" }> {
  return row.kind === "assistant" && !row.parent && !row.streaming && row.text.trim() !== "";
}

export type DelegationReply =
  | { state: "waiting" }
  /** `answers`: every answer the agent gave on the request — the last one is `text`. */
  | { state: "answered"; text: string; answers: string[] }
  | { state: "silent"; answers: [] };

/**
 * Where the agent's work on a delegated request stands, read off the chat. It is over once a later
 * message started or no turn is running; its answers are the ones between the request and that next
 * message. PURE.
 */
export function delegationReply(rows: SdkRow[], request: string, turnRunning: boolean): DelegationReply {
  const at = rows.findLastIndex((row) => row.kind === "user" && row.text === request);
  if (at < 0) return { state: "waiting" };
  const next = rows.findIndex((row, i) => i > at && row.kind === "user");
  if (next < 0 && turnRunning) return { state: "waiting" };
  const answers = rows.slice(at + 1, next < 0 ? rows.length : next).filter(isAgentAnswer).map((row) => row.text);
  const last = answers.at(-1);
  return last === undefined ? { state: "silent", answers: [] } : { state: "answered", text: last, answers };
}
