import * as React from "react";
import { AlertTriangle, Check, FoldVertical } from "lucide-react";
import { compactionElapsed, compactionSummary } from "@/features/board/lib/compaction";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { useT } from "@/i18n";

type CompactionRow = Extract<SdkRow, { kind: "compaction" }>;

/**
 * THE COMPACTION ROW in the chat — the person's /compact or the CLI's automatic one.
 *
 * Running: a card with the indeterminate bar running and the clock — the CLI spends seconds to a
 * minute summarizing without saying a word, and without this the chat looked frozen. Finished: it becomes an
 * edge-to-edge DIVIDER, because that is what it is in the conversation ("from here up, the model only
 * has the summary"), with how much the conversation took up before and after. Failed: the divider in amber, with
 * the reason.
 */
export const SdkCompactionRow = React.memo(function SdkCompactionRow({ row }: { row: CompactionRow }) {
  useT(); // the summary reads the language: switching language redraws the row
  const { title, parts } = compactionSummary(row);

  if (row.status === "running") return <RunningCompaction title={title} startedAt={row.startedAt} />;

  const failed = row.status === "failed";
  const Icon = failed ? AlertTriangle : Check;
  return (
    <div
      data-testid="sdk-compaction"
      data-status={row.status}
      role="separator"
      aria-label={[title, ...parts].join(" · ")}
      className={`flex items-center gap-2 py-1 text-xs animate-in fade-in duration-500 ${failed ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
    >
      <span className={`h-px flex-1 ${failed ? "bg-amber-500/40" : "bg-border"}`} />
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${failed ? "" : "text-emerald-500"}`} />
        <span className="font-medium">{title}</span>
        {parts.map((part) => (
          <React.Fragment key={part}>
            <span aria-hidden className="opacity-50">·</span>
            <span className="truncate tabular-nums">{part}</span>
          </React.Fragment>
        ))}
      </span>
      <span className={`h-px flex-1 ${failed ? "bg-amber-500/40" : "bg-border"}`} />
    </div>
  );
});

/** The compaction in progress: the bar running and the clock, which ticks by itself every second. */
function RunningCompaction({ title, startedAt }: { title: string; startedAt?: number }) {
  const t = useT();
  // Without `startedAt` (an old back), the clock counts from when the row appeared in this tab.
  const [since] = React.useState(() => startedAt ?? Date.now());
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      data-testid="sdk-compaction"
      data-status="running"
      role="status"
      aria-live="polite"
      className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs animate-in fade-in duration-300"
    >
      <div className="flex items-center gap-2">
        <FoldVertical className="h-3.5 w-3.5 shrink-0 animate-pulse text-primary" />
        <span className="font-medium text-foreground">{title}</span>
        <span data-testid="sdk-compaction-elapsed" className="ml-auto font-mono tabular-nums text-muted-foreground">
          {compactionElapsed(since, now)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={title}
        className="relative mt-2 h-1 overflow-hidden rounded-full bg-primary/15"
      >
        <div className="absolute inset-y-0 left-0 w-2/5 animate-compact-slide rounded-full bg-primary" />
      </div>
      <div className="mt-1.5 text-muted-foreground">{t("sdk.compactRunningHint")}</div>
    </div>
  );
}
