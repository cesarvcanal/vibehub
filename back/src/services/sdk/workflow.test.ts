import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      { id: "a1", label: "Leia o diário e diga o que falta", phase: "", status: "done", result: "achei 3 bugs", toolCount: 0 },
      { id: "a2", label: "Leia o diário e diga o que falta", phase: "", status: "running", toolCount: 0 },
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
    expect(run!.agents[0]).toEqual({ id: "a1", label: "Leia o diário e diga o que falta", phase: "", status: "running", toolCount: 0 });
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

/* ------------------------------------------------------------------ a sondagem DE VERDADE */

// O JS da sondagem roda aqui como roda no runner (`node -e <js> <args…>`), contra um diretório com
// o formato que o harness do Claude Code 2.1.x escreve de fato: diário com label/phase, meta.json
// ao lado, e agent-<id>.jsonl cujo PRIMEIRO registro é o cabeçalho com o pedido do usuário.

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const HEADER = (ts: number) => ({
  type: "user", timestamp: iso(ts),
  message: { role: "user", content: [{ type: "text", text: "[Workflow harness — user request]\nFaça um review completo da lentidão da IA" }] },
});
const TASK = (ts: number, task: string) => ({
  type: "user", timestamp: iso(ts),
  message: { role: "user", content: `Você é um subagente do workflow. The computed task text follows:\n${task}` },
});
const ASSISTANT = (ts: number, blocks: unknown[]) => ({ type: "assistant", timestamp: iso(ts), message: { role: "assistant", content: blocks } });
const THINKING = { type: "thinking", thinking: "", signature: "sig" };
const TOOL = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const TOOL_RESULT = (ts: number, id: string, text: string) => ({
  type: "user", timestamp: iso(ts), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
});

interface Fixture { root: string; runs: string; scripts: string; run: string }

function fleetFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vibehub-wf-"));
  const runs = join(root, "subagents", "workflows");
  const scripts = join(root, "workflows", "scripts");
  const run = join(runs, "wf_abc12");
  mkdirSync(run, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(run, "journal.jsonl"), jsonl([
    { type: "launched" },
    { type: "started", key: "v2:1", agentId: "a01f", label: "varre:front-render", phase: "Varredura" },
    { type: "started", key: "v2:2", agentId: "a02f" },
    { type: "started", key: "v2:3", agentId: "a03f" },
    { type: "result", key: "v2:1", agentId: "a01f", result: { ok: true } },
  ]));
  // a01: label no diário; terminou com um texto.
  writeFileSync(join(run, "agent-a01f.jsonl"), jsonl([
    HEADER(T0), TASK(T0 + 1_000, "Varra o front procurando render caro"),
    ASSISTANT(T0 + 2_000, [THINKING]),
    ASSISTANT(T0 + 3_000, [TOOL("t1", "Bash", { command: "npx vitest run --reporter=verbose src", description: "Roda a suíte do front" })]),
    TOOL_RESULT(T0 + 5_000, "t1", "22 passed"),
    ASSISTANT(T0 + 10_000, [{ type: "text", text: "Achei   2 problemas\nno render" }]),
  ]));
  // a02: sem label no diário — o meta.json ao lado sabe; última coisa: um Bash em andamento.
  writeFileSync(join(run, "agent-a02f.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "varre:back-api", workflowPhase: "Varredura" }));
  writeFileSync(join(run, "agent-a02f.jsonl"), jsonl([
    HEADER(T0 + 500), TASK(T0 + 600, "Varra o back"),
    ASSISTANT(T0 + 2_000, [TOOL("t2", "Read", { file_path: "/work/back/src/app.ts" })]),
    TOOL_RESULT(T0 + 2_500, "t2", "conteúdo"),
    ASSISTANT(T0 + 4_000, [TOOL("t3", "Bash", { command: "grep -rn foo src", description: "Procura foo no back" })]),
  ]));
  // a03: nem diário nem meta — só a linha da tarefa calculada; está pensando agora.
  writeFileSync(join(run, "agent-a03f.jsonl"), jsonl([
    HEADER(T0 + 700), TASK(T0 + 800, "Confere os testes de integração"),
    ASSISTANT(T0 + 9_000, [THINKING]),
  ]));
  writeFileSync(join(scripts, "review-wf_abc12.js"), [
    "export const meta = {",
    "  name: 'review',",
    "  phases: [{ title: 'Varredura', detail: 'lê [tudo]' }, { title: \"Síntese\" }, { title: `Relatório` }],",
    "};",
    "export default async function run() { const phases = [{ title: 'NÃO É FASE' }]; }",
  ].join("\n"));
  return { root, runs, scripts, run };
}

function runProbe(js: string, args: string[]): string {
  return execFileSync(process.execPath, ["-e", js, ...args], { encoding: "utf8" });
}

describe("WORKFLOW_PROBE_JS — a sondagem lendo um diário real", () => {
  let fx: Fixture;
  beforeEach(() => { fx = fleetFixture(); });
  afterEach(() => { rmSync(fx.root, { recursive: true, force: true }); });

  async function snapshot() {
    const wf = await load();
    const runs = wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [fx.runs, fx.scripts]));
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    const agent = (id: string) => run.agents.find((a) => a.id === id)!;
    return { run, agent };
  }

  it("o rótulo e a fase vêm do diário, não do cabeçalho com o pedido do usuário", async () => {
    const { run, agent } = await snapshot();
    expect(agent("a01f")).toMatchObject({ label: "varre:front-render", phase: "Varredura" });
    for (const a of run.agents) expect(a.label).not.toContain("Workflow harness");
  });

  it("sem rótulo no diário, cai no agent-<id>.meta.json (description / workflowPhase)", async () => {
    const { agent } = await snapshot();
    expect(agent("a02f")).toMatchObject({ label: "varre:back-api", phase: "Varredura" });
  });

  it("sem diário nem meta, usa a linha 'computed task text follows:' — pulando o cabeçalho", async () => {
    const { agent } = await snapshot();
    expect(agent("a03f")).toMatchObject({ label: "Confere os testes de integração", phase: "" });
  });

  it("tempos: startedAt/lastAt do primeiro e do último timestamp; endedAt só em quem terminou", async () => {
    const { run, agent } = await snapshot();
    expect(agent("a01f")).toMatchObject({ status: "done", startedAt: T0, lastAt: T0 + 10_000, endedAt: T0 + 10_000 });
    expect(agent("a02f")).toMatchObject({ status: "running", startedAt: T0 + 500, lastAt: T0 + 4_000 });
    expect(agent("a02f").endedAt).toBeUndefined();
    expect(run.startedAt).toBe(T0);
  });

  it("atividade: ferramenta + alvo, texto curto, ou o marcador de thinking SEM texto", async () => {
    const { agent } = await snapshot();
    expect(agent("a01f").activity).toEqual({ kind: "text", text: "Achei 2 problemas no render" });
    expect(agent("a02f").activity).toEqual({ kind: "tool", tool: "Bash", target: "Procura foo no back" });
    expect(agent("a03f").activity).toEqual({ kind: "thinking", since: T0 + 9_000 });
  });

  it("conta as ferramentas que o subagente chamou", async () => {
    const { agent } = await snapshot();
    expect(agent("a01f").toolCount).toBe(1);
    expect(agent("a02f").toolCount).toBe(2);
    expect(agent("a03f").toolCount).toBe(0);
    expect(agent("a02f").toolCountPartial).toBeUndefined(); // arquivo pequeno: a contagem é exata
  });

  it("as fases vêm do meta.phases do script, na ordem — e só do meta", async () => {
    const { run } = await snapshot();
    expect(run.phases).toEqual(["Varredura", "Síntese", "Relatório"]);
  });

  it("sem o script, phases é [] (não quebra a rodada)", async () => {
    rmSync(join(fx.scripts, "review-wf_abc12.js"));
    const { run } = await snapshot();
    expect(run.phases).toEqual([]);
    expect(run.agents).toHaveLength(3);
  });

  it("um transcript grande (>600KB) é lido só na cabeça e na cauda — e ainda dá início e última atividade", async () => {
    const filler: unknown[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      filler.push(ASSISTANT(T0 + 20_000 + i, [TOOL(`f${i}`, "Bash", { command: "x".repeat(300), description: `passo ${i}` })]));
    }
    const rows = [HEADER(T0), TASK(T0 + 1, "Tarefa longa"), ...filler, ASSISTANT(T0 + 99_000, [{ type: "text", text: "fim" }])];
    writeFileSync(join(fx.run, "agent-a03f.jsonl"), jsonl(rows));
    const { agent } = await snapshot();
    expect(agent("a03f")).toMatchObject({ startedAt: T0, lastAt: T0 + 99_000, activity: { kind: "text", text: "fim" } });
    // Não leu o arquivo inteiro: a contagem é parcial — e diz que é.
    expect(agent("a03f").toolCountPartial).toBe(true);
    expect(agent("a03f").toolCount).toBeGreaterThan(0);
    expect(agent("a03f").toolCount).toBeLessThan(2_000);
  });
});

