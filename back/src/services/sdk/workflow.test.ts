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
    const base = { runId: "wf_a", name: "n", phases: [], at: 10, finished: false, total: 1, done: 0, agents: [{ id: "a1", label: "l", phase: "", status: "running" as const, toolCount: 0 }] };
    expect(runChanged(undefined, base)).toBe(true);
    expect(runChanged(base, { ...base })).toBe(false);
    expect(runChanged(base, { ...base, at: 11 })).toBe(true);
    expect(runChanged(base, { ...base, finished: true })).toBe(true);
    expect(runChanged(base, { ...base, total: 2, agents: [...base.agents, { id: "a2", label: "", phase: "", status: "running", toolCount: 0 }] })).toBe(true);
    expect(runChanged(base, { ...base, done: 1, agents: [{ id: "a1", label: "l", phase: "", status: "done", toolCount: 0 }] })).toBe(true);
    // The counts alone are enough: agent 201 answering moves nothing in the drawn list.
    expect(runChanged(base, { ...base, done: 1 })).toBe(true);
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

  it("o concluído já visto vai como conhecido no tique seguinte — e o quadro publicado segue inteiro", async () => {
    vi.useFakeTimers();
    const wf = await load();
    const published: Array<{ agents: Array<{ id: string; toolCount: number; result?: string }> }> = [];
    const done = AGENT({ id: "a1f", status: "done", result: "ok", toolCount: 7, startedAt: 1_000, lastAt: 9_000, endedAt: 9_000 });
    runScript.mockResolvedValue({ stdout: probe([{ runId: "wf_a", total: 2, done: 1, at: 1, agents: [done, AGENT({ id: "a2f" })] }]), stderr: "" });
    wf.watchCardWorkflows("c1", { label: "card", dirs, watchers: () => 1, publish: (r) => published.push(r) });
    await vi.advanceTimersByTimeAsync(10);
    expect(String((runScript.mock.calls[0] as unknown as string[])[0])).toContain("'/runs' '/scripts' ''");

    runScript.mockResolvedValue({
      stdout: probe([{ runId: "wf_a", total: 2, done: 1, at: 2, agents: [{ id: "a1f", status: "done", settled: true }, AGENT({ id: "a2f", toolCount: 1 })] }]),
      stderr: "",
    });
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS);
    expect(String((runScript.mock.calls[1] as unknown as string[])[0])).toContain("'/runs' '/scripts' 'wf_a/a1f'");
    expect(published).toHaveLength(2);
    expect(published[1]!.agents.find((a) => a.id === "a1f")).toMatchObject({ toolCount: 7, result: "ok" });
    wf.resetWorkflowWatchesForTesting();
  });

  it("só as rodadas que a sonda ainda lê (as RUNS_PROBED mais recentes) mandam seus concluídos", async () => {
    vi.useFakeTimers();
    const wf = await load();
    const run = (runId: string, at: number) => ({ runId, total: 1, done: 1, at, agents: [AGENT({ id: "a1f", status: "done", result: "ok" })] });
    runScript.mockResolvedValue({ stdout: probe([run("wf_old", 1), run("wf_mid", 2), run("wf_new", 3)]), stderr: "" });
    wf.watchCardWorkflows("c1", { label: "card", dirs, watchers: () => 1, publish: () => undefined });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(wf.WATCH_INTERVAL_MS);
    const script = String((runScript.mock.calls[1] as unknown as string[])[0]);
    expect(script).toContain("wf_new/a1f");
    expect(script).toContain("wf_mid/a1f");
    expect(script).not.toContain("wf_old/a1f");
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

describe("runChanged — atividade, fase e ferramentas também redesenham", () => {
  it("muda com activity/phase/toolCount; o mesmo conteúdo em outro objeto não", async () => {
    const { runChanged } = await load();
    const agent = { id: "a1", label: "l", phase: "P", status: "running" as const, toolCount: 1, activity: { kind: "tool" as const, tool: "Bash", target: "x" } };
    const base = { runId: "wf_a", name: "n", phases: ["P"], at: 10, finished: false, total: 1, done: 0, agents: [agent] };
    expect(runChanged(base, { ...base, agents: [{ ...agent, activity: { kind: "tool", tool: "Bash", target: "x" } }] })).toBe(false);
    expect(runChanged(base, { ...base, agents: [{ ...agent, activity: { kind: "tool", tool: "Bash", target: "y" } }] })).toBe(true);
    expect(runChanged(base, { ...base, agents: [{ ...agent, activity: { kind: "thinking", since: 5 } }] })).toBe(true);
    expect(runChanged(base, { ...base, agents: [{ ...agent, phase: "Q" }] })).toBe(true);
    expect(runChanged(base, { ...base, agents: [{ ...agent, toolCount: 2 }] })).toBe(true);
    expect(runChanged(base, { ...base, phases: ["P", "Q"] })).toBe(true);
  });
});
