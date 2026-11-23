import { useQueries } from "@tanstack/react-query";
import type { AnalysisConversation, ReviewFleetRun } from "@/api/types";
import { boardApi } from "@/features/board/api";
import { FEED_POLL_MS } from "@/features/board/lib/workflowPanel";

export type RunConversationRead = { kind: "read"; conversation: AnalysisConversation | null } | { kind: "failed" };

export const reviewConversationKey = (cardId: string, pr: number | undefined, runId: string, finished: boolean) =>
  ["review-conversation", cardId, pr, runId, finished] as const;

export function useReviewConversations(cardId: string, pr: number | undefined, runs: ReviewFleetRun[]): ReadonlyMap<string, RunConversationRead> {
  const reads = useQueries({
    queries: runs.map((run) => ({
      queryKey: reviewConversationKey(cardId, pr, run.runId, run.finished),
      queryFn: () => boardApi.readReviewConversation(cardId, run.runId, pr),
      refetchInterval: run.finished ? false : FEED_POLL_MS,
      staleTime: run.finished ? Infinity : 0,
      retry: false,
    })),
  });
  return new Map(runs.flatMap((run, index): [string, RunConversationRead][] => {
    const read = reads[index]!;
    if (read.isError) return [[run.runId, { kind: "failed" }]];
    return read.data === undefined ? [] : [[run.runId, { kind: "read", conversation: read.data }]];
  }));
}
