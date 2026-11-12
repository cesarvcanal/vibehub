import { randomUUID } from "node:crypto";
import {
  getCard, createCard, createReviewerCard, removeCard, updateCard, cardMoveEffect, isHumanActive, shareWith, getGithubConnection,
  listCards, recordCardPr, markCardPrMerged, type Card, type CardPr,
} from "../board/registry.js";
import { cardBranch, resumeCard } from "../board/workspace.js";
import { recordCardActor } from "../board/actor.js";
import { findUser } from "../../auth/users.js";
import { cardLevel } from "../../auth/access.js";
import { cardAccountSlug, getUserGit, linkedAccountSlug } from "../../auth/userGit.js";
import { sendToTerminal, SEND_READY_WAIT_MS } from "../maestro/maestro.js";
import { afterPrMerged, gateAtCommit, readPrApproval, readPrState, setPrPeople } from "../maestro/deliver.js";
import type { GateResult } from "../maestro/gate.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { eventsAfter, onCardEvent, recordMessage, type CardEvent, type Severity } from "../events/cardEvents.js";
import { logger } from "../../utils/logger.js";
import { clipLine } from "../../utils/clipLine.js";
import {
  MAX_ROUNDS, MERGE_GATE_AUTO_RETRIES, mergeGateSelfHealing, applyAuthorResponses, applyReviewerVerdicts, autoMergeEligible, waivedText, type ReviewOrders, blockingOpen, normalizeSubmittedFindings, pendingImprovements, pendingQuestions,
  isReviewClosed, phaseAfterReviewerRound,
  type AuthorAnswerStatus, type Finding, type FindingStatus, type Review, type ReviewEvent, type ReviewEventItem,
  type SubmittedFinding,
} from "./model.js";
import {
  activeReviewForPr, getReview, insertReview, listReviewsForCards, mutateReview, reviewByReviewerCard,
} from "./store.js";
import {
  actionableForAuthor, approvePendingText, autoMergeFailedText, authorFixPrompt, authorMergeGatePrompt, mergeGateFailedText, authorQuestionNoticeText, authorSuggestionsPrompt, headMovedPrefix,
  impasseText, nudgePrefix, phaseNoticeText, questionNoticeText, reviewerApprovePrompt, reviewerDeltaPrompt,
  reviewerRoundPrompt, TOOL_RESPOND, TOOL_SUBMIT,
} from "./prompts.js";

/**
 * PR REVIEW ORCHESTRATOR — the server is the mail carrier between the reviewer's AI (on a hidden card,
 * in the reviewer's Claude account) and the author's AI (on the author's card). No person carries messages.
 *
 *   startReview ──► reviewer's card: round 1 (/code-review)
 *   vibehub_review_submit ──► fixing: closed list to the author | ready: Approve on GitHub | impasse
 *   vibehub_review_respond ──► round N+1: the reviewer checks only the diff
 *   turn_finished without the tool ──► a reminder; on the second, impasse "IA não respondeu"
 *   human ──► decideQuestion | retryReview (impasse from a failure, pending Approve) | cancelReview
 *   merge button (route) ──► markReviewMerged | PR head moved: reopenAfterHeadMoved
 *   the PR on GitHub (end of the author's turn; panel open, throttled) ──► syncReviewWithGithub:
 *     merged outside the panel → merged | closed without merge → cancelled | push after ready → reopen
 *
 * The rules of the game (proof, closed list, cap on rounds) live in the pure model; here live the
 * persistence, who may call what, and the relays. Three guarantees run through the file:
 *
 *  - IDEMPOTENCY: the same round submitted/answered twice (an AI retry) does not fire a second relay.
 *    The check is redone INSIDE the mutation, so two simultaneous submits also become one.
 *  - AUTHORSHIP: before each text, the target card's actor becomes the person on that side (author on
 *    the author's card, reviewer on the reviewer's), in the send's `beforeDeliver`: a refused send does
 *    not touch the authorship, and the commit/push/review the text triggers goes out on the right account.
 *  - NEVER STOPPED IN SILENCE: a send that fails (card completed, Claude that does not start) becomes
 *    `impasse` with the error as the reason, a notice on the author's and reviewer's cards and a warn in
 *    the log; and every impasse that is not about rounds has a way out (`retryReview`), besides `cancelReview`.
 *
 * The merge always goes out through `mergeReviewedPr` (`merge.ts`): the human click (`routes/reviews.ts`)
 * or, with the review ready, approved on GitHub and nothing standing, the `autoMerge` here, by the same
 * path and on behalf of the merge owner.
 */

/** Who signs the messages the orchestrator types into the cards. */
const REVIEW_ORIGIN: MessageOrigin = { kind: "system", name: "revisão de PR" };

/** What the end of a turn waits before judging: the tool call in the same turn wins. */
const TURN_GRACE_MS = 1_500;

/** Verdicts the reviewer's AI may give. `accepted_risk` is for humans only (decideQuestion). */
const REVIEWER_VERDICTS: ReadonlySet<FindingStatus> = new Set(["fixed", "open", "dropped"]);

/** Full sha (SHA-1, or SHA-256 in a repo that uses it): the merge compares it with the PR head, an abbreviated one does not do. */
export const HEAD_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const NO_ANSWER = "IA não respondeu";
/** Impasse reason when the PR moved after `ready` and no round is left to check what came in. */
const HEAD_MOVED = "push depois do pronto";

type Side = "reviewer" | "author";
type Decision = "block" | "drop" | "keep" | "accept_risk";

/* ------------------------------------------------------------------ helpers */

/** Cap on each answer quoted in a message: enough to read the argument, without turning into a page. */
const REPLY_MAX = 600;

/**
 * A message in the review log. `items` are the findings it is about, with each one's answer at that
 * moment (it is what the AIs' conversation shows round by round); `by`, who did it, in a human message.
 */
function note(r: Review, who: ReviewEvent["who"], text: string, extra: { items?: ReviewEventItem[]; by?: string } = {}): void {
  const event: ReviewEvent = { at: Date.now(), round: r.round, who, text: clipLine(text, 400) };
  const items = (extra.items ?? []).map((it) => {
    const item: ReviewEventItem = { id: it.id, status: it.status };
    if (it.reply !== undefined && it.reply.trim() !== "") item.reply = clipLine(it.reply, REPLY_MAX);
    if (it.commit !== undefined && it.commit.trim() !== "") item.commit = clipLine(it.commit, 64);
    if (it.isNew) item.isNew = true;
    return item;
  });
  if (items.length) event.items = items;
  if (extra.by) event.by = extra.by;
  r.log.push(event);
}

function assertHeadSha(sha: string): string {
  const v = String(sha ?? "").trim();
  if (!HEAD_SHA_RE.test(v)) {
    throw new Error("headSha inválido: mande o sha completo de `git rev-parse HEAD` (40 caracteres hex)");
  }
  return v.toLowerCase();
}

/** What blocks now: a standing blocking finding or a question the human decided to block on. */
const blockingNow = (r: Review): Finding[] => r.findings.filter(actionableForAuthor);

/** Waiting for this side's tool, in this round. It is what a turn ending without a call demands. */
function awaitingTool(r: Review, side: Side): boolean {
  return side === "reviewer"
    ? r.phase === "reviewing" && r.lastSubmitRound !== r.round
    : r.phase === "fixing" && r.lastRespondRound !== r.round;
}

/**
 * The line that gives the CO-AUTHOR credit in Git (`Co-authored-by: Nome <email>`), with the git identity
 * they have on vibehub. No co-author, co-author equal to the author, or no name/e-mail: none.
 */
async function coauthorTrailer(r: Review): Promise<string | undefined> {
  if (!r.coauthorUserId || r.coauthorUserId === r.authorUserId) return undefined;
  const git = await getUserGit(r.coauthorUserId);
  return git?.gitName && git.gitEmail ? `Co-authored-by: ${git.gitName} <${git.gitEmail}>` : undefined;
}

/**
 * The text this side's turn asks for: the whole round 1, the delta from round 2 on, or the author's
 * list (with the co-author's credit line, when there is one).
 */
async function promptFor(r: Review, side: Side): Promise<string> {
  if (side === "author") return authorFixPrompt(r, { coauthorTrailer: await coauthorTrailer(r) });
  return r.round <= 1 ? reviewerRoundPrompt(r) : reviewerDeltaPrompt(r);
}

/** The GitHub login of a person's OWN connection on vibehub; without one, undefined. */
async function githubLogin(userId: string): Promise<string | undefined> {
  const own = (await getUserGit(userId))?.githubConnectionId;
  return own ? (await getGithubConnection(own))?.login : undefined;
}

/**
 * The review roles GitHub also has, recorded on the PR: the RESPONSIBLE one (who fixes, commits and
 * pushes) becomes the assignee — the owner of the delivery —, and the REVIEWER becomes the requested
 * reviewer. Co-author and whoever merges have no field on the PR (the co-author gets the credit in the
 * commits, through the Co-authored-by line). The conversation tells what went out. Never throws: a PR
 * without the names does not stop the review.
 */
async function namePeopleOnGithub(r: Review): Promise<void> {
  try {
    const [assignee, reviewer] = await Promise.all([githubLogin(r.authorUserId), githubLogin(r.reviewerUserId)]);
    const asked = { ...(assignee ? { assignee } : {}), ...(reviewer ? { reviewer } : {}) };
    const done = await setPrPeople(r.cardId, r.prUrl, asked);
    const parts: string[] = [];
    if (assignee) parts.push(done.assignee === "ok" ? `assignee ${assignee} (o responsável)` : `assignee ${assignee} recusado pelo GitHub`);
    if (reviewer) parts.push(done.reviewer === "ok" ? `reviewer ${reviewer} pedido` : `reviewer ${reviewer} recusado pelo GitHub`);
    const missing = !assignee ? " O assignee não foi marcado: o responsável não tem conexão GitHub própria no vibehub." : "";
    await mutateReview(r.id, (x) => {
      note(x, "system", `No GitHub: ${parts.length ? parts.join(" e ") : "ninguém marcado"}.${missing}`);
    });
  } catch (err) {
    logger.warn({ review: r.id, detail: (err as Error).message }, "could not name the review's people on GitHub");
  }
}

/* ------------------------------------------------------------------ avisos */

