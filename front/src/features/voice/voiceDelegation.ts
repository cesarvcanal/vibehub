import { TERMINAL_ACTIVITY_NOTE, type SdkRow } from "@/features/board/lib/sdkChat";
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
export const DELEGATION_QUEUED =
  "A conexão com o agente do card caiu por um instante: o pedido ficou guardado e o painel o entrega sozinho assim que ela voltar. " +
  "Diga isso à pessoa em poucas palavras e conte a resposta quando chegar; não pergunte se ela quer pedir de novo.";
export const DELEGATION_RECOVERY_MS = 75_000;
export const DELEGATION_INTERRUPTED =
  "O trabalho do agente do card neste pedido foi interrompido antes da resposta (uma atualização do painel ou a conexão caindo, por exemplo). " +
  "Normalmente o painel retoma o trabalho sozinho: se a pessoa perguntar, diga que ainda está esperando a resposta; não pergunte se ela quer pedir de novo.";
export const DELEGATION_FAILED =
  "O agente do card parou sem responder a este pedido e o painel não o retomou a tempo. Diga à pessoa, em poucas palavras, que não deu " +
  "para obter a resposta agora, que o pedido ficou registrado no card e que, se a resposta chegar depois, você conta; não pergunte se ela quer pedir de novo.";
export const DELEGATION_UNDELIVERED =
  "O pedido não chegou ao agente do card: a conexão com ele não voltou a tempo. Diga à pessoa, em poucas palavras, que o pedido ficou " +
  "guardado no card e que o painel segue tentando entregá-lo; não pergunte se ela quer pedir de novo.";
export const DELEGATION_STOPPED =
  "A pessoa parou o agente do card antes da resposta a este pedido; não pergunte se ela quer pedir de novo: se ela quiser, ela pede.";

const VOICE_REQUEST_MARK = "[pedido por voz]\n";
const TRANSCRIPT_HEADER = "Transcrição recente da chamada de voz (pode ter erros de transcrição):";

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
    `${VOICE_REQUEST_MARK}${asked.trim()}`,
    `${TRANSCRIPT_HEADER}\n${lines.reverse().join("\n")}`,
    "Urgente: a pessoa está esperando na chamada. Se estiver no meio de outra tarefa, pare o que está fazendo, atenda este pedido " +
      "primeiro (responda ou execute, com as suas ferramentas) e encerre o turno com a resposta, curta e direta: a voz vai falá-la para a pessoa. " +
      "Se parou outra tarefa para isso, diga o que ficou interrompido, para a pessoa decidir se você retoma.",
  ].join("\n\n");
}

export function parseVoiceRequest(text: string): { asked: string; context: string } | null {
  if (!text.startsWith(VOICE_REQUEST_MARK)) return null;
  const body = text.slice(VOICE_REQUEST_MARK.length);
  const transcriptStart = body.indexOf(`\n\n${TRANSCRIPT_HEADER}`);
  const askedEnd = transcriptStart < 0 ? body.length : transcriptStart;
  const asked = body.slice(0, askedEnd).trim();
  if (asked === "") return null;
  return { asked, context: body.slice(askedEnd).trim() };
}

export function askedOfAgent(argumentsJson: string): string | null {
  try {
    const { request } = JSON.parse(argumentsJson) as { request?: unknown };
    return typeof request === "string" && request.trim() ? request.trim() : null;
  } catch {
    return null;
  }
}

const ASKED_IN_ANSWER_MAX_CHARS = 200;

function clipAsked(asked: string): string {
  const flatAsked = asked.replace(/\s+/g, " ").trim();
  return flatAsked.length > ASKED_IN_ANSWER_MAX_CHARS ? `${flatAsked.slice(0, ASKED_IN_ANSWER_MAX_CHARS - 1)}…` : flatAsked;
}

export function agentAnswerForVoice(asked: string, answer: string): string {
  return `O agente do card respondeu ao pedido "${clipAsked(asked)}": ${answer}`;
}

