import * as React from "react";
import { ArrowDown, Info, UserRound } from "lucide-react";
import type { Finding, FindingSeverity, Review, ReviewEvent, ReviewEventItem, ReviewWorking } from "@/api/types";
import { conversationRows, reviewTurn, type ReviewTurn } from "@/features/board/lib/review";
import { getLanguage, useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The CONVERSATION of a PR review, drawn the way a chat app draws one: the reviewer's AI on the left,
 * the author's AI on the right, what the server and the people did in the middle, a "Rodada N"
 * divider where each round starts, and — at the bottom, while one of the AIs is in its turn — who is
 * "typing". It follows the review live: a new line scrolls into view when the reader is already at
 * the bottom; a reader who scrolled up to read the history is left there and gets a "novas
 * mensagens" button instead of being yanked down.
 *
 * Each AI line carries the findings it is about (`ReviewEvent.items`), with the reply of THAT round,
 * so a finding's back-and-forth reads in order: the reviewer opens it, the author answers, the
 * reviewer accepts it or keeps it open.
 */

/** A bubble shows this many findings until "+N itens" is pressed: a round of 8 suggestions stays readable. */
const ITEMS_SHOWN = 4;
/** How close to the bottom (px) still counts as "reading the latest": new lines scroll into view. */
const STICK_PX = 48;

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

  const scroller = React.useRef<HTMLDivElement>(null);
  /** The reader is at the bottom: what arrives next is scrolled into view. */
  const atBottom = React.useRef(true);
  const [unseen, setUnseen] = React.useState(0);
  const lines = review.log.length;
  const linesBefore = React.useRef(lines);
  // What sits at the bottom besides the lines: the "typing" row changes with the turn.
  const bottomKey = `${lines}:${turnKey(turn)}`;

  const toBottom = React.useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(0);
  }, []);

  React.useLayoutEffect(() => {
    const arrived = lines - linesBefore.current;
    linesBefore.current = lines;
    if (atBottom.current) toBottom();
    else if (arrived > 0) setUnseen((n) => n + arrived);
  }, [bottomKey, lines, toBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (atBottom.current) setUnseen(0);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
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
              <RoundDivider key={row.key} round={row.round} />
            ) : (
              <Line key={row.key} event={row.event} findings={findings} names={names} />
            ),
          )
        )}
        <TurnRow turn={turn} names={names} />
      </div>
      {unseen > 0 ? (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/70 bg-card px-3 py-1 text-[11px] font-medium shadow-md transition-colors hover:bg-muted"
        >
          <ArrowDown className="h-3 w-3" />
          {t("review.conversation.unseen", { n: unseen })}
        </button>
      ) : null}
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

function RoundDivider({ round }: { round: number }) {
  const t = useT();
  return (
    <div data-testid="review-round" className="flex items-center gap-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <span className="h-px flex-1 bg-border/60" />
      {t("review.conversation.round", { round })}
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

type Names = { reviewer: string; author: string; merger: string };

/** One line of the log: a bubble for each AI, a centred note for the server and for the people. */
function Line({ event, findings, names }: { event: ReviewEvent; findings: Map<string, Finding>; names: Names }) {
  const t = useT();
  const when = timeOf(event.at);
  if (event.who === "system" || event.who === "human") {
    const human = event.who === "human";
    return (
      <div
        data-testid="review-line"
        data-who={event.who}
        title={when}
        className={cn(
          "mx-auto flex max-w-[92%] items-start gap-1.5 rounded-md px-2.5 py-1 text-center text-[11px] leading-snug",
          human ? "border border-amber-500/25 bg-amber-500/10 text-amber-200" : "text-muted-foreground",
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
    <div data-testid="review-line" data-who={event.who} className={cn("flex", reviewer ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[88%] space-y-1.5 rounded-lg border px-3 py-2 text-xs",
          reviewer ? "rounded-tl-sm border-sky-500/30 bg-sky-500/10" : "rounded-tr-sm border-emerald-500/30 bg-emerald-500/10",
        )}
      >
        <p className={cn("text-[11px] font-semibold", reviewer ? "text-sky-300" : "text-emerald-300")}>
          {t(reviewer ? "review.conversation.reviewer" : "review.conversation.author", { name: reviewer ? names.reviewer : names.author })}
        </p>
        <p className="whitespace-pre-wrap break-words leading-relaxed">{event.text}</p>
        {event.items?.length ? <Items items={event.items} findings={findings} /> : null}
        <p className="text-right text-[10px] text-muted-foreground">{when}</p>
      </div>
    </div>
  );
}

const SEVERITY_TEXT: Record<FindingSeverity, string> = {
  blocking: "text-destructive",
  question: "text-sky-400",
  suggestion: "text-muted-foreground",
  refuted: "text-muted-foreground line-through",
};

const STATUS_CHIP: Record<ReviewEventItem["status"], string> = {
  open: "border-amber-500/30 text-amber-400",
  fixed: "border-emerald-500/30 text-emerald-400",
  contested: "border-sky-500/30 text-sky-400",
  accepted_risk: "border-border/60 text-muted-foreground",
  dropped: "border-border/60 text-muted-foreground",
};

/** The findings a line is about: what it is, where it stands after this line, and what was said of it. */
function Items({ items, findings }: { items: ReviewEventItem[]; findings: Map<string, Finding> }) {
  const t = useT();
  const [all, setAll] = React.useState(false);
  const shown = all ? items : items.slice(0, ITEMS_SHOWN);
  return (
    <div className="space-y-1">
      <ul className="space-y-1 border-l border-border/60 pl-2">
        {shown.map((item) => {
          const finding = findings.get(item.id);
          return (
            <li key={item.id} data-testid="review-line-item" data-status={item.status} className="space-y-0.5">
              <div className="flex items-start gap-1.5">
                <span className={cn("shrink-0 text-[10px] font-semibold uppercase", finding ? SEVERITY_TEXT[finding.severity] : "text-muted-foreground")}>
                  {finding ? t(`review.severity.${finding.severity}`) : item.id}
                </span>
                <span className="min-w-0 flex-1 break-words">{finding?.title ?? item.id}</span>
                <span className={cn("shrink-0 rounded border px-1 text-[10px]", item.isNew ? "border-border/60 text-muted-foreground" : STATUS_CHIP[item.status])}>
                  {item.isNew ? t("review.conversation.newItem") : t(`review.status.${item.status}`)}
                </span>
              </div>
              {item.reply ? <p className="break-words text-[11px] italic text-muted-foreground">“{item.reply}”</p> : null}
              {item.commit ? <code className="font-mono text-[10px] text-muted-foreground">{item.commit.slice(0, 7)}</code> : null}
            </li>
          );
        })}
      </ul>
      {items.length > ITEMS_SHOWN ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {all ? t("review.conversation.less") : t("review.conversation.more", { n: items.length - ITEMS_SHOWN })}
        </button>
      ) : null}
    </div>
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
      <p data-testid="review-turn" data-who="person" className="py-1 text-center text-[11px] text-muted-foreground">
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
    <div data-testid="review-turn" data-who={turn.who} data-working={turn.working} className={cn("flex", reviewer ? "justify-start" : "justify-end")}>
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

function TypingDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-0.5">
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="h-1 w-1 animate-bounce rounded-full bg-current" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  );
}

/** "14:32" today, "29/10 14:32" on another day — in the reader's language. */
function timeOf(at: number): string {
  const date = new Date(at);
  const locale = getLanguage() === "pt-BR" ? "pt-BR" : "en-US";
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })} ${time}`;
}