/**
 * A notice on BOTH review cards (author and reviewer) — and on the card that attached the PR, when it is
 * another one —, each with its own key: a replay does not duplicate it. Never throws: a notice that does
 * not get recorded costs the notice, not the review.
 */
async function notifyBoth(r: Review, key: string, text: string, severity: Severity): Promise<void> {
  // The card that ATTACHED the PR (when it is not the author's) follows the review from there: it gets the same notice.
  const sides: [string, string][] = [[r.cardId, "author"], [r.reviewerCardId, "reviewer"]];
  if (r.hubCardId && r.hubCardId !== r.cardId) sides.push([r.hubCardId, "hub"]);
  for (const [cardId, who] of sides) {
    try {
      await recordMessage({ cardId, type: "info", severity, text, idempotencyKey: `${key}:${who}` });
    } catch (err) {
      logger.warn({ review: r.id, card: cardId, detail: (err as Error).message }, "could not record the review notice");
    }
  }
}

/**
 * A phase change to `ready`, `impasse` or `merged` becomes a notice on the author's and reviewer's cards
 * (the notice tray that already exists), with the key `review:<id>:<phase>:<round>:<side>`.
 */
export async function announcePhase(r: Review): Promise<void> {
  if (r.phase !== "ready" && r.phase !== "impasse" && r.phase !== "merged") return;
  await notifyBoth(r, `review:${r.id}:${r.phase}:${r.round}`, phaseNoticeText(r), r.phase === "impasse" ? "warning" : "info");
}

/**
 * The reviewer's round left a question undecided: it holds `ready` until somebody decides — the HUMAN
 * reviewer on the panel, or the AIs (the author resolves, the reviewer checks). The notice goes to the
 * reviewer's card and to the author's, once per round (`review:<id>:question:<round>:<side>`). Never throws.
 */
async function announceQuestions(r: Review): Promise<void> {
  if (pendingQuestions(r.findings).length === 0) return;
  // The reviewer's card is hidden from the board: the notice also goes to the author's, where people look,
  // saying who decides.
  const decider = (await findUser(r.reviewerUserId))?.username ?? "o revisor";
  for (const [cardId, side, text] of [
    [r.reviewerCardId, "reviewer", questionNoticeText(r)],
    [r.cardId, "author", authorQuestionNoticeText(r, decider)],
  ] as const) {
    try {
      await recordMessage({ cardId, type: "info", severity: "info", text, idempotencyKey: `review:${r.id}:question:${r.round}:${side}` });
    } catch (err) {
      logger.warn({ review: r.id, card: cardId, detail: (err as Error).message }, "could not record the review question notice");
    }
  }
}

/* ------------------------------------------------------------------ relays */

/**
 * The author's card was PAUSED: it leaves Paused for `waiting` (the same write as dragging on the board,
 * PATCH /api/cards/:id) and, if the session had died, it is resumed. It is the only path in vibehub that
 * takes a card out of Paused without a person — the user's decision (10/29: "Pedir revisão" authorises
 * spending the author's account in this cycle) — and that is why it goes to the audit log as `review.wake`.
 * A sleeping card (hibernated, never opened) does not go through here: the send's `wake` already wakes it.
 */
async function unpauseAuthor(r: Review): Promise<void> {
  const live = await getCard(r.cardId);
  if (!live) throw new Error("o card do autor não existe mais");
  // `done` is somebody's conclusion: it does not leave it through here (the send refuses and the review goes to impasse).
  if (live.column === "done" || (live.column !== "paused" && !live.pausedAt)) return;
  const before = { ...live };
  const effect = cardMoveEffect(before, { column: "waiting" });
  if (before.column !== "waiting") await updateCard(r.cardId, { column: "waiting" });
  logger.info(
    { audit: true, action: "review.wake", card: before.worktreeSlug, review: r.id, from: before.column, effect },
    "author card taken out of Paused by the PR review",
  );
  if (effect === "resume" || before.pausedAt) await resumeCard(r.cardId, `review:${r.id}`);
}

/**
 * Delivers `text` to the card of one of the sides. The actor becomes the person on that side in `beforeDeliver`.
 *  - `unpause`: only the round's FIRST relay to the author takes their card out of Paused. A reminder and
 *    "tentar de novo" do not: a pause in the middle of the fix is the person's decision, and the refused
 *    send becomes an impasse with the reason (which "tentar de novo" resolves after they unpause).
 *  - `approve`: it is the Approve request. A failure keeps `ready` with `approvePending` and a notice (the
 *    human merge is not stuck because of GitHub); success clears the mark.
 *  - `optional`: a request the review does not wait for (suggestions chosen by a person). A failure does
 *    not touch the review: it throws the reason, so whoever asked knows.
 * Any other failure becomes `impasse` with the error, but only if the review is still in the phase and
 * round the text went out for (an answer that landed in between wins). Never throws. Returns whether it delivered.
 */
async function relayReview(
  r: Review, side: Side, text: string, opts: { unpause?: boolean; approve?: boolean; optional?: boolean } = {},
): Promise<boolean> {
  const cardId = side === "author" ? r.cardId : r.reviewerCardId;
  const userId = side === "author" ? r.authorUserId : r.reviewerUserId;
  const samePlace = (x: Review) => x.phase === r.phase && x.round === r.round;
  try {
    if (side === "author" && opts.unpause) await unpauseAuthor(r);
    await sendToTerminal(cardId, text, {
      by: `review:${r.id}`,
      origin: REVIEW_ORIGIN,
      // A sleeping card (hibernated, never opened, session lost in a restart) is woken up.
      wake: true,
      // Claude has to be up to read: a bare shell would swallow the text and the review would stall.
      requireAgent: true,
      // Never type into a menu (Enter would pick the highlighted option); a card that has just started
      // gets the time to draw the prompt.
      guardInteractiveMenu: true,
      readyWaitMs: SEND_READY_WAIT_MS,
      // With the native chat in use, the text becomes a driver turn; typed into tmux it would go to ANOTHER
      // Claude process and the conversation would fork.
      viaNativeChat: true,
      beforeDeliver: async () => recordCardActor(await findUser(userId), cardId),
    });
    if (opts.approve && r.approvePending) {
      await mutateReview(r.id, (x) => {
        if (x.phase === "ready") x.approvePending = undefined;
      }).catch((e: unknown) => logger.warn({ review: r.id, detail: (e as Error).message }, "could not clear approvePending"));
    }
    return true;
  } catch (err) {
    const reason = (err as Error).message;
    logger.warn({ review: r.id, card: cardId, side, detail: reason }, "PR review relay failed");
    if (opts.optional) throw new Error(`envio_falhou: não consegui entregar ao card do ${side === "author" ? "autor" : "revisor"} (${reason})`);
    const who = side === "author" ? "autor" : "revisor";
    try {
      if (opts.approve) {
        const after = await mutateReview(r.id, (x) => {
          if (x.phase !== "ready") return;
          x.approvePending = true;
          note(x, "system", `Approve não publicado: não consegui entregar ao revisor (${reason}).`);
        });
        if (after.approvePending) await notifyBoth(after, `review:${r.id}:approve_pending:${r.round}`, approvePendingText(after), "warning");
        return false;
      }
      let impasse = false as boolean;
      const after = await mutateReview(r.id, (x) => {
        if (isReviewClosed(x.phase) || !samePlace(x)) {
          note(x, "system", `Envio ao ${who} falhou depois que a revisão andou (${reason}); nada muda.`);
          return;
        }
        x.phase = "impasse";
        x.impasseReason = reason;
        note(x, "system", `Impasse: não consegui entregar ao ${who} (${reason}).`);
        impasse = true;
      });
      if (impasse) await announcePhase(after);
    } catch (e) {
      logger.warn({ review: r.id, detail: (e as Error).message }, "could not record the PR review relay failure");
    }
    return false;
  }
}

/** What the new phase asks for: the list to the author, the Approve to the reviewer, or just the notice. Returns the current review. */
async function dispatch(r: Review): Promise<Review> {
  if (r.phase === "fixing") {
    // The round's first relay: the only one that takes the author's card out of Paused.
    await relayReview(r, "author", await promptFor(r, "author"), { unpause: true });
  } else if (r.phase === "ready") {
    await announcePhase(r);
    // The automatic merge does NOT go out from here: this is the reviewer's submit path (their tool would
    // be stuck until CI finished) and the Approve has not even been published. It goes out from the end of
    // the reviewer's turn that reports `ready` (onTurnFinished), with the Approve already on GitHub.
    await relayReview(r, "reviewer", reviewerApprovePrompt(r), { approve: true });
    void checkMergeGate(r.id);
  } else if (r.phase === "impasse") {
    await announcePhase(r);
  }
  return (await getReview(r.id)) ?? r;
}

/**
 * The automatic merge of a ready review with nothing standing ({@link autoMergeEligible}): the SAME path
 * as the button (`mergeReviewedPr`, on behalf of the merge owner, pinned to the reviewed commit, with gate).
 * Called AFTER the Approve: from the end of the reviewer's turn that reported `ready`, or from "não fazer"
 * on the last suggestion of an already approved review. A refusal of "not ready"/"merge already going out"/
 * "head moved" is a race and stays quiet; any other (red CI, conflict, merger with no GitHub connection)
 * marks the round (`autoMergeFailedRound`: does not try again, and the texts go back to the button), becomes
 * a note on the review and a notice on both cards. Never throws. Dynamic import: merge.ts imports this file.
 */
async function autoMerge(r: Review): Promise<void> {
  const now = (await getReview(r.id)) ?? r;
  if (!autoMergeEligible(now)) return;
  // The merge gate is still running: its end calls this merge again. Red: the author was already told.
  const gate = now.mergeGate?.sha === now.reviewedSha ? now.mergeGate : undefined;
  if (gate && gate.state !== "passed") return;
  try {
    // The "ready" the reviewer reports does not prove the Approve: the prompt says to report it even when
    // `gh pr review --approve` fails (review of one's own PR, permission). GitHub is what proves it — an
    // APPROVED on the reviewed commit and no "changes requested" standing. A read that fails = no.
    const approved = await readPrApproval(now.cardId, now.prUrl, now.reviewedSha as string);
    if (approved !== true) {
      const why = approved === null ? "não consegui ler as reviews do PR no GitHub" : "o Approve do revisor não está no GitHub no commit revisado";
      await refuseAutoMerge(now, why);
      return;
    }
    const { mergeReviewedPr } = await import("./merge.js");
    const outcome = await mergeReviewedPr(now.id, now.mergerUserId, { auto: true });
    if (outcome.kind === "merged" || outcome.reason === "not_ready" || outcome.reason === "merging" || outcome.reason === "head_moved") return;
    await refuseAutoMerge(now, outcome.error);
  } catch (err) {
    logger.warn({ review: r.id, detail: (err as Error).message }, "PR review auto-merge failed");
  }
}

