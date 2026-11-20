import { describe, expect, it } from "vitest";
import { readAgentDeliverables } from "./agentDeliverables";

const PROMPT = [
  "Revise a branch atual contra o AGENTS.md.",
  "O diff: git diff origin/main...HEAD",
  "",
  "- [ ] Achados de violação de regra",
  "- [ ] Achados de cheiro",
  "- [ ] Veredito apto ou não apto",
].join("\n");

const REPORT = [
  "- [x] Achados de violação de regra",
  "- [ ] Achados de cheiro — não deu tempo",
  "- [x] Veredito apto ou não apto",
  "",
  "## Veredito: não apto",
].join("\n");

describe("readAgentDeliverables — as entregas do subagente saem do prompt e do relatório", () => {
  it("separa o contexto da lista de entregas do prompt", () => {
    const deliverables = readAgentDeliverables(PROMPT, "", true);
    expect(deliverables.context).toBe("Revise a branch atual contra o AGENTS.md.\nO diff: git diff origin/main...HEAD");
    expect(deliverables.items.map((item) => item.text)).toEqual([
      "Achados de violação de regra",
      "Achados de cheiro",
      "Veredito apto ou não apto",
    ]);
  });

  it("enquanto o subagente roda, toda entrega fica aberta", () => {
    expect(readAgentDeliverables(PROMPT, "", true).items.map((item) => item.state)).toEqual(["open", "open", "open"]);
  });

  it("no fim, a marca do relatório decide: [x] é feito e [ ] é não feito, mesmo com o motivo escrito no item", () => {
    expect(readAgentDeliverables(PROMPT, REPORT, false).items.map((item) => item.state)).toEqual(["done", "missed", "done"]);
  });

  it("casa pela posição quando o relatório reescreve o texto do item, desde que a lista tenha o mesmo tamanho", () => {
    const rewritten = "- [x] Violações\n- [x] Cheiros\n- [ ] Veredito";
    expect(readAgentDeliverables(PROMPT, rewritten, false).items.map((item) => item.state)).toEqual(["done", "done", "missed"]);
  });

  it("relatório sem a lista marcada deixa as entregas sem marcação, sem inventar feito ou não feito", () => {
    expect(readAgentDeliverables(PROMPT, "Terminei, tudo certo.", false).items.map((item) => item.state)).toEqual([
      "unmarked",
      "unmarked",
      "unmarked",
    ]);
  });

  it("aceita * no lugar de -, X maiúsculo e indentação", () => {
    const deliverables = readAgentDeliverables("  * [ ] Um\n* [ ] Dois", "* [X] Um\n  - [x] Dois", false);
    expect(deliverables.items.map((item) => item.state)).toEqual(["done", "done"]);
  });

  it("só a lista que abre o relatório marca as entregas; uma lista de próximos passos mais abaixo não atrapalha", () => {
    const reportWithNextSteps = `${REPORT}\n\n### Próximos passos\n\n- [ ] rodar o CI`;
    expect(readAgentDeliverables(PROMPT, reportWithNextSteps, false).items.map((item) => item.state)).toEqual(["done", "missed", "done"]);
  });

  it("item marcado com anotação depois do texto do prompt casa pelo começo do texto", () => {
    const annotated = "- [x] Achados de violação de regra: 2\n- [x] Veredito apto ou não apto: não apto";
    expect(readAgentDeliverables(PROMPT, annotated, false).items.map((item) => item.state)).toEqual(["done", "unmarked", "done"]);
  });

  it("lista dentro de bloco de código é exemplo, não entrega, e fica no contexto", () => {
    const promptWithExample = "Siga o modelo:\n```text\n- [ ] item do exemplo\n```\n\n- [ ] Entrega real";
    const deliverables = readAgentDeliverables(promptWithExample, "", true);
    expect(deliverables.items.map((item) => item.text)).toEqual(["Entrega real"]);
    expect(deliverables.context).toBe("Siga o modelo:\n```text\n- [ ] item do exemplo\n```");
  });

  it("prompt sem lista de tarefas: nenhuma entrega e o prompt inteiro é o contexto", () => {
    const deliverables = readAgentDeliverables("Leia o arquivo e resuma.\n- um ponto solto", "", false);
    expect(deliverables.items).toEqual([]);
    expect(deliverables.context).toBe("Leia o arquivo e resuma.\n- um ponto solto");
  });
});
