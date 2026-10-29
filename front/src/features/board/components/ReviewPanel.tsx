import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { get, post } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { cn } from "@/lib/utils";
import type {
  Finding, FindingSeverity, PeopleResponse, Person, Review, ReviewEvent, ReviewPhase, ReviewResponse,
} from "@/api/types";
import { CARDS_PREFIX_KEY } from "@/features/board/api";
import {
  IMPASSE_ROUNDS, MERGE_CONFIRM_MS, REVIEW_MAX_ROUNDS, REVIEW_POLL_MS, cardPeopleKey, cardReviewKey, findingCounts, mergeFailure,
  pendingQuestions, reviewActions, reviewIsWorking, reviewPill, stuckItems,
} from "@/features/board/lib/review";
import { useAuth } from "@/providers/auth";
import { t as translate, useT } from "@/i18n";

/**
 * The follow-up panel of a PR's review, the column to the right of the card (like the browser's).
 *
 * It READS one thing — the card's review (`GET /api/cards/:id/review`, the active one or the last)
 * — and offers the human moves the server allows, to the people the server lets make them:
 *
 *  - **merge**: the merger and nobody else, only in `ready`. The request waits for CI (up to ~15 min),
 *    so while it is open the button reads "Mergeando…" and the panel KEEPS READING: a proxy that
 *    gives up on the long request is not a refusal, and if the review turns `merged` meanwhile that
 *    is the success;
 *  - **decide** (a doubt: block/drop; a stuck item: keep/accept risk): the reviewer or an owner;
 *  - **try again** (an impasse that is a failure, or an Approve that never got out) and **cancel**.
 *
 * Who may do what is `reviewActions` (the server's own rules), so no button answers 403. While the
 * AIs work (`reviewing`/`fixing`) the review is re-read every 3 s; in every other phase it waits.
 */

/** The feed shows this many of the latest entries until "ver inteira" is pressed. */
const FEED_TAIL = 5;

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

type Decision = "block" | "drop" | "keep" | "accept_risk";

const SEVERITY_TONE: Record<FindingSeverity, string> = {
  blocking: "border-destructive/40 bg-destructive/10 text-destructive",
  suggestion: "border-border/60 bg-card/40 text-muted-foreground",
  question: "border-sky-500/30 bg-sky-500/10 text-sky-400",
  refuted: "border-border/60 bg-card/40 text-muted-foreground",
};

