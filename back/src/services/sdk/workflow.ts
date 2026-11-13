import { config } from "../../config/env.js";
import { hostExecutor } from "../../runtime/host.js";
import { logger } from "../../utils/logger.js";
import {
  RUNS_PROBED,
  buildAgentFeedProbeScript,
  buildWorkflowProbeScript,
  parseAgentFeed,
  parseWorkflowProbe,
  stopInFlight,
  type WorkflowActivity,
  type WorkflowAgent,
  type WorkflowFeedItem,
  type WorkflowRun,
} from "./workflowProbe.js";

/**
 * THE VISIBLE WORKFLOW — what the screen had no way of knowing.
 *
 * The `Workflow` tool returns right away ("Workflow launched in background. Run ID: wf_…") and the turn
 * ENDS: the model says "te trago quando voltar" and goes quiet for minutes while a fleet of
 * subagents works. In Claude Code's terminal this shows up as a live tree; in the panel's chat
 * NOTHING showed up — and whoever was on the other side read that as "it finished" (production,
 * 2026-10-02). The driver's stream does not help either: between the `tool_use` and the final notification
 * not a single event goes by.
 *
 * What really exists is a JOURNAL on disk, inside the runner, written by the harness:
 *
 *   <transcriptDir>/<sessionId>/subagents/workflows/<runId>/journal.jsonl
 *     {"type":"launched"}
 *     {"type":"started","key":"v2:…","agentId":"a3c4…","label":"varre:front","phase":"Varredura"}
 *     {"type":"result","key":"v2:…","agentId":"a3c4…","result":{…}}
 *
 * and, next to it, per subagent, an `agent-<id>.meta.json` (`description`, `workflowPhase`) and an
 * `agent-<id>.jsonl` with its transcript, line by line and with `timestamp`. The label comes from the JOURNAL;
 * the meta and the transcript's "computed task text follows:" line are the fallbacks. The FIRST line of the
 * transcript is no good: in harness 2.1.x it is the "[Workflow harness — user request]" header with
 * the user's request — the same in every subagent.
 *
 * This module reads that from outside (a read-only probe through `docker exec`, built and parsed in
 * ./workflowProbe.ts), turns it into a snapshot and the manager publishes it in the chat. Nothing is written in the
 * runner.
 *
 * The guards are deliberate (the fleet may last an hour and nobody wants a loop on the server): one
 * probe per card, only while someone has the chat open, stopped on its own when the journal
 * goes quiet with no agent in flight (or when the harness writes the outcome), giving up when NOTHING changes for
 * too long, and a hard time cap beyond which it gives up no matter what.
 */

/** Nothing in flight: every subagent that started has already returned (and at least one started). Counts by the
 *  journal's TOTAL, not by the drawn list — the list has a cap, the fleet does not. PURE. */
export function runSettled(run: WorkflowRun): boolean {
  return run.total > 0 && run.done >= run.total;
}

function sameActivity(a: WorkflowActivity | undefined, b: WorkflowActivity | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "tool" && b.kind === "tool") return a.tool === b.tool && a.target === b.target;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  if (a.kind === "thinking" && b.kind === "thinking") return a.since === b.since;
  return false;
}

function agentChanged(a: WorkflowAgent, b: WorkflowAgent | undefined): boolean {
  return (
    !b || a.id !== b.id || a.status !== b.status || a.label !== b.label || a.phase !== b.phase ||
    a.toolCount !== b.toolCount || a.startedAt !== b.startedAt || a.endedAt !== b.endedAt ||
    !sameActivity(a.activity, b.activity)
  );
}

/** Did anything change that is worth a new frame on screen? `lastAt` alone does not: it moves with every
 *  transcript line, and what the screen shows of it already comes through the activity. PURE. */
export function runChanged(previous: WorkflowRun | undefined, next: WorkflowRun): boolean {
  if (!previous) return true;
  if (previous.runId !== next.runId || previous.at !== next.at) return true;
  if (previous.finished !== next.finished || previous.outcome !== next.outcome) return true;
  if (previous.total !== next.total || previous.done !== next.done) return true;
  if (previous.phases.join("\n") !== next.phases.join("\n")) return true;
  if (previous.agents.length !== next.agents.length) return true;
  return previous.agents.some((a, i) => agentChanged(a, next.agents[i]));
}

