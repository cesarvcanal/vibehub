import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/apiError";
import { t as translate, useT } from "@/i18n";
import type { FailureNarrative, FailureTrigger, PlatformFailureNotice } from "@/api/types";
import { PLATFORM_FAILURES_KEY, platformFailuresApi } from "../api";
import { explainFailure } from "../lib/explainFailure";
import { formatFailureInstant } from "../lib/formatFailureInstant";

type FailureForDetails = Pick<
  PlatformFailureNotice, "id" | "source" | "status" | "explanation" | "occurrences" | "firstSeenAt" | "lastSeenAt" | "details"
>;

const TRIGGER_TONES: Record<FailureTrigger, BadgeTone> = { system: "critical", person: "warn", unknown: "muted" };

function FailureActions({ failure }: { failure: FailureForDetails }) {
  const t = useT();
  const queryClient = useQueryClient();
  const refreshFailures = () => queryClient.invalidateQueries({ queryKey: PLATFORM_FAILURES_KEY });
  const investigate = useMutation({
    mutationFn: () => platformFailuresApi.investigate(failure.id),
    onSuccess: (investigation) => {
      toast.success(translate("platformFailures.investigationStarted", { title: investigation.card.title }));
      void refreshFailures();
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const dismiss = useMutation({
    mutationFn: () => platformFailuresApi.dismiss(failure.id),
    onSuccess: () => void refreshFailures(),
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const canDismiss = failure.status === "open" || failure.status === "concluded_without_fix";
  return (
    <div className="flex gap-2">
      <Button size="sm" disabled={investigate.isPending} onClick={() => investigate.mutate()}>
        {t(failure.status === "open" ? "platformFailures.investigate" : "platformFailures.investigateAgain")}
      </Button>
      {canDismiss ? (
        <Button size="sm" variant="outline" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          {t("platformFailures.dismiss")}
        </Button>
      ) : null}
    </div>
  );
}

function FailureNarrativeSummary({ narrative }: { narrative: FailureNarrative }) {
  const t = useT();
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={TRIGGER_TONES[narrative.trigger]}>{t(`platformFailures.trigger.${narrative.trigger}`)}</Badge>
        <span className="text-xs text-muted-foreground">{narrative.triggerReason}</span>
      </p>
      <dl className="space-y-1.5">
        <dt className="text-xs font-medium text-muted-foreground">{t("platformFailures.narrativeContext")}</dt>
        <dd>{narrative.context}</dd>
        <dt className="text-xs font-medium text-muted-foreground">{t("platformFailures.narrativeCause")}</dt>
        <dd>{narrative.cause}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">{t("platformFailures.narrativeNote")}</p>
    </div>
  );
}

function FailureStatusLine({ status, isOwner }: { status: PlatformFailureNotice["status"]; isOwner: boolean }) {
  const t = useT();
  if (status === "investigating") return <p className="text-xs">{t("platformFailures.investigating")}</p>;
  if (status === "concluded_without_fix") return <p className="text-xs">{t("platformFailures.concludedWithoutFix")}</p>;
  if (status === "open" && !isOwner) return <p className="text-xs">{t("platformFailures.ownerNotified")}</p>;
  return null;
}

export function FailureDetails({ failure, isOwner, affectedCardCount }: { failure: FailureForDetails; isOwner: boolean; affectedCardCount?: number }) {
  const t = useT();
  const { details } = failure;
  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <p className="font-medium">{explainFailure(failure, t)}</p>
      <p className="text-xs text-muted-foreground">
        {t("platformFailures.when", {
          first: formatFailureInstant(failure.firstSeenAt),
          last: formatFailureInstant(failure.lastSeenAt),
          n: failure.occurrences,
          count: failure.occurrences,
        })}
      </p>
      {details?.narrative ? <FailureNarrativeSummary narrative={details.narrative} /> : null}
      {details?.narrativeUnavailable ? (
        <p className="text-xs text-muted-foreground">{t(`platformFailures.narrativeUnavailable.${details.narrativeUnavailable}`)}</p>
      ) : null}
      <FailureStatusLine status={failure.status} isOwner={isOwner} />
      {details ? (
        <details className="space-y-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t("platformFailures.technicalDetails")}</summary>
          <p>{details.symptom}</p>
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
      {isOwner ? <FailureActions failure={failure} /> : null}
    </li>
  );
}
