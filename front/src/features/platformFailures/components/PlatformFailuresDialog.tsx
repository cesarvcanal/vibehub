import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n";
import type { PlatformFailure } from "@/api/types";
import { FailureDetails } from "./FailureDetails";

function toFailureDetails(failure: PlatformFailure) {
  return {
    ...failure,
    details: {
      symptom: failure.symptom,
      component: failure.component,
      evidence: failure.evidence,
      ...(failure.reproduction ? { reproduction: failure.reproduction } : {}),
      ...(failure.hypothesis ? { hypothesis: failure.hypothesis } : {}),
      ...(failure.narrative ? { narrative: failure.narrative } : {}),
      ...(failure.narrativeUnavailable ? { narrativeUnavailable: failure.narrativeUnavailable } : {}),
    },
  };
}

export function PlatformFailuresDialog({ failures, isLoadError, isOpen, onOpenChange }: {
  failures: readonly PlatformFailure[];
  isLoadError: boolean;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("platformFailures.title")}</DialogTitle>
          <DialogDescription>{t("platformFailures.description")}</DialogDescription>
        </DialogHeader>
        {isLoadError ? (
          <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            {t("platformFailures.loadError")}
          </p>
        ) : null}
        <ul className="max-h-[60vh] space-y-2 overflow-y-auto overflow-x-hidden pr-1">
          {failures.map((failure) => (
            <FailureDetails
              key={failure.id}
              failure={toFailureDetails(failure)}
              isOwner
              affectedCardCount={failure.affectedCardIds.length}
              leavesListOnSuccess
            />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
