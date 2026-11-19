import { CheckCircle2, Loader2 } from "lucide-react";
import type { ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { PhasePills } from "@/features/board/components/WorkflowPanel";
import { agentRole, fleetMessages, type AgentReading, type FleetMessage } from "@/features/board/lib/reviewFleet";
import { phasePills } from "@/features/board/lib/workflowPanel";
import { useT, type Translate } from "@/i18n";
import { cn } from "@/lib/utils";

export function ReviewFleet({ round, runs }: { round: number; runs: ReviewFleetRun[] }) {
  const t = useT();
  return (
    <section data-testid="review-fleet" aria-label={t("review.fleet.aria", { round })} className="flex min-w-0 flex-col gap-1.5">
      {runs.map((run) => <FleetRun key={run.runId} run={run} />)}
    </section>
  );
}

function FleetRun({ run }: { run: ReviewFleetRun }) {
  const t = useT();
  const working = run.finished ? [] : run.agents.filter((agent) => agent.status === "running");
  const messages = fleetMessages(run);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {messages.length > 0 ? (
        <ol aria-label={t("review.fleet.conversation")} className="flex min-w-0 flex-col gap-1">
          {messages.map((message) => <AgentMessage key={message.agent.id} message={message} />)}
        </ol>
      ) : null}
      <div data-testid="review-fleet-strip" className="min-w-0 space-y-1.5 rounded-md border border-sky-500/25 bg-sky-500/5 px-2.5 py-2 text-xs">
        <p className="flex items-center gap-1.5 font-medium">
          {run.finished ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />}
          {t(run.finished ? "review.fleet.finished" : "review.fleet.working", { done: run.done, total: run.total })}
        </p>
        <PhasePills pills={phasePills(run.agents, run.phases, run.finished)} t={t} />
        {working.length > 0 ? (
          <ul className="min-w-0 space-y-0.5">
            {working.map((agent) => (
              <li key={agent.id} data-testid="review-fleet-working" className="min-w-0 text-[11px] text-muted-foreground">
                <span className="text-foreground/90">{agentName(agent, t)}</span>
                {agent.model ? <span className="ml-1.5 text-muted-foreground/70">{agent.model}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function AgentMessage({ message }: { message: FleetMessage }) {
  const t = useT();
  const { agent, reading, repliesTo } = message;
  return (
    <li
      data-testid="review-fleet-message"
      className={cn("min-w-0 border-l-2 py-0.5 pl-2.5 text-xs", repliesTo ? "ml-4 border-l-violet-400/60" : "border-l-sky-500/40")}
    >
      <p className="text-[11px]">
        <span className="font-semibold text-foreground/90">{agentName(agent, t)}</span>
        {agent.model ? <span className="ml-1.5 text-muted-foreground">{agent.model}</span> : null}
      </p>
      {repliesTo ? (
        <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{t("review.fleet.replyTo", { title: repliesTo })}</p>
      ) : null}
      <ReadingText reading={reading} />
    </li>
  );
}

function ReadingText({ reading }: { reading: AgentReading }) {
  const t = useT();
  const body = "whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]";
  switch (reading.kind) {
    case "findings":
      return (
        <p className={body}>
          {reading.titles.length === 0
            ? t("review.fleet.noFindings")
            : t(reading.titles.length === 1 ? "review.fleet.findings.one" : "review.fleet.findings.other", {
              n: reading.titles.length, titles: reading.titles.join("; "),
            })}
        </p>
      );
    case "verdict":
      return (
        <p className={body}>
          <span className={cn("font-semibold", reading.confirmed ? "text-amber-300" : "text-emerald-300")}>
            {t(reading.confirmed ? "review.fleet.confirmed" : "review.fleet.refuted")}
          </span>
          {reading.evidence ? `: ${reading.evidence}` : null}
        </p>
      );
    case "text":
      return <p className={body}>{reading.text}</p>;
  }
}

function agentName(agent: ReviewFleetAgent, t: Translate): string {
  const role = agentRole(agent.label);
  switch (role.kind) {
    case "context":
      return t("review.fleet.agent.context");
    case "judge":
      return t("review.fleet.agent.judge");
    case "review":
      return t("review.fleet.agent.review", { dimension: t(`analysis.dimension.${role.dimension}`) });
    case "verification":
      return t("review.fleet.agent.verification", { dimension: t(`analysis.dimension.${role.dimension}`) });
    case "other":
      return role.label;
  }
}