const STATUS_TONE: Record<Finding["status"], string> = {
  open: "text-amber-400",
  fixed: "text-emerald-400",
  contested: "text-sky-400",
  accepted_risk: "text-muted-foreground",
  dropped: "text-muted-foreground",
};

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

  const reviewQuery = useQuery({
    queryKey: key,
    queryFn: () => get<ReviewResponse>(`/cards/${encodeURIComponent(cardId)}/review`).then((r) => r.review),
    refetchInterval: (query) =>
      reviewIsWorking(query.state.data?.phase) || mergeBusy ? REVIEW_POLL_MS : false,
  });
  const review = reviewQuery.data ?? null;

  // The review carries user ids; the roles read better as names. Same key and shape as the request dialog's.
  const people = useQuery({
    queryKey: cardPeopleKey(cardId),
    queryFn: () => get<PeopleResponse>(`/cards/${encodeURIComponent(cardId)}/people`).then((r) => r.people),
  });

  const apply = (next: Review) => {
    qc.setQueryData(key, next);
    // The block in the chat and the line in the sidebar read the card's summary of this review.
    void qc.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
  };
  const reread = () => void qc.invalidateQueries({ queryKey: key });

  /** Decide / retry / cancel: one POST each, the review that comes back is the new truth. */
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: { findingId: string; decision: Decision } }) => {
      const url = `/reviews/${encodeURIComponent(review!.id)}/${path}`;
      return body === undefined ? post<{ review: Review }>(url) : post<{ review: Review }>(url, body);
    },
    onSuccess: (answer) => apply(answer.review),
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

  const actions = reviewActions(review, user ? { id: user.id, isOwner } : null);
  const nameOf = (id: string | undefined) => (id ? (people.data ?? []).find((p: Person) => p.id === id)?.username ?? id : "—");
  const counts = findingCounts(review.findings);
  const stuck = new Set(review.phase === "impasse" ? stuckItems(review.findings).map((f) => f.id) : []);
  const pending = new Set(pendingQuestions(review.findings).map((f) => f.id));
  const busy = act.isPending;

  const decide = (finding: Finding, decision: Decision) => act.mutate({ path: "decide", body: { findingId: finding.id, decision } });
  const cancel = () => {
    if (!window.confirm(t("review.cancel.confirm", { num: review.prNumber }))) return;
    act.mutate({ path: "cancel" });
  };

  const pill = review.phase === "cancelled" ? { key: "review.pill.cancelled", tone: "muted" as const } : reviewPill(review);

  return (
    <PanelFrame
      label={t("review.panel.aria", { n: review.prNumber })}
      onClose={onClose}
      // Pinned under the scrolling list: the merge button is what the whole review is FOR, and it
      // must not end up below the fold of a long list.
      footer={
        <>
          {mergeNote?.kind === "head_moved" ? (
            <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
              {t("review.merge.headMoved")}
            </p>
          ) : null}
          {mergeNote?.kind === "unconfirmed" ? (
            <p role="status" className="rounded-md border border-border/60 bg-card/40 px-2.5 py-1.5 text-xs text-muted-foreground">
              {t(mergeNote.cause === "lost" ? "review.merge.lost" : "review.merge.running")}
            </p>
          ) : null}
          {mergeNote?.kind === "expired" ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {t("review.merge.expired")}
            </p>
          ) : null}
          {mergeNote?.kind === "refused" ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {mergeNote.message}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {actions.merge ? (
              <Button
                type="button"
                size="sm"
                className="h-8 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
                disabled={mergeBusy}
                onClick={() => merge.mutate()}
              >
                {mergeBusy ? (
                  <>
                    <Loader2 className="animate-spin" /> {t("review.merge.pending")}
                  </>
                ) : (
                  t("review.merge", { base: review.base })
                )}
              </Button>
            ) : null}
            {actions.retry ? (
              <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-xs" disabled={busy || mergeBusy} onClick={() => act.mutate({ path: "retry" })}>
                {t("review.retry")}
              </Button>
            ) : null}
            {actions.cancel ? (
              <Button type="button" variant="ghost" size="sm" className="h-8 px-3 text-xs text-muted-foreground" disabled={busy || mergeBusy} onClick={cancel}>
                {t("review.cancel")}
              </Button>
            ) : null}
            <a
              href={review.prUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("review.panel.github")}
            </a>
          </div>
        </>
      }
    >
      <section className="space-y-2 rounded-md border border-border/60 bg-card/40 p-2.5">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-amber-400">PR #{review.prNumber}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">→ {review.base}</span>
          <Badge tone={pill.tone} className="ml-auto shrink-0">
            {t(pill.key, "vars" in pill ? pill.vars : undefined)}
          </Badge>
        </div>
        <Steps round={review.round} phase={review.phase} label={t("review.steps.aria", { round: review.round, max: REVIEW_MAX_ROUNDS })} />
        <p className="text-xs text-muted-foreground">{stageText(review, t)}</p>
        <dl data-testid="review-roles" className="grid grid-cols-2 gap-1.5 text-xs">
          <Role label={t("review.roles.reviewer")} name={nameOf(review.reviewerUserId)} />
          <Role label={t("review.roles.author")} name={nameOf(review.authorUserId)} />
          <Role label={t("review.roles.coauthor")} name={nameOf(review.coauthorUserId)} />
          <Role label={t("review.roles.merger")} name={nameOf(review.mergerUserId)} />
        </dl>
      </section>

      {review.phase === "impasse" ? (
        <p role="status" className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-300">
          {impasseText(review.impasseReason, t)}
        </p>
      ) : null}
      {review.approvePending ? (
        <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
          {t("review.approvePending")}
        </p>
      ) : null}

      <section className="space-y-1.5 rounded-md border border-border/60 bg-card/40 p-2.5">
        <h4 className="text-xs font-semibold">
          {t("review.list.title")} <span className="font-normal text-muted-foreground">· {countsText(counts, t)}</span>
        </h4>
        {review.findings.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("review.list.empty")}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {review.findings.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                busy={busy}
                // Doubts wait for the human reviewer; in an impasse the stuck items wait for the same person.
                decisions={
                  !actions.decide
                    ? []
                    : pending.has(f.id)
                      ? ["block", "drop"]
                      : stuck.has(f.id)
                        ? f.severity === "blocking" ? ["keep", "accept_risk"] : ["accept_risk"]
                        : []
                }
                onDecide={(decision) => decide(f, decision)}
              />
            ))}
          </ul>
        )}
      </section>

      <Feed log={review.log} />

      <Verdict review={review} />
    </PanelFrame>
  );
}

