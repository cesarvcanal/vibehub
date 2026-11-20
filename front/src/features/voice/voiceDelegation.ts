import type { SdkRow } from "@/features/board/lib/sdkChat";
import type { VoiceTurn } from "./voiceTurns";

/** The call's transcript handed over with a request: the newest this many characters. */
export const DELEGATION_TRANSCRIPT_MAX_CHARS = 3_000;

export const DELEGATION_STARTED =
  "Pedido entregue com urgência ao agente do card (Claude Code): ele para o que está fazendo para atender. Ele ainda não foi feito: " +
  "diga à pessoa, em poucas palavras, que passou o pedido ao agente e que conta a resposta quando chegar; não diga que fez e não invente o resultado.";
export const DELEGATION_SLOW_MS = 45_000;
export const DELEGATION_SLOW =
  "O agente do card ainda não terminou este pedido. Avise a pessoa que continua esperando por ele e conte o que você sabe do que o agente " +
  "está fazendo; não diga que terminou.";
export const ASK_WITHOUT_REQUEST = "ask_card_agent veio sem o pedido: pergunte à pessoa, em poucas palavras, o que ela quer do agente.";
export const DELEGATION_NOT_SENT =
  "O pedido não chegou ao agente do card: diga à pessoa que não deu para passar o pedido agora, porque a conexão com o agente caiu, e que ela pode pedir de novo em instantes.";
export const DELEGATION_SILENT =
  "O agente do card não deu resposta em texto a este pedido — o trabalho dele pode ter sido interrompido (uma atualização do painel, por exemplo). Diga isso à pessoa em poucas palavras e pergunte se ela quer que você peça de novo.";

export function delegationRequest(asked: string, turns: VoiceTurn[]): string {
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
    `[pedido por voz]\n${asked.trim()}`,
    `Transcrição recente da chamada de voz (pode ter erros de transcrição):\n${lines.reverse().join("\n")}`,
    "Urgente: a pessoa está esperando na chamada. Se estiver no meio de outra tarefa, pare o que está fazendo, atenda este pedido " +
      "primeiro (responda ou execute, com as suas ferramentas) e encerre o turno com a resposta, curta e direta: a voz vai falá-la para a pessoa. " +
      "Se parou outra tarefa para isso, diga o que ficou interrompido, para a pessoa decidir se você retoma.",
  ].join("\n\n");
}

const ASKED_IN_ANSWER_MAX_CHARS = 200;

export function agentAnswerForVoice(asked: string, answer: string | null): string {
  const flatAsked = asked.replace(/\s+/g, " ").trim();
  const clippedAsked = flatAsked.length > ASKED_IN_ANSWER_MAX_CHARS ? `${flatAsked.slice(0, ASKED_IN_ANSWER_MAX_CHARS - 1)}…` : flatAsked;
  if (answer === null) return `Sobre o pedido "${clippedAsked}": ${DELEGATION_SILENT}`;
  return `O agente do card respondeu ao pedido "${clippedAsked}": ${answer}`;
}

/** One of the agent's own answers, finished: what the voice may be told. PURE. */
export function isAgentAnswer(row: SdkRow): row is Extract<SdkRow, { kind: "assistant" }> {
  return row.kind === "assistant" && !row.parent && !row.streaming && row.text.trim() !== "";
}

/** `answers`: every answer the agent gave on the request so far — when it is over, the last one is `text`. */
export type DelegationReply =
  | { state: "waiting"; answers: string[] }
  | { state: "answered"; text: string; answers: string[] }
  | { state: "silent"; answers: [] };

/**
 * Where the agent's work on a delegated request stands, read off the chat. It is over only when no
 * turn is running: a later message does not end it, because the chat delivers queued messages into
 * the running turn at a breather (`turnHasRoomForMore`) — that turn's last word answers both. PURE.
 */
export function delegationReply(rows: SdkRow[], request: string, turnRunning: boolean): DelegationReply {
  const at = rows.findLastIndex((row) => row.kind === "user" && row.text === request);
  if (at < 0) return { state: "waiting", answers: [] };
  const answers = rows.slice(at + 1).filter(isAgentAnswer).map((row) => row.text);
  if (turnRunning) return { state: "waiting", answers };
  const last = answers.at(-1);
  return last === undefined ? { state: "silent", answers: [] } : { state: "answered", text: last, answers };
}