describe("parseWorkflowProbe — campos novos com lixo viram default", () => {
  it("valida tipo a tipo; nunca expõe texto de thinking", async () => {
    const { parseWorkflowProbe } = await load();
    const [run] = parseWorkflowProbe(probe([{
      runId: "wf_a", phases: ["A", 3, null, "B"], startedAt: "ontem",
      agents: [
        { id: "a1", status: "running", label: "x", phase: 42, toolCount: "muitos", startedAt: Number.NaN, lastAt: -5, endedAt: 9, activity: { kind: "thinking", since: 7, text: "segredo" } },
        { id: "a2", status: "done", label: "y", phase: "P", toolCount: 3.7, startedAt: 1, lastAt: 2, endedAt: 2, toolCountPartial: true, activity: { kind: "tool", tool: "Read", target: 5 } },
        { id: "a3", status: "running", label: "z", activity: { kind: "hack", tool: "x" } },
      ],
    }]));
    expect(run!.phases).toEqual(["A", "B"]);
    expect(run!.startedAt).toBeUndefined();
    const [a1, a2, a3] = run!.agents;
    expect(a1).toEqual({ id: "a1", label: "x", phase: "", status: "running", toolCount: 0, activity: { kind: "thinking", since: 7 } });
    expect(a2).toEqual({ id: "a2", label: "y", phase: "P", status: "done", toolCount: 3, toolCountPartial: true, startedAt: 1, lastAt: 2, endedAt: 2, activity: { kind: "tool", tool: "Read", target: "" } });
    expect(a3).toEqual({ id: "a3", label: "z", phase: "", status: "running", toolCount: 0 });
  });
});

