import * as React from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Card, CardPr, Finding, ReviewSummary } from "@/api/types";
import { RequestReviewDialog } from "@/features/board/components/RequestReviewDialog";
import { prStripCounts, readsPerPr, reviewPill, summaryForPr, visiblePrs } from "@/features/board/lib/review";
import { useLiveReview } from "@/features/board/lib/useLiveReview";
import { cn } from "@/lib/utils";
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
  /** `row`: a line inside the card's PR list ({@link PrList}), which draws the frame around them all. */
  variant?: "block" | "row";
}

export function PrReviewBlock({
  cardId, pr, review: summary, authorWorking = false, actorUserId, onOpenPanel, variant = "block",
}: PrReviewBlockProps) {
  const t = useT();
  const [asking, setAsking] = React.useState(false);
  // The server never puts a cancelled review on a card; a stale cache must not turn one into a panel to open.
  const review = summary?.phase === "cancelled" ? undefined : summary;
  const pill = reviewPill(review, { authorWorking });

  const line = (
    <>
      <span className="shrink-0 font-semibold text-amber-400">PR #{pr.number}</span>
      <span className="min-w-0 truncate text-muted-foreground" title={pr.title}>
        {pr.branch} → {pr.base}
      </span>
      {pr.author ? (
        // Who opened it on GitHub (an attached PR): the person the review's fixes will be asked of.
        <span
          className="shrink-0 rounded-full bg-foreground/5 px-1.5 text-[11px] text-foreground/80"
          title={t("review.openedBy", { login: pr.author })}
        >
          {pr.author}
        </span>
      ) : null}
      <Badge tone={pill.tone} className="ml-auto shrink-0 transition-colors duration-500">
        {t(pill.key, pill.vars)}
      </Badge>
    </>
  );

  return (
    <div
      data-testid="pr-review-block"
      data-pr={pr.number}
      className={cn(
        "flex shrink-0 items-center gap-2 px-2.5 py-1 text-xs",
        variant === "row"
          ? "border-b border-amber-500/15 last:border-b-0"
          : "mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10",
      )}
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

/** Where the card's PR list is remembered as folded, per card and per device. */
const foldedKey = (cardId: string) => `vibehub.prList.folded.${cardId}`;

function readFolded(cardId: string): boolean {
  try {
    return localStorage.getItem(foldedKey(cardId)) === "1";
  } catch {
    return false;
  }
}

/**
 * The frame of a card's PRs. One PR is the block it always was. Two or more get a header — "4 PRs ·
 * 1 pronto · 2 sem revisão" — that folds the list (remembered per card on this device), and a list
 * with a ceiling of ~4 lines that scrolls on its own: a card with many PRs never pushes the chat off
 * the screen.
 */
function PrList({ cardId, count, summaries, children }: {
  cardId: string;
  count: number;
  /** The review of each listed PR, as the board has it (undefined = not reviewed). */
  summaries: (ReviewSummary | undefined)[];
  children: React.ReactNode;
}) {
  const t = useT();
  const [folded, setFolded] = React.useState(() => readFolded(cardId));
  React.useEffect(() => setFolded(readFolded(cardId)), [cardId]);
  if (count < 2) return <>{children}</>;
  const toggle = () => {
    const next = !folded;
    setFolded(next);
    try {
      if (next) localStorage.setItem(foldedKey(cardId), "1");
      else localStorage.removeItem(foldedKey(cardId));
    } catch {
      // A browser that refuses storage still folds; it just forgets on reload.
    }
  };
  const counts = prStripCounts(summaries).map((c) => t(`review.list.${c.kind}`, { n: c.n })).join(" · ");
  return (
    <div data-testid="pr-list" className="mt-1.5 shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 text-xs">
      <button
        type="button"
        aria-expanded={!folded}
        title={t(folded ? "review.list.unfold" : "review.list.fold")}
        onClick={toggle}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="shrink-0 font-semibold text-amber-400">{t("review.list.count", { n: count })}</span>
        <span className="min-w-0 truncate text-muted-foreground">{counts}</span>
        <ChevronDown aria-hidden className={cn("ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", folded && "-rotate-90")} />
      </button>
      {folded ? null : (
        <div data-testid="pr-list-rows" className="max-h-[8.5rem] overflow-y-auto border-t border-amber-500/20">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * One line of a card that reads its PRs one review each ({@link readsPerPr}): its OWN live read
 * (`?pr=N`), with the same rules the single read has — the board's summary stands in until the read
 * lands, a cancelled review is no review, a closed one loses to a newer summary, and a merged one takes
 * the line away.
 */
function LivePrLine({ card, pr, row, onOpenPanel }: {
  card: Pick<Card, "id" | "review" | "reviews" | "actorUserId">;
  pr: CardPr;
  row: boolean;
  onOpenPanel: (prNumber?: number) => void;
}) {
  const summary = summaryForPr(card, pr.number);
  const reviewed = summary !== undefined && summary.phase !== "cancelled";
  const live = useLiveReview(card.id, { enabled: reviewed, summaryId: summary?.id, pr: pr.number });
  const current = live.review && live.review.phase !== "cancelled" && !live.outdated ? live.review : summary;
  if (current?.phase === "merged") return null;
  const authorWorking = live.query.data && !live.outdated ? live.working.author : summary?.authorWorking === true;
  return (
    <PrReviewBlock
      cardId={card.id}
      pr={pr}
      review={current?.prNumber === pr.number ? current : undefined}
      authorWorking={authorWorking}
      actorUserId={card.actorUserId}
      onOpenPanel={() => onOpenPanel(pr.number)}
      variant={row ? "row" : "block"}
    />
  );
}

/**
 * The blocks of a card: one per PR it has open, newest first (see {@link visiblePrs}). Renders
 * nothing for a card with no open PR — which is most of them; a merged one leaves.
 *
 * A card with a review reads it LIVE ({@link useLiveReview}, the same query the panel reads): the
 * board's summary only moves when the sidebar polls, and the block must follow the review as it goes
 * (the AIs' rounds, a push after `ready`, the author's AI working on it) without anyone reopening the
 * card. The board's summary stands in until the first read lands. A card that attached PRs, or has
 * more than one reviewed, reads one review PER LINE instead ({@link readsPerPr}), and each line opens
 * the panel of its own PR. Two or more PRs sit in one list that folds and scrolls ({@link PrList}).
 */
export function PrReviewBlocks({
  card,
  onOpenPanel,
}: {
  card: Pick<Card, "id" | "prs" | "review" | "reviews" | "actorUserId">;
  /** Show the review's panel — of THIS PR, on a card that reads one review per PR. */
  onOpenPanel: (prNumber?: number) => void;
}) {
  return readsPerPr(card) ? <PerPrBlocks card={card} onOpenPanel={onOpenPanel} /> : <CardReviewBlocks card={card} onOpenPanel={onOpenPanel} />;
}

/** A card with several PRs under review, or attached ones: every line reads its own review. */
function PerPrBlocks({ card, onOpenPanel }: {
  card: Pick<Card, "id" | "prs" | "review" | "reviews" | "actorUserId">;
  onOpenPanel: (prNumber?: number) => void;
}) {
  const prs = visiblePrs(card);
  if (prs.length === 0) return null;
  const row = prs.length > 1;
  return (
    <PrList cardId={card.id} count={prs.length} summaries={prs.map((pr) => summaryForPr(card, pr.number))}>
      {prs.map((pr) => <LivePrLine key={pr.number} card={card} pr={pr} row={row} onOpenPanel={onOpenPanel} />)}
    </PrList>
  );
}

/** The card's own PRs with (at most) one reviewed: the single live read of the card's review, as always. */
function CardReviewBlocks({ card, onOpenPanel }: {
  card: Pick<Card, "id" | "prs" | "review" | "actorUserId">;
  onOpenPanel: () => void;
}) {
  const reviewed = card.review !== undefined && card.review.phase !== "cancelled";
  const live = useLiveReview(card.id, { enabled: reviewed, summaryId: card.review?.id });
  // The live read speaks, except: a cancelled review is no review (the board's summary — the latest
  // that was not cancelled — speaks then), and a closed one the board already moved past (`outdated`:
  // a newer review started; the live read is being taken again) gives way to the newer summary.
  const current = live.review && live.review.phase !== "cancelled" && !live.outdated ? live.review : card.review;
  // By the live review: a merge the server just saw takes the block away before the board polls.
  const prs = visiblePrs({ prs: card.prs, review: current });
  if (prs.length === 0) return null;
  // The server's rule either way: the live read's `working`, or the board summary's until it lands.
  const authorWorking = live.query.data && !live.outdated ? live.working.author : card.review?.authorWorking === true;
  const row = prs.length > 1;
  return (
    <PrList cardId={card.id} count={prs.length} summaries={prs.map((pr) => (current?.prNumber === pr.number ? current : undefined))}>
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
          variant={row ? "row" : "block"}
        />
      ))}
    </PrList>
  );
}
