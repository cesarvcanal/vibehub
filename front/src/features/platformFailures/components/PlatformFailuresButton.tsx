import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n";
import type { PlatformFailure } from "@/api/types";
import { PLATFORM_FAILURES_KEY, PLATFORM_FAILURES_POLL_MS, platformFailuresApi } from "../api";
import { useAnnounceUnseenFailures } from "../lib/useAnnounceUnseenFailures";
import { FailureDetails } from "./FailureDetails";

const NO_PLATFORM_FAILURES: readonly PlatformFailure[] = [];

function toFailureDetails(failure: PlatformFailure) {
  return {
    ...failure,
    details: {
      symptom: failure.symptom,
      component: failure.component,
      evidence: failure.evidence,
      ...(failure.reproduction ? { reproduction: failure.reproduction } : {}),
      ...(failure.hypothesis ? { hypothesis: failure.hypothesis } : {}),
    },
  };
}

export function PlatformFailuresButton() {
  const t = useT();
  const [isFailuresDialogOpen, setFailuresDialogOpen] = React.useState(false);
  const failuresQuery = useQuery({
    queryKey: PLATFORM_FAILURES_KEY,
    queryFn: platformFailuresApi.list,
    refetchInterval: PLATFORM_FAILURES_POLL_MS,
  });
  const failures = failuresQuery.data ?? NO_PLATFORM_FAILURES;

  useAnnounceUnseenFailures(failures, setFailuresDialogOpen);

  const hasNoFailuresToShow = failures.length === 0;
  if (hasNoFailuresToShow && isFailuresDialogOpen) setFailuresDialogOpen(false);
  const loadErrorNotice = failuresQuery.isError ? <span className="text-xs text-amber-600">{t("platformFailures.loadError")}</span> : null;
  if (hasNoFailuresToShow) return loadErrorNotice;
  return (
    <>
      {loadErrorNotice}
      <Button size="sm" variant="outline" onClick={() => setFailuresDialogOpen(true)}>
        <AlertTriangle className="mr-1 h-4 w-4 text-amber-500" aria-hidden />
        {t("platformFailures.indicator", { n: failures.length, count: failures.length })}
      </Button>
      <Dialog open={isFailuresDialogOpen} onOpenChange={setFailuresDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("platformFailures.title")}</DialogTitle>
            <DialogDescription>{t("platformFailures.description")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-[60vh] space-y-3 overflow-auto">
            {failures.map((failure) => (
              <FailureDetails key={failure.id} failure={toFailureDetails(failure)} isOwner affectedCardCount={failure.affectedCardIds.length} />
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
