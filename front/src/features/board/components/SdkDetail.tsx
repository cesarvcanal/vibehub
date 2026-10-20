import * as React from "react";
import { Bot, Brain, ChevronLeft, ChevronRight, CircleCheck, CircleX, Copy, FileDiff, GitBranch, Loader2, Maximize2, MessageSquare, Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { Markdown } from "@/features/board/components/ChatView";
import { toolHeadline, type AgentTask, type SdkRow, type ToolResultSummary } from "@/features/board/lib/sdkChat";
import { toolDiff } from "@/features/board/lib/toolDiff";
import {
  agentName,
  agentStatus,
  bashOutput,
  changedFiles,
  detailHasResult,
  formatDuration,
  formatTokens,
  parseUnifiedDiff,
  patchRows,
  readContent,
  toolResultLine,
  toolStatus,
  useDetail,
  type AgentTimelineData,
  type CardChangesData,
  type DiffRow,
  type FileDiffData,
  type TimelineItem,
  type ToolDetailData,
  type ToolStatus,
} from "@/features/board/lib/sdkDetail";

/**
 * VER O QUE O CLAUDE ESTÁ FAZENDO — o clique que o terminal tem e o chat não tinha.
 *
 * Cada ação da conversa abre um modal com o que foi chamado, o que voltou (a saída inteira, o
 * arquivo lido, o diff aplicado) e o raciocínio de logo antes; as setas andam pelas ações. Cada
 * subagente abre a linha do tempo dele, ao vivo enquanto roda. "Mudanças" junta os arquivos que o
 * Claude alterou. O detalhe vem do transcript no runner, sob demanda (lib/sdkDetail.ts).
 */

type ToolRow = Extract<SdkRow, { kind: "tool" }>;
type Translate = ReturnType<typeof useT>;

export type DetailView =
  | { kind: "action"; id: string; seq?: string[]; owner?: string }
  | { kind: "agent"; id: string }
  | { kind: "changes" };

export interface SdkDetailApi {
  open: (view: DetailView) => void;
}

export const SdkDetailContext = React.createContext<SdkDetailApi>({ open: () => {} });

/** De quanto em quanto a linha do tempo de um subagente rodando é pedida de novo. */
export const AGENT_POLL_MS = 4_000;
/** De quanto em quanto uma ação ainda sem resultado é pedida de novo. */
export const ACTION_POLL_MS = 4_000;

/* --------------------------------------------------------------------- peças */

export function StatusIcon({ status, className }: { status: ToolStatus; className?: string }) {
  if (status === "running") return <Loader2 aria-hidden className={cn("h-3 w-3 shrink-0 animate-spin text-primary", className)} />;
  if (status === "ok") return <CircleCheck aria-hidden className={cn("h-3 w-3 shrink-0 text-emerald-500", className)} />;
  if (status === "error") return <CircleX aria-hidden className={cn("h-3 w-3 shrink-0 text-red-500", className)} />;
  return <Wrench aria-hidden className={cn("h-3 w-3 shrink-0 opacity-70", className)} />;
}

function statusLabel(status: ToolStatus, t: Translate): string {
  return status === "running" ? t("sdk.detail.running") : status === "ok" ? t("sdk.detail.done") : status === "error" ? t("sdk.detail.failed") : "";
}

function StatusPill({ status }: { status: ToolStatus }) {
  const t = useT();
  if (status === "unknown") return null;
  return (
    <span
      data-testid="sdk-detail-status"
      data-status={status}
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
        status === "running" && "bg-primary/15 text-primary",
        status === "ok" && "bg-emerald-500/15 text-emerald-500",
        status === "error" && "bg-red-500/15 text-red-500",
      )}
    >
      {statusLabel(status, t)}
    </span>
  );
}

