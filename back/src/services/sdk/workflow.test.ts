import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const runScript = vi.fn(async () => ({ stdout: "[]", stderr: "" }));

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn() }) };
  });
  return await import("./workflow.js");
}

/** One probe payload, as the runner prints it. */
const probe = (runs: unknown): string => `${JSON.stringify(runs)}\n`;

const AGENT = (over: Record<string, unknown> = {}) => ({
  id: "a1", status: "running", label: "Trabalhe em /work/x. Leia o diário e diga o que falta", ...over,
});

beforeEach(() => {
  runScript.mockReset();
  runScript.mockResolvedValue({ stdout: "[]", stderr: "" });
});
afterEach(() => { vi.useRealTimers(); });

describe("parseWorkflowProbe", () => {
  it("reads the runs, the agents and their results", async () => {
    const { parseWorkflowProbe } = await load();
    const runs = parseWorkflowProbe(probe([
      { runId: "wf_abc", name: "review-changes", at: 1700, agents: [
        AGENT({ id: "a1", status: "done", result: "achei 3 bugs" }),
        AGENT({ id: "a2" }),
      ] },
    ]));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "wf_abc", name: "review-changes", at: 1700, finished: false });
    expect(runs[0]!.agents).toEqual([
      { id: "a1", label: "Leia o diário e diga o que falta", status: "done", result: "achei 3 bugs" },
      { id: "a2", label: "Leia o diário e diga o que falta", status: "running" },
    ]);
  });

  it("a broken, empty or hostile payload draws nothing — it never throws", async () => {
    const { parseWorkflowProbe } = await load();
    expect(parseWorkflowProbe("")).toEqual([]);
    expect(parseWorkflowProbe("docker: no such container")).toEqual([]);
    expect(parseWorkflowProbe('{"runId":"wf_a"}')).toEqual([]); // an object, not the array
    expect(parseWorkflowProbe(probe([{ name: "no id" }, null, 7]))).toEqual([]);
    // A line of noise BEFORE the json (a warning from docker) does not lose the payload.
    expect(parseWorkflowProbe(`WARNING: something\n${probe([{ runId: "wf_a", agents: [] }])}`)).toHaveLength(1);
  });

  it("an agent with no result is never shown as having answered", async () => {
    const { parseWorkflowProbe } = await load();
    const [run] = parseWorkflowProbe(probe([{ runId: "wf_a", agents: [AGENT({ status: "running", result: "lixo" })] }]));
    expect(run!.agents[0]).toEqual({ id: "a1", label: "Leia o diário e diga o que falta", status: "running" });
  });
});

