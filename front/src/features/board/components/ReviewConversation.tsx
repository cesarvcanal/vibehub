import * as React from "react";
import { Info, UserRound } from "lucide-react";
import { Badge, BADGE_TEXT } from "@/components/ui/badge";
import type { Finding, Review, ReviewEvent, ReviewEventItem, ReviewWorking } from "@/api/types";
import { JumpToLatest, useStickToBottom } from "@/features/board/components/JumpToLatest";
import { TypingDots } from "@/features/board/components/PeerTypingIndicator";
import { formatResetAt } from "@/features/board/lib/planUsage";
import { FINDING_SEVERITY_TONE, FINDING_STATUS_TONE, conversationRows, reviewTurn, type ReviewTurn } from "@/features/board/lib/review";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The CONVERSATION of a PR review, drawn the way a chat app draws one: the reviewer's AI on the left,
 * the author's AI on the right, what the server and the people did in the middle, a "Rodada N"
 * divider where each round starts, and — at the bottom, while one of the AIs is in its turn — who is
 * "typing". It follows the review live with the app's own chat scroll ({@link useStickToBottom}): a
 * new line scrolls into view when the reader is already at the bottom; a reader who scrolled up to
 * read the history is left there and gets the "jump to latest" arrow instead of being yanked down.
 *
 * Each AI line carries the findings it is about (`ReviewEvent.items`), with the reply of THAT round.
 * They are not packed into the line's bubble: the summary comes first, then one message per finding
 * ({@link conversationRows}), so each subject is read on its own — the reviewer opens it, the author
 * answers, the reviewer accepts it or keeps it open.
 */

/**
 * How something new comes in: a short fade and rise, the way a message lands in a chat app. Only
 * what arrives while the panel is open — the history it opens on is already there, and stays still.
 * Off for people who asked the system for less motion.
 */
export const ENTER = "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none";

export interface ReviewConversationProps {
  review: Review;
  working: ReviewWorking;
  /** A user id to the name people know them by. */
  nameOf: (userId: string | undefined) => string;
}

export function ReviewConversation({ review, working, nameOf }: ReviewConversationProps) {
  const t = useT();
  const rows = React.useMemo(() => conversationRows(review.log), [review.log]);
  const findings = React.useMemo(() => new Map(review.findings.map((f) => [f.id, f])), [review.findings]);
  const turn = reviewTurn(review, working);
  const names = { reviewer: nameOf(review.reviewerUserId), author: nameOf(review.authorUserId), merger: nameOf(review.mergerUserId) };

  // What sits at the bottom besides the lines: the "typing" row changes with the turn.
  const stick = useStickToBottom(`${review.log.length}:${turnKey(turn)}`);
  // The log as it was when the panel opened: lines past it arrived live and come in animated. A log
  // that shrank (another review on screen) is all "already there" again.
  const openedWith = React.useRef(review.log.length);
  if (review.log.length < openedWith.current) openedWith.current = review.log.length;
  const fresh = (index: number) => index >= openedWith.current;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={stick.scrollerRef}
        onScroll={stick.onScroll}
        data-testid="review-conversation"
        role="log"
        aria-live="polite"
        aria-label={t("review.tab.conversation")}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-0.5 py-2"
      >
        {rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{t("review.conversation.empty")}</p>
        ) : (
          rows.map((row) =>
            row.kind === "round" ? (
              <RoundDivider key={row.key} round={row.round} fresh={fresh(row.index)} />
            ) : row.kind === "item" ? (
              <ItemLine key={row.key} event={row.event} item={row.item} finding={findings.get(row.item.id)} fresh={fresh(row.index)} />
            ) : (
              <Line key={row.key} event={row.event} names={names} fresh={fresh(row.index)} />
            ),
          )
        )}
        {/* Keyed by the turn: a change of turn mounts it again, so the new "typing" comes in animated. */}
        <TurnRow key={turnKey(turn)} turn={turn} names={names} />
      </div>
      <JumpToLatest stick={stick} />
    </div>
  );
}

/** Changes whenever the bottom "typing" row would draw something else. */
function turnKey(turn: ReviewTurn): string {
  if (turn.who === "reviewer") return `r:${turn.working}`;
  if (turn.who === "author") return `a:${turn.working}:${turn.onReadyPr}`;
  if (turn.who === "person") return `p:${turn.why}`;
  return "n";
}