/* ------------------------------------------------------------------ the probe */

/** How often the fleet is re-read. A journal moves in seconds, not in milliseconds. */
export const WATCH_INTERVAL_MS = 4_000;
/** Journal stopped for this long, with nothing in flight ⇒ the round ended and the probe closes. */
export const WATCH_QUIET_MS = 90_000;
/**
 * No round changed ANYTHING (journal, agent, tool, activity) for this long with an agent in flight
 * ⇒ the fleet is really stuck and the probe gives up. Counted from the last MOVEMENT, not from the start:
 * counting from the start abandoned, at the 1h mark, a 1h43 round that was still moving (17/10/2026).
 */
export const WATCH_STALL_MS = 60 * 60_000;
/** Hard cap: no probe lives longer than this, whatever happens. */
export const WATCH_MAX_MS = 6 * 60 * 60_000;
/**
 * For how long the probe may fail WITHOUT STOPPING (counted from the first failure of the streak, reset
 * by any success) before giving up. It is time, not a number of ticks: a restarting runner takes
 * about a minute, and giving up after 5 ticks (20 s) published as completed a fleet that was still
 * running. Hitting a `docker exec` that fails is cheap, so the ticks go on during the streak.
 */
export const WATCH_FAILURE_GRACE_MS = 3 * 60_000;
/**
 * Consecutive probes WITHOUT any round before giving up. A `Workflow` that dies before writing
 * the journal (a script with a syntax error) leaves nothing to read: without this, its probe would keep
 * hitting the runner every 4 seconds up to the one-hour cap, for nothing.
 */
export const WATCH_MAX_EMPTY = 15;

interface TrackedRun {
  last: WorkflowRun;
  /** The last time THIS round moved (or that nobody was watching). */
  movedAt: number;
  /** The largest `lastAt` (transcript timestamp) seen so far among its agents. */
  lastAt: number;
}

/** The most recent timestamp written by any agent of the round — it is the FILE's, not the clock's. */
function latestAgentAt(run: WorkflowRun): number {
  return run.agents.reduce((max, a) => Math.max(max, a.lastAt ?? 0), 0);
}

/**
 * Did the round end? Killed/failed: right away. Completed: with everything settled, or on the tick AFTER the
 * outcome (the last agent's `result` may be milliseconds away from the snapshot). No outcome:
 * quiet for long enough AND with nothing in flight — both together, because a fleet may go a
 * whole minute without writing while a long subagent thinks. PURE.
 */
function runEnded(run: WorkflowRun, previous: WorkflowRun | undefined, quietFor: number): boolean {
  if (run.outcome === "killed" || run.outcome === "failed") return true;
  if (run.outcome === "completed") return runSettled(run) || previous?.outcome === "completed";
  return runSettled(run) && quietFor >= WATCH_QUIET_MS;
}

interface Watch {
  timer: NodeJS.Timeout;
  /** When the probe started — the hard cap measures from here. */
  startedAt: number;
  /** The last time ANY round changed something on screen — the give-up for being stuck measures from here. */
  activeAt: number;
  /** Start of the ongoing failure streak; `null` = the last probe answered. */
  failingSince: number | null;
  /** Consecutive ticks with no round at all in the directory. */
  empty: number;
  /** A probe in flight: the next tick does not open another on top of it. */
  busy: boolean;
  runs: Map<string, TrackedRun>;
  publish: (run: WorkflowRun) => void;
}

const watches = new Map<string, Watch>();

/**
 * The LAST snapshot published per card, alive AFTER the probe closes: it is what a tab
 * that opens now needs to receive to draw the fleet that has just finished (and the one still running).
 * It goes away with the card's driver — it never grows beyond the open cards.
 */
const lastRuns = new Map<string, WorkflowRun[]>();

export interface WatchDeps {
  /** Where this session's rounds live, and the scripts next to them. `null` = cannot tell yet. */
  dirs: () => { runs: string; scripts: string } | null;
  /** Does anyone have this card's chat open? With nobody watching, there is no probing. */
  watchers: () => number;
  /** The snapshot changed: publish it. */
  publish: (run: WorkflowRun) => void;
  /** Log label (the card's slug). */
  label: string;
  now?: () => number;
}

