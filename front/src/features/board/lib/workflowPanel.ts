import type { WorkflowAgentFrame, WorkflowFeedItem } from "./sdkChat";

/**
 * The calculations of the WORKFLOW PANEL (components/WorkflowPanel.tsx), kept out of the component so
 * they are testable without a screen: readable times, how much is left, grouping by phase and a
 * subagent's feed. All PURE.
 */

/** "45s", "3m 12s", "1h 04m". Negative or invalid becomes "0s". */
export function formatWholeSeconds(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How many subagents worked AT THE SAME TIME at the peak (on a tie, the end counts before the start). */
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
 * How much is left, by the average of those already finished — calculated on screen, because the
 * clock that moves is the screen's. In flight: the average minus what has already run; in the queue
 * (counted in the journal, outside the list): the whole average; all divided by the observed
 * concurrency. With no finished agent of known duration there is no basis: `null`.
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

/** The phases in the order the panel draws them: the plan first, then the ones only the agents mention. */
function orderedPhases(agents: readonly WorkflowAgentFrame[], plan: readonly string[]): string[] {
  const order = [...plan];
  for (const a of agents) {
    const phase = a.phase ?? "";
    if (phase && !order.includes(phase)) order.push(phase);
  }
  return order;
}

/** The agents grouped by phase, only the groups with someone in them; those without a phase go last (phase ""). */
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
   * done = everyone who started in it has finished; current = someone running; waiting = nobody yet;
   * stopped = nobody running, but someone stopped without answering (dead or abandoned run).
   */
  state: "done" | "current" | "waiting" | "stopped";
}

/**
 * One pill per phase of the plan (including the ones that have not started yet) and per phase only mentioned.
 * `finished`: in a finished run, whoever did not answer is no longer running.
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

/** A line of the feed on screen. `thinking` = still thinking (for `ms`); `thought` = thought for `ms`. */
export type FeedLine =
  | { kind: "tool"; tool: string; target: string }
  | { kind: "text"; text: string }
  | { kind: "thought"; ms: number }
  | { kind: "thinking"; ms: number };

/**
 * The feed as the person reads it. Each tool's raw result is left out (it is noise: the verb and the
 * target already tell the action). Reasoning NEVER shows text — the CLI writes it empty, and even a text
 * that did come is not for the screen: it becomes only how long it lasted, until the next step.
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

/** The i18n key of a tool's human verb ("Leu", "Editou"…); unknown → generic. */
export function verbKey(tool: string): string {
  const name = VERB_ALIASES[tool] ?? tool;
  return VERB_TOOLS.has(name) ? `sdk.verb.${name}` : "sdk.verb.default";
}