function RoundDivider({ round, fresh }: { round: number; fresh: boolean }) {
  const t = useT();
  return (
    <div
      data-testid="review-round"
      data-fresh={fresh || undefined}
      className={cn("flex items-center gap-2 py-1 text-[11px] font-medium text-muted-foreground", fresh && ENTER)}
    >
      <span className="h-px flex-1 bg-border/60" />
      {t("review.conversation.round", { round })}
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

type Names = { reviewer: string; author: string; merger: string };

/** One line of the log: a bubble for each AI, a centred note for the server and for the people. */
function Line({
  event, names, fresh,
}: {
  event: ReviewEvent;
  names: Names;
  /** Arrived while the panel was open: comes in animated. */
  fresh: boolean;
}) {
  const t = useT();
  const when = timeOf(event.at);
  if (event.who === "system" || event.who === "human") {
    const human = event.who === "human";
    return (
      <div
        data-testid="review-line"
        data-who={event.who}
        data-fresh={fresh || undefined}
        title={when}
        className={cn(
          "mx-auto flex max-w-[92%] items-start gap-1.5 rounded-md px-2.5 py-1 text-center text-[11px] leading-snug",
          human ? "border border-amber-500/25 bg-amber-500/10 text-amber-200" : "text-muted-foreground",
          fresh && ENTER,
        )}
      >
        {human ? <UserRound className="mt-px h-3 w-3 shrink-0" /> : <Info className="mt-px h-3 w-3 shrink-0 opacity-70" />}
        <span className="min-w-0 break-words">
          {human && event.by ? <b className="mr-1 font-semibold">{event.by}:</b> : null}
          {event.text}
        </span>
      </div>
    );
  }
  const reviewer = event.who === "reviewer";
  return (
    <Bubble testId="review-line" reviewer={reviewer} fresh={fresh} first>
      <p className={cn("text-[11px] font-semibold", reviewer ? "text-sky-300" : "text-emerald-300")}>
        {t(reviewer ? "review.conversation.reviewer" : "review.conversation.author", { name: reviewer ? names.reviewer : names.author })}
      </p>
      <p className="whitespace-pre-wrap break-words leading-relaxed">{event.text}</p>
      <p className="text-right text-[10px] text-muted-foreground">{when}</p>
    </Bubble>
  );
}

/** An AI's bubble, on its side: the reviewer on the left, the author on the right. */
function Bubble({
  testId, reviewer, fresh, first, status, children,
}: {
  testId: string;
  reviewer: boolean;
  fresh: boolean;
  /** Opens a run of messages: the corner points at the side it came from. */
  first?: boolean;
  status?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-who={reviewer ? "reviewer" : "author"}
      data-status={status}
      data-fresh={fresh || undefined}
      className={cn("flex", reviewer ? "justify-start" : "justify-end", fresh && ENTER)}
    >
      <div
        className={cn(
          "max-w-[88%] space-y-1.5 rounded-lg border px-3 py-2 text-xs",
          reviewer ? "border-sky-500/30 bg-sky-500/10" : "border-emerald-500/30 bg-emerald-500/10",
          first && (reviewer ? "rounded-tl-sm" : "rounded-tr-sm"),
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * One finding an AI line is about, as a message of its own: what it is and where it stands after
 * this line, where in the code, then what was said of it — the author's answer, the reviewer's
 * verdict, or, on the finding the reviewer just opened, how to fix it.
 */
function ItemLine({
  event, item, finding, fresh,
}: {
  event: ReviewEvent;
  item: ReviewEventItem;
  finding: Finding | undefined;
  fresh: boolean;
}) {
  const t = useT();
  const where = finding?.file ? (finding.line ? `${finding.file}:${finding.line}` : finding.file) : null;
  const said = item.reply ?? (item.isNew ? finding?.fix : undefined);
  return (
    <Bubble testId="review-line-item" reviewer={event.who === "reviewer"} fresh={fresh} status={item.status}>
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "text-[11px] font-semibold",
            finding ? BADGE_TEXT[FINDING_SEVERITY_TONE[finding.severity]] : "text-muted-foreground",
            finding?.severity === "refuted" && "line-through",
          )}
        >
          {finding ? t(`review.severity.${finding.severity}`) : item.id}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
        <Badge tone={item.isNew ? "muted" : FINDING_STATUS_TONE[item.status]} className="ml-auto shrink-0 px-1 py-0 text-[10px] font-normal">
          {item.isNew ? t("review.conversation.newItem") : t(`review.status.${item.status}`)}
        </Badge>
      </div>
      <p className="break-words font-medium leading-snug">{finding?.title ?? item.id}</p>
      {where ? <code className="block break-all font-mono text-[10px] text-muted-foreground">{where}</code> : null}
      {said ? (
        <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
          {item.isNew && !item.reply ? <span className="text-muted-foreground">{t("review.conversation.fix")} </span> : null}
          {said}
        </p>
      ) : null}
      {item.commit ? <code className="block font-mono text-[10px] text-muted-foreground">{t("review.conversation.commit", { sha: item.commit.slice(0, 7) })}</code> : null}
    </Bubble>
  );
}

/**
 * The bottom of the conversation: who holds the turn. An AI in its turn "types" (the three dots) on
 * its own side; an AI whose turn it is but that has not started says so, quietly; a turn that is a
 * person's is a centred note. Nothing once the review is over.
 */
function TurnRow({ turn, names }: { turn: ReviewTurn; names: Names }) {
  const t = useT();
  if (turn.who === "nobody") return null;
  if (turn.who === "person") {
    const text =
      turn.why === "decision" ? t("review.conversation.waiting.decision")
        : turn.why === "merge" ? t("review.conversation.waiting.merge", { name: names.merger })
          : t("review.conversation.waiting.impasse");
    return (
      <p data-testid="review-turn" data-who="person" className={cn("py-1 text-center text-[11px] text-muted-foreground", ENTER)}>
        {text}
      </p>
    );
  }
  const reviewer = turn.who === "reviewer";
  const name = reviewer ? names.reviewer : names.author;
  const text = !turn.working
    ? t(reviewer ? "review.conversation.idle.reviewer" : "review.conversation.idle.author", { name })
    : reviewer ? t("review.conversation.typing.reviewing", { name })
      : turn.onReadyPr ? t("review.conversation.typing.onReadyPr", { name })
        : t("review.conversation.typing.fixing", { name });
  return (
    <div
      data-testid="review-turn"
      data-who={turn.who}
      data-working={turn.working}
      className={cn("flex", reviewer ? "justify-start" : "justify-end", ENTER)}
    >
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px]",
          !turn.working ? "border-dashed border-border/70 text-muted-foreground"
            : reviewer ? "border-sky-500/30 bg-sky-500/10 text-sky-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
        )}
      >
        {turn.working ? <TypingDots /> : null}
        {text}
      </div>
    </div>
  );
}

/** "14:32" today, "qui., 29/10 14:32" on another day — in the reader's language. */
function timeOf(at: number): string {
  return formatResetAt(at, Date.now());
}
