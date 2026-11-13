/**
 * PR REVIEW — pure rules. This is where the invariants the server imposes on the reviewer's AI and on
 * the author's live, so the loop does not depend on the prompt's goodwill: blocking only with proof, a
 * closed list from round 2 onwards, and a cap on rounds. No I/O; the orchestrator persists and fires the relays.
 *
 * Severity separates who acts. What has a clear expected behaviour, the author's AI resolves on its own:
 * `blocking` (a bug, with proof) and `improvement` (an improvement in the code the PR touches, preserving
 * rule and behaviour). What requires deciding what the system should do waits for a person: `question`.
 * What is optional waits for a person to choose: `suggestion`. Technical autonomy (how to solve it) is the
 * AI's; a product decision (what the system does) belongs to people.
 */

export const MAX_ROUNDS = 3;

export type ReviewPhase = "reviewing" | "fixing" | "ready" | "impasse" | "merged" | "cancelled";
/** Review closed: the PR was merged or the review cancelled. `impasse` is NOT here: it waits for a human. */
export const isReviewClosed = (phase: ReviewPhase): boolean => phase === "merged" || phase === "cancelled";

export type FindingSeverity = "blocking" | "improvement" | "suggestion" | "question" | "refuted";
/**
 * `wontfix`: the author decided not to apply a suggestion or improvement, with the reason (neither of
 * the two blocks; a blocking one does not accept it).
 */
export type FindingStatus = "open" | "fixed" | "contested" | "accepted_risk" | "dropped" | "wontfix";

/** What the author answers about a finding: fixed, disputed (with proof) or, for a suggestion only, will not apply. */
export type AuthorAnswerStatus = "fixed" | "contested" | "wontfix";

export interface FindingProof {
  kind: "failing_test" | "rule" | "scenario";
  ref: string;
  detail?: string;
}

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  /**
   * The problem explained for whoever decides without opening the code: what is wrong and what happens
   * if it stays that way. The title alone did not say that (production, 2026-11-09). Absent in old findings.
   */
  problem?: string;
  file?: string;
  line?: number;
  proof?: FindingProof;
  fix?: string;
  status: FindingStatus;
  introducedInRound: number;
  commit?: string;
  authorReply?: string;
  reviewerReply?: string;
  humanDecision?: "keep" | "accept_risk" | "block" | "drop";
  /**
   * A suggestion a person already told the author to apply (who and when). While it stays open, the
   * panel does not offer "fazer" again and the server refuses the resend: without this, the list sent
   * came back with the same choices and the same thing could be sent to the author twice (production, 2026-11-09).
   * Disappears when the finding changes hands: the author's answer or the reviewer's verdict clears the mark.
   */
  requested?: { by: string; at: number };
}

/**
 * A finding cited in a message, with what that side said about it AT THAT moment: the finding keeps only
 * the latest answer from each side, and the AIs' conversation needs the one from each round.
 */
export interface ReviewEventItem {
  id: string;
  status: FindingStatus;
  reply?: string;
  commit?: string;
  /** The finding was born in this message (the reviewer's round that opened it). */
  isNew?: boolean;
}

export interface ReviewEvent {
  at: number;
  round: number;
  who: "reviewer" | "author" | "system" | "human";
  text: string;
  /** The findings the message is about. Absent in system messages and in those recorded before this field. */
  items?: ReviewEventItem[];
  /** Who did it, in human messages (the username). */
  by?: string;
}

export interface MergeGate {
  sha: string;
  state: "running" | "passed" | "failed";
  /** The output of the gate that failed (already redacted and capped). */
  output?: string;
  at: number;
  /**
   * This failure was already picked up to run again on its own, at the end of an author's turn: the mark
   * that stops two turn endings together from running the gate twice. A failure recorded before `failures`
   * with this mark is from when the automatic retry happened only once, and no longer runs on its own.
   */
  autoRetried?: true;
  /**
   * How many times in a row the gate failed on this commit since the last human order ("Tentar de novo"
   * resets it). Carried by `running`. Absent in a failure recorded before the field = 1.
   */
  failures?: number;
  /** The failure went past {@link MERGE_GATE_AUTO_RETRIES} automatic retries: nobody runs it again without a person. */
  exhausted?: true;
}