describe("estimateRemainingMs", () => {
  type Agent = import("./workflow.js").WorkflowAgent;
  const A = (id: string, over: Partial<Agent>): Agent => ({ id, label: "", phase: "", status: "running", toolCount: 0, ...over });
  const RUN = (agents: Agent[], total = agents.length) => ({
    runId: "wf_a", name: "", phases: [], total, done: agents.filter((a) => a.status === "done").length, agents, at: 0, finished: false,
  });

  it("sem nenhum concluído não há base: null", async () => {
    const { estimateRemainingMs } = await load();
    expect(estimateRemainingMs(RUN([A("a1", { startedAt: 1 })]), 5_000)).toBeNull();
    expect(estimateRemainingMs(RUN([]), 5_000)).toBeNull();
  });

  it("em série: média dos concluídos menos o que o em voo já correu", async () => {
    const { estimateRemainingMs } = await load();
    const run = RUN([
      A("a1", { status: "done", startedAt: 1, endedAt: 10_001 }),
      A("a2", { status: "done", startedAt: 10_001, endedAt: 30_001 }),
      A("a3", { startedAt: 30_001 }),
    ]);
    // média 15s; a3 correu 4s ⇒ faltam 11s; concorrência observada 1.
    expect(estimateRemainingMs(run, 34_001)).toBe(11_000);
  });

  it("em paralelo: soma em voo + fila e divide pela concorrência observada", async () => {
    const { estimateRemainingMs } = await load();
    const run = RUN([
      A("a1", { status: "done", startedAt: 1, endedAt: 10_001 }),
      A("a2", { status: "done", startedAt: 1, endedAt: 10_001 }),
      A("a3", { startedAt: 10_001 }),
      A("a4", { startedAt: 10_001 }),
    ], 6); // 2 no diário além da lista desenhada, ainda sem resposta = fila
    // em voo: 2 × (10 - 4) = 12s; fila: 2 × 10 = 20s; concorrência 2 ⇒ 16s.
    expect(estimateRemainingMs(run, 14_001)).toBe(16_000);
    // concorrência informada vence a observada.
    expect(estimateRemainingMs(run, 14_001, 4)).toBe(8_000);
  });

  it("quem já passou da média não conta negativo; concluído sem tempo não entra na média", async () => {
    const { estimateRemainingMs } = await load();
    const run = RUN([
      A("a1", { status: "done", startedAt: 1, endedAt: 10_001 }),
      A("a2", { status: "done" }),
      A("a3", { startedAt: 10_001 }),
    ]);
    expect(estimateRemainingMs(run, 60_001)).toBe(0);
    expect(estimateRemainingMs(run, 60_001, 0)).toBe(0); // concorrência mínima 1, nunca divide por 0
    // a2 sem tempo não puxa a média para 5s: o em voo que correu 4s ainda tem 6s pela frente.
    expect(estimateRemainingMs(run, 14_001)).toBe(6_000);
  });
});

