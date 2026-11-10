import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLanguage, setLanguage } from "@/i18n";
import { compactionSummary, compactionElapsed } from "./compaction";

describe("compactionSummary — o que a linha de compactação diz", () => {
  beforeEach(() => setLanguage("pt-BR"));
  afterEach(() => resetLanguage());

  it("terminada, com tudo: título, antes → depois, quanto liberou e quanto levou", () => {
    expect(compactionSummary({ status: "done", trigger: "manual", preTokens: 180_000, postTokens: 22_000, durationMs: 14_000 })).toEqual({
      title: "Conversa compactada",
      parts: ["180 mil → 22 mil tokens", "−88%", "14,0 s"],
    });
  });

  it("automática e só com o antes (o CLI nem sempre manda o depois)", () => {
    expect(compactionSummary({ status: "done", trigger: "auto", preTokens: 190_000 })).toEqual({
      title: "Conversa compactada automaticamente",
      parts: ["190 mil tokens resumidos"],
    });
  });

  it("rodando: o título diz se foi pedida ou automática", () => {
    expect(compactionSummary({ status: "running", trigger: "manual" }).title).toBe("Compactando a conversa…");
    expect(compactionSummary({ status: "running" }).title).toBe("Compactando a conversa…");
    expect(compactionSummary({ status: "running", trigger: "auto" }).title).toBe("Compactação automática — a janela de contexto encheu");
  });

  it("falhou: o motivo do CLI, ou 'interrompida' quando não há motivo", () => {
    expect(compactionSummary({ status: "failed", error: "Not enough messages to compact." })).toEqual({
      title: "Compactação não concluída",
      parts: ["Not enough messages to compact."],
    });
    expect(compactionSummary({ status: "failed", error: "interrompida" }).parts).toEqual(["interrompida antes de terminar"]);
    expect(compactionSummary({ status: "failed" }).parts).toEqual(["interrompida antes de terminar"]);
  });

  it("um 'depois' maior que o 'antes' não vira economia negativa", () => {
    expect(compactionSummary({ status: "done", preTokens: 10_000, postTokens: 12_000 }).parts).toEqual(["10 mil → 12 mil tokens"]);
  });
});

describe("compactionElapsed — o relógio da barra", () => {
  it("m:ss desde o início, nunca negativo", () => {
    expect(compactionElapsed(1_000, 1_000)).toBe("0:00");
    expect(compactionElapsed(1_000, 13_500)).toBe("0:12");
    expect(compactionElapsed(0, 125_000)).toBe("2:05");
    expect(compactionElapsed(5_000, 1_000)).toBe("0:00");
  });
});