/**
 * How many times the merge gate runs again on its own, each one after an author turn fixing the previous
 * failure. A cap so a test the AI cannot fix does not trap the runner in a loop.
 */
export const MERGE_GATE_AUTO_RETRIES = 3;

/**
 * The red gate that still comes back on its own: the author's AI has the failure and, at the end of its
 * turn, the tests run again. False = red that waits for a person. PURE.
 */
export function mergeGateSelfHealing(gate: MergeGate): boolean {
  return gate.state === "failed" && !gate.exhausted && !(gate.autoRetried && gate.failures === undefined);
}

export interface Review {
  id: string;
  /** The AUTHOR's card: where the fix runs and the PR lives. */
  cardId: string;
  /**
   * The card that ATTACHED the PR and asked for the review, when it is not the author's (`vibehub_attach_prs`):
   * from there people follow the PR line, and the phase notices land there. Absent = asked on the author's own card.
   */
  hubCardId?: string;
  projectId: string;
  prNumber: number;
  prUrl: string;
  prBranch: string;
  base: string;
  reviewerUserId: string;
  authorUserId: string;
  coauthorUserId?: string;
  mergerUserId: string;
  reviewerCardId: string;
  round: number;
  phase: ReviewPhase;
  findings: Finding[];
  log: ReviewEvent[];
  reviewedSha?: string;
  /**
   * The PR head the last time someone saw it (the reviewer on submitting, the author on answering, the
   * GitHub check). Different from `reviewedSha` = the PR moved after the review: the panel shows it.
   */
  prHeadSha?: string;
  impasseReason?: string;
  /**
   * `ready`, but the Approve request did not reach the reviewer's card: the PR still has round 1's
   * `--request-changes` on GitHub. The human merge is not blocked; the panel offers
   * "tentar de novo" (retryReview), and the relay that succeeds clears the mark.
   */
  approvePending?: boolean;
  /**
   * The round in which the automatic merge was tried and refused (CI, conflict, connection). In that round
   * it is not tried again and the texts go back to saying "merge pelo botão"; a new round resets the effect.
   */
  autoMergeFailedRound?: number;
  /**
   * The merge gate (the PR's CI, or the tests of the author's worktree), run on the approved commit as soon
   * as the review is ready, and not only on the click: the panel shows the verdict before the button, a green
   * is reused by the merge (which goes out right away) and a red goes back to the author with the failure.
   * Valid only for `sha`; a `running` that is not running in this process is from before a deploy and runs again.
   */
  mergeGate?: MergeGate;
  /**
   * Whoever merges ALREADY gave the merge order when asking for the review ("terminando pode mergear"):
   * there is nobody to wait for to say "pode mergear", so a standing suggestion does not hold the automatic
   * merge (it is optional by definition). Blocking, question, Approve missing on GitHub, CI and conflict still hold it.
   */
  mergeAuthorized?: boolean;
  /**
   * The same order asked to complete the card: once the review is merged, the card that gave the order
   * goes to `done` (the one that attached the PR, `hubCardId`, or the author's when it is the same one).
   */
  concludeWhenMerged?: boolean;
  lastSubmitRound?: number;
  lastRespondRound?: number;
  nudges: number;
  createdAt: number;
  updatedAt: number;
}

/** `introducedInRound` is optional on input: from round 2 on it is the "created by the fix" mark. */
export type SubmittedFinding = Omit<Finding, "id" | "status" | "introducedInRound"> & {
  id?: string;
  introducedInRound?: number;
};

const PROOF_KINDS: ReadonlySet<string> = new Set(["failing_test", "rule", "scenario"]);

function hasProof(p: FindingProof | undefined): boolean {
  return !!p && PROOF_KINDS.has(p.kind) && typeof p.ref === "string" && p.ref.trim() !== "";
}

/**
 * Turns what the reviewer's AI sent into new findings. Blocking without proof is downgraded to a
 * suggestion (the server guarantees it, not the prompt). From round 2 on the list is closed: a new
 * finding only gets in if the reviewer marked it as created by the fix (`introducedInRound === round`);
 * items that cite an existing id are verdicts (they go through `applyReviewerVerdicts`) and create no new finding.
 */
