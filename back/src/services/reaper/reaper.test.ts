import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The runner reaper — the backstop against the process leak that took production down (~180
 * orphaned `claude` + hundreds of leaked transcript watchers → load 55 on 8 vCPUs). What matters:
 *  - only ORPHANS die (ppid 1): every legitimate claude hangs off a tmux pane, every legitimate
 *    watcher off a live docker exec — killing anything parented is a bug;
 *  - only OLD orphans die (the 1h floor): a process orphaned seconds ago gets time to exit;
 *  - only RECOGNISED processes die: claude by exact basename, watchers by marker/signature —
 *    a user command that merely mentions claude must never qualify;
 *  - a runner that is down is a warn log, never a throw.
 */

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));

let runScript: ReturnType<typeof vi.fn>;
let reaper: typeof import("./reaper.js");

const CONTAINER = "vibehub-runner";

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const env = await import("../../config/env.js");
  env.config.runner.container = CONTAINER;
  const host = await import("../../runtime/host.js");
  runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
  vi.mocked(host.hostExecutor).mockReturnValue({
    kind: "local", label: "this machine", runScript, ptyCommand: vi.fn(), writeFile: vi.fn(),
  } as unknown as import("../../runtime/host.js").HostExecutor);
  reaper = await import("./reaper.js");
  reaper.resetReaperForTesting();
});

describe("parseProcessList", () => {
  it("parses pid/ppid/etimes/args and skips malformed lines", () => {
    const out = reaper.parseProcessList(
      [
        "    1     0 862000 sleep infinity",
        "  345     1  90000 claude -c",
        "  400   345     10 tail -n 400 -F /root/.claude/projects/x/abc.jsonl",
        "garbage line",
        "",
      ].join("\n"),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ pid: 1, ppid: 0, etimes: 862000, args: "sleep infinity" });
    expect(out[1]).toEqual({ pid: 345, ppid: 1, etimes: 90000, args: "claude -c" });
  });
});

describe("process classification (pure)", () => {
  it("recognises claude by exact basename on the first two tokens only", () => {
    expect(reaper.isClaudeProcess("claude")).toBe(true);
    expect(reaper.isClaudeProcess("claude -c --model opus")).toBe(true);
    expect(reaper.isClaudeProcess("node /usr/local/bin/claude --resume abc")).toBe(true);
    // Not claude: similar names, or a command that merely mentions it later in argv.
    expect(reaper.isClaudeProcess("claude-monitor --watch")).toBe(false);
    expect(reaper.isClaudeProcess("bash -c 'echo claude'")).toBe(false);
    expect(reaper.isClaudeProcess("tail -f claude.log")).toBe(false);
  });

  it("recognises a transcript watcher by marker and by legacy signature", () => {
    // New loops carry the marker.
    expect(reaper.isTranscriptWatcher("bash -c : vibehub-transcript-follow; cur=...")).toBe(true);
    // The tail child, and pre-marker loops: tail -n <N> -F over a .jsonl.
    expect(reaper.isTranscriptWatcher("tail -n 400 -F /root/.claude/projects/-work-x/abc.jsonl")).toBe(true);
    expect(reaper.isTranscriptWatcher('sh -c cur=""; ... ls -1t "$1"/*.jsonl ... tail -n 400 -F "$f" & ...')).toBe(true);
    // A tail over anything else is somebody's tool, not ours.
    expect(reaper.isTranscriptWatcher("tail -n 400 -F /var/log/syslog")).toBe(false);
    expect(reaper.isTranscriptWatcher("sleep 2")).toBe(false);
  });
});

