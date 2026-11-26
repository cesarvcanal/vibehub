import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

interface ReviewRouting {
  CODE_REVIEWER_AGENT_TYPE: string;
  CODE_REVIEWER_AGENT: { description: string; prompt: string; disallowedTools: string[] };
  reviewRoutingDenial: (toolName: string, input: unknown, availableAgentTypes: unknown) => string | null;
}

function loadReviewRouting(): ReviewRouting {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");
  const from = source.indexOf("const CODE_REVIEWER_AGENT_TYPE");
  const end = source.indexOf("function reviewRoutingDenial(");
  const to = source.indexOf("\n}", end) + 2;
  const factory = new Function(
    `${source.slice(from, to)}\nreturn { CODE_REVIEWER_AGENT_TYPE, CODE_REVIEWER_AGENT, reviewRoutingDenial };`,
  );
  return factory() as ReviewRouting;
}

const { CODE_REVIEWER_AGENT_TYPE, CODE_REVIEWER_AGENT, reviewRoutingDenial } = loadReviewRouting();
const SESSION_AGENTS = ["general-purpose", "claude", "Explore", CODE_REVIEWER_AGENT_TYPE];

describe("driver — pedido de Code Review roda no perfil code-reviewer, nunca no general-purpose", () => {
  it.each([
    ["general-purpose", { description: "Code review · padrões", prompt: "Revise a branch atual contra o AGENTS.md" }],
    ["general-purpose", { description: "Review admissão + Space vínculo", prompt: "Code review READ-ONLY no repo" }],
    ["claude", { description: "Revisão independente PR 656", prompt: "Revise o PR 656" }],
    ["sem tipo", { description: "Code review do diff da branch", prompt: "Revise o diff" }],
    ["general-purpose", { description: "Conferir a branch", prompt: "Faça um code review do diff origin/main...HEAD" }],
  ])("caso real dos transcripts: despacho de revisão como %s é recusado e aponta o code-reviewer", (agentType, input) => {
    const subagentType = agentType === "sem tipo" ? {} : { subagent_type: agentType };
    const denial = reviewRoutingDenial("Agent", { ...input, ...subagentType }, SESSION_AGENTS);
    expect(denial).toContain(`subagent_type "${CODE_REVIEWER_AGENT_TYPE}"`);
  });

  it("a recusa manda reenviar o mesmo pedido, para a pessoa não ter de repeti-lo", () => {
    const denial = reviewRoutingDenial("Agent", { subagent_type: "general-purpose", description: "Code review · spec", prompt: "x" }, SESSION_AGENTS);
    expect(denial).toMatch(/same prompt/i);
  });

  it("o despacho de revisão no perfil code-reviewer passa", () => {
    const input = { subagent_type: CODE_REVIEWER_AGENT_TYPE, description: "Code review · padrões", prompt: "Revise a branch" };
    expect(reviewRoutingDenial("Agent", input, SESSION_AGENTS)).toBeNull();
  });

  it.each([
    [{ subagent_type: "general-purpose", description: "Pesquisar a docs do SDK", prompt: "Ache a opção agents do query()" }],
    [{ subagent_type: "Explore", description: "Review dos imports antigos", prompt: "Ache quem importa X" }],
    [{ subagent_type: "feature-dev:code-reviewer", description: "Code review", prompt: "Revise" }],
  ])("despacho que não é revisão, ou já vai a um perfil especializado, passa: %o", (input) => {
    expect(reviewRoutingDenial("Agent", input, SESSION_AGENTS)).toBeNull();
  });

  it("a skill code-review embutida, que roda num general-purpose, é trocada pelo perfil code-reviewer com os mesmos argumentos", () => {
    const denial = reviewRoutingDenial("Skill", { skill: "code-review", args: "high origin/dev...HEAD" }, SESSION_AGENTS);
    expect(denial).toContain(`subagent_type "${CODE_REVIEWER_AGENT_TYPE}"`);
    expect(denial).toMatch(/args/);
  });

  it("as skills de revisão que orquestram os revisores (Matt Pocock, plugin de PR) passam", () => {
    expect(reviewRoutingDenial("Skill", { skill: "mattpocock-skills:code-review" }, SESSION_AGENTS)).toBeNull();
    expect(reviewRoutingDenial("Skill", { skill: "code-review:code-review" }, SESSION_AGENTS)).toBeNull();
  });

  it.each([
    ["a sessão não registrou o perfil", ["general-purpose", "claude"]],
    ["o init não trouxe a lista de agentes", undefined],
  ])("sem o perfil code-reviewer (%s), a revisão é recusada com aviso explícito, sem cair no general-purpose", (_scenario, agents) => {
    const denial = reviewRoutingDenial("Agent", { subagent_type: "general-purpose", description: "Code review · padrões", prompt: "x" }, agents);
    expect(denial).toMatch(/not available/i);
    expect(denial).toMatch(/tell the person/i);
    expect(denial).toMatch(/never .*general-purpose/i);
  });

  it("ferramenta que não despacha agente nem skill passa", () => {
    expect(reviewRoutingDenial("Bash", { command: "git diff origin/main...HEAD", description: "code review" }, SESSION_AGENTS)).toBeNull();
  });
});

describe("driver — o perfil code-reviewer segue as instruções do projeto e mostra a aderência", () => {
  it("só lê: não edita arquivo nem despacha outro agente", () => {
    expect(CODE_REVIEWER_AGENT.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit", "Agent"]));
  });

  it("toma o CLAUDE.md e o AGENTS.md do projeto como as regras da revisão", () => {
    expect(CODE_REVIEWER_AGENT.prompt).toMatch(/CLAUDE\.md/);
    expect(CODE_REVIEWER_AGENT.prompt).toMatch(/AGENTS\.md/);
  });

  it("o relatório abre com a seção de aderência, e item sem evidência sai como não verificado", () => {
    expect(CODE_REVIEWER_AGENT.prompt).toContain("## Aderência");
    expect(CODE_REVIEWER_AGENT.prompt).toMatch(/não verificado/);
  });
});