/** The automatic merge does not go out in this round: marks it, tells the review log and notifies both cards. */
async function refuseAutoMerge(r: Review, why: string): Promise<void> {
  logger.info({ audit: true, action: "review.automerge", review: r.id, merged: false, reason: clipLine(why, 200) }, "PR review auto-merge refused");
  const after = await mutateReview(r.id, (x) => {
    x.autoMergeFailedRound = x.round;
    note(x, "system", `Merge automático não saiu (${clipLine(why, 200)}); o merge fica pelo botão.`);
  });
  await notifyBoth(after, `review:${r.id}:automerge_failed:${r.round}`, autoMergeFailedText(after, why), "warning");
}

/** Reviews with the merge gate running in THIS process: a recorded `running` absent from here is from before a deploy. */
const mergeGatesRunning = new Set<string>();

/** Whether that review's merge gate is running now, in this process. */
export function mergeGateRunning(reviewId: string): boolean {
  return mergeGatesRunning.has(reviewId);
}

/**
 * Whether the ready review needs the merge gate: it never ran on the approved commit, or it was left
 * `running` orphaned (the process running it died in a deploy). `again` = run even after a failure on that
 * commit (the panel's "rodar de novo", or the end of the author's turn that fixed the worktree).
 */
function needsMergeGate(r: Review, again: boolean): boolean {
  if (r.phase !== "ready" || !r.reviewedSha || mergeGatesRunning.has(r.id)) return false;
  const gate = r.mergeGate?.sha === r.reviewedSha ? r.mergeGate : undefined;
  if (!gate || gate.state === "running") return true;
  return again && gate.state === "failed";
}

/**
 * Runs the merge gate on the approved commit of a ready review ({@link Review.mergeGate}) and records the
 * verdict, if the review is still ready on that commit. Green: the automatic merge goes out, if it applied.
 * Red: a notice on both cards and the failure to the author, to fix before somebody clicks. A gate that did
 * not even run (runner down, card gone) is red with the reason. Never throws.
 */
async function checkMergeGate(reviewId: string, opts: { again?: boolean; by?: string } = {}): Promise<void> {
  let sha = "";
  try {
    const r = await getReview(reviewId);
    if (!r || !needsMergeGate(r, opts.again === true)) return;
    sha = r.reviewedSha as string;
    mergeGatesRunning.add(reviewId);
    const previous = r.mergeGate?.sha === sha ? r.mergeGate : undefined;
    const failuresBefore = previous?.failures ?? (previous?.state === "failed" ? 1 : 0);
    await mutateReview(reviewId, (x) => {
      x.mergeGate = { sha, state: "running", at: Date.now(), ...(failuresBefore ? { failures: failuresBefore } : {}) };
    });
    let verdict: GateResult;
    try {
      verdict = await gateAtCommit(r.cardId, r.prUrl, sha);
    } catch (err) {
      verdict = { ran: true, passed: false, output: `o gate não chegou a rodar: ${(err as Error).message}` };
    }
    let landed = false as boolean;
    const failures = failuresBefore + 1;
    const exhausted = failures > MERGE_GATE_AUTO_RETRIES;
    const after = await mutateReview(reviewId, (x) => {
      if (x.phase !== "ready" || x.reviewedSha !== sha) return;
      x.mergeGate = verdict.passed
        ? { sha, state: "passed", at: Date.now() }
        : { sha, state: "failed", output: verdict.output, at: Date.now(), failures, ...(exhausted ? { exhausted: true as const } : {}) };
      note(x, "system", verdict.passed
        ? `Testes do merge verdes no commit aprovado (${sha.slice(0, 7)}): o merge sai na hora.`
        : exhausted
          ? `Testes do merge vermelhos no commit aprovado (${sha.slice(0, 7)}) depois de rodarem de novo sozinhos ${MERGE_GATE_AUTO_RETRIES} vezes: o merge espera uma pessoa.`
          : `Testes do merge vermelhos no commit aprovado (${sha.slice(0, 7)}): o autor recebeu a falha e, ao fim do turno dele, os testes rodam de novo sozinhos.`,
      opts.by ? { by: opts.by } : {});
      landed = true;
    });
    logger.info(
      { audit: true, action: "review.merge_gate", review: reviewId, sha, passed: verdict.passed, landed, again: opts.again === true, by: opts.by },
      verdict.passed ? "PR review merge gate passed" : "PR review merge gate failed",
    );
    if (!landed) return;
    if (verdict.passed) {
      if (autoMergeEligible(after) && (await reviewerApproved(after))) await autoMerge(after);
      return;
    }
    await notifyBoth(after, `review:${reviewId}:merge_gate_failed:${sha}:${after.mergeGate?.at}`, mergeGateFailedText(after), exhausted ? "warning" : "info");
    if (exhausted) return;
    await relayReview(after, "author", authorMergeGatePrompt(after), { unpause: true, optional: true }).catch((e: unknown) =>
      logger.warn({ review: reviewId, detail: (e as Error).message }, "could not send the merge gate failure to the author"));
  } catch (err) {
    logger.warn({ review: reviewId, sha, detail: (err as Error).message }, "PR review merge gate failed to run");
  } finally {
    mergeGatesRunning.delete(reviewId);
  }
}

/**
 * The author finished a turn with the merge gate red on the approved commit (and the PR still on it): runs
 * the gate again, once per failure and up to {@link MERGE_GATE_AUTO_RETRIES} failures in a row — it is how
 * the fix they made reaches the verdict without anybody clicking. The `autoRetried` mark is recorded inside
 * the mutation, so two turn endings together do not run the gate twice. A push changes the head and reopens
 * the review through the usual path, not through here.
 */
async function retryMergeGateAfterAuthorTurn(r: Review): Promise<void> {
  if (r.phase !== "ready" || !r.reviewedSha) return;
  let claimed = false as boolean;
  await mutateReview(r.id, (x) => {
    const gate = x.mergeGate;
    if (x.phase !== "ready" || !gate || gate.sha !== x.reviewedSha || gate.autoRetried || !mergeGateSelfHealing(gate)) return;
    gate.autoRetried = true;
    claimed = true;
  });
  if (claimed) await checkMergeGate(r.id, { again: true, by: "fim do turno do autor" });
}

/** The system line that tells the result of the reviewer's round. */
function outcomeNote(r: Review): string {
  const blocking = blockingNow(r).length;
  const waiting = pendingQuestions(r.findings).length;
  const questions = waiting ? ` ${waiting} dúvida(s) esperam o revisor humano.` : "";
  switch (r.phase) {
    case "fixing": {
      const improvements = pendingImprovements(r.findings).length;
      const applies = improvements ? ` e ${improvements} melhoria(s) que ele aplica sozinho` : "";
      return `${blocking} bloqueante(s) em aberto${applies}: a lista vai ao autor.${questions}`;
    }
    case "ready":
      return autoMergeEligible(r)
        ? `${waivedText(r) ? `Sem bloqueante (${waivedText(r)})` : "Sem nada em aberto"}: pronto, e o merge sai sozinho.`
        : "Sem bloqueante em aberto: pronto para o merge humano.";
    case "impasse":
      return `Impasse: ${impasseText(r.impasseReason)}.`;
    default:
      return `Esperando o revisor humano decidir ${waiting} dúvida(s).`;
  }
}

/* ------------------------------------------------------------------ iniciar */

/** Serialises "start": the active-review check and the creation count as one single thing. */
let starting: Promise<unknown> = Promise.resolve();
function serialStart<T>(work: () => Promise<T>): Promise<T> {
  const next = starting.then(work, work);
  starting = next.catch(() => undefined);
  return next;
}

/**
 * The card where the fix of an ATTACHED PR runs. A live card of the project (not a reviewer, outside `done`)
 * that already works on the PR's branch is it — including the very card that attached it: two worktrees on
 * the same branch do not coexist in git, and that card already is the place for the fix. Without one, none
 * (the caller creates it).
 */
async function cardOnBranch(projectId: string, branch: string): Promise<Card | undefined> {
  return (await listCards(projectId)).find((c) => !c.reviewOf && c.column !== "done" && cardBranch(c) === branch);
}

/**
 * The FIX CARD of an attached PR that no card works on: a regular project card, visible on the board,
 * in the chosen AUTHOR's Claude account, with the PR's branch as its own (the worktree is born from
 * `origin/<branch>`, and the fix's push lands on the PR) and the PR's base as the target. The PR is
 * recorded on it as if it had delivered it: it is what the deliver, the GitHub check and the PR line read.
 */
async function createFixCard(hub: Card, pr: CardPr, accountSlug: string | undefined): Promise<Card> {
  const fix = await createCard(
    { projectId: hub.projectId, title: `Correção PR #${pr.number} · ${pr.title || hub.title}` },
    { base: pr.base, branch: pr.branch, accountSlug, column: "waiting" },
  );
  await recordCardPr(fix.id, { number: pr.number, url: pr.url, base: pr.base, branch: pr.branch });
  return fix;
}

/** Grants `work` to a person on a card (card share), when they do not have it yet. */
async function ensureWork(userId: string, cardId: string): Promise<void> {
  const user = await findUser(userId);
  if (user && (await cardLevel(user, cardId)) !== "work") {
    await shareWith({ kind: "card", targetId: cardId, userId: user.id, level: "work" });
  }
}

/**
 * Opens the review of the card's PR `prNumber`: creates the reviewer's card (reviewer's Claude account,
 * the PR's branch, hidden from the board) and sends round 1. Refusals with the code in the message, which
 * the route translates into 400: `revisor_igual_autor`, `sem_pr`, `pr_mergeado`, `revisao_ativa`,
 * `revisor_sem_conta`, `autor_sem_conta`.
 *
 * ATTACHED PR (`vibehub_attach_prs`): the fix does not run on the card that attached it, but on the card
 * working on the PR's branch ({@link cardOnBranch}) or, without one, on a new FIX CARD in the author's
 * account ({@link createFixCard}; author without their own Claude account = `autor_sem_conta`). The review
 * records that card as the author's (`cardId`: relays, the author's answer, deliver and the GitHub check go
 * on the same) and the one that attached it in `hubCardId`, from where people follow along.
 */