describe("trimAgentLabel", () => {
  it("drops the working-directory preamble every workflow subagent carries", async () => {
    const { trimAgentLabel } = await load();
    expect(trimAgentLabel("Trabalhe em /work/a/b. Leia COMPLETO o build da ISO")).toBe("Leia COMPLETO o build da ISO");
    expect(trimAgentLabel("Work in /srv/x: review the diff")).toBe("review the diff");
    expect(trimAgentLabel("  linha   com   espaços  ")).toBe("linha com espaços");
  });

  it("keeps the original when the preamble IS the whole label, and caps the length", async () => {
    const { trimAgentLabel } = await load();
    expect(trimAgentLabel("Trabalhe em /work/a/b")).toBe("Trabalhe em /work/a/b");
    expect(trimAgentLabel("")).toBe("");
    const long = trimAgentLabel(`x${"y".repeat(400)}`);
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("runSettled / runChanged", () => {
  it("settled is counted on the WHOLE journal, not on the list the screen draws", async () => {
    const { runSettled } = await load();
    const run = (total: number, done: number) => ({ runId: "r", name: "", at: 0, finished: false, total, done, agents: [] }) as never;
    expect(runSettled(run(0, 0))).toBe(false);
    expect(runSettled(run(2, 1))).toBe(false);
    expect(runSettled(run(2, 2))).toBe(true);
    // A fleet bigger than the drawn list: the counts still decide, so it is not called finished
    // while the agents past the cap are still working.
    expect(runSettled(run(260, 200))).toBe(false);
  });

  it("only a real change redraws the panel", async () => {
    const { runChanged } = await load();
    const base = { runId: "wf_a", name: "n", at: 10, finished: false, total: 1, done: 0, agents: [{ id: "a1", label: "l", status: "running" as const }] };
    expect(runChanged(undefined, base)).toBe(true);
    expect(runChanged(base, { ...base })).toBe(false);
    expect(runChanged(base, { ...base, at: 11 })).toBe(true);
    expect(runChanged(base, { ...base, finished: true })).toBe(true);
    expect(runChanged(base, { ...base, total: 2, agents: [...base.agents, { id: "a2", label: "", status: "running" }] })).toBe(true);
    expect(runChanged(base, { ...base, done: 1, agents: [{ id: "a1", label: "l", status: "done" }] })).toBe(true);
    // The counts alone are enough: agent 201 answering moves nothing in the drawn list.
    expect(runChanged(base, { ...base, done: 1 })).toBe(true);
  });
});

describe("buildWorkflowProbeScript", () => {
  it("passes the directories as ARGUMENTS, never interpolated into the script body", async () => {
    const { buildWorkflowProbeScript } = await load();
    const script = buildWorkflowProbeScript("runner", "/root/.claude/p/s/subagents/workflows", "/root/.claude/p/s/workflows/scripts");
    expect(script).toContain("docker exec 'runner' node -e ");
    expect(script).toContain("'/root/.claude/p/s/subagents/workflows'");
    expect(script).toContain("'/root/.claude/p/s/workflows/scripts'");
    expect(script).toContain("process.argv[1]");
    expect(script.endsWith("|| true")).toBe(true); // no session, no workflows: not an error
  });

  it("a hostile directory cannot break out of the quoting", async () => {
    const { buildWorkflowProbeScript } = await load();
    const { shQuote } = await import("../../runtime/host.js");
    const hostile = "/tmp/x'; rm -rf /; echo '";
    const script = buildWorkflowProbeScript("runner", hostile, "/tmp/s");
    // The whole hostile path travels as ONE quoted argument: every quote in it is escaped, so the
    // `'; rm -rf /` never closes the shell's quoting — it reaches node as part of the path string.
    expect(script).toContain(shQuote(hostile));
    expect(script).not.toContain(hostile); // never raw — only in its escaped form
  });
});

describe("watchCardWorkflows — a sondagem e suas travas", () => {
  const dirs = () => ({ runs: "/runs", scripts: "/scripts" });

  it("probes, publishes the first snapshot and then only what changed", async () => {
    vi.useFakeTimers();
    const wf = await load();
    const published: Array<{ runId: string; finished: boolean }> = [];
    runScript.mockResolvedValue({ stdout: probe([{ runId: "wf_a", agents: [AGENT()] }]), stderr: "" });
    wf.watchCardWorkflows("c1", { label: "card", dirs, watchers: () => 1, publish: (r) => published.push(r) });
    await vi.advanceTimersByTimeAsync(10);
    expect(published).toHaveLength(1);
    // Same snapshot twice: one frame, not two.
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS);
    expect(published).toHaveLength(1);
    // An agent answers: a new frame.
    runScript.mockResolvedValue({ stdout: probe([{ runId: "wf_a", at: 5, agents: [AGENT({ status: "done", result: "ok" })] }]), stderr: "" });
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS);
    expect(published).toHaveLength(2);
    wf.resetWorkflowWatchesForTesting();
  });

  it("with nobody watching the card, it does NOT touch the runner", async () => {
    vi.useFakeTimers();
    const wf = await load();
    wf.watchCardWorkflows("c2", { label: "card", dirs, watchers: () => 0, publish: () => {} });
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * 3);
    expect(runScript).not.toHaveBeenCalled();
    wf.resetWorkflowWatchesForTesting();
  });

  it("a second Workflow call does not open a second loop", async () => {
    vi.useFakeTimers();
    const wf = await load();
    runScript.mockResolvedValue({ stdout: probe([{ runId: "wf_a", agents: [AGENT()] }]), stderr: "" });
    wf.watchCardWorkflows("c3", { label: "card", dirs, watchers: () => 1, publish: () => {} });
    await vi.advanceTimersByTimeAsync(10);
    const afterFirst = runScript.mock.calls.length;
    wf.watchCardWorkflows("c3", { label: "card", dirs, watchers: () => 1, publish: () => {} });
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS);
    expect(runScript.mock.calls.length).toBe(afterFirst + 1); // one tick, not two loops
    wf.resetWorkflowWatchesForTesting();
  });

  it("a settled fleet that goes quiet is reported finished ONCE and the loop stops", async () => {
    vi.useFakeTimers();
    const wf = await load();
    const published: Array<{ finished: boolean }> = [];
    runScript.mockResolvedValue({ stdout: probe([{ runId: "wf_a", at: 1, agents: [AGENT({ status: "done", result: "ok" })] }]), stderr: "" });
    wf.watchCardWorkflows("c4", { label: "card", dirs, watchers: () => 1, publish: (r) => published.push(r) });
    await vi.advanceTimersByTimeAsync(10);
    expect(published.at(-1)!.finished).toBe(false); // settled, but the journal only just went quiet
    await vi.advanceTimersByTimeAsync(wf.WATCH_QUIET_MS + wf.WATCH_INTERVAL_MS);
    expect(published.at(-1)!.finished).toBe(true);
    const calls = runScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * 5);
    expect(runScript.mock.calls.length).toBe(calls); // stopped: no more probing
    // …and the last frame survives the stop, for a tab that opens right after.
    expect(wf.lastWorkflowRuns("c4")[0]?.finished).toBe(true);
    wf.resetWorkflowWatchesForTesting();
  });

  it("a fleet still working is NEVER called finished, however long it stays quiet", async () => {
    vi.useFakeTimers();
    const wf = await load();
    const published: Array<{ finished: boolean }> = [];
    runScript.mockResolvedValue({ stdout: probe([{ runId: "wf_a", at: 1, agents: [AGENT({ id: "a1", status: "done" }), AGENT({ id: "a2" })] }]), stderr: "" });
    wf.watchCardWorkflows("c5", { label: "card", dirs, watchers: () => 1, publish: (r) => published.push(r) });
    await vi.advanceTimersByTimeAsync(wf.WATCH_QUIET_MS * 2);
    expect(published.every((p) => !p.finished)).toBe(true);
    wf.resetWorkflowWatchesForTesting();
  });

  it("a runner that keeps failing is given up on, not hammered", async () => {
    vi.useFakeTimers();
    const wf = await load();
    runScript.mockRejectedValue(new Error("runner down"));
    wf.watchCardWorkflows("c6", { label: "card", dirs, watchers: () => 1, publish: () => {} });
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * (wf.WATCH_MAX_FAILURES + 4));
    expect(runScript.mock.calls.length).toBeLessThanOrEqual(wf.WATCH_MAX_FAILURES);
    wf.resetWorkflowWatchesForTesting();
  });

  it("stops at the ceiling even if the journal never settles", async () => {
    vi.useFakeTimers();
    const wf = await load();
    // The clock is injected so the ceiling can be reached in two ticks instead of nine hundred.
    let clock = 1_000;
    let moving = 0;
    runScript.mockImplementation(async () => ({ stdout: probe([{ runId: "wf_a", at: (moving += 1), agents: [AGENT()] }]), stderr: "" }));
    wf.watchCardWorkflows("c7", { label: "card", dirs, watchers: () => 1, publish: () => {}, now: () => clock });
    await vi.advanceTimersByTimeAsync(10);
    expect(runScript.mock.calls.length).toBe(1);
    clock += wf.WATCH_MAX_MS + 1;
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS);
    const calls = runScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * 3);
    expect(runScript.mock.calls.length).toBe(calls); // the loop is gone, not merely idle
    wf.resetWorkflowWatchesForTesting();
  });

  it("forgetting a card drops both its loop and its last frame", async () => {
    vi.useFakeTimers();
    const wf = await load();
    runScript.mockResolvedValue({ stdout: probe([{ runId: "wf_a", agents: [AGENT()] }]), stderr: "" });
    wf.watchCardWorkflows("c8", { label: "card", dirs, watchers: () => 1, publish: () => {} });
    await vi.advanceTimersByTimeAsync(10);
    expect(wf.lastWorkflowRuns("c8")).toHaveLength(1);
    wf.forgetCardWorkflows("c8");
    expect(wf.lastWorkflowRuns("c8")).toEqual([]);
    const calls = runScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * 3);
    expect(runScript.mock.calls.length).toBe(calls);
  });
  it("giving up SAYS so: the ceiling publishes a last frame marked finished", async () => {
    // Sem isto, desistir deixava o painel — e toda aba que reconectasse depois — girando para
    // sempre numa frota que ninguém mais acompanha.
    vi.useFakeTimers();
    const wf = await load();
    const published: Array<{ finished: boolean }> = [];
    let clock = 1_000;
    let moving = 0;
    runScript.mockImplementation(async () => ({ stdout: probe([{ runId: "wf_a", at: (moving += 1), agents: [AGENT()] }]), stderr: "" }));
    wf.watchCardWorkflows("c9", { label: "card", dirs, watchers: () => 1, publish: (r) => published.push(r), now: () => clock });
    await vi.advanceTimersByTimeAsync(10);
    expect(published.at(-1)!.finished).toBe(false);
    clock += wf.WATCH_MAX_MS + 1;
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS);
    expect(published.at(-1)!.finished).toBe(true);
    expect(wf.lastWorkflowRuns("c9")[0]?.finished).toBe(true);
    wf.resetWorkflowWatchesForTesting();
  });

  it("a runner that keeps failing also gets a last frame, not an eternal spinner", async () => {
    vi.useFakeTimers();
    const wf = await load();
    const published: Array<{ finished: boolean }> = [];
    runScript.mockResolvedValueOnce({ stdout: probe([{ runId: "wf_a", agents: [AGENT()] }]), stderr: "" });
    wf.watchCardWorkflows("c10", { label: "card", dirs, watchers: () => 1, publish: (r) => published.push(r) });
    await vi.advanceTimersByTimeAsync(10);
    runScript.mockRejectedValue(new Error("runner down"));
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * (wf.WATCH_MAX_FAILURES + 2));
    expect(published.at(-1)!.finished).toBe(true);
    wf.resetWorkflowWatchesForTesting();
  });

  it("um Workflow que nunca escreve diário não fica batendo no runner até o teto de uma hora", async () => {
    vi.useFakeTimers();
    const wf = await load();
    runScript.mockResolvedValue({ stdout: "[]", stderr: "" }); // script quebrado: nenhuma rodada
    wf.watchCardWorkflows("c11", { label: "card", dirs, watchers: () => 1, publish: () => {} });
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * (wf.WATCH_MAX_EMPTY + 5));
    expect(runScript.mock.calls.length).toBeLessThanOrEqual(wf.WATCH_MAX_EMPTY);
    wf.resetWorkflowWatchesForTesting();
  });

  it("duas rodadas ao mesmo tempo: as duas são publicadas, e o laço só morre com as duas prontas", async () => {
    vi.useFakeTimers();
    const wf = await load();
    const published: Array<{ runId: string; finished: boolean }> = [];
    const RUNNING = { runId: "wf_new", at: 2, agents: [AGENT({ id: "b1" })] };
    const SETTLED = { runId: "wf_old", at: 1, agents: [AGENT({ id: "a1", status: "done", result: "ok" })] };
    runScript.mockResolvedValue({ stdout: probe([RUNNING, SETTLED]), stderr: "" });
    wf.watchCardWorkflows("c12", { label: "card", dirs, watchers: () => 1, publish: (r) => published.push(r) });
    await vi.advanceTimersByTimeAsync(10);
    expect(published.map((p) => p.runId).sort()).toEqual(["wf_new", "wf_old"]);
    // A velha silencia e é dada por encerrada; a nova continua, e a sondagem com ela.
    await vi.advanceTimersByTimeAsync(wf.WATCH_QUIET_MS + wf.WATCH_INTERVAL_MS);
    expect(published.filter((p) => p.runId === "wf_old").at(-1)!.finished).toBe(true);
    expect(published.filter((p) => p.runId === "wf_new").at(-1)!.finished).toBe(false);
    const calls = runScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * 2);
    expect(runScript.mock.calls.length).toBeGreaterThan(calls); // ainda sondando pela nova
    wf.resetWorkflowWatchesForTesting();
  });

  it("uma sondagem lenta não é ultrapassada pela seguinte", async () => {
    vi.useFakeTimers();
    const wf = await load();
    let release: (() => void) | null = null;
    runScript.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ stdout: probe([{ runId: "wf_a", agents: [AGENT()] }]), stderr: "" });
      }),
    );
    wf.watchCardWorkflows("c13", { label: "card", dirs, watchers: () => 1, publish: () => {} });
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS * 3);
    expect(runScript.mock.calls.length).toBe(1); // três tiques, UMA sondagem em voo
    release?.();
    wf.resetWorkflowWatchesForTesting();
  });
});
