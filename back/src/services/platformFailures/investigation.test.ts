import { describe, it, expect } from "vitest";
import { buildInvestigationBrief } from "./investigation.js";
import type { PlatformFailure } from "./types.js";

const FAILURE: PlatformFailure = {
  id: "f1", signature: "s", source: "agent_report", status: "investigating", component: "vibehub_deliver",
  symptom: "deliver diz merged sem PR", evidence: "resposta: { merged: true, prUrl: null }",
  reproduction: "chamar vibehub_deliver com authorized", hypothesis: "o gate não confere o PR",
  occurrences: 2, affectedCardIds: ["c1", "c2"], firstSeenAt: 0, lastSeenAt: 0,
};

describe("brief do card de investigação", () => {
  it("leva o relato, rotula a hipótese e manda confirmar antes de corrigir e esperar a ordem de merge", () => {
    const brief = buildInvestigationBrief(FAILURE);
    for (const expectedPart of [
      "deliver diz merged sem PR", "vibehub_deliver", "resposta: { merged: true, prUrl: null }",
      "chamar vibehub_deliver com authorized", "Hipótese (não confirmada): o gate não confere o PR", "2 ocorrência",
      "Confirme se é bug", "TDD", "sem `authorized`", "Nunca mergeie por conta própria", "repositório é público",
    ]) expect(brief).toContain(expectedPart);
  });

  it("não cita os cards de origem: o card de correção não lê nada além do relato", () => {
    expect(buildInvestigationBrief(FAILURE)).not.toMatch(/\bc1\b|\bc2\b/);
  });
});
