import { describe, it, expect } from "vitest";
import { prAnalysisWorkflowSource } from "./analysisWorkflow.js";

type AgentOpts = { label?: string; phase?: string; model?: string; effort?: string; schema?: object };
type AgentFake = (prompt: string, opts: AgentOpts) => Promise<unknown>;
type PipelineStage = (previous: unknown, item: unknown, index: number) => unknown;

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...params: string[]
) => (...values: unknown[]) => Promise<unknown>;

async function runFleet(agentFake: AgentFake) {
  const calls: { prompt: string; opts: AgentOpts }[] = [];
  const logs: string[] = [];
  const agent = async (prompt: string, opts: AgentOpts) => {
    calls.push({ prompt, opts });
    return await agentFake(prompt, opts);
  };
  const parallel = async (thunks: (() => Promise<unknown>)[]) =>
    await Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk();
      } catch {
        return null;
      }
    }));
  const pipeline = async (items: unknown[], ...stages: PipelineStage[]) =>
    await Promise.all(items.map(async (item, index) => {
      try {
        return await stages.reduce<Promise<unknown>>(async (previous, stage) => await stage(await previous, item, index), Promise.resolve(item));
      } catch {
        return null;
      }
    }));
  const scriptBody = prAnalysisWorkflowSource().replace("export const meta =", "const meta =");
  const script = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", scriptBody);
  const fleetResult = await script(
    agent, parallel, pipeline, () => undefined, (message: string) => logs.push(message),
    { prNumber: 7, branch: "feat/x", base: "dev", headSha: "d".repeat(40) },
  );
  return { fleetResult: fleetResult as Record<string, unknown>, calls, logs };
}

const ALL_APPLY = { correctness: true, security: true, performance: true, contracts: true, tests: true, repoRules: true };
const ONLY_CORRECTNESS = { correctness: true, security: false, performance: false, contracts: false, tests: false, repoRules: false };

const brief = (applies: Record<string, boolean>) => ({
  summary: "muda o login",
  touchedAreas: ["back/src/auth"],
  consumers: ["front/src/features/auth"],
  dimensions: Object.entries(applies).map(([key, value]) => ({ key, applies: value, reason: value ? "tocado" : "fora do diff" })),
});

const scenarioFinding = (title: string) => ({
  title, problem: "p", file: "a.ts", line: 1, proof: { kind: "scenario", ref: "a.ts:1", detail: "d" }, fix: "x", suggestedSeverity: "blocking",
});