function CodeBlock({ text, start = 1, numbered = true, tone }: { text: string; start?: number; numbered?: boolean; tone?: "error" }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div
      className={cn(
        "max-h-[46vh] overflow-auto rounded-md border border-border/70 bg-card font-mono text-xs leading-relaxed",
        tone === "error" && "border-red-500/40 bg-red-500/5",
      )}
    >
      <div className="min-w-max py-1.5">
        {lines.map((line, i) => (
          <div key={i} className={cn("grid", numbered ? "grid-cols-[3rem_1fr]" : "grid-cols-1 pl-3")}>
            {numbered ? <span className="select-none pr-3 text-right text-muted-foreground/50">{start + i}</span> : null}
            <span className="whitespace-pre pr-4">{line || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffBlock({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="max-h-[56vh] overflow-auto rounded-md border border-border/70 bg-background/70 font-mono text-xs leading-relaxed">
      <div className="min-w-max py-0.5">
        {rows.map((row, i) => (
          <div
            key={i}
            data-testid="sdk-detail-diff-line"
            data-kind={row.kind}
            className={cn(
              "whitespace-pre border-l-2 pl-1.5 pr-3",
              row.kind === "add" && "border-emerald-500/70 bg-emerald-500/10 text-foreground",
              row.kind === "del" && "border-red-500/70 bg-red-500/10 text-foreground/80",
              row.kind === "ctx" && "border-transparent text-muted-foreground",
              row.kind === "hunk" && "border-transparent bg-muted/40 text-muted-foreground/70",
            )}
          >
            <span aria-hidden className={cn("inline-block w-4 select-none font-semibold", row.kind === "add" && "text-emerald-500", row.kind === "del" && "text-red-500")}>
              {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
            </span>
            {row.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ label, aside, children }: { label: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">{label}</span>
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }).catch(() => {});
      }}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Copy className="h-3 w-3" />
      {done ? t("sdk.detail.copied") : t("sdk.detail.copy")}
    </button>
  );
}

const field = (o: unknown, key: string): string => {
  const v = o && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : "";
};

function formatTime(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ------------------------------------------------------------ a linha de ação */

/**
 * O que a linha da ação mostra sob a manchete: o resultado ("7 linhas", "erro: …"). Exportado para
 * a linha da conversa e para a linha do tempo do subagente usarem a mesma frase.
 */
export function ToolResultText({ name, result }: { name: string; result?: ToolResultSummary }) {
  const line = toolResultLine(name, result);
  if (!line) return null;
  return (
    <div
      data-testid="sdk-tool-result"
      data-error={result?.isError || undefined}
      className={cn("mt-0.5 flex min-w-0 items-baseline gap-1 pl-[1.1rem]", result?.isError ? "text-red-500" : "text-muted-foreground/80")}
    >
      <span aria-hidden className="shrink-0 select-none opacity-60">⌊</span>
      <span className="min-w-0 truncate">{line}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ a frota */

/**
 * OS SUBAGENTES disparados em sequência: uma linha por subagente, com o que ele faz agora, quantas
 * ações fez e há quanto tempo. No lugar do "6 ações" que escondia todos eles atrás de um clique.
 */
interface FleetProps { rows: SdkRow[]; tasks: Record<string, AgentTask>; children: ReadonlyMap<string, readonly SdkRow[]> }

/**
 * A frota só redesenha quando ALGO DELA mudou: um token da resposta do principal recria o array de
 * linhas a cada delta, mas as linhas dos subagentes são as mesmas referências. PURE.
 */
export function fleetPropsEqual(a: FleetProps, b: FleetProps): boolean {
  if (a.tasks !== b.tasks || a.rows.length !== b.rows.length || a.rows.some((row, i) => row !== b.rows[i])) return false;
  return a.rows.every((row) => a.children.get(row.id) === b.children.get(row.id));
}

export const SdkFleet = React.memo(SdkFleetView, fleetPropsEqual);

export function SdkFleetView({ rows, tasks, children }: FleetProps) {
  const t = useT();
  const { open } = React.useContext(SdkDetailContext);
  const agents = rows.filter((r): r is ToolRow => r.kind === "tool");
  const statuses = agents.map((row) => agentStatus(row, tasks[row.id]));
  const done = statuses.filter((s) => s === "ok" || s === "error").length;
  const running = statuses.filter((s) => s === "running").length;
  return (
    <div data-testid="sdk-fleet" data-count={agents.length} className="rounded-md border border-border/70 bg-muted/40 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-1.5">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground/90">{t("sdk.fleet.title", { n: agents.length })}</span>
        {agents.length > 1 ? (
          <span className="text-muted-foreground">{t("sdk.fleet.count", { done, running })}</span>
        ) : null}
      </div>
      {agents.length > 1 ? (
        <div className="mb-1 mt-2 h-1 overflow-hidden rounded-full bg-border/60">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round((done / agents.length) * 100)}%` }} />
        </div>
      ) : null}
      <div className="mt-1 space-y-0.5">
        {agents.map((row, i) => {
          const task = tasks[row.id];
          const status = statuses[i] as ToolStatus;
          const kids = children.get(row.id) ?? [];
          const lastKid = [...kids].reverse().find((k) => k.kind === "tool") as ToolRow | undefined;
          const now = task?.status === "running" || !task
            ? task?.summary || (task?.lastTool ? task.lastTool : lastKid ? toolHeadline(lastKid.name, lastKid.input).title : "")
            : t(task.status === "completed" ? "sdk.fleet.finished" : "sdk.fleet.stopped");
          const actions = task?.toolUses ?? row.result?.agent?.toolUses ?? kids.filter((k) => k.kind === "tool").length;
          const duration = task?.durationMs ?? row.result?.agent?.durationMs;
          return (
            <button
              key={row.id}
              type="button"
              data-testid="sdk-fleet-agent"
              data-status={status}
              onClick={() => open({ kind: "agent", id: row.id })}
              className="grid w-full grid-cols-[1rem_minmax(7rem,12rem)_minmax(0,1fr)_auto_0.75rem] items-center gap-2 rounded px-1 py-1 text-left hover:bg-background/60"
            >
              <StatusIcon status={status} className="h-3.5 w-3.5" />
              <span className="min-w-0 truncate font-medium text-foreground/90">{agentName(row.input)}</span>
              <span className="min-w-0 truncate text-muted-foreground">{now}</span>
              <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/80">
                {[actions ? t("sdk.result.actions", { n: actions }) : null, duration ? formatDuration(duration) : null].filter(Boolean).join(" · ")}
              </span>
              <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- os modais */

interface HostProps {
  rows: readonly SdkRow[];
  tasks: Record<string, AgentTask>;
  stack: DetailView[];
  onStack: (stack: DetailView[]) => void;
}

/** O lugar onde os modais vivem: uma pilha (ação aberta de dentro de um subagente volta para ele). */
export function SdkDetailHost({ rows, tasks, stack, onStack }: HostProps) {
  const t = useT();
  const view = stack[stack.length - 1];
  const back = stack.length > 1 ? () => onStack(stack.slice(0, -1)) : undefined;
  const push = (next: DetailView) => onStack([...stack, next]);
  const replace = (next: DetailView) => onStack([...stack.slice(0, -1), next]);
  return (
    <Dialog open={view !== undefined} onOpenChange={(open) => { if (!open) onStack([]); }}>
      <DialogContent
        data-testid="sdk-detail"
        data-view={view?.kind}
        className="flex h-[min(86vh,820px)] w-[min(960px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0"
        onKeyDown={(e) => {
          if (view?.kind !== "action") return;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            const target = e.target as HTMLElement;
            if (target.closest("input,textarea")) return;
            const seq = actionSequence(view, rows);
            const i = seq.indexOf(view.id) + (e.key === "ArrowRight" ? 1 : -1);
            if (i >= 0 && i < seq.length) replace({ ...view, id: seq[i] as string });
          }
        }}
      >
        {view?.kind === "action" ? (
          <ActionView view={view} rows={rows} tasks={tasks} back={back} onNav={replace} onOpenAgent={(id) => push({ kind: "agent", id })} />
        ) : view?.kind === "agent" ? (
          <AgentView id={view.id} rows={rows} tasks={tasks} back={back} onOpenStep={(id, seq) => push({ kind: "action", id, seq, owner: view.id })} />
        ) : view?.kind === "changes" ? (
          <ChangesView rows={rows} onOpenAction={(id) => push({ kind: "action", id })} />
        ) : (
          <DialogTitle className="sr-only">{t("sdk.detail.title")}</DialogTitle>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Por onde as setas andam: a sequência dada (passos de um subagente) ou as ações do mesmo fio. PURE. */
export function actionSequence(view: Extract<DetailView, { kind: "action" }>, rows: readonly SdkRow[]): string[] {
  if (view.seq && view.seq.length) return view.seq;
  const row = rows.find((r) => r.kind === "tool" && r.id === view.id) as ToolRow | undefined;
  const parent = row?.parent;
  return rows.filter((r): r is ToolRow => r.kind === "tool" && !r.pending && r.parent === parent).map((r) => r.id);
}

function BackButton({ back, label }: { back?: () => void; label: string }) {
  if (!back) return null;
  return (
    <button type="button" data-testid="sdk-detail-back" onClick={back} className="mb-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ChevronLeft className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/* ------------------------------------------------------------- uma ação */

function ActionView({
  view, rows, tasks, back, onNav, onOpenAgent,
}: {
  view: Extract<DetailView, { kind: "action" }>;
  rows: readonly SdkRow[];
  tasks: Record<string, AgentTask>;
  back?: () => void;
  onNav: (view: Extract<DetailView, { kind: "action" }>) => void;
  onOpenAgent: (id: string) => void;
}) {
  const t = useT();
  const row = rows.find((r) => r.kind === "tool" && r.id === view.id) as ToolRow | undefined;
  const rowStatus: ToolStatus | null = row ? (row.name === "Agent" || row.name === "Task" ? agentStatus(row, tasks[row.id]) : toolStatus(row)) : null;
  // Enquanto a ação roda (ou o transcript ainda não tem o resultado dela), o detalhe é pedido de
  // novo: a saída aparece sozinha quando o comando termina, sem fechar e abrir o modal.
  const [waiting, setWaiting] = React.useState(false);
  const { data, loading, error } = useDetail<ToolDetailData>("tool", { id: view.id }, view.id, rowStatus === "running" || waiting ? ACTION_POLL_MS : undefined, rowStatus ?? "");
  const detail = data && data.found ? data : null;
  const pendingResult = detail !== null && !detailHasResult(detail);
  React.useEffect(() => setWaiting(pendingResult), [pendingResult]);
  const name = detail?.name || row?.name || "?";
  const input = detail?.input ?? row?.input;
  const result = detail?.result ?? row?.result;
  const status: ToolStatus = rowStatus ?? (result ? (result.isError ? "error" : "ok") : pendingResult ? "running" : "unknown");
  const headline = toolHeadline(name, input);
  const seq = actionSequence(view, rows);
  const at = seq.indexOf(view.id);
  const who = detail?.by === "subagent" || row?.parent
    ? t("sdk.detail.bySubagent", { name: detail?.agentDescription || (row?.parent ? agentName((rows.find((r) => r.id === row.parent) as ToolRow | undefined)?.input) : "") })
    : t("sdk.detail.byMain");
  const duration = detail?.startedAt && detail.endedAt ? formatDuration(detail.endedAt - detail.startedAt) : "";
  const resultLine = toolResultLine(name, result);
  return (
    <>
      <div className="shrink-0 border-b border-border/70 px-5 pb-3 pt-4">
        <BackButton back={back} label={t("sdk.detail.back")} />
        <div className="flex min-w-0 items-center gap-2 pr-8">
          <StatusIcon status={status} className="h-4 w-4" />
          <span className="shrink-0 rounded border border-border/70 bg-muted/50 px-1.5 py-px font-mono text-[11px] text-muted-foreground">{name}</span>
          <DialogTitle className="min-w-0 truncate text-base font-semibold">{headline.title}</DialogTitle>
          <StatusPill status={status} />
        </div>
        <DialogDescription asChild>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{who}</span>
            {detail?.startedAt ? <span>{formatTime(detail.startedAt)}</span> : null}
            {duration ? <span>{t("sdk.detail.took", { d: duration })}</span> : null}
            {resultLine ? <span className={cn(result?.isError && "text-red-500")}>{resultLine}</span> : null}
          </div>
        </DialogDescription>
      </div>
      <div data-testid="sdk-detail-body" className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-4 text-sm">
        {detail?.thinking ? (
          <Section label={<><Brain className="h-3.5 w-3.5" />{t("sdk.detail.why")}</>}>
            <div data-testid="sdk-detail-why" className="whitespace-pre-wrap border-l-2 border-primary/50 pl-3 text-[13px] italic leading-relaxed text-muted-foreground">{detail.thinking}</div>
          </Section>
        ) : null}
        <ActionBody name={name} input={input} detail={pendingResult ? null : detail} row={row} onOpenAgent={onOpenAgent} />
        {pendingResult ? (
          <div data-testid="sdk-detail-pending" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            {status === "running" || status === "unknown" ? t("sdk.detail.stillRunning") : t("sdk.detail.resultPending")}
          </div>
        ) : null}
        {loading && !detail ? (
          <div data-testid="sdk-detail-loading" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("sdk.detail.loading")}</div>
        ) : null}
        {!loading && !detail ? (
          <div data-testid="sdk-detail-missing" className="text-xs italic text-muted-foreground">{error === "offline" ? t("sdk.detail.offline") : error ? t("sdk.detail.failedToLoad") : t("sdk.detail.notFound")}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border/70 px-5 py-2.5 text-xs text-muted-foreground">
        <button type="button" data-testid="sdk-detail-prev" disabled={at <= 0} onClick={() => onNav({ ...view, id: seq[at - 1] as string })} className="flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2.5 py-1 hover:bg-muted disabled:opacity-35">
          <ChevronLeft className="h-3.5 w-3.5" />{t("sdk.detail.prev")}
        </button>
        <span data-testid="sdk-detail-position">{at >= 0 ? t("sdk.detail.position", { i: at + 1, n: seq.length }) : ""}</span>
        <button type="button" data-testid="sdk-detail-next" disabled={at < 0 || at >= seq.length - 1} onClick={() => onNav({ ...view, id: seq[at + 1] as string })} className="flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2.5 py-1 hover:bg-muted disabled:opacity-35">
          {t("sdk.detail.next")}<ChevronRight className="h-3.5 w-3.5" />
        </button>
        <span className="flex-1" />
        <span className="hidden sm:inline">{t("sdk.detail.keys")}</span>
      </div>
    </>
  );
}

function ActionBody({ name, input, detail, row, onOpenAgent }: { name: string; input: unknown; detail: ToolDetailData | null; row?: ToolRow; onOpenAgent: (id: string) => void }) {
  const t = useT();
  const file = field(input, "file_path") || field(input, "notebook_path") || field(input, "path");
  if (name === "Bash" || name === "BashOutput") {
    const command = field(input, "command");
    const out = detail ? bashOutput(detail) : null;
    return (
      <>
        {command ? (
          <Section label={t("sdk.detail.command")} aside={<CopyButton text={command} />}>
            <pre className="whitespace-pre-wrap break-all rounded-md border border-border/70 bg-card px-3 py-2 font-mono text-xs"><span className="select-none text-muted-foreground">$ </span>{command}</pre>
          </Section>
        ) : null}
        {out ? (
          <>
            <Section label={t("sdk.detail.output")}>
              {out.stdout.trim() ? <CodeBlock text={out.stdout} /> : <div className="text-[13px] italic text-muted-foreground">{t("sdk.detail.noOutput")}</div>}
            </Section>
            {out.stderr.trim() ? <Section label={<span className="text-red-500">{t("sdk.detail.stderr")}</span>}><CodeBlock text={out.stderr} tone="error" /></Section> : null}
          </>
        ) : null}
        {detail?.isError && !out?.stderr.trim() && !out?.stdout.trim() ? <ErrorBox text={detail.text ?? ""} /> : null}
      </>
    );
  }
  if (name === "Read") {
    if (!detail || detail.isError) return <>{file ? <FileLabel path={file} /> : null}{detail?.isError ? <ErrorBox text={detail.text ?? ""} /> : null}</>;
    const { content, startLine } = readContent(detail);
    return <Section label={<FileLabel path={file} />}><CodeBlock text={content} start={startLine} /></Section>;
  }
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    const fromResult = detail ? patchRows(detail.structured) : null;
    const fromInput = toolDiff(name, input);
    const rows: DiffRow[] | null = fromResult ?? (fromInput ? fromInput.hunks.flatMap((h, i) => [...(i > 0 ? [{ kind: "hunk" as const, text: "⋯" }] : []), ...h.map((l) => ({ kind: l.kind, text: l.text }))]) : null);
    const created = name === "Write" && (fromInput?.created ?? false);
    return (
      <>
        {detail?.isError ? <ErrorBox text={detail.text ?? ""} label={t("sdk.detail.notApplied")} /> : null}
        <Section label={<FileLabel path={file} />} aside={<span>{created ? t("sdk.detail.newFile") : detail?.isError ? "" : t("sdk.detail.applied")}</span>}>
          {rows && rows.length ? <DiffBlock rows={rows} /> : name === "Write" ? <CodeBlock text={field(input, "content")} /> : null}
        </Section>
      </>
    );
  }
  if (name === "Grep" || name === "Glob") {
    return (
      <>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">{t("sdk.detail.pattern")}</dt><dd className="min-w-0 break-words font-mono">{field(input, "pattern")}</dd>
          {field(input, "path") ? <><dt className="text-muted-foreground">{t("sdk.detail.where")}</dt><dd className="min-w-0 break-words font-mono">{field(input, "path")}</dd></> : null}
          {field(input, "glob") ? <><dt className="text-muted-foreground">glob</dt><dd className="font-mono">{field(input, "glob")}</dd></> : null}
        </dl>
        {detail ? <Section label={t("sdk.detail.results")}>{detail.text?.trim() ? <CodeBlock text={detail.text} numbered={false} /> : <div className="text-[13px] italic text-muted-foreground">{t("sdk.result.nothingFound")}</div>}</Section> : null}
      </>
    );
  }
  if (name === "Agent" || name === "Task") {
    const prompt = field(input, "prompt");
    const report = detail?.text && !detail.result?.background ? detail.text : "";
    return (
      <>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">{t("sdk.detail.subagent")}</dt><dd>{agentName(input)}</dd>
          {field(input, "subagent_type") ? <><dt className="text-muted-foreground">{t("sdk.detail.type")}</dt><dd className="font-mono">{field(input, "subagent_type")}</dd></> : null}
        </dl>
        {row ? (
          <button type="button" data-testid="sdk-detail-open-agent" onClick={() => onOpenAgent(row.id)} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">
            <Bot className="h-3.5 w-3.5" />{t("sdk.detail.openTimeline")}
          </button>
        ) : null}
        {prompt ? <Section label={t("sdk.detail.task")}><div className="whitespace-pre-wrap rounded-md border border-border bg-card px-3 py-2 text-[13px] leading-relaxed">{prompt}</div></Section> : null}
        {report ? <Section label={t("sdk.detail.report")}><div className="rounded-md border border-border bg-card px-3 py-2"><Markdown text={report} /></div></Section> : null}
      </>
    );
  }
  // Qualquer outra (Skill, WebFetch, MCP…): o input e o texto devolvido, sem fingir que sabe mais.
  return (
    <>
      {input !== undefined ? <Section label={t("sdk.detail.input")}><CodeBlock text={JSON.stringify(input, null, 2) ?? ""} numbered={false} /></Section> : null}
      {detail?.isError ? <ErrorBox text={detail.text ?? ""} /> : detail?.text?.trim() ? <Section label={t("sdk.detail.output")}><CodeBlock text={detail.text} numbered={false} /></Section> : null}
    </>
  );
}

function FileLabel({ path }: { path: string }) {
  return <span className="min-w-0 truncate font-mono text-foreground">{path}</span>;
}

function ErrorBox({ text, label }: { text: string; label?: string }) {
  const t = useT();
  return (
    <Section label={<span className="text-red-500">{label ?? t("sdk.detail.error")}</span>}>
      <div data-testid="sdk-detail-error" className="whitespace-pre-wrap rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px] text-red-400">{text.replace(/<\/?tool_use_error>/g, "").trim() || "error"}</div>
    </Section>
  );
}

/* ----------------------------------------------------------- um subagente */

function AgentView({
  id, rows, tasks, back, onOpenStep,
}: {
  id: string;
  rows: readonly SdkRow[];
  tasks: Record<string, AgentTask>;
  back?: () => void;
  onOpenStep: (id: string, seq: string[]) => void;
}) {
  const t = useT();
  const row = rows.find((r) => r.kind === "tool" && r.id === id) as ToolRow | undefined;
  const task = tasks[id];
  const status = row ? agentStatus(row, task) : task ? (task.status === "running" ? "running" : task.status === "completed" ? "ok" : "error") : "unknown";
  const running = status === "running";
  const [tab, setTab] = React.useState<"timeline" | "task" | "report">("timeline");
  const { data, loading, error } = useDetail<AgentTimelineData>("agent", { id }, id, running ? AGENT_POLL_MS : undefined);
  const timeline = data && data.found ? data : null;
  const name = row ? agentName(row.input) : task?.description || timeline?.description || "Agent";
  const prompt = timeline?.prompt || field(row?.input, "prompt");
  const lastText = timeline ? [...timeline.items].reverse().find((i) => i.kind === "text") : undefined;
  const report = !running ? (task?.summary || (lastText && lastText.kind === "text" ? lastText.text : "")) : "";
  const toolUses = task?.toolUses ?? timeline?.toolCount;
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const count = timeline?.items.length ?? 0;
  React.useEffect(() => {
    // Rodando: a ponta viva é o que interessa, como no terminal.
    if (running && tab === "timeline" && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [count, running, tab]);
  const seq = timeline ? timeline.items.filter((i) => i.kind === "tool").map((i) => (i as { id: string }).id) : [];
  return (
    <>
      <div className="shrink-0 border-b border-border/70 px-5 pt-4">
        <BackButton back={back} label={t("sdk.detail.back")} />
        <div className="flex min-w-0 items-center gap-2 pr-8">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="min-w-0 truncate text-base font-semibold">{name}</DialogTitle>
          {timeline?.agentType || task?.subagentType ? <span className="shrink-0 rounded border border-border/70 bg-muted/50 px-1.5 py-px font-mono text-[11px] text-muted-foreground">{timeline?.agentType || task?.subagentType}</span> : null}
          <StatusPill status={status} />
        </div>
        <DialogDescription asChild>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {timeline?.startedAt ? <span>{t("sdk.detail.started", { at: formatTime(timeline.startedAt) })}</span> : null}
            {task?.durationMs ? <span>{formatDuration(task.durationMs)}</span> : null}
            {typeof toolUses === "number" ? <span>{t("sdk.result.actions", { n: toolUses })}</span> : null}
            {task?.tokens ? <span>{t("sdk.detail.tokens", { n: formatTokens(task.tokens) })}</span> : null}
          </div>
        </DialogDescription>
        {running && (task?.summary || task?.lastTool) ? (
          <div data-testid="sdk-agent-now" className="mt-2.5 flex items-start gap-2.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[13px]">
            <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
            <div className="min-w-0">
              <span className="font-medium">{t("sdk.detail.now")}</span> {task?.summary || task?.lastTool}
            </div>
          </div>
        ) : null}
        <div role="tablist" className="-mb-px mt-3 flex gap-1 text-[13px]">
          {(["timeline", "task", "report"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`sdk-agent-tab-${k}`} onClick={() => setTab(k)}
              className={cn("border-b-2 px-2.5 pb-2 pt-1", tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t(`sdk.detail.tab.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <div ref={scroller} data-testid="sdk-agent-body" className="min-h-0 flex-1 overflow-auto px-5 py-4 text-sm">
        {tab === "timeline" ? (
          timeline ? (
            <>
              {timeline.partial ? <p className="mb-2 text-xs italic text-muted-foreground">{t("sdk.detail.partial")}</p> : null}
              {timeline.items.length === 0 ? <p className="text-xs italic text-muted-foreground">{t("sdk.detail.noSteps")}</p> : null}
              <ol className="space-y-1.5">
                {timeline.items.map((item, i) => <TimelineEntry key={i} item={item} onOpen={(stepId) => onOpenStep(stepId, seq)} />)}
              </ol>
              {running ? <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" />{t("sdk.detail.live")}</div> : null}
            </>
          ) : loading ? (
            <div data-testid="sdk-detail-loading" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("sdk.detail.loading")}</div>
          ) : (
            <p data-testid="sdk-detail-missing" className="text-xs italic text-muted-foreground">{error === "offline" ? t("sdk.detail.offline") : error ? t("sdk.detail.failedToLoad") : t("sdk.detail.agentNotFound")}</p>
          )
        ) : tab === "task" ? (
          prompt ? <div className="whitespace-pre-wrap rounded-md border border-border bg-card px-3 py-2 text-[13px] leading-relaxed">{prompt}</div> : <p className="text-xs italic text-muted-foreground">{t("sdk.detail.noTask")}</p>
        ) : report ? (
          <div data-testid="sdk-agent-report" className="rounded-md border border-border bg-card px-4 py-3"><Markdown text={report} /></div>
        ) : (
          <p className="text-xs italic text-muted-foreground">{running ? t("sdk.detail.reportLater") : t("sdk.detail.noReport")}</p>
        )}
      </div>
    </>
  );
}

function TimelineEntry({ item, onOpen }: { item: TimelineItem; onOpen: (id: string) => void }) {
  const time = <span className="w-16 shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground/60">{formatTime(item.at)}</span>;
  if (item.kind === "thinking") {
    return (
      <li data-testid="sdk-timeline-thinking" className="flex gap-2">
        {time}<Brain className="mt-1 h-3 w-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 whitespace-pre-wrap text-xs italic leading-relaxed text-muted-foreground">{item.text}</div>
      </li>
    );
  }
  if (item.kind === "text") {
    return (
      <li data-testid="sdk-timeline-text" className="flex gap-2">
        {time}<MessageSquare className="mt-1 h-3 w-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 text-[13px] leading-relaxed"><Markdown text={item.text} /></div>
      </li>
    );
  }
  if (item.kind !== "tool") return null;
  const headline = toolHeadline(item.name, item.input);
  const status: ToolStatus = item.result ? (item.result.isError ? "error" : "ok") : "running";
  return (
    <li data-testid="sdk-timeline-tool" className="flex gap-2">
      {time}
      <button type="button" onClick={() => onOpen(item.id)} className="group -my-0.5 flex min-w-0 flex-1 items-start gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-muted/50">
        <StatusIcon status={status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground/90">{headline.title}</div>
          {headline.detail ? <div className="truncate font-mono text-[11px] text-muted-foreground/75">{headline.detail}</div> : null}
          {item.result ? <div className={cn("truncate", item.result.isError ? "text-red-500" : "text-muted-foreground/80")}>{toolResultLine(item.name, item.result)}</div> : null}
        </div>
        <Maximize2 className="mt-0.5 h-3 w-3 shrink-0 opacity-0 group-hover:opacity-60" />
      </button>
    </li>
  );
}

/* --------------------------------------------------------------- mudanças */

export function useChangedFiles(rows: readonly SdkRow[]) {
  return React.useMemo(() => changedFiles(rows, (name, input) => {
    const d = toolDiff(name, input);
    return d ? { added: d.added, removed: d.removed } : null;
  }), [rows]);
}

function ChangesView({ rows, onOpenAction }: { rows: readonly SdkRow[]; onOpenAction: (id: string) => void }) {
  const t = useT();
  const files = useChangedFiles(rows);
  const [tab, setTab] = React.useState<"claude" | "git">("claude");
  const [picked, setPicked] = React.useState(0);
  const current = files[Math.min(picked, files.length - 1)];
  const git = useDetail<CardChangesData>("changes", {}, tab === "git" ? "changes" : null);
  const [gitFile, setGitFile] = React.useState<string | null>(null);
  const diff = useDetail<FileDiffData>("file", { path: gitFile ?? "" }, tab === "git" && gitFile ? `file:${gitFile}` : null);
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  const gitFiles = git.data ? mergeGitFiles(git.data) : [];
  return (
    <>
      <div className="shrink-0 border-b border-border/70 px-5 pt-4">
        <div className="flex items-center gap-2 pr-8">
          <FileDiff className="h-4 w-4 text-muted-foreground" />
          <DialogTitle className="text-base font-semibold">{t("sdk.changes.title")}</DialogTitle>
        </div>
        <DialogDescription className="mt-1.5 text-xs text-muted-foreground">
          {t("sdk.changes.summary", { n: files.length, added, removed })}
        </DialogDescription>
        <div role="tablist" className="-mb-px mt-3 flex gap-1 text-[13px]">
          <button type="button" role="tab" aria-selected={tab === "claude"} data-testid="sdk-changes-tab-claude" onClick={() => setTab("claude")} className={cn("border-b-2 px-2.5 pb-2 pt-1", tab === "claude" ? "border-primary" : "border-transparent text-muted-foreground")}>{t("sdk.changes.byClaude")}</button>
          <button type="button" role="tab" aria-selected={tab === "git"} data-testid="sdk-changes-tab-git" onClick={() => setTab("git")} className={cn("flex items-center gap-1 border-b-2 px-2.5 pb-2 pt-1", tab === "git" ? "border-primary" : "border-transparent text-muted-foreground")}><GitBranch className="h-3.5 w-3.5" />{t("sdk.changes.git")}</button>
        </div>
      </div>
      {tab === "claude" ? (
        files.length === 0 ? (
          <p className="px-5 py-4 text-xs italic text-muted-foreground">{t("sdk.changes.none")}</p>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[18rem_1fr]">
            <div className="max-h-48 overflow-auto border-b border-border/70 p-2 sm:max-h-none sm:border-b-0 sm:border-r">
              {files.map((f, i) => (
                <button key={f.path} type="button" data-testid="sdk-changes-file" onClick={() => setPicked(i)}
                  className={cn("grid w-full grid-cols-[1fr_auto] gap-x-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/60", f === current && "bg-muted")}>
                  <span className="min-w-0 truncate font-mono" title={f.path}>{f.path.split("/").pop()}</span>
                  <span className="tabular-nums"><span className="text-emerald-500">+{f.added}</span> <span className="text-red-500">−{f.removed}</span></span>
                  <span className="col-span-2 truncate text-[11px] text-muted-foreground">{f.path}</span>
                </button>
              ))}
            </div>
            <div className="min-h-0 space-y-4 overflow-auto px-4 py-3">
              {current?.rows.map((row) => {
                const d = toolDiff(row.name, row.input);
                return (
                  <section key={row.id} className="space-y-1.5">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <StatusIcon status={toolStatus(row)} />
                      <span>{row.parent ? t("sdk.detail.bySubagent", { name: agentName((rows.find((r) => r.id === row.parent) as ToolRow | undefined)?.input) }) : t("sdk.detail.byMain")}</span>
                      <span className="flex-1" />
                      <button type="button" onClick={() => onOpenAction(row.id)} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"><Maximize2 className="h-3 w-3" />{t("sdk.changes.openAction")}</button>
                    </div>
                    {d ? <DiffBlock rows={d.hunks.flatMap((h, i) => [...(i > 0 ? [{ kind: "hunk" as const, text: "⋯" }] : []), ...h.map((l) => ({ kind: l.kind, text: l.text }))])} /> : null}
                  </section>
                );
              })}
            </div>
          </div>
        )
      ) : git.data ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[18rem_1fr]">
          <div className="max-h-48 overflow-auto border-b border-border/70 p-2 text-xs sm:max-h-none sm:border-b-0 sm:border-r">
            <div className="px-2 pb-2 text-muted-foreground">
              <div className="truncate font-mono">{git.data.branch} ← {git.data.base}</div>
              <div>{t("sdk.changes.gitStat", { n: git.data.stat.files, added: git.data.stat.insertions, removed: git.data.stat.deletions, commits: git.data.commits.length })}</div>
            </div>
            {gitFiles.length === 0 ? <p className="px-2 italic text-muted-foreground">{t("sdk.changes.gitNone")}</p> : null}
            {gitFiles.map((f) => (
              <button key={f.path} type="button" data-testid="sdk-changes-git-file" onClick={() => setGitFile(f.path)}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60", gitFile === f.path && "bg-muted")}>
                <span className="w-6 shrink-0 font-mono text-[11px] font-semibold text-amber-500">{f.status}</span>
                <span className="min-w-0 truncate font-mono" title={f.path}>{f.path}</span>
                {f.uncommitted ? <span className="shrink-0 text-[10px] text-muted-foreground">{t("sdk.changes.uncommitted")}</span> : null}
              </button>
            ))}
          </div>
          <div className="min-h-0 overflow-auto px-4 py-3">
            {!gitFile ? <p className="text-xs italic text-muted-foreground">{t("sdk.changes.pickFile")}</p>
              : diff.data ? (diff.data.diff.trim() ? <DiffBlock rows={parseUnifiedDiff(diff.data.diff)} /> : <p className="text-xs italic text-muted-foreground">{t("sdk.changes.noDiff")}</p>)
              : diff.loading ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("sdk.detail.loading")}</div>
              : <p className="text-xs italic text-muted-foreground">{t("sdk.detail.failedToLoad")}</p>}
          </div>
        </div>
      ) : (
        <div className="px-5 py-4 text-xs text-muted-foreground">
          {git.loading ? <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("sdk.detail.loading")}</span> : t("sdk.detail.failedToLoad")}
        </div>
      )}
    </>
  );
}

/** Os arquivos do branch e os não commitados, num só lista (o não commitado marcado). PURE. */
export function mergeGitFiles(data: CardChangesData): Array<{ path: string; status: string; uncommitted: boolean }> {
  const out = new Map<string, { path: string; status: string; uncommitted: boolean }>();
  for (const f of data.files) out.set(f.path, { path: f.path, status: f.status.slice(0, 1), uncommitted: false });
  for (const f of data.uncommitted) {
    const prev = out.get(f.path);
    out.set(f.path, { path: f.path, status: prev?.status ?? (f.status === "??" ? "A" : f.status.slice(0, 1)), uncommitted: true });
  }
  return [...out.values()];
}
