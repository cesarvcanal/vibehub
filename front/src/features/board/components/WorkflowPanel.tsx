import * as React from "react";
import { Check, CheckCircle2, ChevronRight, Circle, CircleDot, Loader2, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { formatAgentResult, type SdkRow, type WorkflowAgentFrame } from "@/features/board/lib/sdkChat";
import { WorkflowFeedContext, type WorkflowFeedResponse } from "@/features/board/lib/workflowFeed";
import {
  estimateWorkflowRemaining,
  feedLines,
  formatDuration,
  groupAgentsByPhase,
  phasePills,
  verbKey,
  type FeedLine,
  type PhasePill,
} from "@/features/board/lib/workflowPanel";

type WorkflowRow = Extract<SdkRow, { kind: "workflow" }>;
type Translate = ReturnType<typeof useT>;

/** De quanto em quanto o feed de um agente aberto e ainda rodando é pedido de novo. */
export const FEED_POLL_MS = 4_000;

/**
 * O PAINEL DA FROTA — o workflow organizado como nas IDEs.
 *
 * A tool `Workflow` devolve na hora e trabalha em segundo plano: o turno acaba e, sem isto, a tela
 * ficava muda por minutos (produção, 2026-10-02). O painel mostra a frota viva: há quanto tempo
 * roda e quanto falta, as fases do plano (inclusive as que não começaram), cada agente pelo NOME
 * com o que está fazendo agora, e — sob demanda, um por vez — o feed do agente aberto. Enquanto
 * roda fica aberto; terminado, recolhe sozinho UMA vez. O quadro vem do back lendo o diário da
 * rodada (back/src/services/sdk/workflow.ts); o feed, de um pedido desta aba (lib/workflowFeed.ts).
 */
export function WorkflowPanel({ row }: { row: WorkflowRow }) {
  const t = useT();
  const [open, setOpen] = React.useState(!row.finished);
  const [openAgent, setOpenAgent] = React.useState<string | null>(null);
  // Recolhe só uma vez: reabrir e continuar lendo é direito de quem lê.
  const collapsed = React.useRef(false);
  React.useEffect(() => {
    if (row.finished && !collapsed.current) {
      collapsed.current = true;
      setOpen(false);
    }
  }, [row.finished]);

  const running = row.agents.filter((a) => a.status === "running").length;
  const visible = usePageVisible();
  const now = useNow(!row.finished && running > 0 && visible);
  const percent = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
  const plan = (row.phases ?? []).map((p) => p.title);
  const pills = phasePills(row.agents, plan);

  return (
    <div
      data-testid="sdk-workflow"
      data-run={row.runId}
      data-finished={row.finished || undefined}
      className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {row.finished ? (
          <Waypoints className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        )}
        <span className="shrink-0 font-medium text-foreground/90">{t("sdk.workflowFallbackName")}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">{row.name}</span>
        <span data-testid="sdk-workflow-count" className="shrink-0 tabular-nums text-muted-foreground">
          {t("sdk.workflowAgents", { done: row.done, total: row.total })}
        </span>
        <span className="shrink-0 text-muted-foreground/80">
          {row.finished ? t("sdk.workflowDone") : t("sdk.workflowRunning")}
        </span>
      </button>

      {row.total > 0 ? (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-border/60">
          <div
            data-testid="sdk-workflow-bar"
            className={cn("h-full rounded-full transition-all", row.finished ? "bg-emerald-500" : "bg-primary")}
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      <WorkflowStatusLine row={row} running={running} now={now} t={t} />

      {open ? (
        <div className="mt-2 space-y-2">
          {row.description ? <p className="text-muted-foreground">{row.description}</p> : null}
          {pills.length > 0 ? <PhasePills pills={pills} t={t} /> : null}
          {row.total === 0 && row.agents.length === 0 ? (
            <p className="text-muted-foreground/80">{t("sdk.workflowStarting")}</p>
          ) : (
            <AgentGroups
              row={row}
              plan={plan}
              now={now}
              openAgent={openAgent}
              onToggle={(id) => setOpenAgent((current) => (current === id ? null : id))}
              t={t}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** "Rodando há 3m 12s · Faltam ~2m (média de 1m 10s por agente) · 2 trabalhando · 5 na fila". */
function WorkflowStatusLine({ row, running, now, t }: { row: WorkflowRow; running: number; now: number; t: Translate }) {
  const startedAt = row.startedAt;
  let eta: string | null = null;
  if (row.finished) {
    const end = Math.max(0, ...row.agents.map((a) => a.endedAt ?? a.lastAt ?? 0));
    if (startedAt !== undefined && end >= startedAt) eta = t("sdk.workflowDoneIn", { elapsed: formatDuration(end - startedAt) });
  } else {
    const estimate = estimateWorkflowRemaining(row, now);
    eta = estimate
      ? t("sdk.workflowEta", { eta: formatDuration(estimate.remainingMs), avg: formatDuration(estimate.averageMs) })
      : t("sdk.workflowEtaPending");
  }
  const queued = Math.max(0, row.total - row.done - running);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      {!row.finished && startedAt !== undefined ? (
        <span data-testid="workflow-elapsed" className="tabular-nums">
          {t("sdk.workflowElapsed", { elapsed: formatDuration(now - startedAt) })}
        </span>
      ) : null}
      {eta ? <span data-testid="workflow-eta" className="tabular-nums">{eta}</span> : null}
      {!row.finished ? (
        <span data-testid="workflow-status">
          {t("sdk.workflowWorking", { n: running })} · {t("sdk.workflowQueued", { n: queued })}
        </span>
      ) : null}
    </div>
  );
}

function PhasePills({ pills, t }: { pills: PhasePill[]; t: Translate }) {
  return (
    <div data-testid="sdk-workflow-phases" className="flex flex-wrap items-center gap-1 text-[11px]">
      {pills.map((pill) => (
        <span
          key={pill.title}
          data-testid="workflow-phase-pill"
          data-state={pill.state}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-px",
            pill.state === "done" && "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
            pill.state === "current" && "border-primary text-foreground",
            pill.state === "waiting" && "border-border/70 text-muted-foreground/70",
          )}
        >
          {pill.state === "done" ? (
            <Check className="h-3 w-3" />
          ) : pill.state === "current" ? (
            <CircleDot className="h-3 w-3 text-primary" />
          ) : (
            <Circle className="h-3 w-3" />
          )}
          {pill.title}{" "}
          <span className="tabular-nums opacity-70">
            {pill.total > 0 ? `${pill.done}/${pill.total}` : t("sdk.workflowPhaseWaiting")}
          </span>
        </span>
      ))}
    </div>
  );
}

function AgentGroups({
  row, plan, now, openAgent, onToggle, t,
}: {
  row: WorkflowRow; plan: string[]; now: number; openAgent: string | null; onToggle: (id: string) => void; t: Translate;
}) {
  return (
    <div className="space-y-1.5">
      {groupAgentsByPhase(row.agents, plan).map((group) => (
        <div key={group.phase || "-"} data-testid="workflow-phase-group" data-phase={group.phase}>
          {group.phase ? (
            <div className="mb-0.5 flex items-center justify-between px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              <span>{group.phase}</span>
              <span className="tabular-nums">
                {group.agents.filter((a) => a.status === "done").length}/{group.agents.length}
              </span>
            </div>
          ) : null}
          <ul className="space-y-0.5">
            {group.agents.map((agent) => (
              <AgentItem
                key={agent.id}
                agent={agent}
                runId={row.runId}
                finished={row.finished}
                now={now}
                showing={openAgent === agent.id}
                onToggle={() => onToggle(agent.id)}
                t={t}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function AgentItem({
  agent, runId, finished, now, showing, onToggle, t,
}: {
  agent: WorkflowAgentFrame; runId: string; finished: boolean; now: number; showing: boolean; onToggle: () => void; t: Translate;
}) {
  const done = agent.status === "done";
  const time = agentTime(agent, now);
  const doing = nowLine(agent, now, t);
  return (
    <li>
      <button
        type="button"
        data-testid="sdk-workflow-agent"
        data-status={agent.status}
        aria-expanded={showing}
        onClick={onToggle}
        className={cn("flex w-full min-w-0 flex-col rounded px-1 py-0.5 text-left hover:bg-muted/60", showing && "bg-muted/60")}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {done ? (
            <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
          ) : (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
            {agent.label || t("sdk.workflowAgentUnnamed")}
          </span>
          {time ? (
            <span data-testid="workflow-agent-time" className="shrink-0 tabular-nums text-muted-foreground/70">{time}</span>
          ) : null}
        </span>
        {doing ? (
          <span data-testid="workflow-agent-now" className="block w-full truncate pl-[18px] text-[11px] text-muted-foreground">
            {doing}
          </span>
        ) : null}
      </button>
      {showing ? <AgentFeed agent={agent} runId={runId} polling={!finished && !done} now={now} t={t} /> : null}
    </li>
  );
}

/** Decorrido para quem roda, duração para quem terminou; "" quando o quadro não traz tempo. */
function agentTime(agent: WorkflowAgentFrame, now: number): string {
  if (agent.startedAt === undefined) return "";
  if (agent.status === "running") return formatDuration(now - agent.startedAt);
  return agent.endedAt !== undefined ? formatDuration(agent.endedAt - agent.startedAt) : "";
}

/** Verbo humano + alvo em mono: "Leu /w/app.ts". */
function ToolAction({ tool, target, t }: { tool: string; target: string; t: Translate }) {
  return (
    <>
      {t(verbKey(tool), { tool })}
      {target ? " " : ""}
      {target ? <span className="font-mono">{target}</span> : null}
    </>
  );
}

/** A segunda linha do agente: o que ele faz agora (ou, terminado, o começo do que devolveu). */
function nowLine(agent: WorkflowAgentFrame, now: number, t: Translate): React.ReactNode {
  if (agent.status === "done") return agent.result ? formatAgentResult(agent.result).split("\n")[0] : null;
  const activity = agent.activity;
  if (!activity) return null;
  if (activity.kind === "tool") return <ToolAction tool={activity.tool} target={activity.target} t={t} />;
  if (activity.kind === "text") return activity.text;
  const since = activity.since || agent.lastAt || now;
  return <em>{t("sdk.workflowThinkingFor", { elapsed: formatDuration(now - since) })}</em>;
}

/** Quantas vezes um agente CONCLUÍDO pede de novo um feed que não veio (perdido ou `probe-failed`). */
export const FEED_RETRY_MAX = 3;

/**
 * O feed SOB DEMANDA do agente aberto: pede ao abrir e de novo a cada `FEED_POLL_MS` enquanto ele
 * roda. Um CONCLUÍDO pede de novo só enquanto não veio resposta (pedido perdido na queda do socket,
 * ignorado por um back antigo) ou veio `probe-failed` — e no máximo `FEED_RETRY_MAX` vezes, para um
 * runner caído não virar um `docker exec` a cada 4s. `invalid-id` e `no-session` não mudam
 * pedindo de novo. Fechar ou desmontar para de pedir. Só a resposta deste agente conta.
 */
function useAgentFeed(runId: string, agentId: string, polling: boolean): WorkflowFeedResponse | null {
  const channel = React.useContext(WorkflowFeedContext);
  const [feed, setFeed] = React.useState<WorkflowFeedResponse | null>(null);
  const answered = feed !== null && feed.error !== "probe-failed";
  const retriesRef = React.useRef(0);
  React.useEffect(() => {
    if (!channel) return;
    return channel.subscribe((response) => {
      if (response.runId === runId && response.agentId === agentId) setFeed(response);
    });
  }, [channel, runId, agentId]);
  React.useEffect(() => {
    if (!channel) return;
    channel.request(runId, agentId);
  }, [channel, runId, agentId, polling]);
  React.useEffect(() => {
    if (!channel || (!polling && answered)) return;
    const timer = setInterval(() => {
      if (!polling) {
        if (retriesRef.current >= FEED_RETRY_MAX) {
          clearInterval(timer);
          return;
        }
        retriesRef.current += 1;
      }
      channel.request(runId, agentId);
    }, FEED_POLL_MS);
    return () => clearInterval(timer);
  }, [channel, runId, agentId, polling, answered]);
  return feed;
}

function AgentFeed({
  agent, runId, polling, now, t,
}: {
  agent: WorkflowAgentFrame; runId: string; polling: boolean; now: number; t: Translate;
}) {
  const feed = useAgentFeed(runId, agent.id, polling);
  const done = agent.status === "done";
  const lines = feed ? feedLines(feed.items, { running: !done, now, endedAt: agent.endedAt }) : [];
  const tools = agent.toolCount ?? 0;
  const footer = [
    t("sdk.workflowToolCount", { n: tools, count: agent.toolCountPartial ? `${tools}+` : String(tools) }),
    ...(agent.startedAt !== undefined ? [t("sdk.workflowStartedAgo", { ago: formatDuration(now - agent.startedAt) })] : []),
  ].join(" · ");
  return (
    <div
      data-testid="workflow-feed"
      className="ml-[18px] mt-1 space-y-1 rounded border border-border/60 bg-background/70 px-2 py-1.5 text-[11px] text-muted-foreground"
    >
      <p className="text-foreground/80">{t("sdk.workflowTask", { task: agent.label || t("sdk.workflowAgentUnnamed") })}</p>
      <FeedBody feed={feed} lines={lines} t={t} />
      <div
        data-testid="sdk-workflow-result"
        className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-1.5 py-1"
      >
        {done ? (
          agent.result ? formatAgentResult(agent.result) : t("sdk.workflowNoResult")
        ) : (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("sdk.workflowAgentWorking")}
          </span>
        )}
      </div>
      <p className="tabular-nums text-muted-foreground/70">{footer}</p>
    </div>
  );
}

function FeedBody({ feed, lines, t }: { feed: WorkflowFeedResponse | null; lines: FeedLine[]; t: Translate }) {
  if (!feed) return <p className="italic text-muted-foreground/70">{t("sdk.workflowFeedLoading")}</p>;
  if (lines.length === 0) {
    return <p className="italic text-muted-foreground/70">{t(feed.error ? "sdk.workflowFeedError" : "sdk.workflowFeedEmpty")}</p>;
  }
  return (
    <ul className="max-h-56 space-y-0.5 overflow-auto">
      {lines.map((line, i) => (
        <li key={i} className="flex min-w-0 items-start gap-1.5">
          <FeedLineView line={line} t={t} />
        </li>
      ))}
    </ul>
  );
}

function FeedLineView({ line, t }: { line: FeedLine; t: Translate }) {
  switch (line.kind) {
    case "tool":
      return (
        <>
          <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
          <span className="min-w-0 break-words">
            <ToolAction tool={line.tool} target={line.target} t={t} />
          </span>
        </>
      );
    case "text":
      return <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/80">{line.text}</span>;
    case "thought":
      return <em className="text-muted-foreground/70">{t("sdk.workflowThoughtFor", { elapsed: formatDuration(line.ms) })}</em>;
    case "thinking":
      return <em className="text-muted-foreground/70">{t("sdk.workflowThinkingFor", { elapsed: formatDuration(line.ms) })}</em>;
  }
}

/** `Date.now()` que se refaz a cada segundo enquanto `active` — e nenhum timer quando não. */
function useNow(active: boolean): number {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return Date.now();
}

/** A aba está à vista? Escondida, o relógio do painel não precisa andar. */
function usePageVisible(): boolean {
  const read = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";
  const [visible, setVisible] = React.useState(read);
  React.useEffect(() => {
    const onChange = (): void => setVisible(read());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
