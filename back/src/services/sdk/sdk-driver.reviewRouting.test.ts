import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

interface ReviewRouting {
  CODE_REVIEWER_AGENT_TYPE: string;
  CODE_REVIEWER_AGENT: { description: string; prompt: string; disallowedTools: string[] };
  reviewRoutingDenial: (toolName: string, input: unknown, availableAgentTypes: unknown, callerAgentType?: string) => string | null;
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
    { subagent_type: "general-purpose", description: "Code review · padrões", prompt: "Revise a branch atual contra o AGENTS.md" },
    { subagent_type: "general-purpose", description: "Review admissão + Space vínculo", prompt: "Code review READ-ONLY no repo" },
    { subagent_type: "general-purpose", description: "Revisão independente PR 656", prompt: "Revise o PR 656" },
    { subagent_type: "general-purpose", description: "Code review do diff da branch", prompt: "Revise o diff" },
  ])("caso real dos transcripts: $description como general-purpose é recusado e aponta o code-reviewer", (input) => {
    expect(reviewRoutingDenial("Agent", input, SESSION_AGENTS)).toContain(`subagent_type "${CODE_REVIEWER_AGENT_TYPE}"`);
  });

  it.each([
    ["sem tipo, que o Claude Code roda como general-purpose", { description: "Code review · spec", prompt: "x" }],
    ["claude, o tipo padrão do vibehub", { subagent_type: "claude", description: "Code review · spec", prompt: "x" }],
    ["general-purpose com outro nome e o prompt do fechamento", { subagent_type: "general-purpose", description: "Verificação do diff", prompt: "Revise a branch atual contra o AGENTS.md da raiz do repositório." }],
    ["general-purpose com o prompt pedindo code review", { subagent_type: "general-purpose", description: "Conferir a branch", prompt: "Faça um code review do diff origin/main...HEAD" }],
  ])("revisão despachada %s também é recusada", (_scenario, input) => {
    expect(reviewRoutingDenial("Agent", input, SESSION_AGENTS)).toContain(`subagent_type "${CODE_REVIEWER_AGENT_TYPE}"`);
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
    [{ subagent_type: "general-purpose", description: "Aplicar correções da revisão", prompt: "Corrija os achados do code review do PR 12" }],
    [{ subagent_type: "general-purpose", description: "Corrigir achados do code review", prompt: "Aplique os ajustes" }],
    [{ subagent_type: "general-purpose", description: "Fix review findings", prompt: "Apply the code review fixes" }],
    [{ subagent_type: "Explore", description: "Review dos imports antigos", prompt: "Ache quem importa X" }],
    [{ subagent_type: "feature-dev:code-reviewer", description: "Code review", prompt: "Revise" }],
  ])("despacho que não é revisão (pesquisa, correção dos achados) ou já vai a um perfil especializado passa: %o", (input) => {
    expect(reviewRoutingDenial("Agent", input, SESSION_AGENTS)).toBeNull();
  });

  it("a skill code-review embutida, que roda num general-purpose, é trocada pelo perfil code-reviewer com os mesmos argumentos", () => {
    const denial = reviewRoutingDenial("Skill", { skill: "code-review", args: "high origin/dev...HEAD" }, SESSION_AGENTS);
    expect(denial).toContain(`subagent_type "${CODE_REVIEWER_AGENT_TYPE}"`);
    expect(denial).toMatch(/args/);
  });

  it("o próprio code-reviewer que chama a skill embutida é mandado revisar ali mesmo, sem despachar agente que ele não tem", () => {
    const denial = reviewRoutingDenial("Skill", { skill: "code-review" }, SESSION_AGENTS, CODE_REVIEWER_AGENT_TYPE);
    expect(denial).toMatch(/yourself/i);
    expect(denial).not.toMatch(/Dispatch the Agent tool/);
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
  it("não tem ferramenta de edição nem despacha outro agente", () => {
    expect(CODE_REVIEWER_AGENT.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit", "Agent"]));
  });

  it("toma o CLAUDE.md e o AGENTS.md do projeto como as regras da revisão", () => {
    expect(CODE_REVIEWER_AGENT.prompt).toMatch(/CLAUDE\.md/);
    expect(CODE_REVIEWER_AGENT.prompt).toMatch(/AGENTS\.md/);
  });

  it("o relatório diz o perfil e abre com a seção de aderência, e item sem evidência sai como não verificado", () => {
    expect(CODE_REVIEWER_AGENT.prompt).toContain("Perfil: code-reviewer");
    expect(CODE_REVIEWER_AGENT.prompt).toContain("## Aderência");
    expect(CODE_REVIEWER_AGENT.prompt).toMatch(/não verificado/);
  });
});
