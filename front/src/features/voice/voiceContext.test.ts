import { describe, expect, it } from "vitest";
import { agentContext, typedContext } from "./voiceContext";

describe("what the voice is told about the chat", () => {
  it("a typed message goes in quotes, marked as the agent's", () => {
    expect(typedContext("roda os testes")).toBe("A pessoa escreveu no chat do card (isso vai para o agente do card, não para você): «roda os testes»");
  });

  it("attachments are counted, never described — the voice cannot see them", () => {
    const one = typedContext("olha isso /work/.uploads/c1/123-print.png")!;
    expect(one).toContain("«olha isso»");
    expect(one).toContain("Anexou 1 imagem");
    expect(one).not.toContain("uploads");
    expect(typedContext("/work/.uploads/c1/1-a.png /work/.uploads/c1/2-b.png")).toContain("Anexou 2 imagens");
    expect(typedContext("   ")).toBeNull();
  });

  it("the agent's answer is flattened onto one line", () => {
    expect(agentContext("Feito.\n\n- 3 testes")).toBe("O agente do card respondeu no chat: «Feito. - 3 testes»");
  });
});
