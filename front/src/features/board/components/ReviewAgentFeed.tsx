import { FeedBody } from "@/features/board/components/WorkflowPanel";
import { useReviewAgentFeed, type ReviewAgentRef } from "@/features/board/lib/useReviewAgentFeed";
import { feedLines } from "@/features/board/lib/workflowPanel";
import { useNow } from "@/lib/useNow";

export function ReviewAgentFeed({ agent, running }: { agent: ReviewAgentRef; running: boolean }) {
  const feed = useReviewAgentFeed(agent, running);
  const now = useNow(running);
  const status = feed.isError ? "failed" : feed.data ? "read" : "loading";
  const lines = feed.data ? feedLines(feed.data.items, { running, now }) : [];
  return (
    <div data-testid="review-agent-feed" className="mt-1 rounded border border-border/60 bg-background/70 px-2 py-1.5 text-[11px] text-muted-foreground">
      <FeedBody status={status} lines={lines} />
    </div>
  );
}
