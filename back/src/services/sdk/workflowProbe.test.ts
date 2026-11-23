import { describe, it, expect, beforeEach, afterEach, onTestFinished } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The module is pure (nothing executes): imported as is, without an executor stand-in. */
const load = async () => await import("./workflowProbe.js");

/** One probe payload, as the runner prints it. */
const probe = (runs: unknown): string => `${JSON.stringify(runs)}\n`;

const AGENT = (over: Record<string, unknown> = {}) => ({
  id: "a1", status: "running", label: "Trabalhe em /work/x. Leia o diário e diga o que falta", ...over,
});

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

describe("buildWorkflowProbeScript", () => {
  it("passes the directories as ARGUMENTS, never interpolated into the script body", async () => {
    const { buildWorkflowProbeScript } = await load();
    const script = buildWorkflowProbeScript("runner", "/root/.claude/p/s/subagents/workflows", "/root/.claude/p/s/workflows/scripts");
    expect(script).toContain("docker exec 'runner' node -e ");
    expect(script).toContain("'/root/.claude/p/s/subagents/workflows'");
    expect(script).toContain("'/root/.claude/p/s/workflows/scripts'");
    expect(script).toContain("process.argv[1]");
    // A runner that cannot run the probe must reach the caller as an error, never as "no runs".
    expect(script).not.toMatch(/\|\|\s*true/);
    expect(script).not.toContain("2>/dev/null");
  });

  describe("run by a real shell, with a stand-in `docker`", () => {
    let bin = "";
    beforeEach(() => { bin = mkdtempSync(join(tmpdir(), "vibehub-probe-bin-")); });
    afterEach(() => { rmSync(bin, { recursive: true, force: true }); });

    /** `docker` on PATH: `exec` runs the rest locally (the probe's node), `fail` is a runner that is down. */
    function runShell(script: string, docker: "exec" | "fail") {
      const body = docker === "exec"
        ? `#!/bin/sh\nshift 2\nexec "$@"\n`
        : `#!/bin/sh\necho "Error response from daemon: container is restarting" >&2\nexit 1\n`;
      writeFileSync(join(bin, "docker"), body, { mode: 0o755 });
      // `node` resolves to the test's own binary, as it would to the runner's inside the container.
      writeFileSync(join(bin, "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
      return spawnSync("sh", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
    }

    it("no journal directory yet is a SUCCESS that prints `[]` — the legitimate empty", async () => {
      const wf = await load();
      const out = runShell(wf.buildWorkflowProbeScript("runner", join(bin, "missing"), join(bin, "scripts")), "exec");
      expect(out.status).toBe(0);
      expect(wf.parseWorkflowProbe(out.stdout)).toEqual([]);
      expect(out.stdout.trim()).toBe("[]");
    });

    it("a docker exec that fails exits non-zero, so the executor rejects instead of handing back ''", async () => {
      const wf = await load();
      const out = runShell(wf.buildWorkflowProbeScript("runner", "/runs", "/scripts"), "fail");
      expect(out.status).not.toBe(0);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("container is restarting"); // reaches the executor's error detail
    });
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

/* ------------------------------------------------------------------ the REAL probe */

// The probe's JS runs here as it runs in the runner (`node -e <js> <args…>`), against a directory with
// the format Claude Code 2.1.x's harness actually writes: a journal with label/phase, meta.json
// next to it, and agent-<id>.jsonl whose FIRST record is the header with the user's request.

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
  // a01: label in the journal; finished with a text.
  writeFileSync(join(run, "agent-a01f.jsonl"), jsonl([
    HEADER(T0), TASK(T0 + 1_000, "Varra o front procurando render caro"),
    ASSISTANT(T0 + 2_000, [THINKING]),
    ASSISTANT(T0 + 3_000, [TOOL("t1", "Bash", { command: "npx vitest run --reporter=verbose src", description: "Roda a suíte do front" })]),
    TOOL_RESULT(T0 + 5_000, "t1", "22 passed"),
    ASSISTANT(T0 + 10_000, [{ type: "text", text: "Achei   2 problemas\nno render" }]),
  ]));
  // a02: no label in the journal — the meta.json next to it knows; last thing: a Bash in progress.
  writeFileSync(join(run, "agent-a02f.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "varre:back-api", workflowPhase: "Varredura", model: "sonnet" }));
  writeFileSync(join(run, "agent-a02f.jsonl"), jsonl([
    HEADER(T0 + 500), TASK(T0 + 600, "Varra o back"),
    ASSISTANT(T0 + 2_000, [TOOL("t2", "Read", { file_path: "/work/back/src/app.ts" })]),
    TOOL_RESULT(T0 + 2_500, "t2", "conteúdo"),
    ASSISTANT(T0 + 4_000, [TOOL("t3", "Bash", { command: "grep -rn foo src", description: "Procura foo no back" })]),
  ]));
  // a03: neither journal nor meta — only the computed task line; it is thinking now.
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

  it("o modelo de cada agente vem do meta.json; sem meta, o agente sai sem modelo", async () => {
    const { agent } = await snapshot();
    expect(agent("a02f")).toMatchObject({ model: "sonnet" });
    expect(agent("a03f").model).toBeUndefined();
  });

  it("o modelo com versão que respondeu no transcript vale mais que o apelido do meta.json", async () => {
    writeFileSync(join(fx.run, "agent-a02f.jsonl"), jsonl([
      HEADER(T0 + 500), TASK(T0 + 600, "Varra o back"),
      { type: "assistant", timestamp: iso(T0 + 2_000), message: { role: "assistant", model: "claude-sonnet-5-5", content: [THINKING] } },
    ]));
    const { agent } = await snapshot();
    expect(agent("a02f")).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("o aviso <synthetic> do CLI (limite de sessão) no fim do transcript não toma o lugar do modelo que respondeu", async () => {
    writeFileSync(join(fx.run, "agent-a02f.jsonl"), jsonl([
      HEADER(T0 + 500), TASK(T0 + 600, "Varra o back"),
      { type: "assistant", timestamp: iso(T0 + 2_000), message: { role: "assistant", model: "claude-sonnet-5-5", content: [THINKING] } },
      { type: "assistant", timestamp: iso(T0 + 3_000), message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] } },
    ]));
    const { agent } = await snapshot();
    expect(agent("a02f")).toMatchObject({ model: "claude-sonnet-5-5" });
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
    expect(agent("a02f").toolCountPartial).toBeUndefined(); // small file: the count is exact
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
    // It did not read the whole file: the count is partial — and says so.
    expect(agent("a03f").toolCountPartial).toBe(true);
    expect(agent("a03f").toolCount).toBeGreaterThan(0);
    expect(agent("a03f").toolCount).toBeLessThan(2_000);
  });
});

describe("resultado do agente na sondagem — é a fala dele na conversa da frota", () => {
  it.each([
    ["texto com quebras de linha chega com as quebras", "Achei 2 problemas:\n- render caro\n- teste lento"],
    ["resumo do contexto de quase mil caracteres chega inteiro", { summary: `PR #337:\n${"(1) `pillPercent` mostra a sessão de 5h. ".repeat(22)}` }],
  ])("%s", async (_name, result) => {
    const fixture = fleetFixture();
    onTestFinished(() => rmSync(fixture.root, { recursive: true, force: true }));
    appendFileSync(join(fixture.run, "journal.jsonl"), jsonl([{ type: "result", key: "v2:2", agentId: "a02f", result }]));
    const wf = await load();
    const [run] = wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [fixture.runs, fixture.scripts]));
    expect(run!.agents.find((agent) => agent.id === "a02f")!.result).toBe(typeof result === "string" ? result : JSON.stringify(result));
  });

  it("resultado gigante é cortado no teto, sem levar o diário inteiro para a tela", async () => {
    const fixture = fleetFixture();
    onTestFinished(() => rmSync(fixture.root, { recursive: true, force: true }));
    appendFileSync(join(fixture.run, "journal.jsonl"), jsonl([{ type: "result", key: "v2:2", agentId: "a02f", result: "x".repeat(50_000) }]));
    const wf = await load();
    const [run] = wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [fixture.runs, fixture.scripts]));
    expect(run!.agents.find((agent) => agent.id === "a02f")!.result).toHaveLength(wf.AGENT_RESULT_MAX);
  });
});

describe("agentes concluídos já conhecidos — a sondagem não relê o transcript deles", () => {
  let fx: Fixture;
  beforeEach(() => { fx = fleetFixture(); });
  afterEach(() => { rmSync(fx.root, { recursive: true, force: true }); });

  it("um concluído conhecido sai como marcador, sem abrir o arquivo; os outros continuam inteiros", async () => {
    const wf = await load();
    rmSync(join(fx.run, "agent-a01f.jsonl")); // if the probe tried to read it, a01f would come without times
    const raw = JSON.parse(runProbe(wf.WORKFLOW_PROBE_JS, [fx.runs, fx.scripts, "wf_abc12/a01f"]).trim()) as Array<{
      agents: Array<Record<string, unknown>>;
    }>;
    const agents = raw[0]!.agents;
    expect(agents.find((a) => a.id === "a01f")).toEqual({ id: "a01f", status: "done", settled: true });
    expect(agents.find((a) => a.id === "a02f")).toMatchObject({ startedAt: T0 + 500, toolCount: 2 });
  });

  it("só pula quem o diário diz que terminou — um 'conhecido' que ainda roda é lido", async () => {
    const wf = await load();
    const raw = JSON.parse(runProbe(wf.WORKFLOW_PROBE_JS, [fx.runs, fx.scripts, "wf_abc12/a02f"]).trim()) as Array<{
      agents: Array<Record<string, unknown>>;
    }>;
    expect(raw[0]!.agents.find((a) => a.id === "a02f")).toMatchObject({ status: "running", toolCount: 2 });
  });

  it("parseWorkflowProbe remonta o marcador com o quadro anterior; sem quadro anterior, o marcador some", async () => {
    const { parseWorkflowProbe } = await load();
    const stdout = JSON.stringify([{
      runId: "wf_abc12", total: 2, done: 1, at: 5, startedAt: T0 + 500,
      agents: [{ id: "a01f", status: "done", settled: true }, { id: "a02f", status: "running", startedAt: T0 + 500, toolCount: 2 }],
    }]);
    const before = {
      runId: "wf_abc12", name: "review", phases: [], total: 2, done: 1, at: 4, finished: false,
      agents: [{ id: "a01f", label: "varre:front", phase: "Varredura", status: "done" as const, result: "ok", toolCount: 7, startedAt: T0, endedAt: T0 + 9 }],
    };
    const [run] = parseWorkflowProbe(stdout, (runId) => (runId === "wf_abc12" ? before : undefined));
    expect(run!.agents.map((a) => a.id)).toEqual(["a01f", "a02f"]);
    expect(run!.agents[0]).toEqual(before.agents[0]);
    expect(run!.startedAt).toBe(T0); // the round's start counts the completed one that was not re-read
    expect(parseWorkflowProbe(stdout)[0]!.agents.map((a) => a.id)).toEqual(["a02f"]);
  });

  it("o comando leva os conhecidos como argumento — e descarta o que não tem o formato do harness", async () => {
    const { buildWorkflowProbeScript } = await load();
    const script = buildWorkflowProbeScript("runner", "/r", "/s", ["wf_abc12/a01f", "wf_x/a02f", "wf_../a1", "wf_a/a1;rm", "lixo"]);
    expect(script).toContain("'/r' '/s' 'wf_abc12/a01f,wf_x/a02f'");
    expect(buildWorkflowProbeScript("runner", "/r", "/s")).toContain("'/r' '/s' ''");
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
    // A runner failure (no node, stopped container) has to become an error, not an empty feed.
    expect(script).not.toMatch(/\|\|\s*true/);
    expect(script).not.toContain("2>/dev/null");
    // maxItems becomes an integer within the cap.
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
      // No item comes from the header of the user's request.
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

/**
 * The round's OUTCOME (17/10/2026): two fleets of 35 subagents were KILLED (`status: "killed"` in the
 * `<base>/workflows/<runId>.json` the harness writes next to `scripts/`). A killed fleet never
 * writes the `result` of the agents that were in flight — by the journal it stayed "running" forever,
 * and the panel spun a spinner on agents that no longer existed. The outcome comes from the snapshot, not the journal.
 */
describe("desfecho da rodada — o snapshot do harness diz se ela acabou", () => {
  let fx: Fixture;
  beforeEach(() => { fx = fleetFixture(); });
  afterEach(() => { rmSync(fx.root, { recursive: true, force: true }); });

  const snapshotFile = (status: unknown) =>
    writeFileSync(join(fx.scripts, "..", "wf_abc12.json"), JSON.stringify({ runId: "wf_abc12", status, workflowProgress: [{ status: "running" }] }));

  async function probeRun() {
    const wf = await load();
    return wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [fx.runs, fx.scripts]))[0]!;
  }

  it("sem snapshot (rodada em andamento): sem desfecho, agentes como o diário diz", async () => {
    const run = await probeRun();
    expect(run.outcome).toBeUndefined();
    expect(run.agents.map((a) => a.status)).toEqual(["done", "running", "running"]);
  });

  it("killed: desfecho 'killed' e quem estava em voo vira 'stopped' — nunca mais 'running'", async () => {
    snapshotFile("killed");
    const run = await probeRun();
    expect(run.outcome).toBe("killed");
    expect(run.agents.map((a) => [a.id, a.status])).toEqual([["a01f", "done"], ["a02f", "stopped"], ["a03f", "stopped"]]);
    // The completed one keeps what it returned; the interrupted one does not make up a result.
    expect(run.agents[0]!.result).toBeTruthy();
    expect(run.agents[1]!.result).toBeUndefined();
  });

  it("completed: o desfecho chega, mas a sonda NÃO dá por parado quem não respondeu — o back espera um tique", async () => {
    // The "completed" snapshot comes out 8ms after the journal's last line (production): a read race
    // must not stamp "interrompido" on an agent that answered.
    snapshotFile("completed");
    const run = await probeRun();
    expect(run.outcome).toBe("completed");
    expect(run.agents.map((a) => a.status)).toEqual(["done", "running", "running"]);
  });

  it("failed/error viram 'failed'; status desconhecido, ausente ou snapshot quebrado = sem desfecho", async () => {
    snapshotFile("error");
    expect((await probeRun()).outcome).toBe("failed");
    snapshotFile("running");
    expect((await probeRun()).outcome).toBeUndefined();
    snapshotFile(42);
    expect((await probeRun()).outcome).toBeUndefined();
    writeFileSync(join(fx.scripts, "..", "wf_abc12.json"), "{ quebrado");
    expect((await probeRun()).outcome).toBeUndefined();
  });

  it("parseWorkflowProbe sozinho: desfecho com lixo vira undefined; com desfecho, todo não-concluído é 'stopped'", async () => {
    const wf = await load();
    const [lixo] = wf.parseWorkflowProbe(probe([{ runId: "wf_a", outcome: "<script>", agents: [AGENT()] }]));
    expect(lixo!.outcome).toBeUndefined();
    expect(lixo!.agents[0]!.status).toBe("running");
    const [morta] = wf.parseWorkflowProbe(probe([{ runId: "wf_a", outcome: "killed", agents: [AGENT(), AGENT({ id: "a2", status: "done", result: "ok" })] }]));
    expect(morta!.agents.map((a) => a.status)).toEqual(["stopped", "done"]);
  });
});

describe("frota retomada — o Workflow com resumeFromRunId escreve a segunda tentativa no mesmo diário", () => {
  const RESUMED_JOURNAL = [
    { type: "launched" },
    { type: "started", agentId: "a01f", label: "verificação: tests · termo com vírgula", phase: "Verificação" },
    { type: "result", agentId: "a01f", result: { confirmed: true, evidence: "primeira tentativa" } },
    { type: "started", agentId: "a02f", label: "juiz", phase: "Julgamento" },
    { type: "started", agentId: "a03f", label: "verificação: tests · termo com vírgula", phase: "Verificação" },
    { type: "result", agentId: "a03f", result: { confirmed: true, evidence: "segunda tentativa" } },
    { type: "started", agentId: "a04f", label: "juiz", phase: "Julgamento" },
    { type: "result", agentId: "a04f", result: { summary: "1 achado" } },
  ];
  const PARALLEL_JOURNAL = [
    { type: "launched" },
    { type: "started", agentId: "a01f", label: "worker", phase: "Varredura" },
    { type: "started", agentId: "a02f", label: "worker", phase: "Varredura" },
    { type: "result", agentId: "a01f", result: "um" },
    { type: "started", agentId: "a03f", label: "worker", phase: "Varredura" },
    { type: "result", agentId: "a02f", result: "dois" },
  ];
  const progressOf = (agentIds: string[]) => agentIds.map((agentId) => ({ type: "workflow_agent", agentId, state: "done" }));

  function writeRun(journal: unknown[], snapshot?: Record<string, unknown>): { root: string; runsDir: string; scripts: string } {
    const root = mkdtempSync(join(tmpdir(), "vibehub-wf-resume-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const runsDir = join(root, "s1", "subagents", "workflows");
    const scripts = join(root, "s1", "workflows", "scripts");
    mkdirSync(join(runsDir, "wf_res1"), { recursive: true });
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(runsDir, "wf_res1", "journal.jsonl"), jsonl(journal));
    if (snapshot) writeFileSync(join(root, "s1", "workflows", "wf_res1.json"), JSON.stringify({ runId: "wf_res1", ...snapshot }));
    return { root, runsDir, scripts };
  }

  it("com o registro final do harness, só os agentes da tentativa que valeu: nem juiz parado, nem verificação em dobro", async () => {
    const wf = await load();
    const { runsDir, scripts } = writeRun(RESUMED_JOURNAL, { status: "completed", workflowProgress: progressOf(["a03f", "a04f"]) });
    const [run] = wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [runsDir, scripts]));
    expect(run!.agents.map((agent) => [agent.id, agent.status])).toEqual([["a03f", "done"], ["a04f", "done"]]);
    expect([run!.total, run!.done]).toEqual([2, 2]);
  });

  it("na conversa da frota, com o registro final, só fala a tentativa que valeu", async () => {
    const wf = await load();
    const { root } = writeRun(RESUMED_JOURNAL, { status: "completed", workflowProgress: progressOf(["a03f", "a04f"]) });
    const conversation = wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [root]));
    expect(conversation!.agents.map((agent) => [agent.id, agent.status])).toEqual([["a03f", "done"], ["a04f", "done"]]);
    expect(conversation!.finished).toBe(true);
  });

  it.each([
    ["sem registro final", undefined],
    ["com o registro final listando todos", { status: "completed", workflowProgress: progressOf(["a01f", "a02f", "a03f"]) }],
    ["com registro final sem a lista de agentes", { status: "completed" }],
  ])("agentes paralelos com o mesmo rótulo continuam todos na frota (%s)", async (_case, snapshot) => {
    const wf = await load();
    const { runsDir, scripts } = writeRun(PARALLEL_JOURNAL, snapshot);
    const [run] = wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [runsDir, scripts]));
    expect(run!.agents.map((agent) => agent.id)).toEqual(["a01f", "a02f", "a03f"]);
    expect([run!.total, run!.done]).toEqual([3, 2]);
  });
});

