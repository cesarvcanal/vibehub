import { Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { formatTurnElapsed, type LongToolWait } from "@/features/board/lib/sdkChat";

export function LongToolWaitNotice({ wait, onInterrupt }: { wait: LongToolWait; onInterrupt: () => void }) {
  const t = useT();
  return (
    <div
      data-testid="long-tool-wait-notice"
      role="status"
      className="mt-1.5 flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs"
    >
      <Hourglass className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        {t("sdk.longToolWait", { elapsed: formatTurnElapsed(wait.elapsedSeconds), what: wait.what })}
      </span>
      <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={onInterrupt}>
        {t("composer.interrupt")}
      </Button>
    </div>
  );
}
