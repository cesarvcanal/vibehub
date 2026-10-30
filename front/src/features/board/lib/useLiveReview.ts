import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get } from "@/lib/api";
import type { ReportedProblem, Review, ReviewResponse, ReviewWorking } from "@/api/types";
import { CARDS_PREFIX_KEY } from "@/features/board/api";
import { REVIEW_IDLE_POLL_MS, REVIEW_POLL_MS, cardReviewKey, reviewIsOpen, reviewIsWorking } from "@/features/board/lib/review";

const NOBODY_WORKING: ReviewWorking = { author: false, reviewer: false };
const NOTHING_REPORTED: ReportedProblem[] = [];

/**
 * The card's PR review as it stands NOW, for everything on screen that shows it: the block above the
 * composer and the review panel. One query per card (`cardReviewKey`), shared by whoever is mounted.
 *
 * It is re-read while the review is OPEN — in every phase, not only while an AI holds the turn. A
 * review in `ready` still moves without anyone touching the panel: the author's AI pushes and the
 * server sends it back to the reviewer, an AI starts working on the PR, it is merged on GitHub. A
 * screen that stopped reading in `ready` froze on "pronto pra merge" while all that happened. The pace:
 * {@link REVIEW_POLL_MS} while something moves (an AI working, the AIs' phases, `fast` — a merge the
 * caller is waiting on), {@link REVIEW_IDLE_POLL_MS} while it sits still. A closed review (merged,
 * cancelled) is final and is not re-read.
 *
 * When the phase or the round moves, the board's card lists are invalidated too, so the sidebar's
 * "PR #N · estado" line changes in the same second instead of on its own poll.
 */
export function useLiveReview(
  cardId: string,
  opts: {
    enabled?: boolean;
    fast?: boolean;
    /**
     * The id of the review the board's summary carries. When it is not the one read here and the one
     * read here is closed, a NEWER review started where this screen did not see it (a closed review is
     * no longer re-read): read again, so the newer one is followed live from now on.
     */
    summaryId?: string;
  } = {},
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: cardReviewKey(cardId),
    queryFn: () => get<ReviewResponse>(`/cards/${encodeURIComponent(cardId)}/review`),
    enabled: opts.enabled ?? true,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!reviewIsOpen(data?.review?.phase)) return false;
      const moving = opts.fast || reviewIsWorking(data?.review?.phase) || data?.working?.author || data?.working?.reviewer;
      return moving ? REVIEW_POLL_MS : REVIEW_IDLE_POLL_MS;
    },
  });
  const review = query.data?.review ?? null;
  const working = query.data?.working ?? NOBODY_WORKING;
  const reported = query.data?.reported ?? NOTHING_REPORTED;
  const outdated = review !== null && opts.summaryId !== undefined && opts.summaryId !== review.id && !reviewIsOpen(review.phase);
  const { refetch } = query;
  React.useEffect(() => {
    if (outdated) void refetch();
  }, [outdated, opts.summaryId, refetch]);

  // The sidebar line reads the card's summary, which the board list carries: refresh it when the
  // review moved. Not on the first read — that one only tells where the review already was.
  const where = review ? `${review.id}:${review.phase}:${review.round}` : null;
  const seen = React.useRef(where);
  React.useEffect(() => {
    if (seen.current === where) return;
    const first = seen.current === null;
    seen.current = where;
    if (!first) void queryClient.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
  }, [where, queryClient]);

  /** Puts the review an action answered with on screen, keeping who is working as last read. */
  const apply = React.useCallback(
    (next: Review) => {
      queryClient.setQueryData<ReviewResponse>(cardReviewKey(cardId), (prev) => ({ ...prev, review: next }));
      void queryClient.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
    },
    [queryClient, cardId],
  );

  return { query, review, working, reported, apply, outdated };
}