export async function startReview(input: {
  cardId: string;
  prNumber: number;
  reviewerUserId: string;
  authorUserId: string;
  coauthorUserId?: string;
  mergerUserId: string;
  /** What whoever merges already ordered for the end (`Review.mergeAuthorized`, `Review.concludeWhenMerged`). */
  orders?: ReviewOrders;
  by: string;
}): Promise<Review> {
  const review = await serialStart(async () => {
    if (input.reviewerUserId === input.authorUserId) {
      throw new Error("revisor_igual_autor: quem revisa não pode ser quem corrige");
    }
    const card = await getCard(input.cardId);
    if (!card) throw new Error("card not found");
    const pr = card.prs?.find((p) => p.number === input.prNumber);
    if (!pr) throw new Error(`sem_pr: o card não tem o PR #${input.prNumber}`);
    // An already merged PR has nothing to review: reviewing would spend two AIs on a diff already in the base.
    if (pr.mergedAt !== undefined) throw new Error(`pr_mergeado: o PR #${pr.number} já foi mergeado`);
    // By URL, on any card: the same PR attached to two cards does not get two reviews.
    if (await activeReviewForPr(pr.url)) {
      throw new Error(`revisao_ativa: já existe uma revisão em andamento do PR #${pr.number}`);
    }
    // "Having an account" is having a link, including to the built-in account ("default"): whoever is on it
    // reviews and fixes there. Only someone with no link at all is refused.
    const reviewerAccount = await linkedAccountSlug(input.reviewerUserId);
    if (!reviewerAccount) throw new Error("revisor_sem_conta: o revisor não tem uma conta Claude própria no vibehub");

    let authorCard = card;
    let fixCard: Card | undefined;
    if (pr.attached) {
      const working = await cardOnBranch(card.projectId, pr.branch);
      if (working) {
        authorCard = working;
      } else {
        const authorAccount = await linkedAccountSlug(input.authorUserId);
        if (!authorAccount) {
          throw new Error("autor_sem_conta: o autor não tem uma conta Claude própria no vibehub (a correção roda nela)");
        }
        fixCard = await createFixCard(card, pr, cardAccountSlug(authorAccount));
        authorCard = fixCard;
      }
    }

    let reviewerCard: Card | undefined;
    try {
      reviewerCard = await createReviewerCard({
        authorCard, reviewerAccountSlug: cardAccountSlug(reviewerAccount), prBranch: pr.branch, title: `Revisão PR #${pr.number} · ${pr.title || card.title}`,
      });
      const now = Date.now();
      const fresh: Review = {
        id: randomUUID(),
        cardId: authorCard.id,
        ...(authorCard.id !== card.id ? { hubCardId: card.id } : {}),
        projectId: card.projectId,
        prNumber: pr.number,
        prUrl: pr.url,
        prBranch: pr.branch,
        base: pr.base,
        reviewerUserId: input.reviewerUserId,
        authorUserId: input.authorUserId,
        ...(input.coauthorUserId ? { coauthorUserId: input.coauthorUserId } : {}),
        mergerUserId: input.mergerUserId,
        ...(input.orders?.mergeAuthorized ? { mergeAuthorized: true } : {}),
        ...(input.orders?.concludeWhenMerged ? { concludeWhenMerged: true } : {}),
        reviewerCardId: reviewerCard.id,
        round: 1,
        phase: "reviewing",
        findings: [],
        log: [],
        nudges: 0,
        createdAt: now,
        updatedAt: now,
      };
      note(fresh, "system", `Revisão iniciada: o revisor confere o PR #${pr.number} (rodada 1 de ${MAX_ROUNDS}).`);
      if (input.orders?.mergeAuthorized) {
        note(fresh, "system", "Merge autorizado por quem mergeia: pronta sem bloqueante nem dúvida, o merge sai sozinho (sugestão em pé não segura).");
      }
      if (input.orders?.concludeWhenMerged) note(fresh, "system", "Mergeada, o card que deu a ordem vai para Concluído.");
      if (fixCard) note(fresh, "system", `A correção roda no card "${fixCard.title}", na conta Claude do autor.`);
      else if (authorCard.id !== card.id) note(fresh, "system", `A correção roda no card "${authorCard.title}", que já trabalha a branch do PR.`);
      // The reviewer acts on their card through the relay's `recordCardActor`, which only lands with `work`.
      // Owner and project share already give that; someone who only reaches the author's card gets a `work`
      // share on the reviewer's card — otherwise `gh pr review` would go out on another person's account.
      await ensureWork(input.reviewerUserId, reviewerCard.id);
      // The fix on a card that is not the one that asked: the author (actor at each relay) and the merger
      // (the merge operates on the author's card) need `work` there too — the route only checked the asking card.
      if (authorCard.id !== card.id) {
        await ensureWork(input.authorUserId, authorCard.id);
        await ensureWork(input.mergerUserId, authorCard.id);
      }
      await insertReview(fresh);
      logger.info(
        {
          audit: true, action: "review.start", review: fresh.id, card: authorCard.worktreeSlug, pr: pr.number,
          reviewerCard: reviewerCard.id, ...(fresh.hubCardId ? { hubCard: card.worktreeSlug } : {}), ...(fixCard ? { fixCard: fixCard.id } : {}),
          by: input.by,
        },
        "PR review started",
      );
      return fresh;
    } catch (err) {
      // Without a review, the reviewer's card (and the fix card, if it was just born) is garbage: it was never
      // opened, so it goes away with no session to kill.
      if (reviewerCard) await removeCard(reviewerCard.id).catch(() => undefined);
      if (fixCard) await removeCard(fixCard.id).catch(() => undefined);
      throw err;
    }
  });
  // GitHub does not depend on the relay (nor the relay on it): the two go out together.
  await Promise.all([relayReview(review, "reviewer", reviewerRoundPrompt(review)), namePeopleOnGithub(review)]);
  return (await getReview(review.id)) ?? review;
}

/* ------------------------------------------------------------------ revisor */

/**
 * The reviewer's round (`vibehub_review_submit`). Only the review's reviewer card calls it; a round that is
 * not the current one, or already submitted, returns the review with no effect. Findings go through the model
 * (proof, closed list); verdicts only `fixed|open|dropped`, and never on what a human already closed.
 */
export async function submitReviewerRound(
  reviewerCardId: string,
  payload: {
    round: number;
    findings: SubmittedFinding[];
    verdicts?: { id: string; status: FindingStatus; reviewerReply?: string }[];
    headSha: string;
    summary: string;
    reviewId?: string;
  },
): Promise<Review> {
  const review = await reviewByReviewerCard(reviewerCardId);
  if (!review) {
    throw new Error("este card não é o revisor de nenhuma revisão: passe em `card` o $VIBEHUB_CARD_ID do card do revisor");
  }
  if (payload.reviewId && payload.reviewId !== review.id) {
    throw new Error(`a revisão ${payload.reviewId} não é a deste card de revisor (${review.id})`);
  }
  const fresh = (r: Review) => r.phase === "reviewing" && payload.round === r.round && r.lastSubmitRound !== payload.round;
  if (!fresh(review)) return review;
  const headSha = assertHeadSha(payload.headSha);
  const verdicts = payload.verdicts ?? [];
  const refused = verdicts.filter((v) => !REVIEWER_VERDICTS.has(v.status));
  if (refused.length > 0) {
    throw new Error(
      `veredito inválido (${refused.map((v) => `${v.id}: ${v.status}`).join(", ")}): o revisor só dá fixed, open ou dropped ` +
        "(aceitar a contestação do autor = dropped); risco aceito é decisão humana",
    );
  }

  let landed = false as boolean;
  const after = await mutateReview(review.id, (r) => {
    // Again, inside the queue: another submit of the same round may have landed between the read and here.
    if (!fresh(r)) return;
    // The AI's verdict never undoes a human. Accepted risk and human withdrawal are final: any verdict
    // on them is ignored. A human block (block/keep) is only protected from `dropped` (the AI does not
    // withdraw what a human ordered blocked); `open` and `fixed` count, because the reviewer has to be
    // able to refuse the author's "fixed" on an item a human blocked.
    const overridesHuman = (v: { id: string; status: FindingStatus }) => {
      const f = r.findings.find((x) => x.id === v.id);
      if (!f) return false;
      if (f.status === "accepted_risk" || f.humanDecision === "accept_risk" || f.humanDecision === "drop") return true;
      return (f.humanDecision === "block" || f.humanDecision === "keep") && v.status === "dropped";
    };
    const skipped = verdicts.filter(overridesHuman).map((v) => `${v.id} (${v.status})`);
    const applied = verdicts.filter((v) => !overridesHuman(v));
    const judged = applyReviewerVerdicts(r, applied);
    const added = normalizeSubmittedFindings(payload.findings, r.round, r.findings);
    r.findings = [...judged, ...added];
    r.reviewedSha = headSha;
    r.prHeadSha = headSha;
    r.lastSubmitRound = r.round;
    r.nudges = 0;
    note(r, "reviewer", payload.summary || `Rodada ${r.round}: ${added.length} achado(s) novo(s), ${verdicts.length} veredito(s).`, {
      items: [
        ...applied.map((v) => ({ id: v.id, status: v.status, reply: v.reviewerReply })),
        ...added.map((f) => ({ id: f.id, status: f.status, isNew: true })),
      ],
    });
    if (skipped.length) note(r, "system", `Vereditos ignorados (desfariam uma decisão humana): ${skipped.join(", ")}.`);
    const next = phaseAfterReviewerRound(r);
    r.phase = next.phase;
    if (next.impasseReason) r.impasseReason = next.impasseReason;
    note(r, "system", outcomeNote(r));
    landed = true;
  });
  if (!landed) return after;
  await announceQuestions(after);
  return await dispatch(after);
}

/* ------------------------------------------------------------------ autor */

