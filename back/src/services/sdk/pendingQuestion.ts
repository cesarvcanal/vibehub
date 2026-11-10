import * as registry from "../board/registry.js";
import { historySettled, readHistoryTail, type HistoryEvent } from "./history.js";
import { logger } from "../../utils/logger.js";

/**
 * A CONVERSA PAROU NUMA PERGUNTA PARA A PESSOA — o que a bandeja "Decisões pendentes" do chat chama
 * de pergunta em prosa, dito ao BOARD.
 *
 * A bandeja nasce no navegador, das linhas do chat (front/src/features/board/lib/pendingDecisions.ts),
 * e só existe com o card aberto. O ícone do card na barra lateral, no board e nos recentes não tinha
 * como saber dela: o turno acabou, o status é `waiting`, e o card mostrava o círculo neutro de "sua
 * vez" com uma decisão esperando (produção, 2026-10-27, card 37fa689a — "Quer que eu abra um PR
 * pequeno para a mensagem de HTTPS?"). O servidor lê o MESMO log com a MESMA regra e carimba
 * `pendingQuestionAt` no card; o front mostra o "precisa de você" de qualquer pergunta aberta.
 *
 * `proseQuestion` ESPELHA a do front, e tem de continuar espelhando: é a mesma pergunta que a bandeja
 * mostra que acende o ícone. Mude as duas juntas.
 */

/**
 * Words that make a final "?" read as DIRECTED at the user, not rhetorical. Conservative on
 * purpose: "Faz sentido?" and "O que será que acontece?" carry none of these and stay quiet.
 */
const DIRECTED =
  /\b(voces?|sua|seu|suas|seus|quer|querem|prefere|preferem|confirma|confirmam|posso|devo|podemos|seguimos|sigo|qual|quais|me passa|me manda|me diz|me fala|me confirma|aprova|autoriza|pode ser|tudo bem|prefer|would you|do you|can you|could you|should i|shall i|which|your|confirm)\b/i;

/** Openers that are a decision request even without a question mark. */
const DECISION_PREFIX = /^(decisao sua\b|preciso que voce\b|preciso da sua\b|preciso saber\b|me confirma\b)/i;

/** Accent-stripped lowercase view, so `\b` behaves ("você" would otherwise never end on a word boundary). */
function normalized(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** The final paragraph of a text, markdown-trimmed. */
function lastParagraph(text: string): string {
  const paragraphs = text
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return paragraphs[paragraphs.length - 1] ?? "";
}

/**
 * The question directed at the user that CLOSES this text — or null. Only the final paragraph
 * counts, it must end in "?" AND read as directed (or open with an explicit decision request), and
 * quoted/code paragraphs never match. PURE.
 */
export function proseQuestion(text: string): string | null {
  const para = lastParagraph(text);
  if (para === "" || para.startsWith(">") || para.startsWith("```") || para.includes("```")) return null;
  const plain = normalized(para);
  if (DECISION_PREFIX.test(plain)) return para;
  // strip trailing markdown/quote noise after the question mark ("?**", '?"', "?)")
  const end = para.replace(/[\s*_"'`)\]]+$/, "");
  if (!end.endsWith("?")) return null;
  return DIRECTED.test(plain) ? para : null;
}

/**
 * The prose question the conversation is waiting on, read from the card's log — the tray's rule:
 * the NEWEST main-agent message closes on a question to the person and no message came after it.
 * Subagent text is not the conversation (it lives under its Agent row), and a voice call's turns
 * are rows of their own, neither message nor answer. PURE.
 */
export function pendingProseQuestion(events: readonly HistoryEvent[]): string | null {
  const closing = closingMessage(events);
  return closing?.type === "assistant_text" ? proseQuestion(closing.text) : null;
}

/** The newest event that decides the verdict — a message of the person's or the main agent's words. PURE. */
function closingMessage(events: readonly HistoryEvent[]): { type: "user" } | { type: "assistant_text"; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "user") return { type: "user" };
    if (event.type !== "assistant_text") continue;
    if ((event as { parentToolUseId?: unknown }).parentToolUseId) continue;
    const text = (event as { text?: unknown }).text;
    if (typeof text !== "string" || text === "") continue;
    return { type: "assistant_text", text };
  }
  return null;
}

/** The first bite of the log's tail; the end of a turn almost always sits well inside it. */
const TAIL_FIRST_BYTES = 64 * 1024;

/**
 * The prose question the log ends on, read from its TAIL: this runs at the end of every turn, and
 * parsing the whole file to look at its last lines blocked the event loop on a big log. A tail with
 * no deciding message (a fleet's subagent lines after the question) is no verdict yet: it grows
 * until it has one or reaches the start of the file.
 */
async function pendingQuestionOnDisk(cardId: string): Promise<string | null> {
  for (let bytes = TAIL_FIRST_BYTES; ; bytes *= 4) {
    const { events, whole } = await readHistoryTail(cardId, bytes);
    if (whole || closingMessage(events)) return pendingProseQuestion(events);
  }
}

/**
 * Re-reads the card's log and stamps (or clears) `pendingQuestionAt`. Waits for the appends queued
 * so far — the turn's last words are written on their way out, right as the turn closes. Never
 * rejects: an icon is not worth failing anything over.
 */
export async function syncPendingQuestion(cardId: string): Promise<void> {
  try {
    await historySettled(cardId);
    const question = await pendingQuestionOnDisk(cardId);
    await registry.setCardPendingQuestion(cardId, question ? Date.now() : null);
  } catch (err) {
    logger.debug({ card: cardId, detail: (err as Error).message }, "could not read the pending question of a card");
  }
}

/**
 * Once at boot: the cards whose last turn ended on a question BEFORE this server knew how to read
 * one get the stamp too, instead of waiting for their next turn. Cards at rest only — a turn in
 * flight decides its own when it closes. Sequential and best-effort, like the resume sweep.
 */
export async function backfillPendingQuestions(): Promise<number> {
  let stamped = 0;
  for (const card of await registry.listAllCards()) {
    if (card.column === "done" || card.status === "working") continue;
    try {
      const question = await pendingQuestionOnDisk(card.id);
      if (Boolean(question) === Boolean(card.pendingQuestionAt)) continue;
      await registry.setCardPendingQuestion(card.id, question ? Date.now() : null);
      if (question) stamped += 1;
    } catch (err) {
      logger.debug({ card: card.worktreeSlug, detail: (err as Error).message }, "pending question backfill skipped a card");
    }
  }
  return stamped;
}