/** Keeps the published frame, for the tab that connects later. */
function remember(cardId: string, run: WorkflowRun): void {
  const kept = (lastRuns.get(cardId) ?? []).filter((r) => r.runId !== run.runId);
  kept.push(run);
  lastRuns.set(cardId, kept.slice(-RUNS_PROBED));
}

/**
 * Turns the probe off SAYING it turned off: every round left open gets one last frame
 * marked as finished. Without this, giving up (time cap, runner down, a fleet that never wrote)
 * left the panel — and every tab that reconnected afterwards — spinning forever on a fleet that is no longer
 * followed by anyone.
 */
function closeWatch(cardId: string, reason: string, label: string): void {
  const watch = watches.get(cardId);
  if (!watch) return;
  for (const tracked of watch.runs.values()) {
    if (tracked.last.finished) continue;
    // Whoever was in flight is no longer followed: leaving "running" in a finished frame is an eternal spinner.
    const closed: WorkflowRun = { ...tracked.last, agents: stopInFlight(tracked.last.agents), finished: true };
    tracked.last = closed;
    remember(cardId, closed);
    try {
      watch.publish(closed);
    } catch {
      /* the screen closed first — that is no reason for the probe to die standing */
    }
  }
  logger.info({ card: label, reason, runs: watch.runs.size }, "workflow watch stopped");
  stopCardWorkflowWatch(cardId);
}

/**
 * Starts (or keeps) this card's fleet probe. Called on every Workflow `tool_use`: a
 * second call with the probe already up only EXTENDS the tolerated silence — it never opens a
 * second loop, never restarts the hard cap.
 */