/** The review the author's card answers: the named one, or the only one waiting for its fix. */
async function authorReview(authorCardId: string, reviewId?: string): Promise<Review> {
  if (reviewId) {
    const r = await getReview(reviewId);
    if (!r || r.cardId !== authorCardId) {
      throw new Error(`a revisão ${reviewId} não é deste card: só o card do autor responde, com o próprio $VIBEHUB_CARD_ID`);
    }
    return r;
  }
  const active = (await listReviewsForCards([authorCardId])).filter((r) => !isReviewClosed(r.phase));
  if (active.length === 0) {
    throw new Error("nenhuma revisão ativa tem este card como autor: passe em `card` o $VIBEHUB_CARD_ID do card do autor");
  }
  const fixing = active.filter((r) => r.phase === "fixing");
  if (fixing.length > 1) throw new Error("mais de uma revisão espera correção neste card: passe `review` com o id");
  return fixing[0] ?? active.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
}

type AuthorAnswer = { id: string; status: AuthorAnswerStatus; commit?: string; reply: string };
const AUTHOR_ANSWERS: ReadonlySet<string> = new Set<AuthorAnswerStatus>(["fixed", "contested", "wontfix"]);

/** A suggestion or improvement that still accepts the author's answer: nobody withdrew it or accepted it as a risk. */
const answerableSuggestion = (f: Finding): boolean =>
  (f.severity === "suggestion" || f.severity === "improvement") && f.status !== "dropped" && f.status !== "accepted_risk";

/** A question the author can resolve or explain: no human decided it, and it is still standing. */
const answerableQuestion = (f: Finding): boolean => pendingQuestions([f]).length > 0;

/** "2 corrigido(s), 1 contestado(s), 1 não vai(ão) aplicar" — only what happened. */
function answerCounts(items: AuthorAnswer[]): string {
  const n = (status: AuthorAnswerStatus) => items.filter((it) => it.status === status).length;
  const parts = [`${n("fixed")} corrigido(s)`, `${n("contested")} contestado(s)`];
  if (n("wontfix")) parts.push(`${n("wontfix")} não vai(ão) aplicar`);
  return parts.join(", ");
}

/**
 * The author's answer (`vibehub_review_respond`). Only the author's card calls it.
 *  - In the fix round (`fixing`), idempotent per round: answers what blocks (fixed or disputed) and,
 *    optionally, the suggestions (fixed, disputed or `wontfix` with the reason); opens the next round,
 *    with the delta to the reviewer.
 *  - Outside it, with the review open (including `ready`, when somebody told the AI to apply the
 *    suggestions): only the answers to SUGGESTIONS count — they close the item on the panel, without
 *    opening a round and without sending anything to anybody (a push that came along is caught by the
 *    GitHub check). The same answer again does not record another message.
 * An answer to an unknown id, to a closed item or to a blocking one outside the round goes to the log,
 * without bringing down the rest. `wontfix` on a blocking one and disputing/not applying without a reason
 * are refused before anything is touched.
 */
export async function submitAuthorResponse(
  authorCardId: string,
  payload: { round: number; items: AuthorAnswer[]; headSha: string; reviewId?: string },
): Promise<Review> {
  const review = await authorReview(authorCardId, payload.reviewId);
  if (isReviewClosed(review.phase)) return review;
  const bad = payload.items.filter((it) => !AUTHOR_ANSWERS.has(it.status));
  if (bad.length) {
    throw new Error(`status inválido (${bad.map((it) => it.id).join(", ")}): o autor responde fixed, contested ou wontfix`);
  }
  const headSha = assertHeadSha(payload.headSha);
  // A requested suggestion left unanswered loses its mark on the reviewer's next verdict and becomes a choice
  // on the panel again: the person would send it again. Whoever answered answers all the ones they got.
  const answeredIds = new Set(payload.items.map((it) => it.id));
  const unanswered = review.findings.filter((f) => f.requested && f.status === "open" && !answeredIds.has(f.id)).map((f) => f.id);
  if (unanswered.length) {
    throw new Error(
      `sugestao_sem_resposta: ${unanswered.join(", ")} ${unanswered.length === 1 ? "foi pedida" : "foram pedidas"} a você e ` +
        "precisa de resposta nesta mesma chamada (fixed com o commit, ou wontfix com o motivo)",
    );
  }
  const fresh = (r: Review) => r.phase === "fixing" && payload.round === r.round && r.lastRespondRound !== payload.round;
  // The improvement is the author's turn: a round that closed without answering it would leave it pending,
  // and the next phase would give the turn to the author again for the same improvement. Whoever answers the round answers them all.
  const skipped = fresh(review) ? pendingImprovements(review.findings).filter((f) => !answeredIds.has(f.id)).map((f) => f.id) : [];
  if (skipped.length) {
    throw new Error(
      `melhoria_sem_resposta: ${skipped.join(", ")} precisa de resposta nesta mesma chamada ` +
        "(fixed com o commit, ou wontfix com o motivo)",
    );
  }
  // In the round, what blocks and the suggestions count; outside it, only the suggestions. The rest goes to the log.
  const answerableIn = (r: Review) => {
    const round = fresh(r);
    const known = new Map(r.findings.map((f) => [f.id, f]));
    return (it: AuthorAnswer) => {
      const f = known.get(it.id);
      return !!f && (answerableSuggestion(f) || answerableQuestion(f) || (round && actionableForAuthor(f)));
    };
  };
  // The refusals apply before the mutation, and only to what it will accept: a malformed answer to an
  // item that would be ignored does not bring down the others.
  applyAuthorResponses(review, payload.items.filter(answerableIn(review)));

  let opened = false as boolean;
  const after = await mutateReview(review.id, (r) => {
    if (isReviewClosed(r.phase)) return;
    const round = fresh(r);
    const known = new Map(r.findings.map((f) => [f.id, f]));
    const answerable = answerableIn(r);
    // Outside the round, the same answer again does not record another message.
    const changed = (it: AuthorAnswer) => {
      const f = known.get(it.id)!;
      return f.status !== it.status || f.authorReply !== it.reply || (it.commit !== undefined && f.commit !== it.commit);
    };
    const allowed = payload.items.filter((it) => answerable(it) && (round || changed(it)));
    const ignored = payload.items.filter((it) => !answerable(it)).map((it) => it.id);
    if (!round && allowed.length === 0 && ignored.length === 0) return;
    // Outside the round, an answer to a QUESTION with the review waiting for a decision: the reviewer checks
    // (next round, or an extra check of the last one) instead of the question sitting there waiting for people.
    const doubts = !round && r.phase === "reviewing" && r.lastSubmitRound === r.round &&
      allowed.some((it) => known.get(it.id)!.severity === "question");
    if (allowed.length || round) {
      r.findings = applyAuthorResponses(r, allowed);
      r.prHeadSha = headSha;
      const what = round ? "" : doubts ? "Dúvidas e sugestões respondidas: " : "Sugestões respondidas: ";
      note(r, "author", `${what}${answerCounts(allowed)}; head ${headSha.slice(0, 7)}.`, { items: allowed });
    }
    if (ignored.length) {
      note(r, "system", round
        ? `Respostas ignoradas (id desconhecido ou item que não espera resposta do autor): ${ignored.join(", ")}.`
        : `Fora da rodada de correção só as respostas a sugestões valem; ignoradas: ${ignored.join(", ")}.`);
    }
    if (doubts) {
      if (r.round < MAX_ROUNDS) r.round += 1;
      else r.lastSubmitRound = r.round - 1;
      note(r, "system", `O autor respondeu dúvida: rodada ${r.round} de ${MAX_ROUNDS}, o revisor confere.`);
      opened = true;
      return;
    }
    if (!round) return;
    r.lastRespondRound = r.round;
    r.nudges = 0;
    r.round += 1;
    r.phase = "reviewing";
    note(r, "system", `Rodada ${r.round} de ${MAX_ROUNDS}: o revisor confere só o diff.`);
    opened = true;
  });
  if (!opened) return after;
  await relayReview(after, "reviewer", reviewerDeltaPrompt(after));
  return (await getReview(after.id)) ?? after;
}

/* ------------------------------------------------------------------ humano */

/**
 * A person decided, on the panel, what to do with the reviewer's suggestions (`POST
 * /api/reviews/:id/suggestions`; who may is the route's call): `apply` goes to the author to apply, `skip`
 * leaves the list ("não fazer" — withdrawn by human decision, like a question's `drop`). Only open
 * suggestions, and none on both sides; a closed review refuses. The delivery to the author comes before any
 * record: if it fails, nothing changes and the reason comes back. The author applies, pushes and answers item
 * by item (`fixed`/`wontfix`); the push after ready sends the review back to the reviewer, who checks.
 */
export async function decideSuggestions(
  reviewId: string, choice: { apply?: string[]; skip?: string[] }, by: string,
): Promise<Review> {
  const review = await getReview(reviewId);
  if (!review) throw new Error("review not found");
  if (isReviewClosed(review.phase)) throw new Error(`revisao_encerrada: a revisão já está em ${review.phase}`);
  const apply = [...new Set(choice.apply ?? [])];
  const skip = [...new Set(choice.skip ?? [])];
  const open = new Set(review.findings.filter((f) => f.severity === "suggestion" && f.status === "open").map((f) => f.id));
  const all = [...apply, ...skip];
  if (all.length === 0 || all.some((id) => !open.has(id)) || apply.some((id) => skip.includes(id))) {
    throw new Error("sem_sugestao: escolha sugestões em aberto da revisão, cada uma para fazer ou para não fazer");
  }
  // Already requested and the author has not answered yet: sending it again only duplicates their work.
  // "Não fazer" still applies (the person changed their mind).
  const again = review.findings.filter((f) => apply.includes(f.id) && f.requested).map((f) => f.id);
  if (again.length) {
    throw new Error(`ja_pedida: ${again.join(", ")} já ${again.length === 1 ? "foi pedida" : "foram pedidas"} ao autor, que ainda não respondeu`);
  }
  if (apply.length) {
    const chosen = review.findings.filter((f) => apply.includes(f.id));
    const text = authorSuggestionsPrompt(review, chosen, { by, coauthorTrailer: await coauthorTrailer(review) });
    await relayReview(review, "author", text, { unpause: true, optional: true });
  }
  logger.info({ audit: true, action: "review.suggestions", review: reviewId, apply, skip, by }, "PR review: suggestions decided");
  const after = await mutateReview(reviewId, (r) => {
    if (skip.length) {
      for (const f of r.findings) {
        if (!skip.includes(f.id) || f.status !== "open") continue;
        f.status = "dropped";
        f.humanDecision = "drop";
        // Withdrawn, it is no longer with the author (even if it was requested before).
        delete f.requested;
      }
      note(r, "human", `Não fazer ${skip.length === 1 ? "a sugestão" : "as sugestões"} ${skip.join(", ")}.`, {
        items: skip.map((id) => ({ id, status: "dropped" as const })), by,
      });
    }
    if (apply.length) {
      const at = Date.now();
      for (const f of r.findings) if (apply.includes(f.id) && f.status === "open") f.requested = { by, at };
      note(r, "human", `Pediu ao autor aplicar ${apply.length === 1 ? "a sugestão" : "as sugestões"} ${apply.join(", ")}.`, {
        items: apply.map((id) => ({ id, status: "open" as const })), by,
      });
    }
  });
  // "Não fazer" on the last suggestion of a review the reviewer ALREADY approved: nothing is left standing
  // and the turn ending that would fire the merge has already passed. No waiting: it is a person's click, not CI.
  if (skip.length && apply.length === 0 && autoMergeEligible(after) && (await reviewerApproved(after))) {
    void autoMerge(after);
  }
  return after;
}

