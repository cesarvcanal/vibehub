/**
 * WHAT THE COMPACTION ROW SAYS — the /compact (or the automatic one) in the chat.
 *
 * Running: the title (requested or automatic) and the clock. Finished: the divider "before this, only
 * the summary" with how much the conversation took before and after, how much it freed and how long
 * it took. Failed: the CLI's reason. The drawing lives in components/SdkCompactionRow.tsx.
 */

import { t as translate } from "@/i18n";
import { formatDuration, formatTokens } from "@/features/board/lib/sdkDetail";
import type { SdkRow } from "@/features/board/lib/sdkChat";

type CompactionRow = Extract<SdkRow, { kind: "compaction" }>;

/** What the row needs to read from the compaction. */
export type CompactionView = Pick<CompactionRow, "status"> &
  Partial<Pick<CompactionRow, "trigger" | "preTokens" | "postTokens" | "durationMs" | "error">>;

/** The reason the driver sends when the turn closed with the compaction still open. */
const DRIVER_INTERRUPTED = "interrompida";

/** Title and details (each one becomes a piece separated by "·"). PURE. */
export function compactionSummary(row: CompactionView): { title: string; parts: string[] } {
  const auto = row.trigger === "auto";
  if (row.status === "running") {
    return { title: translate(auto ? "sdk.compactRunningAuto" : "sdk.compactRunning"), parts: [] };
  }
  if (row.status === "failed") {
    const reason = row.error && row.error !== DRIVER_INTERRUPTED ? row.error : translate("sdk.compactInterrupted");
    return { title: translate("sdk.compactFailed"), parts: [reason] };
  }
  const parts: string[] = [];
  const { preTokens: pre, postTokens: post } = row;
  if (pre !== undefined && post !== undefined) {
    parts.push(translate("sdk.compactTokens", { pre: formatTokens(pre), post: formatTokens(post) }));
    if (pre > 0 && post < pre) parts.push(translate("sdk.compactSaved", { percent: Math.round(((pre - post) / pre) * 100) }));
  } else if (pre !== undefined) {
    parts.push(translate("sdk.compactTokensPre", { pre: formatTokens(pre) }));
  }
  if (row.durationMs !== undefined) parts.push(formatDuration(row.durationMs));
  return { title: translate(auto ? "sdk.compactDoneAuto" : "sdk.compactDone"), parts };
}

/** The bar's clock: `m:ss` since `startedAt`, never negative (clocks of different machines). PURE. */
export function compactionElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
