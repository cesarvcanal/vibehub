import { hostExecutor, shQuote } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { TRANSCRIPT_FOLLOW_MARKER } from "../chat/chat.js";
import { logger } from "../../utils/logger.js";

/**
 * THE RUNNER REAPER — the periodic garbage collector for processes that leak INSIDE the runner.
 *
 * Why it exists (production incident, 2026-08-29): the runner accumulated ~800 processes — ~180
 * orphaned `claude` processes (ppid 1, running for DAYS after their tmux session was killed: they
 * survive tmux's SIGHUP) plus hundreds of leaked transcript-follow loops (`docker exec` whose
 * backend client died without the in-container loop noticing). Load on an 8-vCPU host hit 55 and
 * vibehub became unusable. The primary fixes are elsewhere (tree-kill in killCardSession, the
 * stdin-EOF liveness check in the follow loop); this is the BACKSTOP that keeps a residual leak
 * from ever piling up again.
 *
 * What it kills, every tick: processes REPARENTED TO PID 1 (nothing owns them any more — every
 * legitimate claude hangs off a tmux pane, every legitimate watcher off a live docker exec) that
 * are ALSO old enough (>= REAP_MIN_AGE_S) and recognisable — a `claude` process or a transcript
 * watcher. The age floor means a process orphaned by a transient hiccup gets a full hour to be
 * irrelevant before it is judged.
 *
 * Resilience: a runner that is down or missing `ps` only produces a warn log — the reaper never
 * takes the backend down and never throws out of a tick.
 *
 * KNOWN LIMIT — zombies need init:true: the runner's PID 1 is `sleep infinity`, which never calls
 * wait(): a process this reaper (or anything else) kills whose parent is already PID 1 becomes a
 * zombie FOREVER (defunct entries; ~176 observed in the incident). Zombies hold no CPU/memory,
 * only a pid slot, but the real fix is recreating the container with `init: true` so PID 1 is a
 * real init that reaps children — scheduled separately with César (see docs/runner-processes.md).
 */

/** Minimum age (seconds) before an orphan is reaped. */
export const REAP_MIN_AGE_S = 3600;

/** How often the reaper sweeps the runner. */
export const REAPER_INTERVAL_MS = 10 * 60_000;

/** One process, as reported by `ps` inside the runner. */
export interface RunnerProc {
  pid: number;
  ppid: number;
  /** Elapsed seconds since the process started (`etimes`). */
  etimes: number;
  args: string;
}

/**
 * Script that lists every process in the runner: pid, ppid, elapsed seconds and the full command
 * line, no header. `ps` comes from procps (installed by the runner setup). PURE.
 */
export function buildProcessListScript(containerName: string): string {
  return `docker exec ${shQuote(containerName)} ps -eo pid=,ppid=,etimes=,args=`;
}

/** Parses the `ps -eo pid=,ppid=,etimes=,args=` output. Malformed lines are skipped. PURE. */
export function parseProcessList(stdout: string): RunnerProc[] {
  const procs: RunnerProc[] = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)/.exec(line);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), etimes: Number(m[3]), args: m[4]! });
  }
  return procs;
}

/**
 * Is this command line a `claude` process? The CLI shows up either as `claude …` (argv[0] is the
 * launcher script) or as `node …/claude …`. Exact-basename match on the first two tokens — never a
 * substring, so `claude-something` or a user command MENTIONING claude does not qualify. PURE.
 */
export function isClaudeProcess(args: string): boolean {
  const tokens = args.trim().split(/\s+/).slice(0, 2);
  return tokens.some((t) => (t.split("/").pop() ?? "") === "claude");
}

/**
 * Is this command line a transcript watcher (the chat's follow loop, or the `tail -F` it forks)?
 * New loops carry TRANSCRIPT_FOLLOW_MARKER on the command line; the tail children — and the loops
 * from before the marker existed — are recognised by their signature: a `tail -n <N> -F` over a
 * `.jsonl` transcript. PURE.
 */
export function isTranscriptWatcher(args: string): boolean {
  if (args.includes(TRANSCRIPT_FOLLOW_MARKER)) return true;
  return /\btail -n \d+ -F\b/.test(args) && args.includes(".jsonl");
}

