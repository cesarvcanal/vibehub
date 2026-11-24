import * as React from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type {
  FailureInvestigationReport, FailureNarrative, FailureTrigger, InvestigationVerdict, PlatformFailureNotice,
} from "@/api/types";
import { explainFailure } from "../lib/explainFailure";
import { formatFailureInstant } from "../lib/formatFailureInstant";
import { useFailureActions } from "../lib/useFailureActions";

type FailureForDetails = Pick<
  PlatformFailureNotice, "id" | "source" | "status" | "explanation" | "occurrences" | "firstSeenAt" | "lastSeenAt" | "details"
>;

const TRIGGER_TONES: Record<FailureTrigger, BadgeTone> = { system: "critical", person: "warn", unknown: "muted" };
const VERDICT_TONES: Record<InvestigationVerdict, BadgeTone> = { vibehub_bug: "critical", not_a_bug: "ok", inconclusive: "muted" };
const STATUS_TONES: Record<PlatformFailureNotice["status"], BadgeTone> = {
  open: "muted", investigating: "info", concluded_without_fix: "muted", resolved: "ok", dismissed: "muted",
};

function BusyLabel({ isBusy, idleLabel, busyLabel }: { isBusy: boolean; idleLabel: string; busyLabel: string }) {
  if (!isBusy) return <>{idleLabel}</>;
  return (
    <>
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      {busyLabel}
    </>
  );
}

function FailureActions({ failure, actions }: { failure: FailureForDetails; actions: ReturnType<typeof useFailureActions> }) {
  const t = useT();
  const { investigate, dismiss, isBusy, isLeaving } = actions;
  const areActionsLocked = isBusy || isLeaving;
  const canDismiss = failure.status === "open" || failure.status === "concluded_without_fix";
  return (
    <div className="flex flex-wrap justify-end gap-2 pt-1">
      {canDismiss ? (
        <Button size="sm" variant="outline" disabled={areActionsLocked} onClick={() => dismiss.mutate()}>
          <BusyLabel isBusy={dismiss.isPending} idleLabel={t("platformFailures.dismiss")} busyLabel={t("platformFailures.dismissing")} />
        </Button>
      ) : null}
      <Button size="sm" disabled={areActionsLocked} onClick={() => investigate.mutate()}>
        <BusyLabel
          isBusy={investigate.isPending}
          idleLabel={t(failure.status === "open" ? "platformFailures.investigate" : "platformFailures.investigateAgain")}
          busyLabel={t("platformFailures.openingInvestigation")}
        />
      </Button>
    </div>
  );
}