describe("frota da análise de PR", () => {
  it("contexto e juiz em Opus; revisão e verificação em Sonnet", async () => {
    const { calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ALL_APPLY);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("bug")] };
      if (opts.phase === "Verificação") return { confirmed: true, evidence: "reproduzido" };
      return { findings: [{ ...scenarioFinding("bug"), dimension: "correctness", severity: "blocking" }] };
    });
    const modelsOf = (phase: string) => new Set(calls.filter((call) => call.opts.phase === phase).map((call) => call.opts.model));
    expect(modelsOf("Contexto")).toEqual(new Set(["opus"]));
    expect(modelsOf("Revisão")).toEqual(new Set(["sonnet"]));
    expect(modelsOf("Verificação")).toEqual(new Set(["sonnet"]));
    expect(modelsOf("Julgamento")).toEqual(new Set(["opus"]));
  });

  it("dimensão fora do diff não roda, sai como pulada e aparece no log", async () => {
    const { fleetResult, calls, logs } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief({ ...ALL_APPLY, security: false });
      return { findings: [] };
    });
    expect(calls.filter((call) => call.opts.phase === "Revisão")).toHaveLength(5);
    expect(fleetResult.dimensions).toContainEqual({ key: "security", status: "skipped", reason: "fora do diff" });
    expect(logs.join("\n")).toContain("security");
  });

  it("achado que a verificação derruba sai da lista e entra na contagem", async () => {
    const { fleetResult, calls } = await runFleet(async (prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("achado-real"), scenarioFinding("achado-falso")] };
      if (opts.phase === "Verificação") return { confirmed: !prompt.includes("achado-falso"), evidence: "e" };
      return { findings: [{ ...scenarioFinding("achado-real"), dimension: "correctness", severity: "blocking" }] };
    });
    expect(fleetResult.refutedCount).toBe(1);
    const judgePrompt = calls.find((call) => call.opts.phase === "Julgamento")!.prompt;
    expect(judgePrompt).toContain("achado-real");
    expect(judgePrompt).not.toContain("achado-falso");
  });

  it("verificador que morre não confirma o achado nem o conta como derrubado: o motivo diz que faltou veredito", async () => {
    const { fleetResult, calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("sem-veredito")] };
      if (opts.phase === "Verificação") return null;
      return { findings: [] };
    });
    expect(calls.some((call) => call.opts.phase === "Julgamento")).toBe(false);
    expect(fleetResult.findings).toEqual([]);
    expect(fleetResult.refutedCount).toBe(0);
    expect(fleetResult.dimensions).toContainEqual(
      expect.objectContaining({ key: "correctness", status: "ran", reason: expect.stringContaining("1 achado sem veredito") }),
    );
  });

  it("revisor que morre deixa a dimensão como não rodou, com o motivo", async () => {
    const { fleetResult } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return null;
      return { findings: [] };
    });
    expect(fleetResult.dimensions).toContainEqual(expect.objectContaining({ key: "correctness", status: "not_run" }));
  });

  it("o juiz é chamado uma vez com os confirmados de todas as dimensões", async () => {
    const { calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief({ ...ONLY_CORRECTNESS, security: true });
      if (opts.phase === "Revisão") return { findings: [scenarioFinding(`achado de ${opts.label}`)] };
      if (opts.phase === "Verificação") return { confirmed: true, evidence: "e" };
      return { findings: [] };
    });
    const judgeCalls = calls.filter((call) => call.opts.phase === "Julgamento");
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]!.prompt).toContain("achado de revisão: correctness");
    expect(judgeCalls[0]!.prompt).toContain("achado de revisão: security");
  });

  it("os achados do juiz saem numerados e o bloqueante sem prova vira sugestão", async () => {
    const { fleetResult } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("x")] };
      if (opts.phase === "Verificação") return { confirmed: true, evidence: "e" };
      return {
        findings: [
          { ...scenarioFinding("com-prova"), dimension: "correctness", severity: "blocking" },
          { title: "sem-prova", problem: "p", fix: "f", dimension: "correctness", severity: "blocking" },
        ],
      };
    });
    expect(fleetResult.findings).toEqual([
      expect.objectContaining({ id: "f1", title: "com-prova", severity: "blocking" }),
      expect.objectContaining({ id: "f2", title: "sem-prova", severity: "suggestion" }),
    ]);
  });

  it("acima de 30 achados numa dimensão, o excedente não é verificado e o motivo diz quantos", async () => {
    const { fleetResult, calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: Array.from({ length: 33 }, (_, index) => scenarioFinding(`a${index}`)) };
      if (opts.phase === "Verificação") return { confirmed: false, evidence: "e" };
      return { findings: [] };
    });
    expect(calls.filter((call) => call.opts.phase === "Verificação")).toHaveLength(30);
    expect(fleetResult.dimensions).toContainEqual(
      expect.objectContaining({ key: "correctness", status: "ran", reason: expect.stringContaining("3 achados") }),
    );
  });

  it("contexto que não responde derruba a frota com erro", async () => {
    await expect(runFleet(async () => null)).rejects.toThrow(/contexto/);
  });

  it("juiz que não responde derruba a frota com erro", async () => {
    await expect(runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("x")] };
      if (opts.phase === "Verificação") return { confirmed: true, evidence: "e" };
      return null;
    })).rejects.toThrow(/juiz/);
  });
});
