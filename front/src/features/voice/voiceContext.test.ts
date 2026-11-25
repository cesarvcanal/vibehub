import { describe, expect, it } from "vitest";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { agentContext, peerMessages, typedContext } from "./voiceContext";

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

  it("a mensagem de outra pessoa é anunciada com o nome de quem escreveu", () => {
    expect(typedContext("olha a requisição", { author: "mussa" })).toBe(
      "Chegou uma mensagem de texto de mussa no chat: «olha a requisição». Ela foi para o agente do card",
    );
    expect(typedContext("/work/.uploads/c1/1-a.png", { author: "mussa" })).toContain("Chegou uma mensagem de mussa no chat");
  });

  it("a mensagem que espera na fila é anunciada como na fila, não como entregue ao agente", () => {
    expect(typedContext("olha a requisição", { author: "mussa", queued: true })).toBe(
      "Chegou uma mensagem de texto de mussa no chat: «olha a requisição». " +
        "Ela está na fila e vai para o agente do card quando ele terminar o que está fazendo",
    );
  });

  it("das mensagens do chat, contam as de outra pessoa e as da mesma conta vindas de outro dispositivo, cada uma com chave estável entre replays", () => {
    const rows: SdkRow[] = [
      { kind: "user", id: "u1", text: "desta aba", state: "sent", from: { kind: "owner", name: "albert" }, at: 1 },
      { kind: "user", id: "u2", text: "do mussa", state: "sent", from: { kind: "user", name: "mussa" }, at: 2 },
      { kind: "user", id: "u3", text: "de outro card", state: "sent", from: { kind: "agent", name: "Card X" }, at: 3 },
      { kind: "user", id: "u4", text: "sem autor", state: "sent", at: 4 },
      { kind: "user", id: "u5", text: "do celular", state: "sent", from: { kind: "owner", name: "albert" }, at: 5 },
    ];
    expect(peerMessages(rows, "albert", new Map([["desta aba", 1]]))).toEqual([
      { key: "2\u0000do mussa", text: "do mussa", author: "mussa" },
      { key: "5\u0000do celular", text: "do celular", author: "albert" },
    ]);
  });

  it("the agent's answer is flattened onto one line", () => {
    expect(agentContext("Feito.\n\n- 3 testes")).toBe("O agente do card respondeu no chat: «Feito. - 3 testes»");
  });
});
