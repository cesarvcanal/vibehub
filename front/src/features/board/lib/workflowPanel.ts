import type { WorkflowAgentFrame, WorkflowFeedItem } from "./sdkChat";

/**
 * As contas do PAINEL DO WORKFLOW (components/WorkflowPanel.tsx), fora do componente para serem
 * testáveis sem tela: tempos legíveis, quanto falta, agrupamento por fase e o feed de um subagente.
 * Tudo PURE.
 */

/** "45s", "3m 12s", "1h 04m". Negativo ou inválido vira "0s". */
export function formatDuration(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Quantos subagentes trabalharam AO MESMO TEMPO no pico (o fim conta antes do começo no empate). */
function observedConcurrency(agents: readonly WorkflowAgentFrame[], now: number): number {
  const edges: Array<[number, 1 | -1]> = [];
  for (const a of agents) {
    if (a.startedAt === undefined) continue;
    const end = a.status === "done" ? (a.endedAt ?? a.lastAt ?? a.startedAt) : now;
    edges.push([a.startedAt, 1], [Math.max(end, a.startedAt), -1]);
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    live += delta;
    peak = Math.max(peak, live);
  }
  return peak;
}

/**
 * Quanto falta, pela média de quem já terminou — calculado na tela, porque o relógio que anda é o
 * dela. Em voo: a média menos o que já correu; na fila (contados no diário, fora da lista): a média
 * inteira; tudo dividido pela concorrência observada. Sem concluído com tempo conhecido não há
 * base: `null`.
 */
export function estimateWorkflowRemaining(
  run: { agents: readonly WorkflowAgentFrame[]; total: number; done: number },
  now: number,
): { remainingMs: number; averageMs: number } | null {
  const durations = run.agents
    .filter((a) => a.status === "done" && a.startedAt !== undefined && a.endedAt !== undefined && a.endedAt >= a.startedAt)
    .map((a) => (a.endedAt ?? 0) - (a.startedAt ?? 0));
  if (durations.length === 0) return null;
  const averageMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const running = run.agents.filter((a) => a.status === "running");
  const inFlight = running.reduce(
    (sum, a) => sum + Math.max(0, averageMs - (a.startedAt !== undefined ? now - a.startedAt : 0)),
    0,
  );
  const queued = Math.max(0, run.total - run.done - running.length);
  const lanes = Math.max(1, observedConcurrency(run.agents, now));
  return { remainingMs: Math.round((inFlight + queued * averageMs) / lanes), averageMs: Math.round(averageMs) };
}

/** As fases na ordem em que o painel as desenha: o plano primeiro, depois as que só os agentes citam. */
function orderedPhases(agents: readonly WorkflowAgentFrame[], plan: readonly string[]): string[] {
  const order = [...plan];
  for (const a of agents) {
    const phase = a.phase ?? "";
    if (phase && !order.includes(phase)) order.push(phase);
  }
  return order;
}

/** Os agentes agrupados por fase, só os grupos com alguém; os sem fase vão por último (fase ""). */
export function groupAgentsByPhase(
  agents: readonly WorkflowAgentFrame[],
  plan: readonly string[],
): Array<{ phase: string; agents: WorkflowAgentFrame[] }> {
  return [...orderedPhases(agents, plan), ""]
    .map((phase) => ({ phase, agents: agents.filter((a) => (a.phase ?? "") === phase) }))
    .filter((group) => group.agents.length > 0);
}

export interface PhasePill {
  title: string;
  done: number;
  total: number;
  /**
   * done = todos os que começaram nela terminaram; current = alguém rodando; waiting = ninguém ainda;
   * stopped = ninguém rodando, mas alguém parou sem responder (rodada morta ou abandonada).
   */
  state: "done" | "current" | "waiting" | "stopped";
}

/**
 * Uma pílula por fase do plano (inclusive as que ainda não começaram) e por fase só citada.
 * `finished`: numa rodada terminada, quem não respondeu não está mais rodando.
 */
export function phasePills(agents: readonly WorkflowAgentFrame[], plan: readonly string[], finished = false): PhasePill[] {
  return orderedPhases(agents, plan).map((title) => {
    const list = agents.filter((a) => a.phase === title);
    const done = list.filter((a) => a.status === "done").length;
    const running = finished ? 0 : list.filter((a) => a.status === "running").length;
    const state: PhasePill["state"] =
      list.length === 0 ? "waiting" : done === list.length ? "done" : running > 0 ? "current" : "stopped";
    return { title, done, total: list.length, state };
  });
}

/** Uma linha do feed na tela. `thinking` = ainda pensando (há `ms`); `thought` = pensou por `ms`. */
export type FeedLine =
  | { kind: "tool"; tool: string; target: string }
  | { kind: "text"; text: string }
  | { kind: "thought"; ms: number }
  | { kind: "thinking"; ms: number };

/**
 * O feed lido pela pessoa. O resultado cru de cada ferramenta fica de fora (é ruído: o verbo e o
 * alvo já contam a ação). O raciocínio NUNCA mostra texto — o CLI grava vazio, e mesmo um texto
 * que viesse não é para a tela: vira só quanto durou, até o passo seguinte.
 */
export function feedLines(
  items: readonly WorkflowFeedItem[],
  context: { running: boolean; now: number; endedAt?: number },
): FeedLine[] {
  const lines: FeedLine[] = [];
  items.forEach((item, i) => {
    if (item.kind === "tool" && item.tool) lines.push({ kind: "tool", tool: item.tool, target: item.target ?? "" });
    else if (item.kind === "text" && item.text) lines.push({ kind: "text", text: item.text });
    else if (item.kind === "thinking") {
      const next = items[i + 1];
      if (next) lines.push({ kind: "thought", ms: Math.max(0, next.at - item.at) });
      else if (context.running) lines.push({ kind: "thinking", ms: Math.max(0, context.now - item.at) });
      else lines.push({ kind: "thought", ms: Math.max(0, (context.endedAt ?? item.at) - item.at) });
    }
  });
  return lines;
}

const VERB_TOOLS = new Set(["Read", "Edit", "Write", "Grep", "Glob", "Bash", "Agent", "WebFetch", "WebSearch", "TodoWrite"]);
const VERB_ALIASES: Record<string, string> = { MultiEdit: "Edit", NotebookEdit: "Edit", Task: "Agent" };

/** A chave i18n do verbo humano de uma ferramenta ("Leu", "Editou"…); desconhecida → genérico. */
export function verbKey(tool: string): string {
  const name = VERB_ALIASES[tool] ?? tool;
  return VERB_TOOLS.has(name) ? `sdk.verb.${name}` : "sdk.verb.default";
}