describe("reapCandidates", () => {
  const proc = (pid: number, ppid: number, etimes: number, args: string) => ({ pid, ppid, etimes, args });

  it("selects only recognised orphans past the age floor", () => {
    const procs = [
      proc(1, 0, 900000, "sleep infinity"), // PID 1 itself
      proc(100, 1, 90000, "claude -c"), // orphan claude, old — DIES
      proc(101, 1, 60, "claude"), // orphan claude, fresh — spared (age floor)
      proc(102, 50, 90000, "claude --model opus"), // parented (tmux pane) — spared
      proc(103, 1, 90000, "tail -n 400 -F /root/.claude/projects/x/s.jsonl"), // orphan watcher — DIES
      proc(104, 1, 90000, "bash -c : vibehub-transcript-follow; while ..."), // orphan marked loop — DIES
      proc(105, 1, 90000, "bash"), // orphan but unrecognised — spared
      proc(106, 1, 90000, "tail -n 100 -F /var/log/app.log"), // orphan tail, not ours — spared
    ];
    expect(reaper.reapCandidates(procs).map((p) => p.pid)).toEqual([100, 103, 104]);
  });

  it("the default floor is one hour", () => {
    const at = (s: number) => reaper.reapCandidates([proc(9, 1, s, "claude")]).length;
    expect(at(reaper.REAP_MIN_AGE_S - 1)).toBe(0);
    expect(at(reaper.REAP_MIN_AGE_S)).toBe(1);
  });
});

describe("script builders (pure)", () => {
  it("lists processes with pid/ppid/etimes/args and no header", () => {
    expect(reaper.buildProcessListScript(CONTAINER)).toBe(
      `docker exec '${CONTAINER}' ps -eo pid=,ppid=,etimes=,args=`,
    );
  });

  it("kills by explicit validated pids — never pid 1, never a non-integer", () => {
    const script = reaper.buildKillPidsScript(CONTAINER, [100, 103, 1, 0, 2.5]);
    expect(script).toContain("kill -KILL 100 103");
    expect(script).not.toMatch(/KILL[^']*\b1\b(?!\d)/); // pid 1 filtered out
    expect(script).not.toContain("2.5");
    expect(() => reaper.buildKillPidsScript(CONTAINER, [1])).toThrow(/no pids/);
  });
});

describe("reapRunnerProcesses", () => {
  it("kills the orphans it finds, logs them, and accumulates the stats", async () => {
    runScript.mockResolvedValueOnce({
      stdout: [
        "    1     0 900000 sleep infinity",
        "  100     1  90000 claude -c",
        "  200    50    100 claude", // live under tmux
        "  300     1  90000 tail -n 400 -F /root/.claude/projects/x/s.jsonl",
      ].join("\n"),
      stderr: "",
    });
    const stats = await reaper.reapRunnerProcesses();
    expect(stats).not.toBeNull();
    expect(stats!.processes).toBe(4);
    expect(stats!.reaped).toBe(2);
    expect(stats!.reapedTotal).toBe(2);
    // Second call: the LIST then the KILL.
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(String(runScript.mock.calls[1]![0])).toContain("kill -KILL 100 300");
    expect(reaper.runnerProcessStats()).toEqual(stats);
  });

  it("a clean runner kills nothing and still records the process count", async () => {
    runScript.mockResolvedValueOnce({ stdout: "    1     0 900 sleep infinity\n   50     1  10 tmux\n", stderr: "" });
    const stats = await reaper.reapRunnerProcesses();
    expect(stats!.reaped).toBe(0);
    expect(stats!.processes).toBe(2);
    expect(runScript).toHaveBeenCalledTimes(1); // no kill call
  });

  it("a runner that is down is a null, never a throw — and the stale stats survive", async () => {
    runScript.mockResolvedValueOnce({ stdout: "  100     1  90000 claude\n", stderr: "" });
    await reaper.reapRunnerProcesses();
    const before = reaper.runnerProcessStats();
    runScript.mockRejectedValueOnce(new Error("docker daemon unreachable"));
    await expect(reaper.reapRunnerProcesses()).resolves.toBeNull();
    expect(reaper.runnerProcessStats()).toEqual(before);
  });
});

describe("startRunnerReaper", () => {
  it("sweeps immediately, then on the interval, and stops when told to", async () => {
    vi.useFakeTimers();
    try {
      runScript.mockResolvedValue({ stdout: "", stderr: "" });
      const stop = reaper.startRunnerReaper(1000);
      await vi.advanceTimersByTimeAsync(0); // the immediate first sweep
      expect(runScript).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(runScript).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(runScript).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
