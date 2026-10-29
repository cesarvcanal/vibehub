import type { BadgeTone } from "@/components/ui/badge";
import type { Card, CardPr, ReviewSummary } from "@/api/types";

/**
 * PR review — the rules the block in the chat, its dialog and (next) the panel and the sidebar line
 * share, kept out of the components so one place decides what a phase is CALLED.
 */

/** The server's ceiling (`MAX_ROUNDS`): the pill reads "rodada 2/3" against it. */
export const REVIEW_MAX_ROUNDS = 3;

/** The people who can take a role in a review of this card. */
export const cardPeopleKey = (cardId: string) => ["card-people", cardId] as const;
/** The card's review — the active one, or the last. The panel reads it; starting one refreshes it. */
export const cardReviewKey = (cardId: string) => ["card-review", cardId] as const;

export interface ReviewPill {
  /** i18n key of the label. */
  key: string;
  vars?: { round: number; max: number };
  tone: BadgeTone;
}

/**
 * The pill of a PR's review. `reviewing` and `fixing` read the same — both are "the AIs are on it,
 * round N of 3"; the difference (whose turn) belongs to the panel. A cancelled review is NO review:
 * the server never sends one on a card, and a stale cache must not resurrect it. PURE.
 */
export function reviewPill(review: ReviewSummary | undefined): ReviewPill {
  switch (review?.phase) {
    case "reviewing":
    case "fixing":
      return { key: "review.pill.round", vars: { round: review.round, max: REVIEW_MAX_ROUNDS }, tone: "warn" };
    case "ready":
      return { key: "review.pill.ready", tone: "ok" };
    // Blue = needs a person, the same colour the mockup gives it.
    case "impasse":
      return { key: "review.pill.impasse", tone: "info" };
    case "merged":
      return { key: "review.pill.merged", tone: "muted" };
    default:
      return { key: "review.pill.none", tone: "muted" };
  }
}

/**
 * The PRs of a card the chat has a block for, newest first. A merged PR is done and leaves; the
 * front only learns a PR was merged from the card's review summary (the most recent one), so that is
 * the one it can hide. PURE — never reorders the card's own list.
 */
export function visiblePrs(card: Pick<Card, "prs" | "review">): CardPr[] {
  const merged = card.review?.phase === "merged" ? card.review.prNumber : null;
  return (card.prs ?? []).filter((pr) => pr.number !== merged).sort((a, b) => b.openedAt - a.openedAt);
}

/** Roles as the dialog names them, keyed by the field the server puts in its message. */
export type ReviewRole = "reviewer" | "author" | "coauthor" | "merger";
const ROLE_FIELDS: Record<string, ReviewRole> = {
  reviewerUserId: "reviewer",
  authorUserId: "author",
  coauthorUserId: "coauthor",
  mergerUserId: "merger",
};

/** The codes `POST /api/cards/:id/review` answers with — each has its own sentence in i18n. */
const START_CODES: ReadonlySet<string> = new Set([
  "revisor_igual_autor", "sem_pr", "revisao_ativa", "revisor_sem_conta", "papel_sem_work", "pessoa_sem_acesso",
]);

interface ApiFailure {
  response?: { status?: number; data?: { error?: string } | string };
}

function failureMessage(err: unknown): string {
  const data = (err as ApiFailure)?.response?.data;
  return (typeof data === "string" ? data : data?.error ?? "").trim();
}

/**
 * Which refusal of the start route this is: a 403 (not somebody who works the card), or the code the
 * server writes before the colon (`revisor_sem_conta: o revisor não tem…`). Null = anything else, and
 * the caller shows the message as it came. PURE.
 */
export function startErrorCode(err: unknown): string | null {
  if ((err as ApiFailure)?.response?.status === 403) return "forbidden";
  const code = /^([a-z_]+)\b/.exec(failureMessage(err))?.[1];
  return code && START_CODES.has(code) ? code : null;
}

/** The roles a refusal names (`papel_sem_work: authorUserId, mergerUserId só tem…`), in the order given. PURE. */
export function startErrorRoles(err: unknown): ReviewRole[] {
  const named = failureMessage(err).match(/\b(?:reviewer|author|coauthor|merger)UserId\b/g) ?? [];
  return named.map((field) => ROLE_FIELDS[field]);
}
