import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/apiError";
import { t as translate, useT } from "@/i18n";
import type { PlatformFailure } from "@/api/types";
import { PLATFORM_FAILURES_KEY, PLATFORM_FAILURES_POLL_MS, platformFailuresApi } from "../api";
import { useAnnounceUnseenFailures } from "../lib/useAnnounceUnseenFailures";

const NO_PLATFORM_FAILURES: readonly PlatformFailure[] = [];

function FailureEntry({ failure }: { failure: PlatformFailure }) {
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
    <li className="space-y-2 rounded-md border border-border p-3">
      <p className="font-medium">{failure.symptom}</p>
      <p className="text-xs text-muted-foreground">
        {t("platformFailures.meta", { component: failure.component, n: failure.occurrences, count: failure.occurrences, cards: failure.affectedCardIds.length })}
      </p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{failure.evidence}</pre>
      {failure.hypothesis ? <p className="text-xs">{t("platformFailures.hypothesis", { hypothesis: failure.hypothesis })}</p> : null}
      {failure.status === "investigating" ? <p className="text-xs">{t("platformFailures.investigating")}</p> : null}
      {failure.status === "concluded_without_fix" ? <p className="text-xs">{t("platformFailures.concludedWithoutFix")}</p> : null}
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
    </li>
  );
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
            {failures.map((failure) => <FailureEntry key={failure.id} failure={failure} />)}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