describe("feed de UM agente — sob demanda", () => {
  it("valida runId e agentId com regex estrita ANTES de montar o comando", async () => {
    const { buildAgentFeedProbeScript } = await load();
    const bad: Array<[string, string]> = [["wf_../x", "a01"], ["wf_a", "a01;rm -rf /"], ["../wf_a", "a01"], ["wf_a", "../a01"], ["wf_A", "a01"], ["wf_a", "aXY"]];
    for (const [runId, agentId] of bad) {
      expect(() => buildAgentFeedProbeScript("runner", "/runs", runId, agentId, 20)).toThrow(/invalid/i);
    }
    const script = buildAgentFeedProbeScript("runner", "/root/x/workflows", "wf_abc-12", "a01f", 20);
    expect(script).toContain("docker exec 'runner' node -e ");
    expect(script).toContain("'/root/x/workflows' 'wf_abc-12' 'a01f' '20'");
    expect(script.endsWith("|| true")).toBe(true);
    // maxItems vira um inteiro dentro do teto.
    expect(buildAgentFeedProbeScript("runner", "/r", "wf_a", "a1", 9_999)).toContain("'wf_a' 'a1' '200'");
    expect(buildAgentFeedProbeScript("runner", "/r", "wf_a", "a1", -3)).toContain("'wf_a' 'a1' '1'");
  });

  it("devolve os últimos N itens da cauda: ferramenta + alvo, texto, thinking sem texto, resultado", async () => {
    const fx = fleetFixture();
    try {
      writeFileSync(join(fx.run, "agent-a03f.jsonl"), jsonl([
        HEADER(T0), TASK(T0 + 1, "Confere"),
        ASSISTANT(T0 + 1_000, [THINKING]),
        ASSISTANT(T0 + 2_000, [TOOL("r", "Read", { file_path: "/w/a.ts" })]),
        TOOL_RESULT(T0 + 2_100, "r", "linha 1\nlinha 2"),
        ASSISTANT(T0 + 3_000, [TOOL("e", "Edit", { file_path: "/w/b.ts", old_string: "a", new_string: "b" })]),
        ASSISTANT(T0 + 4_000, [TOOL("g", "Grep", { pattern: "useEffect", path: "/w" })]),
        ASSISTANT(T0 + 5_000, [TOOL("gl", "Glob", { pattern: "**/*.tsx" })]),
        ASSISTANT(T0 + 6_000, [TOOL("ag", "Agent", { description: "revisa o diff", prompt: "longo" })]),
        ASSISTANT(T0 + 7_000, [TOOL("b", "Bash", { command: `echo ${"z".repeat(400)}` })]),
        ASSISTANT(T0 + 8_000, [{ type: "text", text: "pronto" }]),
      ]));
      const wf = await load();
      const all = wf.parseAgentFeed(runProbe(wf.AGENT_FEED_PROBE_JS, [fx.runs, "wf_abc12", "a03f", "50"]));
      expect(all.map((i) => i.kind)).toEqual(["thinking", "tool", "result", "tool", "tool", "tool", "tool", "tool", "text"]);
      expect(all[0]).toEqual({ at: T0 + 1_000, kind: "thinking" });
      expect(all[1]).toEqual({ at: T0 + 2_000, kind: "tool", tool: "Read", target: "/w/a.ts" });
      expect(all[2]).toEqual({ at: T0 + 2_100, kind: "result", text: "linha 1 linha 2" });
      expect(all.slice(3, 7).map((i) => i.target)).toEqual(["/w/b.ts", "useEffect", "**/*.tsx", "revisa o diff"]);
      expect(all[7]!.target!.startsWith("echo zzz")).toBe(true);
      expect(all[7]!.target!.length).toBeLessThanOrEqual(120);
      expect(all[8]).toEqual({ at: T0 + 8_000, kind: "text", text: "pronto" });
      // Nenhum item vem do cabeçalho do pedido do usuário.
      expect(JSON.stringify(all)).not.toContain("Workflow harness");
      const last2 = wf.parseAgentFeed(runProbe(wf.AGENT_FEED_PROBE_JS, [fx.runs, "wf_abc12", "a03f", "2"]));
      expect(last2.map((i) => i.kind)).toEqual(["tool", "text"]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("lê só a cauda de um transcript enorme, e um agente inexistente devolve []", async () => {
    const fx = fleetFixture();
    try {
      const filler: unknown[] = [];
      for (let i = 0; i < 2_000; i += 1) filler.push(ASSISTANT(T0 + 10 + i, [{ type: "text", text: `bloco ${i} ${"p".repeat(300)}` }]));
      writeFileSync(join(fx.run, "agent-a03f.jsonl"), jsonl([HEADER(T0), TASK(T0 + 1, "Grande"), ASSISTANT(T0 + 5, [TOOL("x", "Read", { file_path: "/primeiro.ts" })]), ...filler]));
      const wf = await load();
      const items = wf.parseAgentFeed(runProbe(wf.AGENT_FEED_PROBE_JS, [fx.runs, "wf_abc12", "a03f", "200"]));
      expect(items).toHaveLength(200);
      expect(items.at(-1)!.text!.startsWith("bloco 1999")).toBe(true);
      expect(JSON.stringify(items)).not.toContain("/primeiro.ts");
      expect(wf.parseAgentFeed(runProbe(wf.AGENT_FEED_PROBE_JS, [fx.runs, "wf_abc12", "a0ff", "20"]))).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("parseAgentFeed: lixo some, campos com tipo errado são descartados", async () => {
    const { parseAgentFeed } = await load();
    expect(parseAgentFeed("")).toEqual([]);
    expect(parseAgentFeed("docker: no such container")).toEqual([]);
    expect(parseAgentFeed('{"at":1}')).toEqual([]);
    expect(parseAgentFeed(JSON.stringify([
      null, 7, { kind: "tool" }, { at: 1, kind: "evil" },
      { at: 2, kind: "tool", tool: "Read", target: 9 },
      { at: 3, kind: "thinking", text: "segredo" },
      { at: 4, kind: "text", text: "oi", tool: "x" },
    ]))).toEqual([
      { at: 2, kind: "tool", tool: "Read", target: "" },
      { at: 3, kind: "thinking" },
      { at: 4, kind: "text", text: "oi" },
    ]);
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
