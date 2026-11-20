import { describe, expect, it } from "vitest";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import type { VoiceTurn } from "./voiceTurns";
import {
  DELEGATION_NOT_SENT,
  DELEGATION_SILENT,
  DELEGATION_SLOW,
  DELEGATION_STARTED,
  DELEGATION_TRANSCRIPT_MAX_CHARS,
  delegationReply,
  delegationRequest,
} from "./voiceDelegation";

const turn = (role: VoiceTurn["role"], text: string, n: number): VoiceTurn => ({ vid: `vc-${role}${n}`, role, text, at: n, final: true });
const user = (id: string, text: string): SdkRow => ({ kind: "user", id, text, state: "sent" });
const answer = (id: string, text: string, extra: Partial<Extract<SdkRow, { kind: "assistant" }>> = {}): SdkRow => ({
  kind: "assistant", id, text, streaming: false, ...extra,
});

describe("delegationRequest", () => {
  it("asks the agent what the person said last, with the call around it", () => {
    const request = delegationRequest([
      turn("user", "oi, tudo bem?", 1),
      turn("assistant", "Tudo, e você?", 2),
      turn("user", "recapitula tudo que tem no chat", 3),
      turn("assistant", "Claro, deixa eu recapitular rapidinho...", 4),
    ])!;
    expect(request.startsWith("[pedido por voz]\nrecapitula tudo que tem no chat\n")).toBe(true);
    expect(request).toContain("Pessoa: oi, tudo bem?");
    expect(request).toContain("Voz: Claro, deixa eu recapitular rapidinho...");
    expect(request.indexOf("oi, tudo bem?")).toBeLessThan(request.indexOf("Voz: Claro"));
  });

  it("keeps the newest of a long call, and nothing when the person said nothing", () => {
    const long = Array.from({ length: 60 }, (_, i) => turn(i % 2 ? "assistant" : "user", `frase ${i} ${"x".repeat(80)}`, i));
    const request = delegationRequest(long)!;
    expect(request).toContain("frase 59");
    expect(request).not.toContain("frase 0 ");
    expect(request.length).toBeLessThan(DELEGATION_TRANSCRIPT_MAX_CHARS + 600);
    expect(delegationRequest([turn("assistant", "Olá!", 1)])).toBeNull();
    expect(delegationRequest([turn("user", "   ", 1)])).toBeNull();
  });
});

describe("o que o agente e a voz ouvem sobre um pedido urgente", () => {
  it("o pedido manda o agente parar o que está fazendo, atender primeiro e encerrar o turno com a resposta", () => {
    const request = delegationRequest([turn("user", "crie um card agora", 1)])!;
    expect(request).toContain("Urgente");
    expect(request).toContain("pare o que está fazendo");
    expect(request).toContain("encerre o turno");
    expect(request).toContain("diga o que ficou interrompido");
  });

  it("o aviso de pedido entregue não deixa a voz dizer que já fez nem narrar outra coisa enquanto espera", () => {
    expect(DELEGATION_STARTED).not.toContain("trabalhando nele");
    expect(DELEGATION_STARTED).toContain("ainda não foi feito");
    expect(DELEGATION_STARTED).toContain("não narre");
  });
});

describe("a voz nunca manda a pessoa ao chat", () => {
  it.each([
    ["DELEGATION_STARTED", DELEGATION_STARTED],
    ["DELEGATION_SLOW", DELEGATION_SLOW],
    ["DELEGATION_NOT_SENT", DELEGATION_NOT_SENT],
    ["DELEGATION_SILENT", DELEGATION_SILENT],
  ])("%s não manda a pessoa conferir, ver ou digitar no chat", (_name, text) => {
    expect(text).not.toMatch(/no chat/);
  });
});

describe("delegationReply", () => {
  const request = "[pedido por voz]\nroda os testes";

  it("waits until the request is in the chat and the agent's turn on it is over", () => {
    expect(delegationReply([], { request }, false)).toEqual({ state: "waiting", answers: [] });
    const rows = [user("u1", request), answer("a1", "Rodando…")];
    expect(delegationReply(rows, { request }, true)).toEqual({ state: "waiting", answers: ["Rodando…"] });
  });

  it("answers with the agent's LAST word on it — not a subagent's, not one still streaming", () => {
    const rows = [
      user("u0", "mensagem antiga"),
      answer("a0", "resposta antiga"),
      user("u1", request),
      answer("a1", "Vou rodar."),
      answer("s1", "subagente falando", { parent: "tool_1" }),
      answer("a2", "12 testes verdes."),
      answer("a3", "e mais", { streaming: true }),
    ];
    expect(delegationReply(rows, { request }, false)).toEqual({ state: "answered", text: "12 testes verdes.", answers: ["Vou rodar.", "12 testes verdes."] });
  });

  it("a message that joins the running turn does not end it: the request waits for the turn's last word", () => {
    // The chat delivers a queued message at a breather of the running turn (turnHasRoomForMore).
    const rows = [user("u1", request), answer("a1", "Vou rodar os testes."), user("u2", "e depois commita"), answer("a2", "Rodando…")];
    expect(delegationReply(rows, { request }, true)).toEqual({ state: "waiting", answers: ["Vou rodar os testes.", "Rodando…"] });
    const over = [...rows, answer("a3", "12 verdes e commitado.")];
    expect(delegationReply(over, { request }, false)).toMatchObject({ state: "answered", text: "12 verdes e commitado." });
  });

  it("a turn that ends with nothing said is told as such", () => {
    expect(delegationReply([user("u1", request)], { request }, false)).toEqual({ state: "silent", answers: [] });
  });

  it("uma escolha dada por voz a uma pergunta do agente conta a partir da pergunta, não de uma mensagem", () => {
    const rows: SdkRow[] = [
      user("u1", "organiza as metas"),
      answer("a0", "Vou perguntar onde guardar."),
      { kind: "question", id: "q_1", questions: [{ question: "Onde?", options: [{ label: "Planilha" }] }], outcome: "answered" },
      answer("a1", "Feito na planilha."),
    ];
    expect(delegationReply(rows, { questionId: "q_1" }, true)).toEqual({ state: "waiting", answers: ["Feito na planilha."] });
    expect(delegationReply(rows, { questionId: "q_1" }, false)).toEqual({ state: "answered", text: "Feito na planilha.", answers: ["Feito na planilha."] });
    expect(delegationReply(rows, { questionId: "q_2" }, false)).toEqual({ state: "waiting", answers: [] });
  });
});
