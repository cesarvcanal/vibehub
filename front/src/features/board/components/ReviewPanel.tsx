import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { get, post } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import type { PeopleResponse, Person, Review, ReviewPhase } from "@/api/types";
import { PanelFrame, ReviewPanelView, type Decision, type PanelNotice } from "@/features/board/components/ReviewPanelView";
import { MERGE_CONFIRM_MS, cardPeopleKey, cardReviewKey, mergeFailure, reviewActions } from "@/features/board/lib/review";
import { useLiveReview } from "@/features/board/lib/useLiveReview";
import { useAuth } from "@/providers/auth";
import { t as translate, useT } from "@/i18n";

/**
 * The follow-up panel of a PR's review, the column to the right of the card (like the browser's).
 * This half READS and ACTS; what it looks like is {@link ReviewPanelView}.
 *
 * It READS one thing — the card's review (`GET /api/cards/:id/review`, the active one or the last)
 * — and offers the human moves the server allows, to the people the server lets make them:
 *
 *  - **merge**: the merger and nobody else, only in `ready`. The request waits for CI (up to ~15 min),
 *    so while it is open the button reads "Mergeando…" and the panel KEEPS READING: a proxy that
 *    gives up on the long request is not a refusal, and if the review turns `merged` meanwhile that
 *    is the success;
 *  - **decide** (a doubt: block/drop; a stuck item: keep/accept risk): the reviewer or an owner;
 *  - **try again** (an impasse that is a failure, an Approve that never got out, or an AI's turn that
 *    stalled) and **cancel**.
 *
 * Who may do what is `reviewActions` (the server's own rules), so no button answers 403. While the
 * review is open it is re-read ({@link useLiveReview}) whatever the phase — every 3 s while something
 * moves, every 10 s while it sits still: it moves on its own (an AI's turn, a push after `ready`, a
 * merge done on GitHub), and the panel follows. With the author's AI working on a
 * `ready` PR, the pill reads "IA mexendo" and the merge waits for it to finish.
 */

/** Where the review stood when a banner was raised: the banner is about THAT state and goes with it. */
type Stamp = { phase: ReviewPhase; round: number };

/**
 *  - `unconfirmed`: the merge's answer is not known (lost on the way, or another click found one already
 *    running) — the panel keeps reading, with the merge button held, until `merged` or the time cap;
 *  - `expired`: the cap passed with no `merged`: reading stops, the button is back, and the person is
 *    sent to GitHub;
 *  - `head_moved` / `refused`: answers of the server, pinned to the `at` state they were raised in.
 */
type MergeNote =
  | { kind: "unconfirmed"; cause: "lost" | "running" }
  | { kind: "expired"; at: Stamp | null }
  | { kind: "head_moved"; at: Stamp | null }
  | { kind: "refused"; message: string; at: Stamp | null };