export function normalizeSubmittedFindings(input: SubmittedFinding[], round: number, existing: Finding[]): Finding[] {
  const known = new Set(existing.map((f) => f.id));
  const out: Finding[] = [];
  for (const item of input) {
    if (item.id && known.has(item.id)) continue;
    if (round >= 2 && item.introducedInRound !== round) {
      throw new Error(
        `lista fechada: a rodada ${round} não aceita achado novo sem introducedInRound=${round} ` +
          `(só o que a correção do autor introduziu): "${item.title}"`,
      );
    }
    const severity = item.severity === "blocking" && !hasProof(item.proof) ? "suggestion"
      // The improvement the AI applies on its own only counts when pinned to a file of the PR: without an
      // anchor, nothing stops the author from "improving" outside the scope, and it becomes optional again (a person chooses).
      : item.severity === "improvement" && !item.file?.trim() ? "suggestion"
        : item.severity;
    // Explicit allowlist: humanDecision, commit, authorReply and reviewerReply belong to the server/human/author
    // and can never come from the reviewer's AI (a question already "decided" would release ready without a human).
    const finding: Finding = {
      id: `f${existing.length + out.length + 1}`,
      severity,
      title: item.title,
      status: "open",
      introducedInRound: round,
    };
    if (item.problem !== undefined) finding.problem = item.problem;
    if (item.file !== undefined) finding.file = item.file;
    if (item.line !== undefined) finding.line = item.line;
    if (item.proof !== undefined) finding.proof = item.proof;
    if (item.fix !== undefined) finding.fix = item.fix;
    out.push(finding);
  }
  return out;
}

function mustFind(findings: Finding[], id: string): Finding {
  const f = findings.find((x) => x.id === id);
  if (!f) throw new Error(`achado desconhecido: ${id}`);
  return f;
}

/** Reviewer verdicts on existing findings. Returns the new list; does not mutate the review. */
export function applyReviewerVerdicts(
  review: Review,
  updates: { id: string; status: FindingStatus; reviewerReply?: string }[],
): Finding[] {
  const out = review.findings.map((f) => ({ ...f }));
  for (const u of updates) {
    const f = mustFind(out, u.id);
    f.status = u.status;
    // The request to the author is over: an "open" from the reviewer is a new suggestion to decide, not the same pending one.
    delete f.requested;
    if (u.reviewerReply !== undefined) f.reviewerReply = u.reviewerReply;
  }
  return out;
}

/**
 * The author's answers. Disputing and not applying require a justification: a silent answer gives the
 * reviewer nothing to judge. `wontfix` only applies to suggestion and improvement — a blocking one is fixed or disputed with proof.
 */
export function applyAuthorResponses(
  review: Review,
  items: { id: string; status: AuthorAnswerStatus; commit?: string; reply: string }[],
): Finding[] {
  const out = review.findings.map((f) => ({ ...f }));
  for (const it of items) {
    const f = mustFind(out, it.id);
    if (it.status !== "fixed" && (it.reply ?? "").trim() === "") {
      throw new Error(`${it.status === "wontfix" ? "não aplicar" : "contestar"} o achado ${it.id} exige uma resposta`);
    }
    if (it.status === "wontfix" && f.severity !== "suggestion" && f.severity !== "improvement") {
      throw new Error(`wontfix vale só para sugestão e melhoria: ${it.id} é ${f.severity} (corrija ou conteste com prova)`);
    }
    f.status = it.status;
    f.authorReply = it.reply;
    // The author answered: the request was fulfilled (or refused with a reason) and no longer holds the choice.
    delete f.requested;
    if (it.commit !== undefined) f.commit = it.commit;
  }
  return out;
}

const isOpen = (f: Finding): boolean => f.status === "open" || f.status === "contested";

/** Blocking findings still standing (open or disputed). */
export function blockingOpen(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "blocking" && isOpen(f));
}

/**
 * Questions waiting for a decision: no human decided them and they are still standing. A question the
 * author resolved and the reviewer checked (`fixed`), or that the reviewer withdrew (`dropped`), waits for nobody.
 */
export function pendingQuestions(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "question" && !f.humanDecision && isOpen(f));
}

/**
 * Improvements still waiting for the author's turn: open and without an answer from them. Once answered
 * (applied or refused with a reason), it does not ask for a round again: the reviewer checks, and whatever stays standing only shows up.
 */
export function pendingImprovements(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "improvement" && f.status === "open" && f.authorReply === undefined);
}

