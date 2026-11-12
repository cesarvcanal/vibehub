import type { BadgeTone } from "@/components/ui/badge";
import type {
  CardPr, Finding, FindingSeverity, FindingStatus, MergeGate, Person, Review, ReviewEvent, ReviewPhase, ReviewSummary, ReviewWorking,
} from "@/api/types";

/**
 * PR review — the rules the block in the chat, its dialog and (next) the panel and the sidebar line
 * share, kept out of the components so one place decides what a phase is CALLED.
 */

/** The server's ceiling (`MAX_ROUNDS`): the pill reads "rodada 2/3" against it. */
export const REVIEW_MAX_ROUNDS = 3;
/** How many times a red merge gate reruns on its own, after the author's AI fixes it (the server's `MERGE_GATE_AUTO_RETRIES`). */
export const MERGE_GATE_AUTO_RETRIES = 3;

/**
 * How long the panel waits for a merge it cannot confirm (the answer got lost, or another click found
 * one already running) before giving up: the server's own merge limit is ~15 min, plus a margin.
 */
export const MERGE_CONFIRM_MS = 16 * 60_000;

/**
 * How often an OPEN review is re-read while something is moving — an AI in its turn (either side, or
 * the reviewing/fixing phases), a merge running: the screen follows each step.
 */
export const REVIEW_POLL_MS = 3_000;
/**
 * …and while it sits still (ready or impasse, nobody working): still read, because it moves on its own
 * (a merge done on GitHub, another person's decision), but at a calmer pace.
 */
export const REVIEW_IDLE_POLL_MS = 10_000;

/** The two `impasseReason` values the server writes as codes/fixed texts: neither has a turn to hand back. */
export const IMPASSE_ROUNDS = "rodadas";
export const IMPASSE_HEAD_MOVED = "push depois do pronto";

/** The people who can take a role in a review of this card. */
export const cardPeopleKey = (cardId: string) => ["card-people", cardId] as const;
/**
 * The card's review — the active one, or the last. The panel reads it; starting one refreshes it. With
 * `pr`, the review of THAT PR among the ones the card follows (a card with several PRs reads one per
 * line); `["card-review", cardId]` is the prefix of both, so invalidating it refreshes them all.
 */
export const cardReviewKey = (cardId: string, pr?: number) =>
  (pr === undefined ? ["card-review", cardId] : ["card-review", cardId, pr]) as readonly unknown[];

export interface ReviewPill {
  /** i18n key of the label. */
  key: string;
  vars?: { round: number; max: number };
  tone: BadgeTone;
}

/**
 * The review waits on the human reviewer: in `reviewing` with a doubt nobody decided. Those doubts
 * hold the `ready` without spending a round, and nothing on the server calls anyone back for them.
 * A card's summary carries the count (`pendingQuestions`); the panel's whole review counts its own
 * findings. PURE.
 */
export function awaitingDecision(review: ReviewSummary & { findings?: Finding[] }): boolean {
  if (review.phase !== "reviewing") return false;
  const waiting = review.findings ? pendingQuestions(review.findings).length : review.pendingQuestions ?? 0;
  return waiting > 0;
}

/**
 * The pill of a PR's review. `reviewing` and `fixing` read the same — both are "the AIs are on it,
 * round N of 3"; the difference (whose turn) belongs to the panel — except a `reviewing` that waits
 * on a doubt only a person can decide ({@link awaitingDecision}): that one reads "aguardando decisão",
 * in the blue of "needs a person", or it would look like the AIs working. A `ready` whose author's AI
 * is working right now (`authorWorking`: someone sent it to touch the PR) reads "IA trabalhando", in the
 * orange of work: what it pushes sends the review back to the reviewer, so "pronto pra merge" would
 * be a lie while it works. A cancelled review is NO review: the server never sends one on a card,
 * and a stale cache must not resurrect it. PURE.
 */