/** The column: the way out on top, the scrollable body, and the pinned footer (the human moves). */
function PanelFrame({
  label, onClose, footer, children,
}: {
  label: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <section
      aria-label={label}
      data-testid="review-panel"
      className="flex min-h-[220px] min-w-0 flex-1 flex-col gap-2 rounded-md border border-border/60 bg-card/30 p-2.5 text-sm"
    >
      <div className="flex shrink-0 items-center justify-end">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">{children}</div>
      {footer ? <div className="flex shrink-0 flex-col gap-2 border-t border-border/50 pt-2">{footer}</div> : null}
    </section>
  );
}

/** Three segments, one per round: the ones behind are done, the one in play is lit, the rest wait. */
function Steps({ round, phase, label }: { round: number; phase: Review["phase"]; label: string }) {
  const over = phase === "ready" || phase === "merged";
  return (
    <div data-testid="review-steps" role="img" aria-label={label} className="grid grid-cols-3 gap-1">
      {Array.from({ length: REVIEW_MAX_ROUNDS }, (_, i) => {
        const state = i + 1 < round || (over && i + 1 === round) ? "done" : i + 1 === round ? "current" : "todo";
        return (
          <div
            key={i}
            data-testid="review-step"
            data-state={state}
            className={cn(
              "h-1.5 rounded-full",
              state === "done" ? "bg-emerald-500/70" : state === "current" ? "bg-amber-400" : "bg-border/70",
            )}
          />
        );
      })}
    </div>
  );
}

function Role({ label, name }: { label: string; name: string }) {
  return (
    <div className="min-w-0 rounded-md bg-background/40 px-2 py-1">
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{name}</dd>
    </div>
  );
}

/**
 * One finding of the closed list. Struck through when the verification refuted it; the replies of the
 * two AIs sit folded under the row, and the human's buttons (when they have any) under those.
 */
