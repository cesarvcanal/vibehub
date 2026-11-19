import { X } from "lucide-react";
import { Badge, BADGE_TEXT, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ANALYSIS_DIMENSIONS, type AnalysisFinding, type AnalysisReadModel, type AnalysisSeverity, type AnalysisVerdict,
  type DimensionHealth,
} from "@/api/types";
import { PanelFrame } from "@/features/board/components/ReviewPanelView";
import { useCardAnalysis } from "@/features/board/lib/useCardAnalysis";
import { apiErrorMessage } from "@/lib/apiError";
import { useT, type Translate } from "@/i18n";

const SEVERITY_ORDER: readonly AnalysisSeverity[] = ["blocking", "improvement", "question", "suggestion"];

const HEALTH_TONE: Record<DimensionHealth, BadgeTone> = {
  ok: "ok",
  attention: "warn",
  problem: "critical",
  not_run: "critical",
  skipped: "muted",
};

const VERDICT_TONE: Record<AnalysisVerdict, BadgeTone> = { apt: "ok", not_apt: "critical", pending: "info" };

export function AnalysisPanel({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const t = useT();
  const analysisQuery = useCardAnalysis(cardId, { enabled: true });
  const read = analysisQuery.data;
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
      {analysisQuery.isPending ? <p className="text-xs text-muted-foreground">{t("common.loading")}</p> : null}
      {analysisQuery.isError ? <p className="text-xs text-destructive">{apiErrorMessage(analysisQuery.error)}</p> : null}
      {read && !read.analysis ? <p className="text-xs text-muted-foreground">{t("analysis.panel.empty")}</p> : null}
      {read?.analysis ? <AnalysisBody read={read} /> : null}
    </PanelFrame>
  );
}

function VerdictBadge({ read }: { read: AnalysisReadModel }) {
  const t = useT();
  if (read.analysis.stage === "fleet_unavailable") return <Badge tone="critical">{t("analysis.verdict.fleetUnavailable")}</Badge>;
  return <Badge tone={VERDICT_TONE[read.verdict]}>{t(`analysis.verdict.${read.verdict}`)}</Badge>;
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
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overflow-x-hidden [overflow-wrap:anywhere]">
      <p className="text-xs leading-relaxed text-foreground/90">{analysis.summary}</p>
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
