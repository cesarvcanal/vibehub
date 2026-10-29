import type { BadgeTone } from "@/components/ui/badge";
import type { Card, CardPr, Finding, Review, ReviewPhase, ReviewSummary } from "@/api/types";

/**
 * PR review — the rules the block in the chat, its dialog and (next) the panel and the sidebar line
 * share, kept out of the components so one place decides what a phase is CALLED.
 */

/** The server's ceiling (`MAX_ROUNDS`): the pill reads "rodada 2/3" against it. */
export const REVIEW_MAX_ROUNDS = 3;

/** How often the panel re-reads a review the AIs are still working on (or a merge is running on). */
export const REVIEW_POLL_MS = 3_000;

/** The two `impasseReason` values the server writes as codes/fixed texts: neither has a turn to hand back. */
export const IMPASSE_ROUNDS = "rodadas";
export const IMPASSE_HEAD_MOVED = "push depois do pronto";

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
 * The PRs of a card the chat has a block for, newest first. A PR the server saw MERGED (`mergedAt`)
 * is done and leaves — except the one the card's current review summary is about, once that review
 * is merged: it stays as the "mergeado" line until a newer review takes the summary. A PR closed
 * without a merge is not tracked and stays. PURE — never reorders the card's own list.
 */
export function visiblePrs(card: Pick<Card, "prs" | "review">): CardPr[] {
  const mergedReview = card.review?.phase === "merged" ? card.review.prNumber : null;
  return (card.prs ?? [])
    .filter((pr) => pr.mergedAt === undefined || pr.number === mergedReview)
    .sort((a, b) => b.openedAt - a.openedAt);
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
  "revisor_igual_autor", "sem_pr", "pr_mergeado", "revisao_ativa", "revisor_sem_conta", "papel_sem_work", "pessoa_sem_acesso",
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

/* ------------------------------------------------------------------ the panel */

/** The AIs are on it: the panel keeps reading. Every other phase waits for a person, or is over. */
export const reviewIsWorking = (phase: ReviewPhase | undefined): boolean => phase === "reviewing" || phase === "fixing";

/** Still going: it can be cancelled (`merged` and `cancelled` are closed — the server answers 409). */
const isActive = (phase: ReviewPhase): boolean => phase !== "merged" && phase !== "cancelled";

/** How many findings of each severity, whatever their status: the header of the closed list. PURE. */
export interface FindingCounts {
  blocking: number;
  suggestion: number;
  question: number;
  refuted: number;
}
export function findingCounts(findings: Finding[]): FindingCounts {
  const counts: FindingCounts = { blocking: 0, suggestion: 0, question: 0, refuted: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

const isOpen = (f: Finding): boolean => f.status === "open" || f.status === "contested";

/** Doubts that wait for the human reviewer: they hold the `ready` without spending a round. PURE. */
export function pendingQuestions(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "question" && !f.humanDecision);
}

/**
 * What an impasse is stuck ON: blocking findings still open or contested. A doubt the human turned
 * into a block weighs the same on the server (`phaseAfterReviewerRound`), so it is stuck too — the
 * panel offers it only "aceitar risco", because the server refuses `keep` on a doubt. PURE.
 */
export function stuckItems(findings: Finding[]): Finding[] {
  return findings.filter(
    (f) => isOpen(f) && (f.severity === "blocking" || (f.severity === "question" && f.humanDecision === "block")),
  );
}

/** What the signed-in person may do to a review right now: their role AND the state it is in. */
export interface ReviewActions {
  decide: boolean;
  retry: boolean;
  cancel: boolean;
  merge: boolean;
}

/**
 * Who sees which button — the server's rules (`routes/reviews.ts`), so the panel never offers one
 * that would answer 403/409:
 *  - **merge**: the merger and nobody else (the owner's click is not the merger's), only in `ready`;
 *  - **decide** (questions, stuck items): the reviewer or an owner, while the review is open to it;
 *  - **retry**: the reviewer, the merger or an owner, for an impasse that is a FAILURE (not "rodadas",
 *    not a push after ready: those have no turn to hand back) or a `ready` whose Approve never got out;
 *  - **cancel**: the reviewer, the author, the merger or an owner, while the review is active.
 * PURE.
 */
export function reviewActions(
  review: Pick<Review, "phase" | "reviewerUserId" | "authorUserId" | "mergerUserId" | "impasseReason" | "approvePending">,
  me: { id: string; isOwner: boolean } | null,
): ReviewActions {
  if (!me) return { decide: false, retry: false, cancel: false, merge: false };
  const isReviewer = me.id === review.reviewerUserId;
  const isMerger = me.id === review.mergerUserId;
  const { phase } = review;
  const failedImpasse =
    phase === "impasse" && review.impasseReason !== IMPASSE_ROUNDS && review.impasseReason !== IMPASSE_HEAD_MOVED;
  const approveStuck = phase === "ready" && review.approvePending === true;
  return {
    merge: isMerger && phase === "ready",
    decide: (isReviewer || me.isOwner) && (reviewIsWorking(phase) || phase === "impasse"),
    retry: (isReviewer || isMerger || me.isOwner) && (failedImpasse || approveStuck),
    cancel: (isReviewer || me.id === review.authorUserId || isMerger || me.isOwner) && isActive(phase),
  };
}

/** What the merge request came back with, in the three ways the panel treats differently. */
export type MergeFailure =
  | { kind: "head_moved"; review?: Review }
  /** No answer, or a proxy gave up on a request that can run for minutes: the merge may still happen. */
  | { kind: "lost" }
  | { kind: "refused"; reason?: string; message: string; review?: Review };

/** Proxies that cut a long request answer with these; the server never does. */
const PROXY_GAVE_UP: ReadonlySet<number> = new Set([502, 503, 504, 524]);

interface MergeErrorBody {
  error?: string;
  reason?: string;
  review?: Review;
}

/**
 * Sorts a failed `POST /api/reviews/:id/merge`. The request waits for CI (up to ~15 min), so "no
 * answer" is not "refused": the panel keeps reading the review and calls it a success if it turns
 * `merged`. `head_moved` is the 409 the server answers when the PR moved after the approval — and
 * it has already put the review back, which the body carries. PURE.
 */
export function mergeFailure(err: unknown): MergeFailure {
  const response = (err as { response?: { status?: number; data?: MergeErrorBody | string } })?.response;
  const status = response?.status;
  if (status === undefined || PROXY_GAVE_UP.has(status)) return { kind: "lost" };
  const body = typeof response?.data === "object" && response.data ? response.data : {};
  if (status === 409 && body.reason === "head_moved") return { kind: "head_moved", review: body.review };
  const message = (typeof response?.data === "string" ? response.data : body.error ?? "").trim();
  return { kind: "refused", reason: body.reason, message, review: body.review };
}
