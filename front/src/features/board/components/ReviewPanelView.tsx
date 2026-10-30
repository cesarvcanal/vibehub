import * as React from "react";
import { Link } from "react-router-dom";
import { ExternalLink, FileDiff, Loader2, SquareTerminal, X } from "lucide-react";
import { BADGE_TEXT, Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Finding, FindingSeverity, Review, ReviewPhase, ReviewWorking } from "@/api/types";
import { ReviewConversation } from "@/features/board/components/ReviewConversation";
import { cardHref } from "@/features/board/lib/board";
import {
  FINDING_SEVERITY_TONE, FINDING_STATUS_TONE, IMPASSE_ROUNDS, REVIEW_MAX_ROUNDS, awaitingDecision, findingCounts, findingIsOpen,
  pendingQuestions, reviewIsOpen, reviewPill, reviewTurn, stuckItems, type ReviewActions,
} from "@/features/board/lib/review";
import { t as translate, useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * What the PR review's panel DRAWS, from props alone: the review, who is working right now, who may
 * do what, and the callbacks of the human moves. `ReviewPanel` reads the server and runs the merge;
 * this draws — which is what lets every state be seen in the Storybook without a back-end.
 *
 *   ┌ header ─ PR #N → base · pill · close; the rounds; what is happening now; the people ┐
 *   │ [ Conversa ]  [ Achados N ]                                                         │
 *   │ the conversation of the AIs (chat)  |  the closed list, grouped by severity         │
 *   └ footer ─ merge · try again · cancel · GitHub; the reviewer's session · the diff     ┘
 *
 * Both tabs stay mounted (the hidden one with `hidden`): switching back to the conversation finds it
 * scrolled where it was. Until the person picks one, the panel shows the findings while they have a
 * decision to make there, and the conversation otherwise.
 */

export type Decision = "block" | "drop" | "keep" | "accept_risk";
type Tab = "conversation" | "findings";

/** A banner over the footer's buttons: what the last merge click came to. */
export interface PanelNotice {
  tone: "warn" | "muted" | "error";
  text: string;
}

export interface ReviewPanelViewProps {
  review: Review;
  working: ReviewWorking;
  /** A user id to the name people know them by. */
  nameOf: (userId: string | undefined) => string;
  actions: ReviewActions;
  /** A decide / retry / cancel request is open: those buttons wait. */
  busy: boolean;
  /** A merge request is open, or its answer is not known yet: the merge button reads "Mergeando…". */
  mergeBusy: boolean;
  notice?: PanelNotice | null;
  onMerge: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onDecide: (finding: Finding, decision: Decision) => void;
  onClose: () => void;
}

export function ReviewPanelView(props: ReviewPanelViewProps) {
  const { review, working, nameOf, actions, busy, mergeBusy, notice, onMerge, onRetry, onCancel, onDecide, onClose } = props;
  const t = useT();
  const stuck = new Set(review.phase === "impasse" ? stuckItems(review.findings).map((f) => f.id) : []);
  const pending = new Set(pendingQuestions(review.findings).map((f) => f.id));
  const decisionsHere = actions.decide ? review.findings.filter((f) => pending.has(f.id) || stuck.has(f.id)).length : 0;
  // Until the person picks a tab, the panel shows where their attention is needed: the findings while
  // they have a decision to make there (it can appear later — a round landing with a doubt), the
  // conversation otherwise.
  const [chosen, setTab] = React.useState<Tab | null>(null);
  const tab: Tab = chosen ?? (decisionsHere > 0 ? "findings" : "conversation");
  // The author's AI is on a PR that was ready: what it pushes goes back to the reviewer, so the merge
  // waits for it to finish instead of racing it.
  const authorOnReadyPr = review.phase === "ready" && working.author;

  const decisionsFor = (f: Finding): Decision[] => {
    if (!actions.decide) return [];
    // Doubts wait for the human reviewer; in an impasse the stuck items wait for the same person.
    if (pending.has(f.id)) return ["block", "drop"];
    if (stuck.has(f.id)) return f.severity === "blocking" ? ["keep", "accept_risk"] : ["accept_risk"];
    return [];
  };

  return (
    <PanelFrame
      label={t("review.panel.aria", { n: review.prNumber })}
      header={<Header review={review} working={working} nameOf={nameOf} onClose={onClose} />}
      footer={
        <Footer
          review={review}
          actions={actions}
          busy={busy}
          mergeBusy={mergeBusy}
          holdMerge={authorOnReadyPr}
          notice={notice}
          onMerge={onMerge}
          onRetry={onRetry}
          onCancel={onCancel}
        />
      }
    >
      {review.phase === "impasse" ? (
        <p role="status" className="shrink-0 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-300">
          {impasseText(review.impasseReason, t)}
        </p>
      ) : null}
      {review.approvePending ? (
        <p role="status" className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
          {t("review.approvePending")}
        </p>
      ) : null}
      {authorOnReadyPr ? null : <Verdict review={review} />}

      <div role="tablist" aria-label={t("review.panel.aria", { n: review.prNumber })} className="flex shrink-0 gap-1 rounded-md border border-border/60 bg-background/40 p-0.5">
        <TabButton active={tab === "conversation"} onClick={() => setTab("conversation")}>
          {t("review.tab.conversation")}
        </TabButton>
        <TabButton active={tab === "findings"} onClick={() => setTab("findings")}>
          {t("review.tab.findings")}
          <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">{review.findings.length}</span>
          {decisionsHere > 0 ? <span aria-label={t("review.tab.decisions", { n: decisionsHere })} className="h-1.5 w-1.5 rounded-full bg-sky-400" /> : null}
        </TabButton>
      </div>

      <div role="tabpanel" hidden={tab !== "conversation"} className={cn("min-h-0 flex-1 flex-col", tab === "conversation" ? "flex" : "hidden")}>
        <ReviewConversation review={review} working={working} nameOf={nameOf} />
      </div>
      <div role="tabpanel" hidden={tab !== "findings"} className={cn("min-h-0 flex-1 overflow-y-auto", tab !== "findings" && "hidden")}>
        <FindingsList review={review} busy={busy} decisionsFor={decisionsFor} onDecide={onDecide} />
      </div>
    </PanelFrame>
  );
}

/** The column: a fixed header, the body (whose tabs scroll themselves), and the pinned footer. */
export function PanelFrame({
  label, header, footer, onClose, children,
}: {
  label: string;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** Without a header of its own, the frame draws just the way out. */
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-testid="review-panel"
      className="flex min-h-[220px] min-w-0 flex-1 flex-col gap-2 rounded-md border border-border/60 bg-card/30 p-2.5 text-sm"
    >
      {header ?? (onClose ? <div className="flex shrink-0 justify-end"><CloseButton onClose={onClose} /></div> : null)}
      <div className="flex min-h-0 flex-1 flex-col gap-2">{children}</div>
      {footer ? <div className="flex shrink-0 flex-col gap-2 border-t border-border/50 pt-2">{footer}</div> : null}
    </section>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0 text-muted-foreground"
      aria-label={t("common.close")}
      title={t("common.close")}
      onClick={onClose}
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  );
}

/** PR and base, where it stands (the pill and the rounds), what is happening right now, and the people. */
function Header({
  review, working, nameOf, onClose,
}: {
  review: Review;
  working: ReviewWorking;
  nameOf: (userId: string | undefined) => string;
  onClose: () => void;
}) {
  const t = useT();
  const pill = review.phase === "cancelled"
    ? { key: "review.pill.cancelled", tone: "muted" as const }
    : reviewPill(review, { authorWorking: working.author });
  const turn = reviewTurn(review, working);
  const live = (turn.who === "reviewer" || turn.who === "author") && turn.working;
  return (
    <section className="shrink-0 space-y-2 rounded-md border border-border/60 bg-card/40 p-2.5">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-amber-400">PR #{review.prNumber}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">→ {review.base}</span>
        <Badge tone={pill.tone} className="ml-auto shrink-0">
          {t(pill.key, "vars" in pill ? pill.vars : undefined)}
        </Badge>
        <CloseButton onClose={onClose} />
      </div>
      <Steps round={review.round} phase={review.phase} />
      <Commits reviewed={review.reviewedSha} head={review.prHeadSha} />
      <p data-testid="review-now" className="flex items-start gap-2 text-xs">
        <span
          aria-hidden
          className={cn(
            "mt-1 h-2 w-2 shrink-0 rounded-full",
            live ? "animate-pulse bg-amber-400" : turn.who === "person" ? "bg-sky-400" : "bg-muted-foreground/50",
          )}
        />
        <span className="text-foreground/90">{stageText(review, working.author, t)}</span>
      </p>
      <dl data-testid="review-roles" className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <Role
          label={t("review.roles.reviewer")}
          hint={t("review.roles.reviewer.hint")}
          name={nameOf(review.reviewerUserId)}
          tag={t("review.roles.reviewer.tag")}
        />
        <Role
          label={t("review.roles.author")}
          hint={t("review.roles.author.hint")}
          name={nameOf(review.authorUserId)}
          tag={t("review.roles.assignee")}
        />
        {review.coauthorUserId ? (
          <Role
            label={t("review.roles.coauthor")}
            hint={t("review.roles.coauthor.hint")}
            name={nameOf(review.coauthorUserId)}
            tag={t("review.roles.coauthor.tag")}
          />
        ) : null}
        <Role label={t("review.roles.merger")} hint={t("review.roles.merger.hint")} name={nameOf(review.mergerUserId)} />
      </dl>
    </section>
  );
}

/**
 * Which commit the reviewer approved, and — when the PR moved after it — which one the PR is on now:
 * the "is what I am about to merge what was reviewed?" question, answered before anybody presses merge.
 */
function Commits({ reviewed, head }: { reviewed?: string; head?: string }) {
  const t = useT();
  if (!reviewed) return null;
  const moved = head !== undefined && head !== reviewed;
  return (
    <p data-testid="review-commits" className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
      <span>
        {t("review.commits.reviewed")} <code className="font-mono text-foreground/80">{reviewed.slice(0, 7)}</code>
      </span>
      {moved ? (
        <span className="text-amber-300">
          {t("review.commits.moved")} <code className="font-mono">{head.slice(0, 7)}</code>
        </span>
      ) : null}
    </p>
  );
}

/** One segment per round — behind: done; in play: lit; ahead: waiting — with "Rodada N de 3" beside it. */
function Steps({ round, phase }: { round: number; phase: ReviewPhase }) {
  const t = useT();
  const over = phase === "ready" || phase === "merged";
  return (
    <div className="flex items-center gap-2">
      <div
        data-testid="review-steps"
        role="img"
        aria-label={t("review.steps.aria", { round, max: REVIEW_MAX_ROUNDS })}
        className="grid flex-1 grid-cols-3 gap-1"
      >
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
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {t("review.steps.aria", { round, max: REVIEW_MAX_ROUNDS })}
      </span>
    </div>
  );
}

/** A role and who holds it; hovering says what the role DOES (and what GitHub calls it, when it has a name there). */
function Role({ label, hint, name, tag }: { label: string; hint: string; name: string; tag?: string }) {
  return (
    <div title={hint} className="flex min-w-0 cursor-help items-baseline gap-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-1">
        <span className="truncate font-medium">{name}</span>
        {tag ? <span className="shrink-0 rounded border border-border/60 px-1 text-[9px] text-muted-foreground">{tag}</span> : null}
      </dd>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
        active ? "bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** The closed list in the order that matters: what blocks, what a person must decide, the suggestions, what fell. */
const GROUPS: FindingSeverity[] = ["blocking", "question", "suggestion", "refuted"];

function FindingsList({
  review, busy, decisionsFor, onDecide,
}: {
  review: Review;
  busy: boolean;
  decisionsFor: (f: Finding) => Decision[];
  onDecide: (finding: Finding, decision: Decision) => void;
}) {
  const t = useT();
  if (review.findings.length === 0) {
    return <p className="py-6 text-center text-xs text-muted-foreground">{t("review.list.empty")}</p>;
  }
  return (
    <div className="space-y-3 py-1 pr-1">
      <p className="text-[11px] text-muted-foreground">{countsText(findingCounts(review.findings), t)}</p>
      {GROUPS.map((severity) => {
        const items = review.findings.filter((f) => f.severity === severity);
        if (items.length === 0) return null;
        const open = items.filter(findingIsOpen).length;
        return (
          <section key={severity} data-testid="finding-group" data-severity={severity} className="space-y-1">
            <h4 className="flex items-baseline justify-between pr-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t(`review.group.${severity}`)}
              <span className="font-normal normal-case tracking-normal">
                {t("review.group.state", { open, done: items.length - open })}
              </span>
            </h4>
            <ul className="divide-y divide-border/50 rounded-md border border-border/60 bg-card/40 px-2.5">
              {items.map((f) => (
                <FindingRow key={f.id} finding={f} busy={busy} decisions={decisionsFor(f)} onDecide={(d) => onDecide(f, d)} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * One finding of the closed list. Struck through when the verification refuted it; the latest reply
 * of each AI sits folded under the row (the whole back-and-forth is in the conversation), and the
 * human's buttons, when they have any, under those.
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
  const closed = !findingIsOpen(f);

  return (
    <li data-testid="finding" data-severity={f.severity} data-status={f.status} className="space-y-1 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Badge tone={FINDING_SEVERITY_TONE[f.severity]} className="shrink-0 px-1.5 text-[10px] font-semibold">
          {t(`review.severity.${f.severity}`)}
        </Badge>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className={cn("break-words font-medium", (refuted || closed) && "text-muted-foreground", refuted && "line-through")}>{f.title}</p>
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
          <span className={cn("text-[11px] font-medium", BADGE_TEXT[FINDING_STATUS_TONE[f.status]])}>{t(`review.status.${f.status}`)}</span>
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
        <div className="space-y-1 rounded-md border border-sky-500/30 bg-sky-500/5 p-2">
          <p className="text-[11px] text-sky-200">{t(decisions.includes("block") ? "review.decide.hint.question" : "review.decide.hint.stuck")}</p>
          <div className="flex flex-wrap gap-1.5">
            {decisions.map((d) => (
              <Button key={d} type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onDecide(d)}>
                {t(`review.decide.${d}`)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Where the review ended up, when it did: ready to merge, merged, or called off. */
function Verdict({ review }: { review: Review }) {
  const t = useT();
  if (review.phase === "merged") return <VerdictBox tone="ok">{t("review.panel.merged", { base: review.base })}</VerdictBox>;
  if (review.phase === "cancelled") return <VerdictBox tone="muted">{t("review.panel.cancelled")}</VerdictBox>;
  if (review.phase !== "ready") return null;

  const blocking = review.findings.filter((f) => f.severity === "blocking");
  const resolved = blocking.filter((f) => !findingIsOpen(f)).length;
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
        "shrink-0 rounded-md border px-2.5 py-1.5 text-xs",
        tone === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-border/60 bg-card/40 text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

const NOTICE_TONE: Record<PanelNotice["tone"], string> = {
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  muted: "border-border/60 bg-card/40 text-muted-foreground",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};

/** The human moves, pinned under the body: the merge is what the whole review is FOR. */
function Footer({
  review, actions, busy, mergeBusy, holdMerge, notice, onMerge, onRetry, onCancel,
}: {
  review: Review;
  actions: ReviewActions;
  busy: boolean;
  mergeBusy: boolean;
  /** The author's AI is working on the ready PR: the merge waits for it. */
  holdMerge: boolean;
  notice?: PanelNotice | null;
  onMerge: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <>
      {holdMerge && actions.merge ? (
        <p role="status" className={cn("rounded-md border px-2.5 py-1.5 text-xs", NOTICE_TONE.warn)}>
          {t("review.merge.authorWorking")}
        </p>
      ) : null}
      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={cn("rounded-md border px-2.5 py-1.5 text-xs", NOTICE_TONE[notice.tone])}>
          {notice.text}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {actions.merge ? (
          <Button
            type="button"
            size="sm"
            className="h-8 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
            disabled={mergeBusy || holdMerge}
            onClick={onMerge}
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
          <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-xs" disabled={busy || mergeBusy} onClick={onRetry}>
            {t("review.retry")}
          </Button>
        ) : null}
        {actions.cancel ? (
          <Button type="button" variant="ghost" size="sm" className="h-8 px-3 text-xs text-muted-foreground" disabled={busy || mergeBusy} onClick={onCancel}>
            {t("review.cancel")}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* The reviewer's card is off the board: this is the one way to its terminal, to unstick an
            AI caught in a menu or an error loop. A closed review sends it to done (and the retention
            erases it), so the link goes with the review. */}
        {reviewIsOpen(review.phase) ? (
          <Link
            to={cardHref(review.projectId, review.reviewerCardId)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <SquareTerminal className="h-3.5 w-3.5" />
            {t("review.panel.reviewerSession")}
          </Link>
        ) : null}
        <a
          href={`${review.prUrl}/files`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <FileDiff className="h-3.5 w-3.5" />
          {t("review.panel.diff")}
        </a>
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
  );
}

/** One sentence on what is happening now: whose turn it is, or what the review waits for. */
function stageText(review: Review, authorWorking: boolean, t: typeof translate): string {
  switch (review.phase) {
    case "reviewing":
      if (awaitingDecision(review)) return t("review.stage.decision");
      return review.round > 1
        ? t("review.stage.reviewing.next", { prev: review.round - 1 })
        : t("review.stage.reviewing.first");
    case "fixing":
      return t("review.stage.fixing");
    case "ready":
      return authorWorking ? t("review.stage.authorWorking") : t("review.stage.ready");
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
  const parts = GROUPS.filter((severity) => counts[severity] > 0).map((severity) => t(`review.count.${severity}`, { n: counts[severity] }));
  return parts.length > 0 ? parts.join(" · ") : t("review.list.empty");
}
