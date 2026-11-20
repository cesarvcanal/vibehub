import { describe, expect, it } from "vitest";
import { cardInstructions } from "./live.js";

describe("cardInstructions — o que a voz do card é mandada fazer", () => {
  const instructions = cardInstructions("");

  it("pergunta da pessoa vem antes de qualquer novidade do agente, e o que depende dele é delegado na hora", () => {
    expect(instructions).toContain("Pergunta da pessoa é urgente");
    expect(instructions).toContain("- A pessoa pergunta sobre o que o agente está fazendo, por que fez ou vai fazer algo.");
  });

  it("a voz não confirma uma ação sem tê-la delegado, nem diz que fez antes do resultado", () => {
    expect(instructions).toContain("Nunca diga que vai fazer ou que está fazendo algo sem gerar <|SpawnThinking|>");
    expect(instructions).toContain("Só diga que algo foi feito quando o resultado da tarefa disser");
  });

  it("a voz nunca manda a pessoa conferir o chat: ela conta, inclusive as perguntas com opções do agente", () => {
    expect(instructions).toContain("Nunca mande a pessoa conferir ou ler o chat");
  });

  it("a voz guarda as perguntas e ordens pendentes da chamada e não deixa nenhuma cair", () => {
    expect(instructions).toContain("Guarde as perguntas e ordens da pessoa que ainda não tiveram resultado");
  });
});