export function watchCardWorkflows(cardId: string, deps: WatchDeps): void {
  const now = deps.now ?? Date.now;
  const existing = watches.get(cardId);
  if (existing) {
    for (const tracked of existing.runs.values()) tracked.movedAt = now();
    existing.activeAt = now();
    existing.empty = 0;
    return;
  }
  const watch: Watch = {
    timer: null as unknown as NodeJS.Timeout,
    startedAt: now(),
    activeAt: now(),
    failingSince: null,
    empty: 0,
    busy: false,
    runs: new Map(),
    publish: deps.publish,
  };
  const tick = async (): Promise<void> => {
    if (watches.get(cardId) !== watch) return; // stopped between one tick and the next
    if (watch.busy) return; // the previous probe has not come back yet: two in flight overtake each other
    if (now() - watch.startedAt > WATCH_MAX_MS) {
      closeWatch(cardId, "ceiling", deps.label);
      return;
    }
    if (now() - watch.activeAt > WATCH_STALL_MS) {
      closeWatch(cardId, "stalled", deps.label);
      return;
    }
    // Nobody with the chat open: no `docker exec` is spent for nobody. The silence clock
    // moves along, otherwise the round would be taken as finished just because nobody was watching.
    if (deps.watchers() <= 0) {
      for (const tracked of watch.runs.values()) tracked.movedAt = now();
      watch.activeAt = now();
      // Without probing, one does not know whether the runner stayed down: the streak restarts on the next failure.
      watch.failingSince = null;
      return;
    }
    const dirs = deps.dirs();
    if (!dirs) return; // no session id yet — the next tick tries again
    let runs: WorkflowRun[];
    watch.busy = true;
    try {
      // Only the rounds the probe still reads (the most recent): the others do not need a marker.
      const settled = [...watch.runs.values()]
        .map(({ last }) => last)
        .sort((x, y) => y.at - x.at)
        .slice(0, RUNS_PROBED)
        .flatMap((last) => last.agents.filter((a) => a.status === "done").map((a) => `${last.runId}/${a.id}`));
      const { stdout } = await hostExecutor().runScript(
        buildWorkflowProbeScript(config.runner.container, dirs.runs, dirs.scripts, settled),
        { timeoutMs: 10_000 },
      );
      runs = parseWorkflowProbe(stdout, (runId) => watch.runs.get(runId)?.last);
      watch.failingSince = null;
    } catch (err) {
      // One line per streak, not per tick: the give-up is logged by closeWatch.
      if (watch.failingSince === null) {
        watch.failingSince = now();
        logger.warn({ card: deps.label, detail: (err as Error).message }, "workflow probe failing");
      }
      if (now() - watch.failingSince > WATCH_FAILURE_GRACE_MS) closeWatch(cardId, "probe failures", deps.label);
      return;
    } finally {
      watch.busy = false;
    }
    if (watches.get(cardId) !== watch) return; // parada enquanto a sondagem corria
    if (runs.length === 0) {
      watch.empty += 1;
      if (watch.empty >= WATCH_MAX_EMPTY) closeWatch(cardId, "no journal", deps.label);
      return;
    }
    watch.empty = 0;
    for (const run of runs) {
      const tracked = watch.runs.get(run.runId);
      const movedAt = !tracked || tracked.last.at !== run.at ? now() : tracked.movedAt;
      // An agent in a loop (same tool, transcript beyond what is read) changes nothing that
      // runChanged compares; its transcript timestamp moves — that is movement too.
      const lastAt = Math.max(tracked?.lastAt ?? 0, latestAgentAt(run));
      if (lastAt > (tracked?.lastAt ?? 0)) watch.activeAt = now();
      // Finished = the harness wrote the outcome (including KILLED: its journal never settles), or
      // settled and quiet. A finished frame never carries a "running" agent: it would be an eternal spinner.
      run.finished = runEnded(run, tracked?.last, now() - movedAt);
      if (run.finished) run.agents = stopInFlight(run.agents);
      if (runChanged(tracked?.last, run)) {
        watch.activeAt = now();
        watch.runs.set(run.runId, { last: run, movedAt, lastAt });
        remember(cardId, run);
        deps.publish(run);
      } else if (tracked) {
        tracked.movedAt = movedAt;
        tracked.lastAt = lastAt;
      }
    }
    // It only closes when EVERY round this probe follows has reached its end: a second
    // workflow fired midway keeps the loop alive for both.
    const live = [...watch.runs.values()];
    if (live.length > 0 && live.every((tracked) => tracked.last.finished)) {
      logger.info({ card: deps.label, runs: live.length }, "workflow finished — watch stopped");
      stopCardWorkflowWatch(cardId);
    }
  };
  watch.timer = setInterval(() => void tick(), WATCH_INTERVAL_MS);
  watch.timer.unref?.();
  watches.set(cardId, watch);
  void tick();
}

/** How many steps a subagent's feed brings: the latest actions, not the whole transcript. */
const FEED_REQUEST_ITEMS = 50;

/**
 * The feed of ONE subagent, read now from the runner (same executor as the fleet probe). On demand:
 * only when someone opens the agent in the panel. Throws `InvalidWorkflowIdError` for ids outside the format
 * (before a command exists) and the executor's error when the runner does not answer.
 */
export async function readAgentFeed(runsDir: string, runId: string, agentId: string): Promise<WorkflowFeedItem[]> {
  const script = buildAgentFeedProbeScript(config.runner.container, runsDir, runId, agentId, FEED_REQUEST_ITEMS);
  const { stdout } = await hostExecutor().runScript(script, { timeoutMs: 10_000 });
  return parseAgentFeed(stdout);
}

/** This card's last published frames — what a tab that has just opened needs to see. */
export function lastWorkflowRuns(cardId: string): WorkflowRun[] {
  return lastRuns.get(cardId) ?? [];
}

/** Closes the probe (end of the round, dead driver, paused card). Idempotent. */
function stopCardWorkflowWatch(cardId: string): void {
  const watch = watches.get(cardId);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(cardId);
}

/** The card's driver died: its fleet is no longer this screen's business. */
export function forgetCardWorkflows(cardId: string): void {
  stopCardWorkflowWatch(cardId);
  lastRuns.delete(cardId);
}

/** Test hook: knocks down every live probe and forgets the snapshots. */
export function resetWorkflowWatchesForTesting(): void {
  for (const cardId of [...watches.keys()]) stopCardWorkflowWatch(cardId);
  lastRuns.clear();
}
