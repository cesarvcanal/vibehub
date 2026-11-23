import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useFailuresDialog, usePlatformFailures } from "../lib/usePlatformFailures";
import { PlatformFailuresDialog } from "./PlatformFailuresDialog";

export function PlatformFailuresButton() {
  const t = useT();
  const { failures, isLoadError } = usePlatformFailures({ isPolling: false });
  const { isFailuresDialogOpen, setFailuresDialogOpen } = useFailuresDialog(failures.length > 0);
  const loadErrorNotice = isLoadError ? <span className="text-xs text-amber-600">{t("platformFailures.loadError")}</span> : null;
  if (failures.length === 0) return loadErrorNotice;
  return (
    <>
      {loadErrorNotice}
      <Button size="sm" variant="outline" onClick={() => setFailuresDialogOpen(true)}>
        <AlertTriangle className="mr-1 h-4 w-4 text-amber-500" aria-hidden />
        {t("platformFailures.indicator", { n: failures.length, count: failures.length })}
      </Button>
      <PlatformFailuresDialog failures={failures} isLoadError={isLoadError} isOpen={isFailuresDialogOpen} onOpenChange={setFailuresDialogOpen} />
    </>
  );
}