describe("agente que falhou — o diário marca 'failed' e o snapshot do harness diz o motivo", () => {
  const USAGE_LIMIT = "You've hit your session limit · resets 1:10am (UTC)";

  function failedRunRoot(withSnapshot: boolean): { runsDir: string; scripts: string } {
    const root = mkdtempSync(join(tmpdir(), "vibehub-wf-failed-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const runsDir = join(root, "s1", "subagents", "workflows");
    const scripts = join(root, "workflows", "scripts");
    mkdirSync(join(runsDir, "wf_fail1"), { recursive: true });
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(runsDir, "wf_fail1", "journal.jsonl"), jsonl([
      { type: "launched" },
      { type: "started", agentId: "a01f", label: "revisão: tests", phase: "Revisão" },
      { type: "result", agentId: "a01f", result: { findings: [] } },
      { type: "started", agentId: "a02f", label: "juiz", phase: "Julgamento" },
      { type: "failed", agentId: "a02f" },
    ]));
    if (withSnapshot) {
      writeFileSync(join(root, "workflows", "wf_fail1.json"), JSON.stringify({
        runId: "wf_fail1", status: "failed",
        workflowProgress: [
          { type: "workflow_phase", index: 1, title: "Revisão" },
          { type: "workflow_agent", agentId: "a01f", label: "revisão: tests", state: "done" },
          { type: "workflow_agent", agentId: "a02f", label: "juiz", state: "error", error: USAGE_LIMIT },
        ],
      }));
    }
    return { runsDir, scripts };
  }

  it("com a execução ainda aberta, o 'failed' do diário já para o agente: ele não responde mais", async () => {
    const wf = await load();
    const { runsDir, scripts } = failedRunRoot(false);
    const [run] = wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [runsDir, scripts]));
    expect(run!.agents.map((agent) => [agent.id, agent.status])).toEqual([["a01f", "done"], ["a02f", "stopped"]]);
    expect(run!.agents[1]!.error).toBeUndefined();
  });

  it("com o snapshot, o agente que falhou leva o erro do harness; quem respondeu não leva erro", async () => {
    const wf = await load();
    const { runsDir, scripts } = failedRunRoot(true);
    const [run] = wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [runsDir, scripts]));
    expect(run!.outcome).toBe("failed");
    expect(run!.agents.map((agent) => [agent.id, agent.status, agent.error])).toEqual([["a01f", "done", undefined], ["a02f", "stopped", USAGE_LIMIT]]);
  });

  it("erro no snapshot sem o 'failed' no diário também para o agente, com o motivo", async () => {
    const wf = await load();
    const { runsDir, scripts } = failedRunRoot(true);
    const journal = join(runsDir, "wf_fail1", "journal.jsonl");
    writeFileSync(journal, jsonl([
      { type: "launched" },
      { type: "started", agentId: "a01f", label: "revisão: tests", phase: "Revisão" },
      { type: "result", agentId: "a01f", result: { findings: [] } },
      { type: "started", agentId: "a02f", label: "juiz", phase: "Julgamento" },
    ]));
    const [run] = wf.parseWorkflowProbe(runProbe(wf.WORKFLOW_PROBE_JS, [runsDir, scripts]));
    expect(run!.agents[1]).toMatchObject({ id: "a02f", status: "stopped", error: USAGE_LIMIT });
  });

  it("parseWorkflowProbe: erro só em quem parou, cortado no teto, e lixo vira ausente", async () => {
    const wf = await load();
    const [run] = wf.parseWorkflowProbe(probe([{
      runId: "wf_a",
      agents: [
        AGENT({ id: "a1", status: "stopped", error: "x".repeat(5_000) }),
        AGENT({ id: "a2", status: "done", result: "ok", error: "não vale em quem respondeu" }),
        AGENT({ id: "a3", status: "stopped", error: 42 }),
      ],
    }]));
    expect(run!.agents.map((agent) => agent.status)).toEqual(["stopped", "done", "stopped"]);
    expect(run!.agents[0]!.error!.length).toBe(wf.AGENT_ERROR_MAX);
    expect(run!.agents[1]!.error).toBeUndefined();
    expect(run!.agents[2]!.error).toBeUndefined();
  });
});

