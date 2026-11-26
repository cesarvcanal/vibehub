import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CirclePause, GitMerge, Loader2, MessageCircleQuestion, RotateCcw, X } from "lucide-react";
import { Badge, BADGE_TEXT, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ANALYSIS_DIMENSIONS, type AnalysisFinding, type AnalysisReadModel, type AnalysisSeverity, type AnalysisVerdict,
  type DimensionHealth,
} from "@/api/types";
import * as React from "react";
import { AnalysisConversation } from "@/features/board/components/AnalysisConversation";
import { Markdown } from "@/features/board/components/ChatView";
import { PanelFrame, TabButton } from "@/features/board/components/ReviewPanelView";
import { boardApi } from "@/features/board/api";
import { analysisProgress, cardAnalysisKey, type AnalysisProgress } from "@/features/board/lib/analysis";
import type { CardState } from "@/features/board/lib/board";
import { mergeFailure } from "@/features/board/lib/review";
import { useCardAnalysis } from "@/features/board/lib/useCardAnalysis";
import { apiErrorMessage } from "@/lib/apiError";
import { useT, type Translate } from "@/i18n";
import { cn } from "@/lib/utils";

const SEVERITY_ORDER: readonly AnalysisSeverity[] = ["blocking", "improvement", "question", "suggestion"];

const HEALTH_TONE: Record<DimensionHealth, BadgeTone> = {
  ok: "ok",
  attention: "warn",
  problem: "critical",
  not_run: "critical",
  skipped: "muted",
};

const VERDICT_TONE: Record<AnalysisVerdict, BadgeTone> = { apt: "ok", not_apt: "critical", pending: "info" };

function mergeRefusalTitle(reason: string, t: Translate): string {
  if (reason === "gate") return t("analysis.merge.refused.gate");
  if (reason === "no_ci") return t("analysis.merge.refused.noCi");
  if (reason === "conflict") return t("analysis.merge.refused.conflict");
  return t("analysis.merge.refused.other");
}

export function AnalysisPanel({ cardId, cardState, onClose }: { cardId: string; cardState?: CardState; onClose: () => void }) {
  const t = useT();
  const analysisQuery = useCardAnalysis(cardId, { enabled: true });
  const [tab, setTab] = React.useState<"report" | "conversation">("conversation");
  const read = analysisQuery.data;
  const progress = read?.analysis && cardState ? analysisProgress(read.verdict, cardState.kind) : null;
  const header = (
    <div className="flex shrink-0 items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-sm font-semibold">
          {read?.analysis ? t("analysis.panel.title", { n: read.analysis.prNumber }) : t("analysis.panel.label")}
        </h2>
        {read?.analysis ? (
          <p className="font-mono text-[11px] text-muted-foreground">{t("analysis.panel.head", { sha: read.analysis.analysedSha.slice(0, 7) })}</p>
        ) : null}
      </div>
      {read?.analysis ? <VerdictBadge read={read} /> : null}
      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={t("analysis.panel.close")} onClick={onClose}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <PanelFrame label={t("analysis.panel.label")} header={header}>
      {progress ? <FixProgress progress={progress} summary={cardState?.summary} /> : null}
      {read?.analysis ? <AnalysisMerge cardId={cardId} read={read} rereading={analysisQuery.isFetching} /> : null}
      <div role="tablist" aria-label={t("analysis.panel.label")} className="flex shrink-0 gap-1 rounded-md border border-border/60 bg-background/40 p-0.5">
        <TabButton active={tab === "conversation"} onClick={() => setTab("conversation")}>{t("analysis.tab.conversation")}</TabButton>
        <TabButton active={tab === "report"} onClick={() => setTab("report")}>{t("analysis.tab.report")}</TabButton>
      </div>
      <div role="tabpanel" hidden={tab !== "report"} className={cn("min-h-0 flex-1 flex-col gap-3", tab === "report" ? "flex" : "hidden")}>
        {analysisQuery.isPending ? <p className="text-xs text-muted-foreground">{t("common.loading")}</p> : null}
        {analysisQuery.isError ? <p className="text-xs text-destructive">{apiErrorMessage(analysisQuery.error)}</p> : null}
        {read && !read.analysis ? <p className="text-xs text-muted-foreground">{t("analysis.panel.empty")}</p> : null}
        {read?.analysis ? <AnalysisBody read={read} /> : null}
      </div>
      {tab === "conversation" ? (
        <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
          <AnalysisConversation cardId={cardId} read={read?.analysis ? read : undefined} cardState={cardState?.kind} />
        </div>
      ) : null}
    </PanelFrame>
  );
}

const FIX_PROGRESS_ICON_CLASS = "h-3.5 w-3.5 shrink-0";

const WORKING_TONE = "border-sky-500/30 bg-sky-500/10 text-sky-300";