/**
 * The processes a sweep is allowed to kill: ORPHANED (ppid 1 — reparented, nothing owns them),
 * OLD ENOUGH (>= minAgeS) and RECOGNISED (a claude process or a transcript watcher). Everything
 * else — tmux, panes, live claudes under tmux, live watchers under their docker exec, PID 1
 * itself — never qualifies. PURE/testable.
 */
export function reapCandidates(procs: RunnerProc[], minAgeS: number = REAP_MIN_AGE_S): RunnerProc[] {
  return procs.filter(
    (p) =>
      p.pid > 1 &&
      p.ppid === 1 &&
      p.etimes >= minAgeS &&
      (isClaudeProcess(p.args) || isTranscriptWatcher(p.args)),
  );
}

/** Script that SIGKILLs the given pids inside the runner. Pids are validated integers. PURE. */
export function buildKillPidsScript(containerName: string, pids: number[]): string {
  const safe = pids.filter((p) => Number.isInteger(p) && p > 1);
  if (safe.length === 0) throw new Error("no pids to kill");
  return `docker exec ${shQuote(containerName)} sh -c ${shQuote(`kill -KILL ${safe.join(" ")} 2>/dev/null; true`)}`;
}

/** What the last sweep saw — the observability the /api/runner status exposes. */
export interface RunnerProcessStats {
  /** When the sweep ran (epoch ms). */
  at: number;
  /** Total processes in the runner at sweep time (zombies included — they show in ps). */
  processes: number;
  /** How many orphans this sweep killed. */
  reaped: number;
  /** Cumulative kills since the backend started. */
  reapedTotal: number;
}

let lastStats: RunnerProcessStats | null = null;

/** The last sweep's numbers, or null before the first sweep (or while the runner is unreachable). */
export function runnerProcessStats(): RunnerProcessStats | null {
  return lastStats;
}

/** Test-only reset of the module state. */
export function resetReaperForTesting(): void {
  lastStats = null;
}

/**
 * ONE sweep: list the runner's processes, pick the orphans, kill them, log what died. Returns the
 * stats, or null when the runner could not be asked (logged, never thrown — the runner being down
 * must not hurt the backend).
 */
export async function reapRunnerProcesses(minAgeS: number = REAP_MIN_AGE_S): Promise<RunnerProcessStats | null> {
  const container = config.runner.container;
  let procs: RunnerProc[];
  try {
    const { stdout } = await hostExecutor().runScript(buildProcessListScript(container), { timeoutMs: 30_000 });
    procs = parseProcessList(stdout);
  } catch (e) {
    logger.warn({ detail: (e as Error).message }, "runner reaper could not list processes (runner down? skipping this sweep)");
    return null;
  }
  const victims = reapCandidates(procs, minAgeS);
  if (victims.length > 0) {
    try {
      await hostExecutor().runScript(buildKillPidsScript(container, victims.map((v) => v.pid)), { timeoutMs: 30_000 });
      logger.info(
        {
          audit: true,
          action: "runner.reap",
          reaped: victims.length,
          processes: procs.length,
          victims: victims.map((v) => ({ pid: v.pid, ageS: v.etimes, args: v.args.slice(0, 160) })),
        },
        "runner reaper killed orphaned processes (claude/transcript watchers with ppid 1, older than the floor)",
      );
    } catch (e) {
      logger.warn({ detail: (e as Error).message, victims: victims.length }, "runner reaper failed to kill (will retry next sweep)");
      return null;
    }
  }
  lastStats = {
    at: Date.now(),
    processes: procs.length,
    reaped: victims.length,
    reapedTotal: (lastStats?.reapedTotal ?? 0) + victims.length,
  };
  return lastStats;
}

/**
 * Starts the periodic reaper and returns the function that stops it. One tick never overlaps the
 * next; the timer is unref'd so it never keeps the process alive. An immediate first sweep runs so
 * the stats exist (and a backlog left by a crash is collected) without waiting ten minutes.
 * Called from the server's entry point — never from buildServer (tests must not inherit it).
 */
export function startRunnerReaper(intervalMs: number = REAPER_INTERVAL_MS): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await reapRunnerProcesses();
    } catch (e) {
      logger.warn({ detail: (e as Error).message }, "runner reaper tick failed (continuing)");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