function AnalysisSections({ sections }: { sections: readonly { label: string; text: string }[] }) {
  return (
    <dl className="space-y-2 text-sm">
      {sections.map((section) => (
        <div key={section.label} className="space-y-0.5">
          <dt className="text-xs font-medium text-muted-foreground">{section.label}</dt>
          <dd className="min-w-0 whitespace-pre-line break-words">{section.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function FailureAnalysis({ symptom, narrative, report }: {
  symptom: string;
  narrative?: FailureNarrative;
  report?: FailureInvestigationReport;
}) {
  const t = useT();
  const [isExpanded, setExpanded] = React.useState(false);
  const symptomSection = { label: t("platformFailures.analysis.symptom"), text: symptom };
  if (!narrative && !report) return <AnalysisSections sections={[symptomSection]} />;
  const cause = report?.cause ?? narrative?.cause;
  const sections = [
    ...(narrative ? [{ label: t("platformFailures.analysis.context"), text: narrative.context }] : []),
    ...(report ? [{ label: t("platformFailures.analysis.howItHappened"), text: report.howItHappened }] : []),
    ...(cause ? [{ label: t("platformFailures.analysis.cause"), text: cause }] : []),
    ...(report ? [{ label: t("platformFailures.analysis.resolution"), text: report.resolution }] : []),
    symptomSection,
  ];
  return (
    <div className="space-y-2">
      {isExpanded ? (
        <div className="space-y-2 border-l-2 border-border pl-3">
          <AnalysisSections sections={sections} />
          <p className="text-[11px] text-muted-foreground">
            {report
              ? t("platformFailures.reportNote", { at: formatFailureInstant(report.reportedAt) })
              : t("platformFailures.narrativeNote")}
          </p>
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => setExpanded((wasExpanded) => !wasExpanded)}
        className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        <ChevronDown className={cn("size-3.5 transition-transform motion-reduce:transition-none", isExpanded && "rotate-180")} aria-hidden />
        {t(isExpanded ? "platformFailures.analysis.close" : "platformFailures.analysis.open")}
      </button>
    </div>
  );
}

function InvestigationConclusion({ report }: { report: FailureInvestigationReport }) {
  const t = useT();
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-line break-words text-sm">{report.conclusion}</p>
      {report.pendingDecision ? (
        <div className="space-y-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <p className="text-xs font-medium text-amber-400">{t("platformFailures.pendingDecision")}</p>
          <p className="whitespace-pre-line break-words text-sm">{report.pendingDecision}</p>
        </div>
      ) : null}
    </div>
  );
}

function FailureStatusLine({ status, isOwner, hasReport }: { status: PlatformFailureNotice["status"]; isOwner: boolean; hasReport: boolean }) {
  const t = useT();
  if (status === "investigating") return <p className="text-xs text-muted-foreground">{t("platformFailures.investigating")}</p>;
  if (status === "concluded_without_fix" && !hasReport) {
    return <p className="text-xs text-muted-foreground">{t("platformFailures.concludedWithoutReport")}</p>;
  }
  if (status === "open" && !isOwner) return <p className="text-xs text-muted-foreground">{t("platformFailures.ownerNotified")}</p>;
  return null;
}

export function FailureDetails({ failure, isOwner, affectedCardCount, leavesListOnSuccess = false }: {
  failure: FailureForDetails;
  isOwner: boolean;
  affectedCardCount?: number;
  leavesListOnSuccess?: boolean;
}) {
  const t = useT();
  const actions = useFailureActions(failure.id, { leavesListOnSuccess });
  const { details } = failure;
  const narrative = details?.narrative;
  const report = details?.investigationReport;
  return (
    <li
      aria-busy={actions.isBusy}
      className={cn(
        "space-y-2 rounded-lg border border-border/70 bg-card/40 p-3 transition-[opacity,transform] duration-200 motion-reduce:transition-none",
        actions.isBusy && "opacity-60",
        actions.isLeaving && "-translate-x-2 opacity-0",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {report ? <Badge tone={VERDICT_TONES[report.verdict]}>{t(`platformFailures.verdict.${report.verdict}`)}</Badge> : null}
        {!report && narrative ? <Badge tone={TRIGGER_TONES[narrative.trigger]}>{t(`platformFailures.trigger.${narrative.trigger}`)}</Badge> : null}
        {failure.status === "open" ? null : (
          <Badge tone={STATUS_TONES[failure.status]}>{t(`platformFailures.status.${failure.status}`)}</Badge>
        )}
        <span className="text-[11px] text-muted-foreground">
          {t("platformFailures.when", {
            first: formatFailureInstant(failure.firstSeenAt),
            last: formatFailureInstant(failure.lastSeenAt),
            n: failure.occurrences,
            count: failure.occurrences,
          })}
        </span>
      </div>
      <div className="space-y-0.5">
        <p className="text-sm font-semibold leading-snug">{explainFailure(failure, t)}</p>
        {!report && narrative ? <p className="text-xs text-muted-foreground">{narrative.triggerReason}</p> : null}
      </div>
      {report ? <InvestigationConclusion report={report} /> : null}
      {details ? <FailureAnalysis symptom={details.symptom} narrative={narrative} report={report} /> : null}
      {!report && details?.narrativeUnavailable ? (
        <p className="text-xs text-muted-foreground">{t(`platformFailures.narrativeUnavailable.${details.narrativeUnavailable}`)}</p>
      ) : null}
      <FailureStatusLine status={failure.status} isOwner={isOwner} hasReport={report !== undefined} />
      {details ? (
        <details className="space-y-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t("platformFailures.technicalDetails")}</summary>
          <p className="text-muted-foreground">
            {affectedCardCount === undefined
              ? t("platformFailures.cardMeta", { component: details.component, n: failure.occurrences, count: failure.occurrences })
              : t("platformFailures.meta", { component: details.component, n: failure.occurrences, count: failure.occurrences, cards: affectedCardCount })}
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{details.evidence}</pre>
          {details.reproduction ? <p>{t("platformFailures.reproduction", { reproduction: details.reproduction })}</p> : null}
          {details.hypothesis ? <p>{t("platformFailures.hypothesis", { hypothesis: details.hypothesis })}</p> : null}
        </details>
      ) : null}
      {isOwner ? <FailureActions failure={failure} actions={actions} /> : null}
    </li>
  );
}
