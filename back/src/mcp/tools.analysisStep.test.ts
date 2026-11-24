import { describe, it, expect } from "vitest";
import { analysisStepInput } from "./tools.js";

const FIX_SHA = "d".repeat(40);

describe("entrada da vibehub_analysis_step", () => {
  it.each([
    ["achado em correção", { card: "c1", kind: "fixing", findingId: "f1" }, { kind: "fixing", findingId: "f1" }],
    ["achado corrigido com o commit", { card: "c1", kind: "fixed", findingId: "f1", commit: FIX_SHA }, { kind: "fixed", findingId: "f1", commit: FIX_SHA }],
    ["reconferência limpa", { card: "c1", kind: "recheck", outcome: "clean" }, { kind: "recheck", outcome: "clean" }],
    ["reconferência que achou algo, com a nota", { card: "c1", kind: "recheck", outcome: "found", note: "teste quebrou" },
      { kind: "recheck", outcome: "found", note: "teste quebrou" }],
  ])("%s vira o passo que o servidor grava", (_case, raw, step) => {
    expect(analysisStepInput.parse(raw)).toEqual({ card: "c1", step });
  });

  it.each([
    ["fixing sem o achado", { card: "c1", kind: "fixing" }, "fixing and fixed need the findingId"],
    ["fixed sem o commit", { card: "c1", kind: "fixed", findingId: "f1" }, "fixed needs the sha of the commit that fixed the finding"],
    ["fixed com commit que não é sha", { card: "c1", kind: "fixed", findingId: "f1", commit: "HEAD" }, "fixed needs the sha of the commit that fixed the finding"],
    ["recheck sem o resultado", { card: "c1", kind: "recheck" }, "recheck needs the outcome: clean or found"],
  ])("%s é recusado com a mensagem do que falta", (_case, raw, message) => {
    const parsed = analysisStepInput.safeParse(raw);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(message);
  });
});
