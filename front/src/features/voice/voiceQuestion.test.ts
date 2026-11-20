import { describe, expect, it } from "vitest";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import type { VoiceTurn } from "./voiceTurns";
import { CONTEXT_MAX_CHARS } from "./liveVoice";
import { openQuestion, questionForVoice, voiceAnswers } from "./voiceQuestion";

const turn = (role: VoiceTurn["role"], text: string, n: number): VoiceTurn => ({ vid: `vc-${role}${n}`, role, text, at: n, final: true });
const question = (id: string, outcome: "pending" | "answered"): SdkRow => ({
  kind: "question",
  id,
  questions: [{ question: `Pergunta ${id}?`, options: [{ label: "A" }] }],
  outcome,
});

describe("openQuestion", () => {
  it("é a pergunta do agente que ainda espera a pessoa, a mais nova", () => {
    expect(openQuestion([])).toBeNull();
    expect(openQuestion([question("q_1", "answered")])).toBeNull();
    expect(openQuestion([question("q_1", "pending"), question("q_2", "answered")])?.id).toBe("q_1");
  });
});

describe("questionForVoice", () => {
  it("traz cada pergunta com as opções numeradas, as descrições, a recomendada e como responder", () => {
    const text = questionForVoice([
      {
        question: "Onde guardo as metas?",
        options: [{ label: "Planilha (Recomendado)", description: "Rápido" }, { label: "Banco novo" }],
      },
      { question: "Quais filiais?", options: [{ label: "CD" }, { label: "Loja 1" }], multiSelect: true },
    ]);
    expect(text).toContain("«Onde guardo as metas?» Escolha uma opção. Opções: 1) Planilha (Recomendado) — Rápido; 2) Banco novo.");
    expect(text).toContain("«Quais filiais?» Pode escolher mais de uma opção. Opções: 1) CD; 2) Loja 1.");
    expect(text).toContain("diga qual é a recomendada");
    expect(text).not.toMatch(/no chat/);
  });

  it("uma pergunta grande demais para o limite da voz perde as descrições, nunca as opções nem o pedido de escolha", () => {
    const option = (label: string) => ({ label, description: "d".repeat(150) });
    const text = questionForVoice([
      { question: "Primeira?", options: [option("A1"), option("A2"), option("A3"), option("A4")] },
      { question: "Segunda?", options: [option("B1"), option("B2"), option("B3"), option("B4 (Recomendado)")] },
    ]);
    expect(text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(text).toContain("4) B4 (Recomendado).");
    expect(text).toContain("passe a escolha ao agente");
    expect(text).not.toContain("ddd");
  });
});

describe("voiceAnswers", () => {
  const questions = [
    { question: "Onde?", options: [{ label: "Planilha" }, { label: "Banco novo" }] },
    { question: "Quando?", options: [{ label: "Hoje" }] },
  ];

  it("a primeira pergunta leva o que a pessoa disse, o que a voz tinha acabado de dizer e a saída para um pedido novo; as outras, só a fala", () => {
    const answers = voiceAnswers(questions, [
      turn("user", "oi", 1),
      turn("assistant", "Fica com o banco novo, então?", 2),
      turn("user", "isso,   pode ser", 3),
    ])!;
    expect(answers).toHaveLength(2);
    const [first, second] = answers.map((answer) => answer.selected);
    expect(first).toEqual([
      "[resposta por voz] isso, pode ser\n\nA voz tinha acabado de dizer: «Fica com o banco novo, então?»\n\n" +
        "Se a fala não escolhe uma das opções, é um pedido novo da pessoa: atenda-o.",
    ]);
    expect(second).toEqual(["[resposta por voz] isso, pode ser"]);
  });

  it("sem fala da voz antes, a resposta não inventa uma; sem fala da pessoa, não há resposta", () => {
    expect(voiceAnswers(questions.slice(0, 1), [turn("user", "a planilha", 1)])![0]!.selected[0]).not.toContain("A voz tinha");
    expect(voiceAnswers(questions, [turn("assistant", "Oi", 1)])).toBeNull();
  });
});
