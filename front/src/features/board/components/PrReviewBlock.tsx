import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Card, CardPr, Finding, ReviewSummary } from "@/api/types";
import { RequestReviewDialog } from "@/features/board/components/RequestReviewDialog";
import { reviewPill, visiblePrs } from "@/features/board/lib/review";
import { useLiveReview } from "@/features/board/lib/useLiveReview";
import { useT } from "@/i18n";

/**
 * A PR the card delivered, one compact line above the composer: its number, `branch → base`, where
 * its review stands, and the way forward.
 *
 *  - NO review: the pill reads "sem revisão" and the line offers "Pedir revisão", which opens the
 *    dialog where the roles are chosen;
 *  - a review exists: the line IS the way into it — the pill says where it stands (round N of 3,
 *    ready to merge, impasse…) and clicking anywhere on it asks the screen for the review's panel.
 *
 * The PR number also leads out to GitHub, but from a link of its own beside the line: a link inside
 * the button that opens the panel would be two things to press in the same place.
 */
export interface PrReviewBlockProps {
  cardId: string;
  pr: CardPr;
  /** The card's review, when it is about THIS PR: the live one, or the board's summary. Absent = never reviewed. */
  review?: ReviewSummary & { findings?: Finding[] };
  /** The author's AI is working right now: a `ready` PR reads "IA mexendo". */
  authorWorking?: boolean;
  /** Who works the card now: the dialog suggests them as the author. */
  actorUserId?: string;
  /** Show the review's panel. */
  onOpenPanel: () => void;
}

export function PrReviewBlock({ cardId, pr, review: summary, authorWorking = false, actorUserId, onOpenPanel }: PrReviewBlockProps) {
  const t = useT();
  const [asking, setAsking] = React.useState(false);
  // The server never puts a cancelled review on a card; a stale cache must not turn one into a panel to open.
  const review = summary?.phase === "cancelled" ? undefined : summary;
  const pill = reviewPill(review, { authorWorking });

  const line = (
    <>
      <span className="shrink-0 font-semibold text-amber-400">PR #{pr.number}</span>
      <span className="min-w-0 truncate text-muted-foreground">
        {pr.branch} → {pr.base}
      </span>
      <Badge tone={pill.tone} className="ml-auto shrink-0">
        {t(pill.key, pill.vars)}
      </Badge>
    </>
  );

  return (
    <div
      data-testid="pr-review-block"
      data-pr={pr.number}
      className="mt-1.5 flex shrink-0 items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs"
    >
      {review ? (
        <button
          type="button"
          title={t("review.openPanel")}
          onClick={onOpenPanel}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-0.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {line}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 py-0.5">{line}</div>
      )}
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        aria-label={t("review.github", { n: pr.number })}
        title={t("review.github", { n: pr.number })}
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
      {review ? null : (
        <Button type="button" size="sm" className="h-7 shrink-0 px-3 text-xs" onClick={() => setAsking(true)}>
          {t("review.ask")}
        </Button>
      )}
      <RequestReviewDialog
        cardId={cardId}
        pr={pr}
        actorUserId={actorUserId}
        open={asking}
        onClose={() => setAsking(false)}
      />
    </div>
  );
}

/**
 * The blocks of a card: one per PR it has open, newest first (see {@link visiblePrs}). Renders
 * nothing for a card that never opened one — which is most of them.
 *
 * A card with a review reads it LIVE ({@link useLiveReview}, the same query the panel reads): the
 * board's summary only moves when the sidebar polls, and the block must follow the review as it goes
 * (the AIs' rounds, a push after `ready`, the author's AI working on it) without anyone reopening the
 * card. The board's summary stands in until the first read lands.
 */
export function PrReviewBlocks({
  card,
  onOpenPanel,
}: {
  card: Pick<Card, "id" | "prs" | "review" | "actorUserId" | "status">;
  onOpenPanel: () => void;
}) {
  const reviewed = card.review !== undefined && card.review.phase !== "cancelled";
  const live = useLiveReview(card.id, { enabled: reviewed });
  const prs = visiblePrs(card);
  if (prs.length === 0) return null;
  // A cancelled review is no review: the board's summary (the latest that was not cancelled) speaks then.
  const current = live.review && live.review.phase !== "cancelled" ? live.review : card.review;
  const authorWorking = live.query.data ? live.working.author : card.status === "working";
  return (
    <>
      {prs.map((pr) => (
        <PrReviewBlock
          key={pr.number}
          cardId={card.id}
          pr={pr}
          // The review is the card's MOST RECENT one: it belongs to one PR, not to all of them.
          review={current?.prNumber === pr.number ? current : undefined}
          authorWorking={authorWorking}
          actorUserId={card.actorUserId}
          onOpenPanel={onOpenPanel}
        />
      ))}
    </>
  );
}
