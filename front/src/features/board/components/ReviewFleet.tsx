import type * as React from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { ReviewFleetRun } from "@/api/types";
import { FleetChat, type FleetAgentState } from "@/features/board/components/FleetChat";
import { PhasePills } from "@/features/board/components/WorkflowPanel";
import { reviewFleetChat } from "@/features/board/lib/fleetChat";
import { phasePills } from "@/features/board/lib/workflowPanel";
import { useT } from "@/i18n";

export type RunAgentDetail = (runId: string, agent: FleetAgentState) => React.ReactNode;

export function ReviewFleet({ round, runs, agentDetail }: { round: number; runs: ReviewFleetRun[]; agentDetail?: RunAgentDetail }) {
  const t = useT();
  return (
    <section data-testid="review-fleet" aria-label={t("review.fleet.aria", { round })} className="flex min-w-0 flex-col gap-1.5">
      {runs.map((run) => <FleetRun key={run.runId} run={run} agentDetail={agentDetail} />)}
    </section>
  );
}

function FleetRun({ run, agentDetail }: { run: ReviewFleetRun; agentDetail: RunAgentDetail | undefined }) {
  const t = useT();
  const entries = reviewFleetChat(run);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {entries.length > 0 ? (
        <FleetChat
          entries={entries}
          label={t("review.fleet.conversation")}
          agentDetail={agentDetail && ((agent) => agentDetail(run.runId, agent))}
        />
      ) : null}
      <div data-testid="review-fleet-strip" className="min-w-0 space-y-1.5 rounded-md border border-sky-500/25 bg-sky-500/5 px-2.5 py-2 text-xs">
        <p className="flex items-center gap-1.5 font-medium">
          {run.finished ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />}
          {t(run.finished ? "review.fleet.finished" : "review.fleet.working", { done: run.done, total: run.total })}
        </p>
        <PhasePills pills={phasePills(run.agents, run.phases, run.finished)} t={t} />
      </div>
    </div>
  );
}
