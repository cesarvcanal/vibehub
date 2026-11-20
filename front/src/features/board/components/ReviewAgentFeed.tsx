import type { FleetAgentState } from "@/features/board/components/FleetChat";
import { FeedBody } from "@/features/board/components/WorkflowPanel";
import { useReviewAgentFeed, type ReviewAgentRef } from "@/features/board/lib/useReviewAgentFeed";
import { feedLines } from "@/features/board/lib/workflowPanel";
import { useNow } from "@/lib/useNow";

export function ReviewAgentFeed({ agent }: { agent: ReviewAgentRef & FleetAgentState }) {
  const { running, endedAt } = agent;
  const feed = useReviewAgentFeed(agent, running);
  const now = useNow(running);
  const status = feed.isError ? "failed" : feed.data ? "read" : "loading";
  const lines = feed.data ? feedLines(feed.data.items, endedAt === undefined ? { running, now } : { running, now, endedAt }) : [];
  return (
    <div data-testid="review-agent-feed" className="mt-1 rounded border border-border/60 bg-background/70 px-2 py-1.5 text-[11px] text-muted-foreground">
      <FeedBody status={status} lines={lines} />
    </div>
  );
}