/** O revisor terminou o turno do Approve: o card dele parou declarando `ready` (o passo final do prompt). */
async function reviewerApproved(r: Review): Promise<boolean> {
  const card = await getCard(r.reviewerCardId);
  return card?.declaredState === "ready" && card.status !== "working";
}

/** "Fazer" only: the chosen suggestions go to the author ({@link decideSuggestions}). */
export async function requestSuggestions(reviewId: string, findingIds: string[], by: string): Promise<Review> {
  return await decideSuggestions(reviewId, { apply: findingIds }, by);
}

/**
 * The HUMAN reviewer's decision on an item: a question (`question`) or a stuck blocking one.
 *  - question: `block` (becomes blocking), `drop` (withdrawn) or `accept_risk`; `keep` does not apply here.
 *  - blocking: `keep`/`block` (keeps blocking; the dev resolves it), `accept_risk` or `drop`.
 * In `reviewing` with the reviewer's round already delivered, the phase is recomputed (author, Approve or impasse).
 * In `impasse` with the reviewer's round delivered, for whatever reason, it moves to `ready` when the last
 * stuck item is released; without it, it only records (the way out is `retryReview`). Otherwise, it only records.
 */
export async function decideQuestion(reviewId: string, findingId: string, decision: Decision, by: string): Promise<Review> {
  if (!["block", "drop", "keep", "accept_risk"].includes(decision)) throw new Error(`decisão inválida: ${String(decision)}`);
  let recompute = false as boolean;
  const after = await mutateReview(reviewId, (r) => {
    if (r.phase !== "reviewing" && r.phase !== "fixing" && r.phase !== "impasse") {
      throw new Error(`a revisão está em ${r.phase}: não há decisão pendente`);
    }
    const f = r.findings.find((x) => x.id === findingId);
    if (!f) throw new Error(`achado desconhecido: ${findingId}`);
    if (f.severity !== "question" && f.severity !== "blocking") {
      throw new Error(`o achado ${findingId} é ${f.severity}: não espera decisão`);
    }
    if (f.severity === "question" && decision === "keep") {
      throw new Error(`keep vale para bloqueante travado; na dúvida ${findingId} decida block, drop ou accept_risk`);
    }
    f.humanDecision = decision;
    if (decision === "accept_risk") f.status = "accepted_risk";
    else if (decision === "drop") f.status = "dropped";
    else if (f.status === "dropped" || f.status === "accepted_risk") f.status = "open";
    const said: Record<Decision, string> = { block: "bloqueia", keep: "mantém o bloqueio", drop: "retira", accept_risk: "aceita o risco" };
    note(r, "human", `Decisão humana em ${findingId}: ${said[decision]}.`, { items: [{ id: f.id, status: f.status }], by });

    if (r.phase === "reviewing") {
      // In the middle of the reviewer's round, what closes the phase is their submit.
      if (r.lastSubmitRound !== r.round) return;
      const next = phaseAfterReviewerRound(r);
      if (next.phase === r.phase) return;
      r.phase = next.phase;
      if (next.impasseReason) r.impasseReason = next.impasseReason;
    } else if (r.phase === "impasse") {
      // Without the reviewer's check in this round, the author's "fixed" is their word: going to ready
      // here would ask for an Approve of code nobody looked at (and a "fixed" without a commit would merge
      // the bug). The decision stays recorded; the way out is "tentar de novo", and the reviewer's submit honours it.
      if (r.lastSubmitRound !== r.round) return;
      // With the round checked, the impasse (for whatever reason) leaves with the last released item;
      // "manter" holds it (the dev resolves it by hand; the rest leaves through retryReview).
      if (phaseAfterReviewerRound(r).phase !== "ready") return;
      r.phase = "ready";
      r.impasseReason = undefined;
    } else {
      return;
    }
    note(r, "system", outcomeNote(r));
    recompute = true;
  });
  logger.info({ audit: true, action: "review.decide", review: reviewId, finding: findingId, decision, by }, "PR review decision recorded");
  return recompute ? await dispatch(after) : after;
}

/**
 * The panel's "Tentar de novo": the way out of an impasse that is not about rounds (a send that failed, an
 * AI that did not answer), of the Approve that did not arrive and of a stalled turn. Resets the reminders,
 * clears the reason and gives the turn back to whoever is due: `reviewing` if the reviewer's round was not
 * delivered, otherwise `fixing`; in `ready` it resends the Approve request.
 * In `reviewing`/`fixing` waiting for that side's tool, it resends the turn's text without changing the phase:
 * the turn ending the orchestrator does not judge (a person using the card, an agent that declared needs_me)
 * has no deadline, and without this the only way out of a stalled AI would be cancelling the whole review.
 * Does not take anybody out of Paused (whoever paused unpauses and tries again). Any other state (including
 * `reviewing` waiting for the human decision on questions) throws `nada_a_tentar`. Who may is the route's call.
 */
export async function retryReview(reviewId: string, by: string): Promise<Review> {
  let side = null as Side | "approve" | "gate" | null;
  const after = await mutateReview(reviewId, (r) => {
    if (r.phase === "ready" && r.approvePending) {
      side = "approve";
    } else if (r.phase === "ready" && r.mergeGate?.sha === r.reviewedSha && r.mergeGate?.state === "failed") {
      side = "gate";
      // A human order: the count of automatic retries starts over (a red again goes back to the author).
      r.mergeGate.failures = 0;
      note(r, "human", "Tentar de novo: os testes do merge rodam de novo no commit aprovado.", { by });
      return;
    } else if (r.phase === "impasse" && r.impasseReason !== "rodadas" && r.impasseReason !== HEAD_MOVED) {
      // "rodadas" and "push depois do pronto" have no turn to give back (the last round is over): the human
      // reviewer decides the items, or cancels and asks for a new review.
      r.phase = r.lastSubmitRound !== r.round ? "reviewing" : "fixing";
      side = r.phase === "reviewing" ? "reviewer" : "author";
    } else if (awaitingTool(r, "reviewer")) {
      side = "reviewer";
    } else if (awaitingTool(r, "author")) {
      side = "author";
    } else {
      throw new Error(
        `nada_a_tentar: a revisão está em ${r.phase}${r.impasseReason ? ` (${r.impasseReason})` : ""}; ` +
          "só impasse por falha/IA sem resposta, Approve pendente, testes do merge vermelhos ou uma vez de IA parada têm o que tentar de novo",
      );
    }
    r.nudges = 0;
    r.impasseReason = undefined;
    note(r, "human", side === "approve" ? "Tentar de novo: o pedido de Approve volta ao revisor." :
      `Tentar de novo: a vez volta ao ${side === "reviewer" ? "revisor" : "autor"} (rodada ${r.round} de ${MAX_ROUNDS}).`, { by });
  });
  logger.info({ audit: true, action: "review.retry", review: reviewId, side, by }, "PR review retried");
  if (side === "gate") void checkMergeGate(reviewId, { again: true, by });
  else if (side === "approve") await relayReview(after, "reviewer", reviewerApprovePrompt(after), { approve: true });
  else if (side) await relayReview(after, side, await promptFor(after, side));
  return (await getReview(reviewId)) ?? after;
}

/**
 * The review closed (`merged` or `cancelled`): the reviewer's card goes to `done`, the same write as dragging
 * on the board. Hidden from the board, nobody would see or delete it, and each review would leave a worktree
 * (plus whatever the AI installed to test) on the runner; in `done`, hibernation and retention take care of it
 * like any card. The review's history (findings and conversation) lives in the reviews store, not on the card.
 * Never throws: a card that is gone, or a write that failed, costs the cleanup, not closing the review.
 */
async function retireReviewerCard(r: Review): Promise<void> {
  await moveCardToDone(r, r.reviewerCardId, "reviewer card");
}

/**
 * Moves a review card to `done`, the same write as dragging on the board. A card that is gone or already
 * there: nothing. Never throws: the review is already closed, and a write that failed costs only the column.
 */
async function moveCardToDone(r: Review, cardId: string, what: string): Promise<void> {
  try {
    const card = await getCard(cardId);
    if (!card || card.column === "done") return;
    await updateCard(card.id, { column: "done" });
    logger.info({ audit: true, review: r.id, card: card.worktreeSlug, phase: r.phase }, `${what} moved to done`);
  } catch (err) {
    logger.warn({ review: r.id, card: cardId, detail: (err as Error).message }, `could not move the ${what} to done`);
  }
}

/**
 * Cancels the review, from any active phase. `cancelled` is not active (`activeReviewFor`), so the same PR
 * can be reviewed again. The reviewer's card goes to `done` (`retireReviewerCard`); the history stays in
 * the review.
 */
export async function cancelReview(reviewId: string, by: string): Promise<Review> {
  const after = await mutateReview(reviewId, (r) => {
    if (isReviewClosed(r.phase)) throw new Error(`revisao_encerrada: a revisão já está em ${r.phase}`);
    r.phase = "cancelled";
    r.approvePending = undefined;
    note(r, "human", "Revisão cancelada.", { by });
  });
  lastGithubSync.delete(reviewId);
  logger.info({ audit: true, action: "review.cancel", review: reviewId, by }, "PR review cancelled");
  await retireReviewerCard(after);
  return after;
}