function FindingRow({
  finding: f, decisions, busy, onDecide,
}: {
  finding: Finding;
  decisions: Decision[];
  busy: boolean;
  onDecide: (decision: Decision) => void;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const replies = [
    f.authorReply ? { who: "author" as const, text: f.authorReply } : null,
    f.reviewerReply ? { who: "reviewer" as const, text: f.reviewerReply } : null,
  ].filter((r): r is { who: "author" | "reviewer"; text: string } => r !== null);
  const refuted = f.severity === "refuted";

  return (
    <li data-testid="finding" data-severity={f.severity} data-status={f.status} className="space-y-1 py-2 text-xs first:pt-0 last:pb-0">
      <div className="flex items-start gap-2">
        <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold", SEVERITY_TONE[f.severity])}>
          {t(`review.severity.${f.severity}`)}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className={cn("break-words font-medium", refuted && "text-muted-foreground line-through")}>{f.title}</p>
          {f.file ? (
            <p className="break-all font-mono text-[11px] text-muted-foreground">{f.line !== undefined ? `${f.file}:${f.line}` : f.file}</p>
          ) : null}
          {f.proof ? (
            <p className="text-[11px] text-muted-foreground">
              <span>{t(`review.proof.${f.proof.kind}`)}</span> <span className="break-all font-mono">{f.proof.ref}</span>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className={cn("text-[11px] font-medium", STATUS_TONE[f.status])}>{t(`review.status.${f.status}`)}</span>
          {f.commit ? <code className="font-mono text-[10px] text-muted-foreground">{f.commit.slice(0, 7)}</code> : null}
        </div>
      </div>

      {replies.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("review.replies", { n: replies.length })}
          </button>
          {open ? (
            <ul className="mt-1 space-y-1 border-l border-border/60 pl-2">
              {replies.map((r) => (
                <li key={r.who} className="break-words text-[11px]">
                  <span className="font-semibold">{t(`review.reply.${r.who}`)}</span> <span>{r.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {decisions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {decisions.map((d) => (
            <Button
              key={d}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy}
              onClick={() => onDecide(d)}
            >
              {t(`review.decide.${d}`)}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** "Conversa das IAs": the latest entries, and the whole of it on request. */
function Feed({ log }: { log: ReviewEvent[] }) {
  const t = useT();
  const [all, setAll] = React.useState(false);
  const shown = all ? log : log.slice(-FEED_TAIL);
  return (
    <section data-testid="review-feed" className="space-y-1.5 rounded-md border border-border/60 bg-card/40 p-2.5">
      <h4 className="flex items-center justify-between text-xs font-semibold">
        {t("review.feed.title")}
        {log.length > FEED_TAIL ? (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="text-[11px] font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {all ? t("review.feed.last") : t("review.feed.all")}
          </button>
        ) : null}
      </h4>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("review.feed.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {shown.map((e, i) => (
            <li key={`${e.at}-${i}`} className="break-words text-xs">
              <b className="mr-1 font-semibold">{t(`review.feed.who.${e.who}`)}</b>
              <span className="text-muted-foreground">{e.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Where the review ended up, when it did: ready to merge, merged, or called off. */
function Verdict({ review }: { review: Review }) {
  const t = useT();
  if (review.phase === "merged") return <VerdictBox tone="ok">{t("review.panel.merged", { base: review.base })}</VerdictBox>;
  if (review.phase === "cancelled") return <VerdictBox tone="muted">{t("review.panel.cancelled")}</VerdictBox>;
  if (review.phase !== "ready") return null;

  const blocking = review.findings.filter((f) => f.severity === "blocking");
  const resolved = blocking.filter((f) => f.status !== "open" && f.status !== "contested").length;
  const suggestions = review.findings.filter((f) => f.severity === "suggestion" && f.status === "open").length;
  return (
    <VerdictBox tone="ok">
      {blocking.length > 0 ? t("review.verdict.ready", { resolved, total: blocking.length }) : t("review.verdict.readyNone")}
      {suggestions > 0 ? ` ${t("review.verdict.suggestions", { n: suggestions })}` : ""}
    </VerdictBox>
  );
}

function VerdictBox({ tone, children }: { tone: "ok" | "muted"; children: React.ReactNode }) {
  return (
    <div
      data-testid="review-verdict"
      className={cn(
        "rounded-md border px-2.5 py-2 text-xs",
        tone === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-border/60 bg-card/40 text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** One sentence on whose turn it is. */
function stageText(review: Review, t: typeof translate): string {
  switch (review.phase) {
    case "reviewing":
      return review.round > 1
        ? t("review.stage.reviewing.next", { prev: review.round - 1 })
        : t("review.stage.reviewing.first");
    case "fixing":
      return t("review.stage.fixing");
    case "ready":
      return t("review.stage.ready");
    case "impasse":
      return t("review.stage.impasse");
    case "merged":
      return t("review.stage.merged");
    default:
      return t("review.stage.cancelled");
  }
}

/** "rodadas" is the model's code; every other reason is already written for people and shown as it is. */
function impasseText(reason: string | undefined, t: typeof translate): string {
  if (reason === IMPASSE_ROUNDS) return t("review.impasse.rodadas", { max: REVIEW_MAX_ROUNDS });
  return reason?.trim() || t("review.impasse.unknown");
}

/** "3 bloqueiam · 1 sugestão · 1 derrubado", from the data; zeros stay out. */
function countsText(counts: ReturnType<typeof findingCounts>, t: typeof translate): string {
  const parts = (["blocking", "suggestion", "question", "refuted"] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => t(`review.count.${severity}`, { n: counts[severity] }));
  return parts.length > 0 ? parts.join(" · ") : t("review.list.empty");
}

/** The words for a merge the server refused: its own text for the codes with one, the server's otherwise. */
function refusalText(reason: string | undefined, message: string, error: unknown): string {
  if (reason === "merger_sem_github") return translate("review.merge.error.merger_sem_github");
  if (reason === "not_ready") return translate("review.merge.error.not_ready");
  return message ? apiErrorMessage(error) : translate("error.generic");
}
