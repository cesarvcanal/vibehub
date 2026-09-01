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
 * Everything here is PURE and derived from the row list — which itself is replayed from the
 * sdk-history on every connect, so the tray survives F5 for free.
 */

export interface PendingDecision {
  kind: "question" | "prose";
  /** The row to scroll to / highlight. */
  rowId: string;
  /** Short line for the tray. */
  summary: string;
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

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/**
 * The tray's content, oldest first. Structured questions stay pending until answered; a prose
 * question only counts while NO user message came after it (answering by message clears it). A
 * streaming row never enters (its text is still growing). PURE.
 */
export function pendingDecisions(rows: readonly SdkRow[]): PendingDecision[] {
  let lastUserAt = -1;
  rows.forEach((row, i) => {
    if (row.kind === "user") lastUserAt = i;
  });
  const out: PendingDecision[] = [];
  rows.forEach((row, i) => {
    if (row.kind === "question" && row.outcome === "pending") {
      const first = row.questions[0]?.question ?? "";
      out.push({ kind: "question", rowId: row.id, summary: summarize(first) });
      return;
    }
    if (row.kind === "assistant" && !row.streaming && i > lastUserAt) {
      const question = proseQuestion(row.text);
      if (question) out.push({ kind: "prose", rowId: row.id, summary: summarize(question) });
    }
  });
  return out;
}
