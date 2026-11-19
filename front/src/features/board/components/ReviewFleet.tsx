import type { ReviewFleetRun } from "@/api/types";
import { WorkflowPanel } from "@/features/board/components/WorkflowPanel";
import { fleetMessages, workflowRowOf, type AgentReading, type FleetMessage } from "@/features/board/lib/reviewFleet";
import { useT, type Translate } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The reviewer's agent fleet of one round, inside the review's conversation: the chat's own fleet panel
 * (phases, each agent with its model and what it is doing now) and, below it, what each agent said — the
 * findings of each specialist, the verification answering each finding, the judge last.
 */
export function ReviewFleet({ round, runs }: { round: number; runs: ReviewFleetRun[] }) {
  const t = useT();
  return (
    <section data-testid="review-fleet" aria-label={t("review.fleet.aria", { round })} className="flex min-w-0 flex-col gap-1.5">
      {runs.map((run) => {
        const messages = fleetMessages(run);
        return (
          <div key={run.runId} className="flex min-w-0 flex-col gap-1.5">
            <WorkflowPanel row={workflowRowOf(run)} />
            {messages.length > 0 ? (
              <ol aria-label={t("review.fleet.conversation")} className="flex min-w-0 flex-col gap-1">
                {messages.map((message) => <AgentMessage key={message.agent.id} message={message} />)}
              </ol>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function AgentMessage({ message }: { message: FleetMessage }) {
  const t = useT();
  const { agent, reading, repliesTo } = message;
  return (
    <li
      data-testid="review-fleet-message"
      className={cn(
        "min-w-0 rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5 text-xs",
        repliesTo && "ml-4 border-l-2 border-l-violet-400/70",
      )}
    >
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[11px]">
        <span className="font-semibold text-foreground/90 [overflow-wrap:anywhere]">{agent.label}</span>
        {agent.model ? <span className="text-muted-foreground">{agent.model}</span> : null}
        {agent.phase ? <span className="text-muted-foreground/70">· {agent.phase}</span> : null}
      </p>
      {repliesTo ? (
        <p className="text-[11px] text-violet-300/90 [overflow-wrap:anywhere]">{t("review.fleet.replyTo", { title: repliesTo })}</p>
      ) : null}
      <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">{readingText(reading, t)}</p>
    </li>
  );
}

function readingText(reading: AgentReading, t: Translate): string {
  switch (reading.kind) {
    case "findings":
      if (reading.titles.length === 0) return t("review.fleet.noFindings");
      return t(reading.titles.length === 1 ? "review.fleet.findings.one" : "review.fleet.findings.other", {
        n: reading.titles.length, titles: reading.titles.join("; "),
      });
    case "verdict": {
      const verdict = t(reading.confirmed ? "review.fleet.confirmed" : "review.fleet.refuted");
      return reading.evidence ? `${verdict}: ${reading.evidence}` : verdict;
    }
    case "text":
      return reading.text;
  }
}
