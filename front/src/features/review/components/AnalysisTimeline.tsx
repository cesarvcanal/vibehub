import { CircleAlert, FileText, GitCommitHorizontal, Loader2, ShieldAlert, ShieldCheck, Upload, Wrench } from "lucide-react";
import type * as React from "react";
import type { AnalysisReport, AnalysisTimelineEntry } from "@/api/types";
import type { CardStateKind } from "@/features/board/lib/board";
import { chatClockText } from "@/features/board/lib/fleetChat";
import { analysisTimelineRows, fixingNotStartedYet, questionsWaitingForPerson } from "@/features/review/lib/analysisTimeline";
import type { AnalysisTimelineRow } from "@/features/review/types/analysisTimeline";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

const ROW_ICON_CLASS = "mt-0.5 h-3.5 w-3.5 shrink-0";

function rowIcon(row: AnalysisTimelineRow): React.ReactNode {
  if (row.current) return <Loader2 aria-hidden className={cn(ROW_ICON_CLASS, "animate-spin text-sky-400")} />;
  switch (row.kind) {
    case "fixing":
      return <Wrench aria-hidden className={cn(ROW_ICON_CLASS, "text-muted-foreground")} />;
    case "fixed":
      return <GitCommitHorizontal aria-hidden className={cn(ROW_ICON_CLASS, "text-emerald-400")} />;
    case "recheck":
      return row.needsAttention
        ? <ShieldAlert aria-hidden className={cn(ROW_ICON_CLASS, "text-amber-400")} />
        : <ShieldCheck aria-hidden className={cn(ROW_ICON_CLASS, "text-emerald-400")} />;
    case "delivered":
      return row.needsAttention
        ? <CircleAlert aria-hidden className={cn(ROW_ICON_CLASS, "text-destructive")} />
        : <Upload aria-hidden className={cn(ROW_ICON_CLASS, "text-sky-400")} />;
    case "report":
      return <FileText aria-hidden className={cn(ROW_ICON_CLASS, "text-muted-foreground")} />;
  }
}

export function AnalysisTimeline({ timeline, analysis, cardState }: {
  timeline: AnalysisTimelineEntry[];
  analysis: AnalysisReport;
  cardState: CardStateKind | undefined;
}) {
  const t = useT();
  const rows = analysisTimelineRows(timeline, analysis.findings, { cardWorking: cardState === "working" });
  const waitingQuestions = questionsWaitingForPerson(analysis, cardState);
  return (
    <section aria-labelledby="analysis-timeline-title" className="flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3">
      <h3 id="analysis-timeline-title" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("analysis.timeline.title")}
      </h3>
      {fixingNotStartedYet(timeline, analysis.stage) ? <p className="text-xs text-muted-foreground">{t("analysis.timeline.empty")}</p> : null}
      <ol aria-labelledby="analysis-timeline-title" className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li
            key={row.id}
            aria-current={row.current ? "step" : undefined}
            className="flex min-w-0 gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5 text-xs"
          >
            {rowIcon(row)}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{t(row.textKey, row.vars)}</p>
              {row.detail ? (
                <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{row.detail}</pre>
              ) : null}
            </div>
            <span className="shrink-0 text-[10px] text-muted-foreground">{chatClockText(row.at)}</span>
          </li>
        ))}
      </ol>
      {waitingQuestions.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
          <p id="analysis-timeline-questions" className="font-medium">{t("analysis.timeline.questions.title")}</p>
          <ul aria-labelledby="analysis-timeline-questions" className="flex flex-col gap-1">
            {waitingQuestions.map((question) => (
              <li key={question.id} className="[overflow-wrap:anywhere]">{`${question.id} · ${question.title}`}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
