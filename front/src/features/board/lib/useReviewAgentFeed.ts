import { useQuery } from "@tanstack/react-query";
import type { ReviewAgentFeedResponse } from "@/api/types";
import { FEED_POLL_MS } from "@/features/board/lib/workflowPanel";
import { get } from "@/lib/api";

export interface ReviewAgentRef {
  cardId: string;
  pr?: number;
  runId: string;
  agentId: string;
}

export function useReviewAgentFeed({ cardId, pr, runId, agentId }: ReviewAgentRef, running: boolean) {
  const path = `/cards/${encodeURIComponent(cardId)}/review/agents/${encodeURIComponent(runId)}/${encodeURIComponent(agentId)}/feed`;
  return useQuery({
    queryKey: ["review-agent-feed", cardId, pr, runId, agentId],
    queryFn: async () => await get<ReviewAgentFeedResponse>(pr === undefined ? path : `${path}?pr=${pr}`),
    refetchInterval: running ? FEED_POLL_MS : false,
    retry: false,
  });
}