/**
 * Cancels the review for a SYSTEM reason (one side's card was deleted, the PR was closed on GitHub): the
 * message in the log and the audit line. Idempotent — an already closed review stays as it is.
 */
async function cancelBySystem(
  reviewId: string, text: string, audit: Record<string, unknown>,
): Promise<{ review: Review; cancelled: boolean }> {
  let cancelled = false as boolean;
  const review = await mutateReview(reviewId, (x) => {
    if (isReviewClosed(x.phase)) return;
    x.phase = "cancelled";
    x.approvePending = undefined;
    note(x, "system", text);
    cancelled = true;
  });
  if (cancelled) logger.info({ audit: true, action: "review.cancel", review: reviewId, ...audit }, "PR review cancelled");
  lastGithubSync.delete(reviewId);
  return { review, cancelled };
}

/**
 * A card left the board (the delete button, `done` retention, the project deleted). Every ACTIVE review in
 * which it is the author or the reviewer is cancelled: without the card, no relay arrives and "tentar de novo"
 * would have nowhere to go. Returns the reviewer cards of the reviews in which it was the AUTHOR, of any phase,
 * so whoever deletes takes them along: without the author, the reviewer's card is just a hidden worktree.
 * Idempotent.
 */
export async function closeReviewsOfRemovedCard(cardId: string, by?: string): Promise<string[]> {
  const asAuthor = await listReviewsForCards([cardId]);
  const asReviewer = await reviewByReviewerCard(cardId);
  for (const r of [...asAuthor, ...(asReviewer ? [asReviewer] : [])]) {
    if (isReviewClosed(r.phase)) continue;
    const side = r.cardId === cardId ? "autor" : "revisor";
    await cancelBySystem(r.id, `Revisão cancelada: o card do ${side} foi excluído.`, { reason: `${side} card removed`, card: cardId, by });
  }
  return [...new Set(asAuthor.map((r) => r.reviewerCardId))].filter((id) => id !== cardId);
}

/* ------------------------------------------------------------------ merge humano */

/**
 * The PR moved after `ready`: the merge button found the PR on a commit that is not the reviewed one
 * (`cause: "merge"`), or the author's turn ended with a new push on the PR (`cause: "push"`,
 * {@link checkAuthorPush}). In a single mutation, the review goes back to `reviewing` and the reviewer gets
 * the delta (since the approved `reviewedSha`) through the same relay as the other rounds: in the next round,
 * or — with no round left — in an extra check of the last one (a blocking finding found there becomes an
 * impasse through the cap on rounds, as always). It only acts in `ready`: the merge takes
 * minutes (CI), and a review that moved or was cancelled in between stays as it is. `headSha` (the head
 * read) holds off a stale read: if the review already approved that commit, there is nothing to reopen.
 */
export async function reopenAfterHeadMoved(
  reviewId: string, by: string, opts: { cause?: "merge" | "push"; headSha?: string } = {},
): Promise<Review> {
  const cause = opts.cause ?? "merge";
  const head = opts.headSha?.toLowerCase();
  let reopened = false as boolean;
  const after = await mutateReview(reviewId, (r) => {
    if (r.phase !== "ready") return;
    if (head && r.reviewedSha === head) return;
    const approved = r.reviewedSha ? ` (${r.reviewedSha.slice(0, 7)})` : "";
    const why = cause === "push"
      ? `O autor empurrou depois do pronto${head ? ` (head ${head.slice(0, 7)})` : ""}: ${HEAD_MOVED}; o PR não está mais no commit aprovado${approved}.`
      : `Merge recusado: ${HEAD_MOVED}; o PR não está mais no commit aprovado${approved}.`;
    r.approvePending = undefined;
    r.nudges = 0;
    r.phase = "reviewing";
    if (r.round < MAX_ROUNDS) {
      r.round += 1;
      note(r, "system", `${why} Rodada ${r.round} de ${MAX_ROUNDS}: o revisor confere o que entrou.`);
    } else {
      // With no round left, the reviewer still checks what came in (applying suggestions after ready must not
      // lock the PR): the last round reopens for them. If they find a blocking one, the cap on rounds applies
      // as always — impasse.
      r.lastSubmitRound = r.round - 1;
      note(r, "system", `${why} Rodada ${r.round} de ${MAX_ROUNDS} (conferência extra): o revisor confere o que entrou.`);
    }
    reopened = true;
  });
  logger.info({ audit: true, action: "review.head_moved", review: reviewId, cause, reopened, by }, "PR review: head moved after ready");
  if (reopened) await relayReview(after, "reviewer", headMovedPrefix(after, cause) + reviewerDeltaPrompt(after));
  return (await getReview(reviewId)) ?? after;
}

/**
 * The PR on GitHub, checked against the review: what happened there OUTSIDE the panel, which no click
 * reported here.
 *  - MERGED: merged by hand, or by an AI through the API — the review closes as merged (the same
 *    `markReviewMerged` as the button: a notice on both cards, the reviewer's card to `done`), the card's PR
 *    gets `mergedAt` and its branch leaves GitHub (the work is already in the base).
 *  - CLOSED without merge: the review is cancelled (there is nothing left to review or merge).
 *  - OPEN with a head different from the approved one, in `ready`: somebody told the author's AI to change
 *    the PR and it pushed — the review goes back to the reviewer right away ({@link reopenAfterHeadMoved}),
 *    without waiting for the merge click to find out. In `fixing`, a push is the answer to the list: nothing changes.
 * Only an open review goes to GitHub. Never throws: a read that fails leaves the review as it is.
 */
export async function syncReviewWithGithub(reviewId: string, by = "conferência do GitHub"): Promise<Review | undefined> {
  const r = await getReview(reviewId);
  // With the button's merge in progress, the PR shows up MERGED before the button closes the review: it is
  // the button that closes it (with the name of whoever merged), not this check.
  if (!r || isReviewClosed(r.phase) || merging.has(r.id)) return r;
  const pr = await readPrState(r.cardId, r.prUrl);
  if (!pr || merging.has(r.id)) return r;
  if (pr.state === "MERGED") {
    const after = await markReviewMerged(r.id, "GitHub", { outsidePanel: { headSha: pr.headSha } });
    await afterPrMerged(r.cardId, r.prUrl, r.base, r.prBranch);
    return after;
  }
  if (pr.state === "CLOSED") {
    const { review: after, cancelled } = await cancelBySystem(
      r.id, `PR #${r.prNumber} fechado no GitHub sem merge: revisão cancelada.`, { reason: "PR closed on GitHub" },
    );
    if (cancelled) await retireReviewerCard(after);
    return after;
  }
  // `gh pr view` takes seconds: if somebody recorded a head in the meantime (the author on answering), theirs
  // is the newest — the read from here does not overwrite it.
  const seen = r.prHeadSha === pr.headSha ? r : await mutateReview(r.id, (x) => {
    if (!isReviewClosed(x.phase) && x.prHeadSha === r.prHeadSha) x.prHeadSha = pr.headSha;
  });
  if (seen.phase === "ready" && seen.reviewedSha && pr.headSha !== seen.reviewedSha) {
    return await reopenAfterHeadMoved(r.id, by, { cause: "push", headSha: pr.headSha });
  }
  return seen;
}

/** Reviews with a merge in progress (the button, or the owner's deliver): one at a time. */
const merging = new Set<string>();

/** Takes this review's merge turn; false = there is already one in progress. Give it back with {@link releaseMerge}. */
export function claimMerge(reviewId: string): boolean {
  if (merging.has(reviewId)) return false;
  merging.add(reviewId);
  return true;
}

export function releaseMerge(reviewId: string): void {
  merging.delete(reviewId);
}

/** How often, at most, an open panel makes the server check the PR on GitHub. */
const GITHUB_SYNC_MS = 60_000;
const lastGithubSync = new Map<string, number>();

/**
 * The panel read the review: checks the PR on GitHub in the background, at most once per
 * {@link GITHUB_SYNC_MS} per review — the panel rereads every 3 s and one `gh` per read would be
 * waste. It is what catches a merge done directly on GitHub even without any author turn.
 */
export function syncReviewSoon(r: Review): void {
  if (isReviewClosed(r.phase)) {
    lastGithubSync.delete(r.id);
    return;
  }
  if (!claimGithubSync(r.id)) return;
  void syncReviewWithGithub(r.id, "painel aberto").catch((err: unknown) => {
    logger.warn({ review: r.id, detail: (err as Error).message }, "PR review could not sync with GitHub");
  });
}

/**
 * The review for the panel's READ, along with whether a merge of it is running now (`merging`).
 *
 * `merging: false` with the review in `ready` is what makes the panel stop waiting for a merge whose
 * answer got lost — so the phase that goes along has to be at least as new as the lock:
 *  - the lock is looked at first and the review is reread afterwards. A merge that ends between the first
 *    read and the lock has already recorded `merged` (the merge records before releasing the lock);
 *  - a merge that went out on GitHub and died before recording `merged` (a deploy in the middle: `gh pr merge`
 *    runs, the process dies, the lock goes with it) only shows up on GitHub. That is why, in `ready` with no
 *    merge running, the GitHub check runs BEFORE answering (under the same throttle of
 *    {@link GITHUB_SYNC_MS}); the new process after the deploy has no throttle, and the first read
 *    already returns `merged`.
 * The other phases go on with the background check ({@link syncReviewSoon}). Never throws.
 */
export async function reviewForRead(r: Review): Promise<{ review: Review; merging: boolean }> {
  if (merging.has(r.id)) return { review: r, merging: true };
  if (r.phase !== "ready") {
    syncReviewSoon(r);
    return { review: r, merging: false };
  }
  let now: Review | undefined;
  try {
    now = claimGithubSync(r.id) ? await syncReviewWithGithub(r.id, "painel aberto") : await getReview(r.id);
  } catch (err) {
    logger.warn({ review: r.id, detail: (err as Error).message }, "PR review could not sync with GitHub");
    now = await getReview(r.id);
  }
  const review = now ?? r;
  // A ready review with no gate verdict on the approved commit (ready before this code, or the gate
  // died in a deploy): runs it now, in the background; the panel shows "rodando" until the end.
  void checkMergeGate(review.id);
  return { review, merging: merging.has(review.id) };
}

