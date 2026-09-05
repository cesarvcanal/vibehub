import type { SdkRow } from "@/features/board/lib/sdkChat";

/**
 * PENDING DECISIONS — what in this conversation is still WAITING ON THE USER.
 *
 * The pain this solves: a long turn buries the one question that unblocks the sequence. Two
 * sources feed the tray above the composer:
 *
 *  1. **Structured questions** — every `user_question` card (AskUserQuestion) still pending. These
 *     are exact: they stay pending until answered, whatever else is said in between.
 *  2. **Prose questions (best effort)** — an assistant message whose FINAL paragraph is a question
 *     directed at the user (conservative heuristic below). These have no structured answer: any
 *     user message sent afterwards counts as dealing with them.
 *
 * A decision can also be ANSWERED ON PURPOSE: the composer aims at one, and the message it sends
 * wears `buildDecisionReply`'s wrapper. That wrapper is the whole trick behind "pronto, respondi" —
 * it travels to the model AND back out of the history, so the answer stays anchored to its question
 * after a reload with no new field on the wire.
 *
 * Everything here is PURE and derived from the row list — which itself is replayed from the
 * sdk-history on every connect, so the tray survives F5 for free.
 */

export interface PendingDecision {
  kind: "question" | "prose";
  /** The row to scroll to / highlight. */
  rowId: string;
  /** The question, in full — what the composer banner shows while the reply is armed. */
  text: string;
  /** Short line for the tray. */
  summary: string;
  /**
   * Can a message TYPED in the composer answer this one? False for a card that asks SEVERAL
   * questions at once: one typed line cannot say which is which, so that card is answered by its
   * own fields and the tray only jumps to it.
   */
  answerable: boolean;
}

/* ------------------------------------------------------------- heuristic */

/**
 * Words that make a final "?" read as DIRECTED at the user, not rhetorical. Conservative on
 * purpose: "Faz sentido?" and "O que será que acontece?" carry none of these and stay quiet; a
 * false positive is acceptable only if rare.
 */
const DIRECTED =
  /\b(voces?|sua|seu|suas|seus|quer|querem|prefere|preferem|confirma|confirmam|posso|devo|podemos|seguimos|sigo|qual|quais|me passa|me manda|me diz|me fala|me confirma|aprova|autoriza|pode ser|tudo bem|prefer|would you|do you|can you|could you|should i|shall i|which|your|confirm)\b/i;

/** Openers that are a decision request even without a question mark. */
const DECISION_PREFIX = /^(decisao sua\b|preciso que voce\b|preciso da sua\b|preciso saber\b|me confirma\b)/i;

/** Accent-stripped lowercase view, so `\b` behaves ("você" would otherwise never end on a word boundary). */
function normalized(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
 * The question directed at the user that CLOSES this text — or null. Conservative: only the final
 * paragraph counts (a question answered by the text itself is not pending), it must end in "?"
 * AND read as directed (or open with an explicit decision request), and quoted/code paragraphs
 * never match. PURE.
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

/** Split a text into the body and its closing prose question, for the highlighted render. PURE. */
export function splitProseQuestion(text: string): { body: string; question: string } | null {
  const question = proseQuestion(text);
  if (!question) return null;
  const at = text.lastIndexOf(question);
  if (at < 0) return null;
  return { body: text.slice(0, at).replace(/\n[ \t]*\n$/, "").trimEnd(), question: text.slice(at) };
}

/* ----------------------------------------------------------------- tray */

const SUMMARY_MAX = 100;

/** One tray-sized line out of a question — also what the composer banner shows. PURE. */
export function decisionSummary(text: string): string {
  return summarize(text);
}

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/**
 * The tray's content, oldest first. Structured questions stay pending until answered — several may
 * legitimately stack. A prose question is far more fragile, so it only counts while it is the tail
 * of the conversation: NO user message came after it (answering by message clears it) AND it is the
 * NEWEST assistant message. The second rule is how "o agente seguiu sozinho" expires a guess — once
 * Claude has spoken again, the old paragraph is not what it is waiting on. A streaming row never
 * enters (its text is still growing). PURE.
 */
export function pendingDecisions(rows: readonly SdkRow[]): PendingDecision[] {
  let lastUserAt = -1;
  let lastAssistantAt = -1;
  rows.forEach((row, i) => {
    if (row.kind === "user") lastUserAt = i;
    if (row.kind === "assistant") lastAssistantAt = i;
  });
  const out: PendingDecision[] = [];
  rows.forEach((row, i) => {
    if (row.kind === "question" && row.outcome === "pending") {
      const first = row.questions[0]?.question ?? "";
      out.push({
        kind: "question",
        rowId: row.id,
        text: first,
        summary: summarize(first),
        answerable: row.questions.length === 1,
      });
      return;
    }
    if (row.kind === "assistant" && !row.streaming && i > lastUserAt && i === lastAssistantAt) {
      const question = proseQuestion(row.text);
      if (question) out.push({ kind: "prose", rowId: row.id, text: question, summary: summarize(question), answerable: true });
    }
  });
  return out;
}

/* --------------------------------------------------------- explicit reply */

/**
 * The wrapper an EXPLICIT reply wears on its way to the MODEL — the same idea as the supersede
 * wrapper (protocol.ts `buildSupersedeText`), for the same reason: the user's intent must reach the
 * conversation, not just the screen. Quoting the question makes the answer unambiguous for Claude
 * ("o segundo" alone is a riddle two turns later) and, because the history log stores the text
 * verbatim, it is ALSO what lets a reload re-anchor the answer to its question with no new wire
 * field. pt-BR like the supersede wrapper: it is the user's own speech act. PURE.
 */
const REPLY_OPEN = "[resposta à decisão pendente:";

export function buildDecisionReply(question: string, answer: string): string {
  return `${REPLY_OPEN}\n«${question.replace(/\s+/g, " ").trim()}»]\n\n${answer}`;
}

const REPLY_RE = /^\[resposta à decisão pendente:\n«([\s\S]*?)»\]\n\n([\s\S]*)$/;

/** Read a wrapped reply back: the question it answers and the words the person actually wrote. PURE. */
export function parseDecisionReply(text: string): { question: string; answer: string } | null {
  const match = REPLY_RE.exec(text.trim());
  if (!match) return null;
  const answer = match[2]!.trim();
  if (answer === "") return null;
  return { question: match[1]!, answer };
}

/** Question identity for anchoring — the wrapper flattens whitespace, so the match must too. PURE. */
export function decisionKey(question: string): string {
  return question.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Every explicit reply in the conversation, keyed by the ROW ID of the question it answered — how a
 * prose question renders "Respondida: …" under itself, on this screen and after an F5 alike. Keyed
 * by row, not by text: an agent that asks the same thing twice must not show the second answer
 * under the first question. Each reply lands on the NEAREST question above it. PURE.
 */
export function decisionReplies(rows: readonly SdkRow[]): Map<string, string> {
  const byRow = new Map<string, string>();
  const lastAsked = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "assistant" && !row.streaming) {
      const question = proseQuestion(row.text);
      if (question) lastAsked.set(decisionKey(question), row.id);
      continue;
    }
    if (row.kind !== "user") continue;
    const parsed = parseDecisionReply(row.text);
    if (!parsed) continue;
    const rowId = lastAsked.get(decisionKey(parsed.question));
    if (rowId) byRow.set(rowId, parsed.answer);
  }
  return byRow;
}
