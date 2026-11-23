import type * as React from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { ReviewFleetRun } from "@/api/types";
import { FleetChat, type FleetAgentState } from "@/features/board/components/FleetChat";
import { PhasePills } from "@/features/board/components/WorkflowPanel";
import { reviewConversationChat, reviewFleetChat } from "@/features/board/lib/fleetChat";
import type { RunConversationRead } from "@/features/board/lib/useReviewConversations";
import { phasePills } from "@/features/board/lib/workflowPanel";
import { useT } from "@/i18n";

export type RunAgentDetail = (runId: string, agent: FleetAgentState) => React.ReactNode;

export function ReviewFleet({ round, runs, conversations, agentDetail }: {
  round: number;
  runs: ReviewFleetRun[];
  conversations?: ReadonlyMap<string, RunConversationRead>;
  agentDetail?: RunAgentDetail;
}) {
  const t = useT();
  return (
    <section data-testid="review-fleet" aria-label={t("review.fleet.aria", { round })} className="flex min-w-0 flex-col gap-1.5">
      {runs.map((run) => <FleetRun key={run.runId} run={run} conversationRead={conversations?.get(run.runId)} agentDetail={agentDetail} />)}
    </section>
  );
}

function FleetRun({ run, conversationRead, agentDetail }: {
  run: ReviewFleetRun;
  conversationRead: RunConversationRead | undefined;
  agentDetail: RunAgentDetail | undefined;
}) {
  const t = useT();
  const conversation = conversationRead?.kind === "read" ? conversationRead.conversation : null;
  const entries = conversation ? reviewConversationChat(run, conversation) : reviewFleetChat(run);
  const interrupted = run.outcome === "failed" || run.outcome === "killed";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {entries.length > 0 ? (
        <FleetChat
          entries={entries}
          label={t("review.fleet.conversation")}
          agentDetail={agentDetail && ((agent) => agentDetail(run.runId, agent))}
        />
      ) : null}
      {conversationRead?.kind === "failed" ? (
        <p role="note" className="flex min-w-0 items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t("review.fleet.speechFailed")}</span>
        </p>
      ) : null}
      <div data-testid="review-fleet-strip" className="min-w-0 space-y-1.5 rounded-md border border-sky-500/25 bg-sky-500/5 px-2.5 py-2 text-xs">
        <p className="flex items-center gap-1.5 font-medium">
          {interrupted ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            : run.finished ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              : <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />}
          {t(interrupted ? "review.fleet.interrupted" : run.finished ? "review.fleet.finished" : "review.fleet.working", { done: run.done, total: run.total })}
        </p>
        <PhasePills pills={phasePills(run.agents, run.phases, run.finished)} t={t} />
      </div>
    </div>
  );
}