export function ReviewPanel({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { user, isOwner } = useAuth();
  const key = cardReviewKey(cardId);

  // A merge request is open (the button reads "Mergeando…"), or its answer is unconfirmed and the
  // panel is checking whether it went through. Either way the review is re-read.
  const [mergeWait, setMergeWait] = React.useState(false);
  const [mergeNote, setMergeNote] = React.useState<MergeNote | null>(null);
  /** A merge was asked from THIS panel: the `merged` that follows is its success, and says so once. */
  const mergeAsked = React.useRef(false);
  /** When that click happened: the unconfirmed wait is counted from it, not from when the answer got lost. */
  const mergeStartedAt = React.useRef(0);
  /** The review's state as of the latest render, for the banners raised from callbacks. */
  const stamp = React.useRef<Stamp | null>(null);
  const unconfirmed = mergeNote?.kind === "unconfirmed";
  /** The merge button is held: a request is open, or its result is unknown. Cancel and retry wait too. */
  const mergeBusy = mergeWait || unconfirmed;

  const { query: reviewQuery, review, working, reported, apply } = useLiveReview(cardId, { fast: mergeBusy });

  // The review carries user ids; the roles read better as names. Same key and shape as the request dialog's.
  const people = useQuery({
    queryKey: cardPeopleKey(cardId),
    queryFn: () => get<PeopleResponse>(`/cards/${encodeURIComponent(cardId)}/people`).then((r) => r.people),
  });

  const reread = () => void qc.invalidateQueries({ queryKey: key });

  /** Decide / retry / cancel: one POST each, the review that comes back is the new truth. */
  const act = useMutation({
    mutationFn: ({ path, body }: {
      path: string;
      body?: { findingId: string; decision: Decision } | { apply: string[]; skip: string[] };
    }) => {
      const url = `/reviews/${encodeURIComponent(review!.id)}/${path}`;
      return body === undefined ? post<{ review: Review }>(url) : post<{ review: Review }>(url, body);
    },
    onSuccess: (answer, { path, body }) => {
      apply(answer.review);
      if (path === "suggestions" && body && "apply" in body) {
        toast.success(translate("review.suggestions.sent", { apply: body.apply.length, skip: body.skip.length }));
      }
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error));
      // A refusal usually means the review moved under the click (someone else decided, it ended).
      reread();
    },
  });

  const merge = useMutation({
    mutationFn: () => post<{ review: Review }>(`/reviews/${encodeURIComponent(review!.id)}/merge`),
    onMutate: () => {
      setMergeNote(null);
      setMergeWait(true);
      mergeAsked.current = true;
      mergeStartedAt.current = Date.now();
    },
    onSuccess: (answer) => apply(answer.review),
    onError: (error) => {
      const failed = mergeFailure(error);
      if (failed.kind === "lost" || failed.kind === "running") {
        // Not a refusal: the merge may well be running (or done). Read now, keep reading, and keep
        // `mergeAsked`, so the `merged` that follows is announced as this click's success.
        setMergeNote({ kind: "unconfirmed", cause: failed.kind });
        reread();
        return;
      }
      mergeAsked.current = false;
      if (failed.review) apply(failed.review);
      else reread();
      // The banner belongs to the state the answer left the review in.
      const at = failed.review ? { phase: failed.review.phase, round: failed.review.round } : stamp.current;
      if (failed.kind === "head_moved") setMergeNote({ kind: "head_moved", at });
      else setMergeNote({ kind: "refused", message: refusalText(failed.reason, failed.message, error), at });
    },
    onSettled: () => setMergeWait(false),
  });

  // The merge went through: said once, from here, whichever way the answer arrived (the response, or
  // the next read after the request was cut). A review merged by somebody else is not announced.
  const phase = review?.phase;
  const round = review?.round;
  const prNumber = review?.prNumber;
  const base = review?.base;
  stamp.current = phase !== undefined && round !== undefined ? { phase, round } : null;
  React.useEffect(() => {
    if (phase === "merged") {
      setMergeNote(null);
      if (mergeAsked.current) {
        mergeAsked.current = false;
        toast.success(translate("review.merge.done", { num: prNumber, base }));
      }
      return;
    }
    if (phase === undefined) return;
    if (phase !== "ready") {
      // An unconfirmed answer is settled by the phase moving on (a push sent it back, it was
      // cancelled): that merge did not happen, so a later `merged` is not its success.
      mergeAsked.current = false;
    }
    // A banner is about the state it was raised in: when the phase or the round moves, it goes.
    setMergeNote((note) => {
      if (!note) return note;
      if (note.kind === "unconfirmed") return phase !== "ready" ? null : note;
      return note.at && (note.at.phase !== phase || note.at.round !== round) ? null : note;
    });
  }, [phase, round, prNumber, base]);

  // The wait for an unconfirmed merge has a cap (the server's own merge limit, plus a margin): past it
  // the panel stops reading and says it could not confirm, instead of polling for ever.
  React.useEffect(() => {
    if (!unconfirmed) return;
    const left = Math.max(0, mergeStartedAt.current + MERGE_CONFIRM_MS - Date.now());
    const timer = window.setTimeout(() => {
      mergeAsked.current = false;
      setMergeNote({ kind: "expired", at: stamp.current });
    }, left);
    return () => window.clearTimeout(timer);
  }, [unconfirmed]);

  if (!review) {
    return (
      <PanelFrame label={t("review.panel.title")} onClose={onClose}>
        {reviewQuery.isError ? (
          <p role="alert" className="text-xs text-destructive">{t("review.panel.loadError")}</p>
        ) : reviewQuery.isPending ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("review.panel.loading")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("review.panel.none")}</p>
        )}
      </PanelFrame>
    );
  }

  const nameOf = (id: string | undefined) => (id ? (people.data ?? []).find((p: Person) => p.id === id)?.username ?? id : "—");
  const cancel = () => {
    if (!window.confirm(t("review.cancel.confirm", { num: review.prNumber }))) return;
    act.mutate({ path: "cancel" });
  };

  return (
    <ReviewPanelView
      review={review}
      working={working}
      reported={reported}
      nameOf={nameOf}
      actions={reviewActions(review, user ? { id: user.id, isOwner } : null)}
      busy={act.isPending}
      mergeBusy={mergeBusy}
      notice={noticeOf(mergeNote, t)}
      onMerge={() => merge.mutate()}
      onRetry={() => act.mutate({ path: "retry" })}
      onCancel={cancel}
      onDecide={(finding, decision) => act.mutate({ path: "decide", body: { findingId: finding.id, decision } })}
      onDecideSuggestions={(choice) => act.mutate({ path: "suggestions", body: choice })}
      onClose={onClose}
    />
  );
}

/** The merge banner in words: where the last click left things. */
function noticeOf(note: MergeNote | null, t: typeof translate): PanelNotice | null {
  switch (note?.kind) {
    case "head_moved":
      return { tone: "warn", text: t("review.merge.headMoved") };
    case "unconfirmed":
      return { tone: "muted", text: t(note.cause === "lost" ? "review.merge.lost" : "review.merge.running") };
    case "expired":
      return { tone: "error", text: t("review.merge.expired") };
    case "refused":
      return { tone: "error", text: note.message };
    default:
      return null;
  }
}

/** The words for a merge the server refused: its own text for the codes with one, the server's otherwise. */
function refusalText(reason: string | undefined, message: string, error: unknown): string {
  if (reason === "merger_sem_github") return translate("review.merge.error.merger_sem_github");
  if (reason === "not_ready") return translate("review.merge.error.not_ready");
  return message ? apiErrorMessage(error) : translate("error.generic");
}
