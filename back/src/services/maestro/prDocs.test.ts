import { describe, it, expect } from "vitest";
import { missingPrSections, PR_SECTIONS } from "./prDocs.js";

/** A body with every section the standard asks for, as an agent following the tool would write it. */
const BODY = [
  "## Contexto", "O deliver abre PRs para os cards.",
  "## Problema identificado", "O corpo saía do --fill: só a lista de commits.",
  "## Objetivo", "Todo PR aberto pelo vibehub chega documentado.",
  "## Solução implementada", "O deliver recebe título, corpo e comentários.",
  "## Detalhamento técnico", "prDocs.ts valida; deliver.ts publica.",
  "## Comportamento esperado", "PR novo sem documentação não abre.",
  "## Impactos", "Quem entrega por outro card precisa pedir a ele.",
  "## Testes e validações", "Executado: vitest de prDocs e deliver.",
  "## Pontos de atenção", "A linha do comentário precisa estar no diff.",
].join("\n\n");

/** A comment that explains its block — long enough to say what, why and how. */
const EXPLAINED =
  "Este trecho troca o --fill pelo título e corpo que a IA escreveu: sem isso o PR saía só com a lista " +
  "de commits, e o revisor não tinha contexto nenhum do porquê da mudança.";

const COMMENT = { path: "back/src/x.ts", line: 10, body: EXPLAINED };

describe("missingPrSections — the description has every section of the standard", () => {
  it("a body with all the sections misses nothing", () => {
    expect(missingPrSections(BODY)).toEqual([]);
  });

  it("names exactly the sections that are not there", () => {
    const body = BODY.replace("## Impactos", "Impactos (sem heading)").replace("## Pontos de atenção", "");
    expect(missingPrSections(body)).toEqual(["Impactos", "Pontos de atenção"]);
  });

  it("accepts any heading level, numbering, bold, accents or their absence, and English headings", () => {
    const body = [
      "# 1. Contexto", "### **Problema**", "## Objetivo:", "## Solucao", "## Technical details",
      "## Expected behavior", "## Impact", "## Tests", "## Pontos de atencao",
    ].join("\n");
    expect(missingPrSections(body)).toEqual([]);
  });

  it("a section named only in a paragraph does not count: it has to be a heading", () => {
    const flat = PR_SECTIONS.map((s) => `${s.label}: algo`).join("\n");
    expect(missingPrSections(flat)).toEqual(PR_SECTIONS.map((s) => s.label));
  });

  it("an empty body misses everything", () => {
    expect(missingPrSections("")).toHaveLength(PR_SECTIONS.length);
  });
});

