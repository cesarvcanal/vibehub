import { describe, it, expect, afterEach } from "vitest";
import { resetLanguage, setLanguage, t } from "@/i18n";
import { explainFailure } from "./explainFailure";

afterEach(() => resetLanguage());

describe("texto leigo de uma falha", () => {
  it("usa a explicação que o agente escreveu", () => {
    expect(explainFailure({ source: "agent_report", explanation: "O medidor ficou na conta antiga." }, t)).toBe("O medidor ficou na conta antiga.");
  });

  it("com a explicação da IA, o título é o que aconteceu, no lugar do texto fixo da origem", () => {
    const narrative = { context: "c", whatHappened: "O GitHub recusou os comentários do PR.", cause: "x", trigger: "system" as const, triggerReason: "r" };
    expect(explainFailure({ source: "backend_error", details: { symptom: "s", component: "c", evidence: "e", narrative } }, t))
      .toBe("O GitHub recusou os comentários do PR.");
  });

  it.each([
    ["backend_error", /erro interno/],
    ["slow_turn", /demorando mais que o normal/],
    ["agent_report", /não se comportou como deveria/],
    ["screen_error", /tela do vibehub mostrou um erro/],
  ] as const)("sem explicação, a origem %s tem texto leigo próprio", (source, expectedText) => {
    setLanguage("pt-BR");
    expect(explainFailure({ source }, t)).toMatch(expectedText);
  });
});
