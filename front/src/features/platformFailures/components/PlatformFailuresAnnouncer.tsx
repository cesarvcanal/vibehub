import { useAnnounceUnseenFailures } from "../lib/useAnnounceUnseenFailures";
import { useFailuresDialog, usePlatformFailures } from "../lib/usePlatformFailures";
import { PlatformFailuresDialog } from "./PlatformFailuresDialog";

export function PlatformFailuresAnnouncer() {
  const { failures } = usePlatformFailures({ isPolling: true });
  const { isFailuresDialogOpen, setFailuresDialogOpen } = useFailuresDialog(failures.length > 0);
  useAnnounceUnseenFailures(failures, setFailuresDialogOpen);
  return <PlatformFailuresDialog failures={failures} isOpen={isFailuresDialogOpen} onOpenChange={setFailuresDialogOpen} />;
}
