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

export function PlatformFailuresDialog({ failures, isOpen, onOpenChange }: {
  failures: readonly PlatformFailure[];
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
        <ul className="max-h-[60vh] space-y-3 overflow-auto">
          {failures.map((failure) => (
            <FailureDetails key={failure.id} failure={toFailureDetails(failure)} isOwner affectedCardCount={failure.affectedCardIds.length} />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
