import * as React from "react";
import type { Review, ReviewFleetRun } from "@/api/types";
import { JumpToLatest, useStickToBottom } from "@/features/board/components/JumpToLatest";
import { ReviewFleet } from "@/features/board/components/ReviewFleet";
import { fleetsByRound } from "@/features/board/lib/reviewFleet";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

export function ReviewAgents({ review, fleet }: { review: Review; fleet: ReviewFleetRun[] }) {
  const t = useT();
  const fleets = fleetsByRound(review, fleet);
  const rounds = [...fleets.keys()].sort((left, right) => left - right);
  const [chosenRound, setChosenRound] = React.useState<number | null>(null);
  const round = chosenRound !== null && fleets.has(chosenRound) ? chosenRound : rounds.at(-1);
  if (round === undefined) return <p className="py-6 text-center text-xs text-muted-foreground">{t("review.agents.empty")}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {rounds.length > 1 ? (
        <div role="group" aria-label={t("review.agents.rounds")} className="flex shrink-0 flex-wrap gap-1.5">
          {rounds.map((pillRound) => (
            <button
              key={pillRound}
              type="button"
              aria-pressed={pillRound === round}
              onClick={() => setChosenRound(pillRound)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                pillRound === round ? "border-sky-400/70 bg-sky-500/10 text-sky-300" : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              {t("review.conversation.round", { round: pillRound })}
            </button>
          ))}
        </div>
      ) : null}
      <RoundFleet key={round} round={round} runs={fleets.get(round)!} />
    </div>
  );
}

function RoundFleet({ round, runs }: { round: number; runs: ReviewFleetRun[] }) {
  const answered = runs.reduce((total, run) => total + run.done, 0);
  const stick = useStickToBottom(`${answered}:${runs.length}`);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={stick.scrollerRef}
        onScroll={stick.onScroll}
        data-testid="review-agents"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-0.5 py-1"
      >
        <ReviewFleet round={round} runs={runs} />
      </div>
      <JumpToLatest stick={stick} />
    </div>
  );
}