describe("conversa da frota — todos os agentes de uma vez, numa execução só", () => {
  const MODEL_ASSISTANT = (ts: number, model: string, blocks: unknown[]) => ({
    type: "assistant", timestamp: iso(ts), message: { role: "assistant", model, content: blocks },
  });

  function conversationFixture(): { transcriptDir: string } {
    const transcriptDir = mkdtempSync(join(tmpdir(), "vibehub-conv-"));
    onTestFinished(() => rmSync(transcriptDir, { recursive: true, force: true }));
    const older = join(transcriptDir, "s-old", "subagents", "workflows", "wf_old1");
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, "journal.jsonl"), jsonl([{ type: "started", agentId: "a0aa", label: "contexto", phase: "Contexto" }]));
    utimesSync(join(older, "journal.jsonl"), new Date(T0), new Date(T0));
    const run = join(transcriptDir, "s-new", "subagents", "workflows", "wf_new1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "journal.jsonl"), jsonl([
      { type: "launched" },
      { type: "started", agentId: "a01f", label: "revisão:security", phase: "Revisão" },
      { type: "started", agentId: "a02f", label: "verificação:security · token vaza", phase: "Verificação" },
      { type: "result", agentId: "a01f", result: { findings: [] } },
    ]));
    writeFileSync(join(run, "agent-a01f.meta.json"), JSON.stringify({ model: "sonnet" }));
    writeFileSync(join(run, "agent-a01f.jsonl"), jsonl([
      HEADER(T0), TASK(T0 + 100, "Revise segurança"),
      MODEL_ASSISTANT(T0 + 1_000, "claude-sonnet-5-5", [THINKING, TOOL("t1", "Read", { file_path: "/work/back/src/auth.ts" })]),
      TOOL_RESULT(T0 + 1_500, "t1", "export function login() {}"),
      MODEL_ASSISTANT(T0 + 4_000, "claude-sonnet-5-5", [{ type: "text", text: `O token vaza no log. ${"x".repeat(900)}` }]),
    ]));
    writeFileSync(join(run, "agent-a02f.jsonl"), jsonl([
      HEADER(T0 + 200), TASK(T0 + 300, "Verifique"),
      MODEL_ASSISTANT(T0 + 2_000, "claude-opus-5-5", [{ type: "text", text: "Refutado: o log mascara o token." }]),
    ]));
    return { transcriptDir };
  }

  it("na conversa, o aviso <synthetic> do CLI no fim do transcript não toma o lugar do modelo que respondeu", async () => {
    const wf = await load();
    const { transcriptDir } = conversationFixture();
    writeFileSync(join(transcriptDir, "s-new", "subagents", "workflows", "wf_new1", "agent-a02f.jsonl"), jsonl([
      HEADER(T0 + 200), TASK(T0 + 300, "Verifique"),
      MODEL_ASSISTANT(T0 + 2_000, "claude-opus-5-5", [{ type: "text", text: "Refutado: o log mascara o token." }]),
      MODEL_ASSISTANT(T0 + 3_000, "<synthetic>", [{ type: "text", text: "You've hit your session limit" }]),
    ]));
    const conversation = wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [transcriptDir]));
    expect(conversation!.agents.find((agent) => agent.id === "a02f")).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("lê a rodada mais recente de todas as sessões do card, com quem falou, o id do modelo que respondeu e o que disse, em ordem de tempo", async () => {
    const wf = await load();
    const { transcriptDir } = conversationFixture();
    const conversation = wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [transcriptDir]));
    expect(conversation).toMatchObject({ runId: "wf_new1", finished: false });
    expect(conversation!.agents).toEqual([
      { id: "a01f", label: "revisão:security", phase: "Revisão", status: "done", model: "claude-sonnet-5-5" },
      { id: "a02f", label: "verificação:security · token vaza", phase: "Verificação", status: "running", model: "claude-opus-5-5" },
    ]);
    expect(conversation!.items.map((item) => [item.agentId, item.kind])).toEqual([
      ["a01f", "thinking"], ["a01f", "tool"], ["a01f", "result"], ["a02f", "text"], ["a01f", "text"],
    ]);
    expect(conversation!.items[1]).toMatchObject({ tool: "Read", target: "/work/back/src/auth.ts" });
    expect(conversation!.items[3]!.text).toBe("Refutado: o log mascara o token.");
    expect(conversation!.items[4]!.text!.length).toBeGreaterThan(300);
  });

  it("com o runId de uma rodada antiga, lê as falas dela e não as da rodada mais recente", async () => {
    const wf = await load();
    const { transcriptDir } = conversationFixture();
    const older = join(transcriptDir, "s-old", "subagents", "workflows", "wf_old1");
    writeFileSync(join(older, "agent-a0aa.jsonl"), jsonl([
      MODEL_ASSISTANT(T0 + 500, "claude-haiku-4-5", [{ type: "text", text: "O PR mexe em 3 arquivos." }]),
    ]));
    const conversation = wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [transcriptDir, "wf_old1"]));
    expect(conversation!.runId).toBe("wf_old1");
    expect(conversation!.agents.map((agent) => agent.id)).toEqual(["a0aa"]);
    expect(conversation!.items.map((item) => item.text)).toEqual(["O PR mexe em 3 arquivos."]);
  });

  it("com o runId de uma rodada que não existe no card, devolve null", async () => {
    const wf = await load();
    const { transcriptDir } = conversationFixture();
    expect(wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [transcriptDir, "wf_nada1"]))).toBeNull();
  });

  it("o runId vai citado depois do diretório; fora do formato, nenhum comando é montado", async () => {
    const wf = await load();
    expect(wf.buildFleetConversationProbeScript("runner", "/root/t", "wf_old1").endsWith(" '/root/t' 'wf_old1'")).toBe(true);
    expect(() => wf.buildFleetConversationProbeScript("runner", "/root/t", "wf_x'; rm -rf /")).toThrow(wf.InvalidWorkflowIdError);
  });

  it("a resposta que o agente entrega pela ferramenta StructuredOutput vira a fala dele, com o JSON inteiro", async () => {
    const wf = await load();
    const transcriptDir = mkdtempSync(join(tmpdir(), "vibehub-conv-so-"));
    onTestFinished(() => rmSync(transcriptDir, { recursive: true, force: true }));
    const run = join(transcriptDir, "s1", "subagents", "workflows", "wf_so1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "journal.jsonl"), jsonl([{ type: "started", agentId: "a0b1", label: "verificação:tests · x", phase: "Verificação" }]));
    const verdict = { confirmed: false, evidence: "o teste já cobre o caso" };
    writeFileSync(join(run, "agent-a0b1.jsonl"), jsonl([
      MODEL_ASSISTANT(T0, "claude-sonnet-5-5", [TOOL("t9", "StructuredOutput", verdict)]),
    ]));
    const conversation = wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [transcriptDir]));
    expect(conversation!.items).toEqual([{ agentId: "a0b1", at: T0, kind: "text", text: JSON.stringify(verdict) }]);
  });

  it("a fala do agente chega com as quebras de linha, para o markdown dela renderizar", async () => {
    const wf = await load();
    const transcriptDir = mkdtempSync(join(tmpdir(), "vibehub-conv-md-"));
    onTestFinished(() => rmSync(transcriptDir, { recursive: true, force: true }));
    const run = join(transcriptDir, "s1", "subagents", "workflows", "wf_md1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "journal.jsonl"), jsonl([{ type: "started", agentId: "a0c1", label: "revisão:tests", phase: "Revisão" }]));
    const speech = "Achei 2 problemas:\n\n- `ContextMeter` sem teste\n- espera de 700ms no relógio real";
    writeFileSync(join(run, "agent-a0c1.jsonl"), jsonl([MODEL_ASSISTANT(T0, "claude-sonnet-5-5", [{ type: "text", text: speech }])]));
    const conversation = wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [transcriptDir]));
    expect(conversation!.items[0]!.text).toBe(speech);
  });

  it("todos os agentes respondidos dão a conversa por terminada", async () => {
    const wf = await load();
    const conversation = wf.parseFleetConversation(probe({
      runId: "wf_x", agents: [{ id: "a1", label: "juiz", phase: "Julgamento", status: "done" }], items: [],
    }));
    expect(conversation).toMatchObject({ runId: "wf_x", finished: true });
  });

  it("card sem frota (diretório vazio ou inexistente) devolve null; lixo também", async () => {
    const wf = await load();
    const empty = mkdtempSync(join(tmpdir(), "vibehub-conv-empty-"));
    onTestFinished(() => rmSync(empty, { recursive: true, force: true }));
    expect(wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [empty]))).toBeNull();
    expect(wf.parseFleetConversation(runProbe(wf.FLEET_CONVERSATION_PROBE_JS, [join(empty, "nao-existe")]))).toBeNull();
    expect(wf.parseFleetConversation("lixo")).toBeNull();
  });

  it("o diretório vai como argumento citado, nunca dentro do script", async () => {
    const wf = await load();
    const script = wf.buildFleetConversationProbeScript("runner", "/root/x'; rm -rf /");
    expect(script.startsWith("docker exec 'runner' node -e ")).toBe(true);
    expect(script.endsWith(` '/root/x'\\''; rm -rf /'`)).toBe(true);
  });
});