/** Marks the check as happening now, if the last one was more than {@link GITHUB_SYNC_MS} ago. Returns whether it may go. */
function claimGithubSync(reviewId: string): boolean {
  const now = Date.now();
  if (now - (lastGithubSync.get(reviewId) ?? 0) < GITHUB_SYNC_MS) return false;
  lastGithubSync.set(reviewId, now);
  return true;
}

/**
 * The end of the AUTHOR card's turn: each of its open reviews is checked on GitHub — in `ready` always
 * (a push there sends the review back to the reviewer, and that has to show up at once), in the other phases
 * at most once per {@link GITHUB_SYNC_MS} (there a push is the answer to the list; what matters is catching a
 * merge or a close done from outside). Never throws.
 */
async function checkAuthorPush(cardId: string): Promise<void> {
  for (const r of await listReviewsForCards([cardId])) {
    if (isReviewClosed(r.phase)) continue;
    if (r.phase === "ready") lastGithubSync.set(r.id, Date.now());
    else if (!claimGithubSync(r.id)) continue;
    await syncReviewWithGithub(r.id, "fim do turno do autor");
  }
}

/**
 * The human merge went out: the review closes as `merged` (stops being active), both cards get the notice
 * and the reviewer's card goes to `done`. Records even if the review was cancelled during the merge — the
 * PR was merged, and that is what the panel has to say. Repeating records nothing and does not notify again.
 */
export async function markReviewMerged(
  reviewId: string, by: string, opts: { outsidePanel?: { headSha: string }; auto?: boolean } = {},
): Promise<Review> {
  let landed = false as boolean;
  const after = await mutateReview(reviewId, (r) => {
    if (r.phase === "merged") return;
    r.phase = "merged";
    r.approvePending = undefined;
    r.impasseReason = undefined;
    if (opts.outsidePanel) {
      // Nobody clicked the button: the PR showed up merged on GitHub (by hand, or by an AI through the API).
      note(r, "system", `Mergeado em ${r.base} fora do painel, direto no GitHub (head ${opts.outsidePanel.headSha.slice(0, 7)}).`);
    } else {
      const head = r.reviewedSha ? ` (head ${r.reviewedSha.slice(0, 7)})` : "";
      if (opts.auto) {
        note(r, "system", `Mergeado em ${r.base} automaticamente, em nome de ${by}${head}: ${waivedText(r) ?? "nada ficou em aberto"}.`);
      }
      else note(r, "human", `Mergeado em ${r.base} por ${by}${head}.`, { by });
    }
    landed = true;
  });
  lastGithubSync.delete(reviewId);
  if (landed) {
    logger.info({ audit: true, action: "review.merged", review: reviewId, by, auto: opts.auto === true }, "PR review merged");
    // The card that attached the PR also sees it merged (its line goes away). Best-effort: the merge already happened.
    if (after.hubCardId) {
      await markCardPrMerged(after.hubCardId, after.base, after.prNumber, Date.now()).catch((err: unknown) =>
        logger.warn({ review: reviewId, card: after.hubCardId, detail: (err as Error).message }, "could not mark the attached PR as merged"));
    }
    await announcePhase(after);
    await retireReviewerCard(after);
    // "...e concluir o card": the card that gave the order, the one that attached the PR, or the author's when it is the same.
    if (after.concludeWhenMerged) await moveCardToDone(after, after.hubCardId ?? after.cardId, "ordering card");
  }
  return after;
}

/* ------------------------------------------------------------------ fim de turno */

/**
 * Why this turn ending does NOT count as "finished without the tool", or null if it counts. The fallback only
 * demands turns the relay opened; with no origin on the event, these signals say the turn was about something
 * else: a person using the card right now, the agent that declared it needs them, or an open question/
 * permission waiting for somebody.
 */
async function notJudged(event: CardEvent): Promise<string | null> {
  const card = await getCard(event.cardId);
  if (!card) return "card sumiu";
  if (isHumanActive(card)) return "pessoa usando o card";
  const declared = event.state ?? card.declaredState;
  if (declared === "needs_me" || declared === "blocked") return `agente declarou ${declared}`;
  if (card.awaitingDecisionAt || card.pendingQuestionAt) return "pergunta ou permissão em aberto";
  const open = (await eventsAfter(0)).events.some(
    (e) => e.cardId === card.id && !e.resolvedAt && (e.kind === "question" || e.kind === "permission"),
  );
  return open ? "pergunta ou permissão em aberto" : null;
}

/**
 * A card finished its turn. If it is a side the review was waiting for (reviewer in `reviewing` without the
 * round's submit, author in `fixing` without the answer) and the turn is not about something else (`notJudged`),
 * it is "finished without calling the tool": the first time it resends the turn's text with the reminder in
 * front (without taking anybody out of Paused); the second becomes the impasse "IA não respondeu".
 * The decision is taken inside the mutation, so two turn endings together do not remind twice.
 */
async function onTurnFinished(event: CardEvent): Promise<void> {
  const cardId = event.cardId;
  const waiting: { id: string; side: Side }[] = [];
  const asReviewer = await reviewByReviewerCard(cardId);
  // The reviewer finished the Approve turn (the prompt says to report `ready` at the end): it is the turn of
  // the automatic merge, if nothing was left standing. Outside the path of their tool — here nobody waits for CI.
  if (asReviewer?.phase === "ready" && event.state === "ready") await autoMerge(asReviewer);
  if (asReviewer && awaitingTool(asReviewer, "reviewer")) waiting.push({ id: asReviewer.id, side: "reviewer" });
  for (const r of await listReviewsForCards([cardId])) {
    if (awaitingTool(r, "author")) waiting.push({ id: r.id, side: "author" });
    void retryMergeGateAfterAuthorTurn(r);
  }
  if (waiting.length === 0) return;
  const skip = await notJudged(event);
  if (skip) {
    logger.info({ card: cardId, reviews: waiting.map((w) => w.id), reason: skip }, "PR review: finished turn not judged");
    return;
  }
  for (const { id, side } of waiting) {
    let action = null as "nudge" | "impasse" | null;
    const tool = side === "reviewer" ? TOOL_SUBMIT : TOOL_RESPOND;
    const after = await mutateReview(id, (r) => {
      if (!awaitingTool(r, side)) return;
      if (r.nudges >= 1) {
        r.phase = "impasse";
        r.impasseReason = NO_ANSWER;
        note(r, "system", `Impasse: a IA do ${side === "reviewer" ? "revisor" : "autor"} terminou o turno de novo sem chamar ${tool}.`);
        action = "impasse";
      } else {
        r.nudges += 1;
        note(r, "system", `A IA do ${side === "reviewer" ? "revisor" : "autor"} terminou o turno sem chamar ${tool}: lembrete enviado.`);
        action = "nudge";
      }
    });
    if (action === "nudge") await relayReview(after, side, nudgePrefix(tool) + (await promptFor(after, side)));
    else if (action === "impasse") await announcePhase(after);
  }
}

/**
 * Hooks the orchestrator to the cards' event feed (once, at boot). The listener does not throw and does not
 * block: it only schedules the judgement (and the check of the author's push after ready) for after a short
 * grace period — the tool call that arrived in the same turn wins — and swallows any error with a warn.
 * Returns the unsubscribe.
 */
export function startReviewOrchestrator(opts: { graceMs?: number } = {}): () => void {
  const graceMs = opts.graceMs ?? TURN_GRACE_MS;
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  const off = onCardEvent((event: CardEvent) => {
    if (stopped || event.kind !== "turn_finished") return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      void onTurnFinished(event).catch((err: unknown) => {
        logger.warn({ card: event.cardId, detail: (err as Error).message }, "PR review could not judge a finished turn");
      });
      void checkAuthorPush(event.cardId).catch((err: unknown) => {
        logger.warn({ card: event.cardId, detail: (err as Error).message }, "PR review could not check the author's push");
      });
    }, graceMs);
    timer.unref?.();
    timers.add(timer);
  });
  return () => {
    stopped = true;
    off();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}

/**
 * Short answer of the MCP tools: whether the requested round is recorded, where the review is and what the
 * AI does now. A round that did not take (wrong, review in another phase) says whose turn it really is,
 * instead of an "ok" that would make the AI think it delivered.
 */
export function reviewToolAnswer(r: Review, side: Side, askedRound: number): Record<string, unknown> {
  const registered = side === "reviewer" ? r.lastSubmitRound === askedRound : r.lastRespondRound === askedRound;
  const tool = side === "reviewer" ? TOOL_SUBMIT : TOOL_RESPOND;
  let next: string;
  if (awaitingTool(r, side)) next = `a vez é sua: rodada ${r.round}; chame ${tool} com round: ${r.round}`;
  else if (r.phase === "reviewing") {
    next = r.lastSubmitRound === r.round ? "esperando o revisor humano decidir as dúvidas" : "a vez é do revisor";
  } else if (r.phase === "fixing") next = "a vez é do autor";
  else if (r.phase === "ready") {
    // The real reason the merge does not go out on its own: the AI passes this on to the person.
    if (r.approvePending) next = "pronto, mas o Approve do revisor não chegou ao GitHub: o merge espera o 'tentar de novo' do painel";
    else if (r.autoMergeFailedRound === r.round) next = "pronto; o merge automático falhou nesta rodada: fica para o merge humano, pelo botão do responsável";
    else if (autoMergeEligible(r)) {
      const waived = waivedText(r);
      next = `pronto${waived ? ` (${waived})` : " e sem nada em pé"}: o painel mergeia sozinho; nenhuma IA mergeia daqui`;
    } else if (r.mergeAuthorized) next = "pronto para o merge humano (sugestão pedida ao autor ainda em pé); ninguém mergeia daqui";
    else next = "pronto para o merge humano (há sugestão em aberto); ninguém mergeia daqui";
  }
  else if (r.phase === "impasse") next = `impasse: ${impasseText(r.impasseReason)}`;
  else next = `revisão encerrada (${r.phase})`;
  return {
    review: r.id, registered, phase: r.phase, round: r.round,
    findings: r.findings.length, blocking: blockingOpen(r.findings).length, next,
  };
}
