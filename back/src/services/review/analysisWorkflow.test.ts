import { describe, it, expect } from "vitest";
import { ANALYSIS_DIMENSIONS } from "./analysisModel.js";
import { prAnalysisWorkflowSource } from "./analysisWorkflow.js";

type AgentOpts = { label?: string; phase?: string; model?: string; effort?: string; schema?: object };
type AgentFake = (prompt: string, opts: AgentOpts) => Promise<unknown>;
type PipelineStage = (previous: unknown, item: unknown, index: number) => unknown;

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...params: string[]
) => (...values: unknown[]) => Promise<unknown>;

const VALID_ARGS = { prNumber: 7, branch: "feat/x", base: "dev", headSha: "d".repeat(40) };

async function runFleet(agentFake: AgentFake, fleetArgs: unknown = VALID_ARGS) {
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
    fleetArgs,
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
  it("as dimensões da frota são as do modelo do servidor: uma só no modelo nunca rodaria, uma só no script o zod recusaria", async () => {
    const { calls } = await runFleet(async (_prompt, opts) => (opts.phase === "Contexto" ? brief(ALL_APPLY) : { findings: [] }));
    const briefSchema = calls.find((call) => call.opts.phase === "Contexto")!.opts.schema as {
      properties: { dimensions: { items: { properties: { key: { enum: string[] } } } } };
    };
    expect(briefSchema.properties.dimensions.items.properties.key.enum).toEqual([...ANALYSIS_DIMENSIONS]);
    const reviewedKeys = calls.filter((call) => call.opts.phase === "Revisão").map((call) => call.opts.label?.replace("revisão: ", ""));
    expect(reviewedKeys.sort()).toEqual([...ANALYSIS_DIMENSIONS].sort());
  });

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
      expect.objectContaining({ key: "correctness", status: "ran", unverifiedCount: 1, reason: expect.stringContaining("1 achado sem veredito") }),
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

  it("acima de 15 achados numa dimensão, o excedente não é verificado: o motivo diz quantos e a dimensão os conta como não verificados", async () => {
    const { fleetResult, calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: Array.from({ length: 18 }, (_, index) => scenarioFinding(`a${index}`)) };
      if (opts.phase === "Verificação") return { confirmed: false, evidence: "e" };
      return { findings: [] };
    });
    expect(calls.filter((call) => call.opts.phase === "Verificação")).toHaveLength(15);
    expect(fleetResult.dimensions).toContainEqual(
      expect.objectContaining({ key: "correctness", status: "ran", unverifiedCount: 3, reason: expect.stringContaining("3 achados") }),
    );
  });

  it("o verificador roda só o teste filtrado pelo caso, nunca o arquivo inteiro nem a suíte", async () => {
    const { calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("x")] };
      if (opts.phase === "Verificação") return { confirmed: false, evidence: "e" };
      return { findings: [] };
    });
    const verifyPrompt = calls.find((call) => call.opts.phase === "Verificação")!.prompt;
    expect(verifyPrompt).toContain('npx vitest run <arquivo> -t "<caso>"');
    expect(verifyPrompt).toContain("nunca o arquivo inteiro nem a suíte");
  });

  it("o schema do juiz exige o fix que a ferramenta do relatório exige", async () => {
    const { calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("x")] };
      if (opts.phase === "Verificação") return { confirmed: true, evidence: "e" };
      return { findings: [] };
    });
    const judgeSchema = calls.find((call) => call.opts.phase === "Julgamento")!.opts.schema as {
      properties: { findings: { items: { required: string[]; properties: Record<string, object> } } };
    };
    expect(judgeSchema.properties.findings.items.required).toContain("fix");
    expect(judgeSchema.properties.findings.items.properties.fix).toMatchObject({ minLength: 1 });
  });

  it("problem vazio ou só com espaços não passa no schema do juiz, como não passa no trim da ferramenta", async () => {
    const { calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("x")] };
      if (opts.phase === "Verificação") return { confirmed: true, evidence: "e" };
      return { findings: [] };
    });
    const judgeSchema = calls.find((call) => call.opts.phase === "Julgamento")!.opts.schema as {
      properties: { findings: { items: { properties: { problem: { minLength?: number; pattern?: string } } } } };
    };
    const problemSchema = judgeSchema.properties.findings.items.properties.problem;
    expect(problemSchema.minLength).toBe(1);
    expect(new RegExp(problemSchema.pattern ?? "").test("   ")).toBe(false);
  });

  it("fix só com espaços não passa no schema do juiz, como não passa no trim da ferramenta", async () => {
    const { calls } = await runFleet(async (_prompt, opts) => {
      if (opts.phase === "Contexto") return brief(ONLY_CORRECTNESS);
      if (opts.phase === "Revisão") return { findings: [scenarioFinding("x")] };
      if (opts.phase === "Verificação") return { confirmed: true, evidence: "e" };
      return { findings: [] };
    });
    const judgeSchema = calls.find((call) => call.opts.phase === "Julgamento")!.opts.schema as {
      properties: { findings: { items: { properties: { fix: { pattern: string } } } } };
    };
    const fixPattern = new RegExp(judgeSchema.properties.findings.items.properties.fix.pattern);
    expect(fixPattern.test("   ")).toBe(false);
    expect(fixPattern.test("troque o filtro")).toBe(true);
  });

  it.each([
    ["sha de 40 hex em maiúsculas", "D".repeat(40)],
    ["sha de 64 hex (repositório SHA-256)", "e".repeat(64)],
  ])("aceita o mesmo sha que a ferramenta do relatório aceita: %s", async (_case, headSha) => {
    const { calls } = await runFleet(async (_prompt, opts) => (opts.phase === "Contexto" ? brief(ONLY_CORRECTNESS) : { findings: [] }), {
      ...VALID_ARGS, headSha,
    });
    expect(calls.some((call) => call.opts.phase === "Contexto")).toBe(true);
  });

  it.each([
    ["args em texto (JSON stringificado)", JSON.stringify(VALID_ARGS)],
    ["sha ainda com o marcador do prompt", { ...VALID_ARGS, headSha: "<sha do passo 1>" }],
    ["sem a base", { ...VALID_ARGS, base: "" }],
    ["número da PR que não é inteiro", { ...VALID_ARGS, prNumber: "7" }],
  ])("args inválido (%s) derruba a frota antes de chamar qualquer agente", async (_case, fleetArgs) => {
    const agentCalls: string[] = [];
    await expect(runFleet(async (prompt) => {
      agentCalls.push(prompt);
      return null;
    }, fleetArgs)).rejects.toThrow(/args/);
    expect(agentCalls).toEqual([]);
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
