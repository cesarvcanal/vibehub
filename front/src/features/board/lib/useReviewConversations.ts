import * as React from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { ReviewFleetRun } from "@/api/types";
import { boardApi } from "@/features/board/api";
import { FEED_POLL_MS } from "@/features/board/lib/workflowPanel";
import type { RunConversationRead } from "@/features/board/types/reviewConversation";

const reviewConversationKey = (cardId: string, pr: number | undefined, runId: string) => ["review-conversation", cardId, pr, runId] as const;

export function useReviewConversations(
  cardId: string,
  pr: number | undefined,
  runs: ReviewFleetRun[],
  agentsShown: boolean,
): ReadonlyMap<string, RunConversationRead> {
  const queryClient = useQueryClient();
  const runIdsSeenOpen = React.useRef(new Set<string>());
  const reads = useQueries({
    queries: runs.map((run) => ({
      queryKey: reviewConversationKey(cardId, pr, run.runId),
      queryFn: () => boardApi.readReviewConversation(cardId, run.runId, pr),
      enabled: agentsShown,
      refetchInterval: run.finished ? false : FEED_POLL_MS,
      staleTime: run.finished ? Infinity : 0,
      retry: false,
    })),
  });
  React.useEffect(() => {
    for (const run of runs) {
      if (!run.finished) runIdsSeenOpen.current.add(run.runId);
      else if (runIdsSeenOpen.current.delete(run.runId)) void queryClient.invalidateQueries({ queryKey: reviewConversationKey(cardId, pr, run.runId), exact: true });
    }
  });
  return new Map(runs.flatMap((run, index): [string, RunConversationRead][] => {
    const read = reads[index]!;
    if (read.data === undefined && !read.isError) return [];
    return [[run.runId, { conversation: read.data ?? null, lastReadFailed: read.isError }]];
  }));
}