export function reviewPill(
  review: (ReviewSummary & { findings?: Finding[] }) | undefined,
  live: { authorWorking?: boolean; gate?: MergeGateStatus | "passed" } = {},
): ReviewPill {
  switch (review?.phase) {
    case "reviewing":
    case "fixing":
      if (awaitingDecision(review)) return { key: "review.pill.decision", tone: "info" };
      return { key: "review.pill.round", vars: { round: review.round, max: REVIEW_MAX_ROUNDS }, tone: "warn" };
    case "ready":
      if (live.authorWorking) return { key: "review.pill.authorWorking", tone: "warn" };
      // "Pronto pra merge" only with the merge gate out of the way: running or red, the click would not merge.
      if (live.gate === "failed") return { key: "review.pill.gateFailed", tone: "critical" };
      // Red, but the author's AI has it and the checks rerun on their own: work, not a stop.
      if (live.gate === "fixing") return { key: "review.pill.gateFixing", tone: "warn" };
      if (live.gate === "running") return { key: "review.pill.gateRunning", tone: "info" };
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
 * The PRs of a card the chat has a block for, newest first: only the ones still OPEN. A merged PR is
 * work done and leaves the chat — the card's line in the sidebar still says "mergeado", and the panel
 * keeps the review's history. Merged is either what
 * the server saw (`mergedAt`) or what the review says (`phase: "merged"`): the review can know first
 * — a live read lands before the board polls — and a PR recorded before `mergedAt` existed has only
 * the review's word. A PR closed without a merge is not tracked and stays. PURE — never reorders the
 * card's own list.
 */
export function visiblePrs(card: {
  prs?: CardPr[];
  review?: Pick<ReviewSummary, "prNumber" | "phase">;
  reviews?: Pick<ReviewSummary, "prNumber" | "phase">[];
}): CardPr[] {
  const mergedByReview = new Set(
    [...(card.reviews ?? []), ...(card.review ? [card.review] : [])].filter((r) => r.phase === "merged").map((r) => r.prNumber),
  );
  return (card.prs ?? [])
    .filter((pr) => pr.mergedAt === undefined && !mergedByReview.has(pr.number))
    .sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * The card reads its PRs one review per line — each line its own live read (`?pr=N`) and its own
 * panel — when it attached PRs or has more than one reviewed. Otherwise it keeps the single read of
 * the card's review it always had. PURE.
 */
export function readsPerPr(card: { prs?: CardPr[]; reviews?: ReviewSummary[] }): boolean {
  return (card.reviews?.length ?? 0) > 1 || (card.prs ?? []).some((pr) => pr.attached);
}

/** The board's summary of the review of ONE PR of the card, if it has one. PURE. */
export function summaryForPr(
  card: { review?: ReviewSummary; reviews?: ReviewSummary[] }, prNumber: number,
): ReviewSummary | undefined {
  return card.reviews?.find((r) => r.prNumber === prNumber) ?? (card.review?.prNumber === prNumber ? card.review : undefined);
}

/** What the header of a card's PR list counts, in the order it reads. */
export type PrStripCount = "ready" | "fixing" | "reviewing" | "decision" | "none";

/**
 * The header of a card's PR list: how many PRs are where, by the same reading as each line's pill —
 * ready to merge, being fixed, being reviewed, waiting on a person (a doubt or an impasse), and not
 * reviewed yet. Only the counts that are not zero, in a fixed order. PURE.
 */
export function prStripCounts(reviews: (ReviewSummary | undefined)[]): { kind: PrStripCount; n: number }[] {
  const n: Record<PrStripCount, number> = { ready: 0, fixing: 0, reviewing: 0, decision: 0, none: 0 };
  for (const r of reviews) {
    if (!r || r.phase === "cancelled" || r.phase === "merged") n.none += 1;
    else if (r.phase === "ready") n.ready += 1;
    else if (r.phase === "impasse" || awaitingDecision(r)) n.decision += 1;
    else n[r.phase] += 1;
  }
  return (["ready", "fixing", "reviewing", "decision", "none"] as const).filter((k) => n[k] > 0).map((kind) => ({ kind, n: n[kind] }));
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
  "revisor_igual_autor", "sem_pr", "pr_mergeado", "revisao_ativa", "revisor_sem_conta", "revisor_sem_github", "papel_sem_work",
  "pessoa_sem_acesso", "autor_sem_conta", "merge_autorizado_de_outro",
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

/** Who holds each role in the review request: a user id, "" while nobody is picked. */
export type ReviewRoles = Record<ReviewRole, string>;

/**
 * What the dialog starts with, so the common case is one click: you review and merge (unless you
 * are the author, or have no Claude account to review on), and the card's actor fixes. A person who
 * is not among the card's people cannot hold a role, so they never come out as a default. PURE.
 */
export function suggestedRoles(people: Person[], meId: string | undefined, actorUserId: string | undefined, pr: CardPr): ReviewRoles {
  const me = people.find((p) => p.id === meId);
  const author = pr.attached
    ? githubAuthor(people, pr.author)?.id ?? ""
    : actorUserId && people.some((p) => p.id === actorUserId) ? actorUserId : "";
  return {
    reviewer: me && me.canReview && me.id !== author ? me.id : "",
    author,
    coauthor: "",
    merger: me?.id ?? "",
  };
}

/**
 * Who opened an attached PR, among the card's people: the one whose OWN GitHub connection has that
 * login (GitHub logins are case-insensitive) and who has a Claude account for the fixes to run on. PURE.
 */
export function githubAuthor(people: Person[], login: string | undefined): Person | undefined {
  if (!login) return undefined;
  const wanted = login.toLowerCase();
  return people.find((p) => p.canReview && p.githubLogin?.toLowerCase() === wanted);
}

/* ------------------------------------------------------------------ the panel */

/** The AIs hold the turn (reviewing, fixing): every other phase waits for a person, or is over. */
export const reviewIsWorking = (phase: ReviewPhase | undefined): boolean => phase === "reviewing" || phase === "fixing";

/** Still going: it can be cancelled (`merged` and `cancelled` are closed — the server answers 409). PURE. */
export const reviewIsOpen = (phase: ReviewPhase | undefined): boolean =>
  phase !== undefined && phase !== "merged" && phase !== "cancelled";

/** How many findings of each severity, whatever their status: the header of the closed list. PURE. */
export interface FindingCounts {
  blocking: number;
  improvement: number;
  suggestion: number;
  question: number;
  refuted: number;
}
export function findingCounts(findings: Finding[]): FindingCounts {
  const counts: FindingCounts = { blocking: 0, improvement: 0, suggestion: 0, question: 0, refuted: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/**
 * What the AIs settled on their own and what waits on a person: bugs the author fixed (not the ones a
 * person turned into a block), improvements it applied, and doubts no one decided yet. PURE.
 */
export interface AutonomySummary {
  fixed: number;
  improved: number;
  human: number;
}
export function autonomySummary(findings: Finding[]): AutonomySummary {
  return {
    fixed: findings.filter((f) => f.severity === "blocking" && f.status === "fixed").length,
    improved: findings.filter((f) => f.severity === "improvement" && f.status === "fixed").length,
    human: pendingQuestions(findings).length,
  };
}

/**
 * A finding still standing: open, or contested. Fixed, dropped, accepted risk and won't fix are closed,
 * and so is a refuted one whatever its status — the server saves it "open", and counting it read as a
 * pending item the person opened only to find knocked down. PURE.
 */
export const findingIsOpen = (f: Pick<Finding, "severity" | "status">): boolean =>
  f.severity !== "refuted" && (f.status === "open" || f.status === "contested");
const isOpen = findingIsOpen;

/** The tone of each finding's severity and status, wherever a finding is drawn (the list, the conversation). */
export const FINDING_SEVERITY_TONE: Record<FindingSeverity, BadgeTone> = {
  blocking: "critical",
  improvement: "ok",
  question: "info",
  suggestion: "muted",
  refuted: "muted",
};
export const FINDING_STATUS_TONE: Record<FindingStatus, BadgeTone> = {
  open: "warn",
  fixed: "ok",
  contested: "info",
  accepted_risk: "muted",
  dropped: "muted",
  wontfix: "muted",
};

/**
 * Doubts that wait for a decision: they hold the `ready` without spending a round. One the author
 * resolved and the reviewer checked (fixed), or the reviewer dropped, waits for nobody — the server's
 * own rule. PURE.
 */
export function pendingQuestions(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "question" && !f.humanDecision && findingIsOpen(f));
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

/**
 * The merge gate's verdict on the APPROVED commit, or undefined when it has none for it (never run,
 * or a verdict on an older commit). What the merge button waits on: running and failed hold it. PURE.
 */
export function mergeGateOf(review: Pick<Review, "reviewedSha" | "mergeGate">): MergeGate | undefined {
  return review.mergeGate && review.mergeGate.sha === review.reviewedSha ? review.mergeGate : undefined;
}

export type MergeGateStatus = "running" | "fixing" | "failed";

/**
 * Where the merge gate on the approved commit holds the merge: running, red while the author's AI fixes
 * it and it reruns on its own (`fixing`), or red waiting for a person (`failed`: past the automatic
 * reruns, or a failure from when it reran only once). Undefined = it holds nothing. The server's
 * `mergeGateSelfHealing` draws the same line for the board summary. PURE.
 */
export function mergeGateStatus(review: Pick<Review, "reviewedSha" | "mergeGate">): MergeGateStatus | undefined {
  const gate = mergeGateOf(review);
  if (gate?.state === "running") return "running";
  if (gate?.state !== "failed") return undefined;
  return gate.exhausted || (gate.autoRetried && gate.failures === undefined) ? "failed" : "fixing";
}

/** What the signed-in person may do to a review right now: their role AND the state it is in. */
export interface ReviewActions {
  decide: boolean;
  retry: boolean;
  cancel: boolean;
  merge: boolean;
  /** Choose open suggestions and ask the author's AI to apply them. */
  request: boolean;
}

/**
 * Who sees which button — the server's rules (`routes/reviews.ts`), so the panel never offers one
 * that would answer 403/409:
 *  - **merge**: anyone with a role in the review — merger, reviewer, author, co-author (an owner
 *    without one, no) — only in `ready`; each merges on their own GitHub connection;
 *  - **decide** (questions, stuck items): the reviewer or an owner, while the review is open to it;
 *  - **retry**: the reviewer, the merger, the co-author or an owner, for an impasse that is a FAILURE (not "rodadas",
 *    not a push after ready: those have no turn to hand back), a `ready` whose Approve never got out
 *    or whose merge gate failed on the approved commit (retry runs the gate again),
 *    or a turn an AI may have dropped — `fixing`, or `reviewing` before the reviewer's round is in
 *    (after it, only doubts are left and the turn is the human's);
 *  - **cancel**: the reviewer, the author, the co-author, the merger or an owner, while the review is active;
 *  - **request** (ask the author to apply chosen suggestions): the same people, while it is active.
 * PURE.
 */
export function reviewActions(
  review: Pick<
    Review,
    | "phase" | "round" | "lastSubmitRound" | "reviewerUserId" | "authorUserId" | "coauthorUserId" | "mergerUserId"
    | "impasseReason" | "approvePending" | "reviewedSha" | "mergeGate"
  >,
  me: { id: string; isOwner: boolean } | null,
): ReviewActions {
  if (!me) return { decide: false, retry: false, cancel: false, merge: false, request: false };
  const isReviewer = me.id === review.reviewerUserId;
  const isMerger = me.id === review.mergerUserId;
  const isCoauthor = review.coauthorUserId !== undefined && me.id === review.coauthorUserId;
  // Whoever has a role in the review (the server's `canMergeReview`): the work goes on without the person in charge.
  const hasRole = isReviewer || isMerger || isCoauthor || me.id === review.authorUserId;
  const { phase } = review;
  const failedImpasse =
    phase === "impasse" && review.impasseReason !== IMPASSE_ROUNDS && review.impasseReason !== IMPASSE_HEAD_MOVED;
  const approveStuck = phase === "ready" && review.approvePending === true;
  const gateFailed = phase === "ready" && mergeGateOf(review)?.state === "failed";
  const turnOpen = phase === "fixing" || (phase === "reviewing" && review.lastSubmitRound !== review.round);
  return {
    merge: hasRole && phase === "ready",
    decide: (isReviewer || me.isOwner) && (reviewIsWorking(phase) || phase === "impasse"),
    retry: (isReviewer || isMerger || isCoauthor || me.isOwner) && (failedImpasse || approveStuck || gateFailed || turnOpen),
    cancel: (hasRole || me.isOwner) && reviewIsOpen(phase),
    request: (hasRole || me.isOwner) && reviewIsOpen(phase),
  };
}

/** What the merge request came back with, in the three ways the panel treats differently. */
export type MergeFailure =
  | { kind: "head_moved"; review?: Review }
  /** No answer, or a proxy gave up on a request that can run for minutes: the merge may still happen. */
  | { kind: "lost" }
  /** 409 `merging`: a merge is already running on the server (this click, lost earlier, or another's). */
  | { kind: "running" }
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
 * `merged`; so is the 409 `merging` (a merge is already running). `head_moved` is the 409 the server
 * answers when the PR moved after the approval — and it has already put the review back, which the
 * body carries. PURE.
 */
export function mergeFailure(err: unknown): MergeFailure {
  const response = (err as { response?: { status?: number; data?: MergeErrorBody | string } })?.response;
  const status = response?.status;
  if (status === undefined || PROXY_GAVE_UP.has(status)) return { kind: "lost" };
  const body = typeof response?.data === "object" && response.data ? response.data : {};
  if (status === 409 && body.reason === "head_moved") return { kind: "head_moved", review: body.review };
  if (status === 409 && body.reason === "merging") return { kind: "running" };
  const message = (typeof response?.data === "string" ? response.data : body.error ?? "").trim();
  return { kind: "refused", reason: body.reason, message, review: body.review };
}

/* ------------------------------------------------------------------ the conversation */

/**
 * Whose move it is RIGHT NOW, and whether that side's AI is actually in a turn — the one sentence the
 * panel leads with and the "digitando…" of the conversation:
 *  - `reviewer`: `reviewing` before the reviewer's round is in (after it, only doubts are left);
 *  - `author`: `fixing`, or a `ready` PR the author's AI is working on (`onReadyPr`: what it pushes
 *    sends the review back to the reviewer);
 *  - `person`: a doubt to decide, an impasse, or a ready PR waiting for its merge;
 *  - `nobody`: merged or cancelled.
 * PURE.
 */
export type ReviewTurn =
  | { who: "reviewer"; working: boolean }
  | { who: "author"; working: boolean; onReadyPr: boolean }
  | { who: "person"; why: "decision" | "impasse" | "merge" }
  | { who: "nobody" };

export function reviewTurn(
  review: Pick<Review, "phase" | "round" | "lastSubmitRound" | "findings">,
  working: ReviewWorking,
): ReviewTurn {
  switch (review.phase) {
    case "reviewing":
      if (review.lastSubmitRound !== review.round) return { who: "reviewer", working: working.reviewer };
      return { who: "person", why: "decision" };
    case "fixing":
      return { who: "author", working: working.author, onReadyPr: false };
    case "ready":
      return working.author ? { who: "author", working: true, onReadyPr: true } : { who: "person", why: "merge" };
    case "impasse":
      return { who: "person", why: "impasse" };
    default:
      return { who: "nobody" };
  }
}

/**
 * A row of the conversation: a "Rodada N" divider, or one line of the log — with a stable key and the
 * position in the log (`index`; a divider carries its first line's), which tells a line that arrived
 * while the panel was open from one that was already there.
 */
export type ConversationRow =
  | { kind: "round"; round: number; key: string; index: number }
  | { kind: "line"; event: ReviewEvent; key: string; index: number }
  /** The findings of an AI line, drawn right after its summary as one group of messages, one per finding. */
  | { kind: "items"; event: ReviewEvent; key: string; index: number };

/**
 * The log as the conversation draws it: a "Rodada N" divider before the first line of each round —
 * the way a chat app marks a new day — then the lines in the order they happened. An AI line that is
 * about findings is split the way a person would type it: the summary first, then its findings, one
 * message each, so each subject reads on its own instead of in one long bubble. Both rows share the
 * line's `index` (they arrived together). PURE.
 */
export function conversationRows(log: ReviewEvent[]): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let round: number | null = null;
  log.forEach((event, i) => {
    if (event.round !== round) {
      round = event.round;
      rows.push({ kind: "round", round, key: `round-${round}-${i}`, index: i });
    }
    rows.push({ kind: "line", event, key: `${event.at}-${i}`, index: i });
    if ((event.who === "reviewer" || event.who === "author") && event.items?.length) {
      rows.push({ kind: "items", event, key: `${event.at}-${i}-items`, index: i });
    }
  });
  return rows;
}

/**
 * When a suggestion was sent to the author, as `dd/mm/aaaa hh:mm` in São Paulo time — the company's
 * clock, whatever the browser's timezone, and a fixed shape a test can assert. PURE.
 */
export function requestedAtText(at: number): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}