/**
 * Next phase, called AFTER applying the reviewer's round (`review.round` = the round just reviewed).
 * A question decided as `block` weighs as blocking; `drop` counts as resolved. A pending question alone
 * holds ready without spending a round (it waits for the human); with an open blocking one the normal rule wins.
 * A pending improvement gives the turn to the author (they apply it without waiting for anyone), but never
 * becomes an impasse: on the last round it stays unapplied.
 */
export function phaseAfterReviewerRound(review: Review): { phase: ReviewPhase; impasseReason?: string } {
  const blocking =
    blockingOpen(review.findings).length +
    review.findings.filter((f) => f.severity === "question" && f.humanDecision === "block" && isOpen(f)).length;
  if (blocking > 0) {
    return review.round >= MAX_ROUNDS ? { phase: "impasse", impasseReason: "rodadas" } : { phase: "fixing" };
  }
  if (review.round < MAX_ROUNDS && pendingImprovements(review.findings).length > 0) return { phase: "fixing" };
  if (pendingQuestions(review.findings).length > 0) return { phase: "reviewing" };
  return { phase: "ready" };
}

/**
 * WHO MAY MERGE a ready review: anybody with a role in it — the merge owner, the reviewer, the author
 * and the co-author. The owner is still the one the automatic merge uses; the others exist so the work
 * goes on when they are not around (production, 2026-11-09: Albert, reviewer and co-author, had no button
 * and the ready review stopped waiting for César). PURE.
 */
export function canMergeReview(
  review: Pick<Review, "reviewerUserId" | "authorUserId" | "coauthorUserId" | "mergerUserId">,
  userId: string | undefined,
): boolean {
  if (!userId) return false;
  return [review.mergerUserId, review.reviewerUserId, review.authorUserId, review.coauthorUserId].includes(userId);
}

/** The orders whoever merges gives when asking for the review (see the fields of {@link Review}). */
export type ReviewOrders = Pick<Review, "mergeAuthorized" | "concludeWhenMerged">;

/** A suggestion the authorised merge lets through: standing and not requested from the author. PURE. */
function isWaived(review: Review, f: Finding): boolean {
  return !!review.mergeAuthorized && f.severity === "suggestion" && !f.requested;
}

/**
 * The standing suggestions the authorised merge lets through, so the texts say how many were left instead
 * of "nada em aberto". Without `mergeAuthorized`, none. PURE.
 */
export function waivedSuggestions(review: Review): Finding[] {
  return review.findings.filter((f) => isOpen(f) && isWaived(review, f));
}

/** "merge autorizado por quem mergeia; N sugestão(ões) em aberto não segura(m)", or null when there is none. PURE. */
export function waivedText(review: Review): string | null {
  const n = waivedSuggestions(review).length;
  if (!n) return null;
  return n === 1
    ? "merge autorizado por quem mergeia; 1 sugestão em aberto não segura"
    : `merge autorizado por quem mergeia; ${n} sugestões em aberto não seguram`;
}

/**
 * The merge goes out ON ITS OWN when nothing is left for a person to look at: review in `ready` and no
 * finding standing, of any severity — blocking, question or open/disputed suggestion. A suggestion does not
 * hold `ready`, but it holds the automatic merge: it is precisely what somebody may want applied first.
 * Without this the PR sat "pronto pra merge" waiting for somebody to come back to the card just to say "pode mergear".
 * An improvement never holds: it already had the author's turn, who decided on their own, and it is nobody's choice.
 * With the merge already authorised (`mergeAuthorized`) that person has already spoken: a standing suggestion does
 * not hold, except one somebody already told the author to apply ("Fazer"), which holds until they push ({@link waivedSuggestions}).
 * PURE.
 */
export function autoMergeEligible(review: Review): boolean {
  const holds = (f: Finding): boolean => f.severity !== "improvement" && isOpen(f) && !isWaived(review, f);
  return (
    review.phase === "ready" && !!review.reviewedSha && !review.findings.some(holds) &&
    // An Approve that did not reach GitHub: the PR still has round 1's "changes requested" — the automatic
    // merge does not override that; the panel's "tentar de novo" publishes it and the merge goes out afterwards.
    !review.approvePending &&
    review.autoMergeFailedRound !== review.round
  );
}