export function aboutRequestForVoice(asked: string, note: string): string {
  return `Sobre o pedido "${clipAsked(asked)}": ${note}`;
}

/** One of the agent's own answers, finished: what the voice may be told. PURE. */
export function isAgentAnswer(row: SdkRow): row is Extract<SdkRow, { kind: "assistant" }> {
  return row.kind === "assistant" && !row.parent && !row.streaming && row.text.trim() !== "";
}

/** `answers`: every answer the agent gave on the request so far — when it is over, the last one is `text`. */
export type DelegationReply =
  | { state: "waiting"; answers: string[] }
  | { state: "answered"; text: string; answers: string[] }
  | { state: "silent"; answers: string[] }
  | { state: "unknown"; answers: string[] }
  | { state: "undelivered"; answers: [] };

export type DelegationAnchor = { request: string; queued: boolean } | { questionId: string };

export type AgentTurn = "running" | "idle" | "unknown";

const isPanelNote = (row: SdkRow): boolean => row.kind === "note" && row.text !== TERMINAL_ACTIVITY_NOTE;

export function delegationReply(rows: SdkRow[], anchor: DelegationAnchor, turn: AgentTurn): DelegationReply {
  const at = "request" in anchor
    ? rows.findLastIndex((row) => row.kind === "user" && row.text === anchor.request)
    : rows.findIndex((row) => row.kind === "question" && row.id === anchor.questionId);
  const stillInTheQueue = at < 0 && "request" in anchor && anchor.queued;
  if (stillInTheQueue) return { state: "undelivered", answers: [] };
  const after = at < 0 ? [] : rows.slice(at + 1);
  const answers = after.filter(isAgentAnswer).map((row) => row.text);
  if (turn === "unknown") return { state: "unknown", answers };
  if (at < 0) return { state: "waiting", answers: [] };
  if (turn === "running") return { state: "waiting", answers };
  const anchorRow = rows[at]!;
  const notConfirmedByTheServer = anchorRow.kind === "user" && anchorRow.state !== "sent" && answers.length === 0;
  if (notConfirmedByTheServer) return { state: "undelivered", answers: [] };
  const panelCutTheTurn = after.findLastIndex(isPanelNote) > after.findLastIndex(isAgentAnswer);
  const last = answers.at(-1);
  if (last === undefined || panelCutTheTurn) return { state: "silent", answers };
  return { state: "answered", text: last, answers };
}

export interface DelegationRecovery {
  stalledSince: number | null;
  stallTold: boolean;
  failureTold: boolean;
}

export const NO_RECOVERY: DelegationRecovery = { stalledSince: null, stallTold: false, failureTold: false };

export type RecoveryStep =
  | { kind: "answered"; text: string }
  | { kind: "wait"; recovery: DelegationRecovery }
  | { kind: "hold"; recovery: DelegationRecovery; tell: boolean }
  | { kind: "give_up"; note: string; recovery: DelegationRecovery }
  | { kind: "keep" };

export function nextRecoveryStep(reply: DelegationReply, recovery: DelegationRecovery, now: number): RecoveryStep {
  if (reply.state === "answered") return { kind: "answered", text: reply.text };
  if (recovery.failureTold) return { kind: "keep" };
  if (reply.state === "waiting") return { kind: "wait", recovery: { ...recovery, stalledSince: null } };
  const stalledSince = recovery.stalledSince ?? now;
  if (now - stalledSince < DELEGATION_RECOVERY_MS) {
    const tell = reply.state === "silent" && !recovery.stallTold;
    return { kind: "hold", recovery: { ...recovery, stalledSince, stallTold: recovery.stallTold || tell }, tell };
  }
  const note = reply.state === "undelivered" ? DELEGATION_UNDELIVERED : DELEGATION_FAILED;
  return { kind: "give_up", note, recovery: { ...recovery, stalledSince, failureTold: true } };
}
