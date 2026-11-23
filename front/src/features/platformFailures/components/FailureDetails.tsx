import * as React from "react";
import { Loader2 } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type { FailureNarrative, FailureTrigger, PlatformFailureNotice } from "@/api/types";
import { explainFailure } from "../lib/explainFailure";
import { formatFailureInstant } from "../lib/formatFailureInstant";
import { useFailureActions } from "../lib/useFailureActions";

type FailureForDetails = Pick<
  PlatformFailureNotice, "id" | "source" | "status" | "explanation" | "occurrences" | "firstSeenAt" | "lastSeenAt" | "details"
>;

const SUMMARY_CLAMP_CHARS = 240;
const TRIGGER_TONES: Record<FailureTrigger, BadgeTone> = { system: "critical", person: "warn", unknown: "muted" };
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

function FailureSummary({ symptom, narrative }: { symptom: string; narrative?: FailureNarrative }) {
  const t = useT();
  const [isExpanded, setExpanded] = React.useState(false);
  const summaryItems = [
    ...(narrative ? [
      { label: t("platformFailures.narrativeContext"), text: narrative.context },
      { label: t("platformFailures.narrativeCause"), text: narrative.cause },
    ] : []),
    { label: t("platformFailures.symptomLabel"), text: symptom },
  ];
  const isLong = summaryItems.some((item) => item.text.length > SUMMARY_CLAMP_CHARS);
  const isFolded = isLong && !isExpanded;
  return (
    <div className="space-y-1">
      <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        {summaryItems.map((item) => (
          <React.Fragment key={item.label}>
            <dt className="text-xs font-medium leading-5 text-muted-foreground">{item.label}</dt>
            <dd className={cn("min-w-0 whitespace-pre-line break-words", isFolded && "line-clamp-3")}>{item.text}</dd>
          </React.Fragment>
        ))}
      </dl>
      {isLong ? (
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setExpanded((wasExpanded) => !wasExpanded)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t(isExpanded ? "platformFailures.showLess" : "platformFailures.showMore")}
        </button>
      ) : null}
      {narrative ? <p className="text-[11px] text-muted-foreground">{t("platformFailures.narrativeNote")}</p> : null}
    </div>
  );
}

function FailureStatusLine({ status, isOwner }: { status: PlatformFailureNotice["status"]; isOwner: boolean }) {
  const t = useT();
  if (status === "investigating") return <p className="text-xs text-muted-foreground">{t("platformFailures.investigating")}</p>;
  if (status === "concluded_without_fix") return <p className="text-xs text-muted-foreground">{t("platformFailures.concludedWithoutFix")}</p>;
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
        {narrative ? <Badge tone={TRIGGER_TONES[narrative.trigger]}>{t(`platformFailures.trigger.${narrative.trigger}`)}</Badge> : null}
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
        {narrative ? <p className="text-xs text-muted-foreground">{narrative.triggerReason}</p> : null}
      </div>
      {details ? <FailureSummary symptom={details.symptom} narrative={narrative} /> : null}
      {details?.narrativeUnavailable ? (
        <p className="text-xs text-muted-foreground">{t(`platformFailures.narrativeUnavailable.${details.narrativeUnavailable}`)}</p>
      ) : null}
      <FailureStatusLine status={failure.status} isOwner={isOwner} />
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