const FIX_PROGRESS: Record<AnalysisProgress, { icon: React.ReactNode; tone: string; textKey: string }> = {
  working: {
    icon: <Loader2 aria-hidden className={cn(FIX_PROGRESS_ICON_CLASS, "animate-spin")} />,
    tone: WORKING_TONE,
    textKey: "analysis.progress.working",
  },
  workingAfterReport: {
    icon: <Loader2 aria-hidden className={cn(FIX_PROGRESS_ICON_CLASS, "animate-spin")} />,
    tone: WORKING_TONE,
    textKey: "analysis.progress.workingAfterReport",
  },
  needsMe: {
    icon: <MessageCircleQuestion aria-hidden className={FIX_PROGRESS_ICON_CLASS} />,
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    textKey: "analysis.progress.needsMe",
  },
  stopped: {
    icon: <CirclePause aria-hidden className={FIX_PROGRESS_ICON_CLASS} />,
    tone: "border-border/60 bg-background/40 text-muted-foreground",
    textKey: "analysis.progress.stopped",
  },
};

function FixProgress({ progress, summary }: { progress: AnalysisProgress; summary?: string }) {
  const t = useT();
  const { icon, tone, textKey } = FIX_PROGRESS[progress];
  return (
    <div
      role="status"
      aria-label={t("analysis.progress.label")}
      className={cn("flex shrink-0 flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-xs", tone)}
    >
      <p className="flex items-center gap-1.5">{icon} {t(textKey)}</p>
      {summary ? <p className="pl-5 text-foreground/80">{summary}</p> : null}
    </div>
  );
}

function VerdictBadge({ read }: { read: AnalysisReadModel }) {
  const t = useT();
  if (read.analysis.stage === "fleet_unavailable") return <Badge tone="critical">{t("analysis.verdict.fleetUnavailable")}</Badge>;
  return <Badge tone={VERDICT_TONE[read.verdict]}>{t(`analysis.verdict.${read.verdict}`)}</Badge>;
}

function AnalysisMerge({ cardId, read, rereading }: { cardId: string; read: AnalysisReadModel; rereading: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const rereadAnalysis = () => queryClient.invalidateQueries({ queryKey: cardAnalysisKey(cardId) });
  const merge = useMutation({ mutationFn: () => boardApi.mergeCardAnalysis(cardId), onSettled: rereadAnalysis });
  const rerunGate = useMutation({ mutationFn: () => boardApi.rerunCardAnalysisMergeGate(cardId), onSettled: rereadAnalysis });
  const prNumber = read.analysis.prNumber;
  if (merge.isSuccess) return <p className={`text-xs ${BADGE_TEXT.ok}`}>{t("analysis.merge.done", { n: prNumber })}</p>;
  if (read.mergedAt !== undefined) return <p className={`text-xs ${BADGE_TEXT.ok}`}>{t("analysis.merge.merged", { n: prNumber })}</p>;
  if (!read.canMerge) return null;
  const merging = merge.isPending || read.merging;
  const gateState = read.mergeGate?.state;
  if (gateState === "failed" && !merging) {
    return (
      <div role="alert" className="flex shrink-0 flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
        <p className="font-medium text-destructive">{t(read.mergeGate?.noCi ? "analysis.mergeGate.noCi" : "analysis.mergeGate.failed")}</p>
        {read.mergeGate?.output ? (
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{read.mergeGate.output}</pre>
        ) : null}
        <Button type="button" size="sm" variant="outline" className="self-start" disabled={rerunGate.isPending} onClick={() => rerunGate.mutate()}>
          {rerunGate.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          {t("analysis.mergeGate.rerun")}
        </Button>
        {rerunGate.isError ? <p className="whitespace-pre-wrap text-destructive">{apiErrorMessage(rerunGate.error)}</p> : null}
      </div>
    );
  }
  const gateRunning = gateState === "running" && !merging;
  const failure = merge.isError ? mergeFailure(merge.error) : undefined;
  const refusedByClick = failure?.kind === "refused" ? apiErrorMessage(merge.error) : undefined;
  const refusal = merging || refusedByClick ? undefined : read.lastMergeRefusal;
  const answerLost = failure?.kind === "lost" || failure?.kind === "running";
  const unconfirmed = answerLost && !merging && !rereading && !refusal;
  const mergeBlocked = merging || gateRunning;
  const mergeLabel = (): string => {
    if (merging) return t("analysis.merge.pending");
    if (gateRunning) return t("analysis.mergeGate.runningButton");
    return t(refusal ? "analysis.merge.retry" : "analysis.merge", { n: prNumber });
  };
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      {gateRunning ? (
        <p role="status" className="flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-300">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> {t("analysis.mergeGate.running")}
        </p>
      ) : null}
      {gateState === "passed" && read.mergeGate?.sha && !merging ? (
        <p className={`text-xs ${BADGE_TEXT.ok}`}>{t("analysis.mergeGate.passed", { sha: read.mergeGate.sha.slice(0, 7) })}</p>
      ) : null}
      {refusal ? (
        <div role="alert" className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
          <p className="font-medium text-destructive">{mergeRefusalTitle(refusal.reason, t)}</p>
          {refusal.output && refusal.reason !== "conflict" ? (
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{refusal.output}</pre>
          ) : null}
        </div>
      ) : null}
      <Button type="button" size="sm" className="self-start" disabled={mergeBlocked} onClick={() => merge.mutate()}>
        {mergeBlocked ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
        {mergeLabel()}
      </Button>
      {merging ? <p className="text-xs text-muted-foreground">{t("analysis.merge.running")}</p> : null}
      {refusedByClick ? <p className="whitespace-pre-wrap text-xs text-destructive">{refusedByClick}</p> : null}
      {unconfirmed ? <p role="alert" className="text-xs text-destructive">{t("analysis.merge.unconfirmed")}</p> : null}
    </div>
  );
}

function AnalysisBody({ read }: { read: AnalysisReadModel }) {
  const t = useT();
  const { analysis } = read;
  if (analysis.stage === "fleet_unavailable") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <p className="text-sm font-medium">{t("analysis.fleet.title")}</p>
        <p className="text-muted-foreground">{t("analysis.fleet.body")}</p>
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t("analysis.fleet.reason")}</dt>
          <dd className="font-mono">{analysis.unavailableReason}</dd>
          <dt className="text-muted-foreground">{t("analysis.fleet.action")}</dt>
          <dd>{t("analysis.fleet.actionText")}</dd>
        </dl>
      </div>
    );
  }
  const openFindings = analysis.findings.filter((finding) => finding.status === "open");
  const counts = [
    { key: "analysis.count.fixed", n: analysis.findings.filter((finding) => finding.status === "fixed").length },
    { key: "analysis.count.questions", n: openFindings.filter((finding) => finding.severity === "question").length },
    { key: "analysis.count.suggestions", n: openFindings.filter((finding) => finding.severity === "suggestion").length },
    { key: "analysis.count.refuted", n: analysis.refutedCount },
  ];
  const visibleCounts = counts.filter((count) => count.n > 0);
  const findingGroups = SEVERITY_ORDER
    .map((severity) => ({ severity, findings: analysis.findings.filter((finding) => finding.severity === severity) }))
    .filter((group) => group.findings.length > 0);
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden [overflow-wrap:anywhere]">
      <div className="text-xs leading-relaxed text-foreground/90">
        <Markdown text={analysis.summary} />
      </div>
      {visibleCounts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {visibleCounts.map((count) => (
            <span key={count.key} className="rounded bg-muted px-2 py-0.5 text-foreground/80">{t(count.key, { n: count.n })}</span>
          ))}
        </div>
      ) : null}
      <ul aria-label={t("analysis.dimensions.title")} className="grid grid-cols-2 gap-1.5">
        {ANALYSIS_DIMENSIONS.map((dimension) => {
          const health = read.health[dimension];
          const reason = analysis.dimensions.find((run) => run.key === dimension)?.reason;
          return (
            <li key={dimension} className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
              <span className="text-xs font-medium">{t(`analysis.dimension.${dimension}`)}</span>
              <span className={`text-[11px] ${BADGE_TEXT[HEALTH_TONE[health]]}`}>{t(`analysis.health.${health}`)}</span>
              {reason ? <span className="text-[11px] text-muted-foreground">{reason}</span> : null}
            </li>
          );
        })}
      </ul>
      {findingGroups.map((group) => (
        <section key={group.severity} aria-labelledby={`analysis-group-${group.severity}`} className="flex flex-col gap-1.5">
          <h3 id={`analysis-group-${group.severity}`} className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t(`analysis.group.${group.severity}`)}
          </h3>
          {group.findings.map((finding) => <FindingCard key={finding.id} finding={finding} />)}
        </section>
      ))}
    </div>
  );
}

