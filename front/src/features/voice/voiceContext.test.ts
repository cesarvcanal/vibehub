import { describe, expect, it } from "vitest";
import { agentContext, typedContext } from "./voiceContext";

describe("what the voice is told about the chat", () => {
  it("a typed message is announced as a text that arrived in the chat, in quotes, for the agent", () => {
    expect(typedContext("roda os testes")).toBe("Chegou uma mensagem de texto no chat: «roda os testes». Ela foi para o agente do card");
  });

  it("attachments are counted, never described — the voice cannot see them", () => {
    const one = typedContext("olha isso /work/.uploads/c1/123-print.png")!;
    expect(one).toContain("«olha isso»");
    expect(one).toContain("Veio com 1 imagem");
    expect(one).not.toContain("uploads");
    expect(typedContext("/work/.uploads/c1/1-a.png /work/.uploads/c1/2-b.png")).toContain("Veio com 2 imagens");
    expect(typedContext("   ")).toBeNull();
  });

  it("the agent's answer is flattened onto one line", () => {
    expect(agentContext("Feito.\n\n- 3 testes")).toBe("O agente do card respondeu no chat: «Feito. - 3 testes»");
  });
});
