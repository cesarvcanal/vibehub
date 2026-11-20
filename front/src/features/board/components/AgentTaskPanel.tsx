import { Circle, CircleCheck, CircleDashed, CircleMinus, type LucideIcon } from "lucide-react";
import { Markdown } from "@/features/board/components/ChatView";
import { readAgentDeliverables, type DeliverableState } from "@/features/board/lib/agentDeliverables";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<DeliverableState, { icon: LucideIcon; iconClass: string; textClass: string }> = {
  done: { icon: CircleCheck, iconClass: "text-emerald-400", textClass: "text-foreground" },
  missed: { icon: CircleMinus, iconClass: "text-amber-400", textClass: "text-foreground" },
  open: { icon: Circle, iconClass: "text-muted-foreground/60", textClass: "text-foreground/90" },
  unmarked: { icon: CircleDashed, iconClass: "text-muted-foreground/60", textClass: "text-foreground/90" },
};

export function AgentTaskPanel({ prompt, report, running }: { prompt: string; report: string; running: boolean }) {
  const t = useT();
  const { context, items } = readAgentDeliverables(prompt, report, running);
  const doneCount = items.filter((item) => item.state === "done").length;
  const reportMarkedNothing = !running && items.every((item) => item.state === "unmarked");
  const showsProgress = !running && !reportMarkedNothing;
  const progressText = showsProgress
    ? t("sdk.detail.deliverablesProgress", { done: doneCount, n: items.length })
    : t(running ? "sdk.detail.deliverablesPending" : "sdk.detail.deliverablesUnmarked", { n: items.length });
  return (
    <div className="space-y-5">
      {items.length > 0 ? (
        <section className="rounded-md border border-border bg-card">
          <header className="flex items-baseline justify-between gap-3 border-b border-border/70 px-4 py-2.5">
            <h3 className="text-[13px] font-semibold">{t("sdk.detail.deliverables")}</h3>
            <span data-testid="sdk-agent-deliverables-progress" className="text-xs text-muted-foreground">{progressText}</span>
          </header>
          {showsProgress ? (
            <div className="h-0.5 bg-muted/60" aria-hidden>
              <div className="h-full bg-emerald-400/80 transition-[width]" style={{ width: `${(doneCount / items.length) * 100}%` }} />
            </div>
          ) : null}
          <ul className="divide-y divide-border/50">
            {items.map((item, index) => {
              const style = STATE_STYLE[item.state];
              const Icon = style.icon;
              return (
                <li key={index} data-testid="sdk-agent-deliverable" data-state={item.state} className="flex items-start gap-2.5 px-4 py-2.5 text-[13px] leading-relaxed">
                  <Icon aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0", style.iconClass)} />
                  <span className={cn("min-w-0 flex-1 break-words", style.textClass)}>{item.text}</span>
                  <span className={cn("shrink-0 pt-0.5 text-[11px]", item.state === "missed" ? "text-amber-400" : "text-muted-foreground")}>
                    {t(`sdk.detail.deliverable.${item.state}`)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {context ? (
        <section className="space-y-2">
          {items.length > 0 ? <h3 className="text-[13px] font-semibold text-muted-foreground">{t("sdk.detail.taskContext")}</h3> : null}
          <div data-testid="sdk-agent-task-context" className="rounded-md border border-border bg-card px-4 py-3 text-[13px] leading-relaxed">
            <Markdown text={context} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
