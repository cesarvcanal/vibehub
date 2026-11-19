import { describe, it, expect, afterEach } from "vitest";
import { resetLanguage, setLanguage, t } from "@/i18n";
import { explainFailure } from "./explainFailure";

afterEach(() => resetLanguage());

describe("texto leigo de uma falha", () => {
  it("usa a explicação que o agente escreveu", () => {
    expect(explainFailure({ source: "agent_report", explanation: "O medidor ficou na conta antiga." }, t)).toBe("O medidor ficou na conta antiga.");
  });

  it.each([
    ["backend_error", /erro interno/],
    ["slow_turn", /demorando mais que o normal/],
    ["agent_report", /não se comportou como deveria/],
  ] as const)("sem explicação, a origem %s tem texto leigo próprio", (source, expectedText) => {
    setLanguage("pt-BR");
    expect(explainFailure({ source }, t)).toMatch(expectedText);
  });
});
