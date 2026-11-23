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
  it("com a ordem de merge, mergeia e conclui o card à mão, porque sem revisão o concludeWhenMerged não registra nada", () => {
    const mergeStep = buildInvestigationBrief(FAILURE).split("\n").find((line) => line.startsWith("4.")) ?? "";
    expect(mergeStep).toContain("`authorized: true`");
    expect(mergeStep).not.toContain("concludeWhenMerged");
    expect(mergeStep).toContain("vibehub_move_cards");
  });

  it("leva o relato, rotula a hipótese e manda confirmar antes de corrigir e esperar a ordem de merge", () => {
    const brief = buildInvestigationBrief(FAILURE);
    for (const expectedPart of [
      "deliver diz merged sem PR", "vibehub_deliver", "resposta: { merged: true, prUrl: null }",
      "chamar vibehub_deliver com authorized", "Hipótese (não confirmada): o gate não confere o PR", "2 ocorrência",
      "Confirme se é bug", "TDD", "sem `authorized`", "Nunca mergeie por conta própria", "repositório é público",
    ]) expect(brief).toContain(expectedPart);
  });

  it("leva o que a pessoa viu, em linguagem leiga, quando o relato traz", () => {
    const brief = buildInvestigationBrief({ ...FAILURE, explanation: "A entrega disse que publicou, mas não abriu PR." });
    expect(brief).toContain("O que a pessoa viu: A entrega disse que publicou, mas não abriu PR.");
    expect(buildInvestigationBrief(FAILURE)).not.toContain("O que a pessoa viu");
  });

  it("leva a explicação automática da IA rotulada como não confirmada, quando ela existe", () => {
    const brief = buildInvestigationBrief({
      ...FAILURE,
      narrative: { context: "ctx-x", whatHappened: "aconteceu-x", cause: "causa-x", trigger: "person", triggerReason: "enviou agora" },
    });
    for (const expectedPart of ["Explicação automática (IA, não confirmada)", "ctx-x", "aconteceu-x", "causa-x", "Quem provocou: person (enviou agora)"]) {
      expect(brief).toContain(expectedPart);
    }
    expect(buildInvestigationBrief(FAILURE)).not.toContain("Explicação automática");
  });

  it("erro de tela avisa que sintoma e evidência vieram do navegador de um usuário", () => {
    const screenBrief = buildInvestigationBrief({ ...FAILURE, source: "screen_error", component: "front" });
    expect(screenBrief).toContain("vieram do navegador de um usuário");
    expect(buildInvestigationBrief(FAILURE)).not.toContain("vieram do navegador de um usuário");
  });

  it("não cita os cards de origem: o card de correção não lê nada além do relato", () => {
    expect(buildInvestigationBrief(FAILURE)).not.toMatch(/\bc1\b|\bc2\b/);
  });
});