function findingStatusText(finding: AnalysisFinding, t: Translate): string {
  switch (finding.status) {
    case "fixed":
      return t("analysis.finding.fixedIn", { commit: finding.commit });
    case "decided":
      return t("analysis.finding.decided", { decision: finding.decision });
    case "open":
      return finding.severity === "question" ? t("analysis.finding.awaitingDecision") : t("analysis.finding.open");
  }
}

function FindingCard({ finding }: { finding: AnalysisFinding }) {
  const t = useT();
  const location = finding.file && finding.line ? `${finding.file}:${finding.line}` : finding.file;
  return (
    <article className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/40 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{finding.id}</span>
        <span className="min-w-0 flex-1 font-medium">{finding.title}</span>
        <span className="rounded-full bg-muted px-1.5 text-[11px] text-foreground/80">{t(`analysis.dimension.${finding.dimension}`)}</span>
        <span className="text-[11px] text-muted-foreground">{findingStatusText(finding, t)}</span>
      </div>
      {location ? <span className="font-mono text-[11px] text-sky-400">{location}</span> : null}
      {finding.problem ? <p className="leading-relaxed text-foreground/90">{finding.problem}</p> : null}
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
        {finding.proof ? (
          <>
            <dt className="text-muted-foreground">{t("analysis.finding.proof")}</dt>
            <dd>
              <span>{`${t(`analysis.proof.${finding.proof.kind}`)} · ${finding.proof.ref}`}</span>
              {finding.proof.detail ? <span className="block text-foreground/80">{finding.proof.detail}</span> : null}
            </dd>
          </>
        ) : null}
        {finding.fix ? (
          <>
            <dt className="text-muted-foreground">{t("analysis.finding.fix")}</dt>
            <dd>{finding.fix}</dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}
