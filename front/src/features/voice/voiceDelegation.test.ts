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
  agentAnswerForVoice,
  delegationRequest,
} from "./voiceDelegation";

const turn = (role: VoiceTurn["role"], text: string, n: number): VoiceTurn => ({ vid: `vc-${role}${n}`, role, text, at: n, final: true });
const user = (id: string, text: string): SdkRow => ({ kind: "user", id, text, state: "sent" });
const answer = (id: string, text: string, extra: Partial<Extract<SdkRow, { kind: "assistant" }>> = {}): SdkRow => ({
  kind: "assistant", id, text, streaming: false, ...extra,
});

describe("delegationRequest", () => {
  it("leva ao agente o pedido escrito pelo backend da voz, com a chamada em volta", () => {
    const request = delegationRequest("Recapitule a conversa do card e liste as decisões pendentes.", [
      turn("user", "oi, tudo bem?", 1),
      turn("assistant", "Tudo, e você?", 2),
      turn("user", "recapitula tudo que tem no chat", 3),
      turn("assistant", "Claro, deixa eu recapitular rapidinho...", 4),
    ]);
    expect(request.startsWith("[pedido por voz]\nRecapitule a conversa do card e liste as decisões pendentes.\n")).toBe(true);
    expect(request).toContain("Pessoa: recapitula tudo que tem no chat");
    expect(request).toContain("Voz: Claro, deixa eu recapitular rapidinho...");
    expect(request.indexOf("oi, tudo bem?")).toBeLessThan(request.indexOf("Voz: Claro"));
  });

  it("guarda só o fim de uma chamada longa", () => {
    const long = Array.from({ length: 60 }, (_, i) => turn(i % 2 ? "assistant" : "user", `frase ${i} ${"x".repeat(80)}`, i));
    const request = delegationRequest("roda os testes", long);
    expect(request).toContain("frase 59");
    expect(request).not.toContain("frase 0 ");
    expect(request.length).toBeLessThan(DELEGATION_TRANSCRIPT_MAX_CHARS + 600);
  });
});

describe("o que o agente e a voz ouvem sobre um pedido urgente", () => {
  it("o pedido manda o agente parar o que está fazendo, atender primeiro e encerrar o turno com a resposta", () => {
    const request = delegationRequest("crie um card agora", [turn("user", "crie um card agora", 1)]);
    expect(request).toContain("Urgente");
    expect(request).toContain("pare o que está fazendo");
    expect(request).toContain("encerre o turno");
    expect(request).toContain("diga o que ficou interrompido");
  });

  it("o aviso de pedido entregue não deixa a voz dizer que já fez nem inventar o resultado", () => {
    expect(DELEGATION_STARTED).not.toContain("trabalhando nele");
    expect(DELEGATION_STARTED).toContain("ainda não foi feito");
    expect(DELEGATION_STARTED).toContain("não invente");
  });

  it("a resposta do agente chega à voz dizendo a que pedido responde", () => {
    const told = agentAnswerForVoice("Investigue por que o teste de login falha.", "O token expirou; renovei e passou.");
    expect(told).toContain("Investigue por que o teste de login falha.");
    expect(told).toContain("O token expirou; renovei e passou.");
    expect(agentAnswerForVoice("x".repeat(1_000), "ok").length).toBeLessThan(400);
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
    expect(delegationReply([], request, false)).toEqual({ state: "waiting", answers: [] });
    const rows = [user("u1", request), answer("a1", "Rodando…")];
    expect(delegationReply(rows, request, true)).toEqual({ state: "waiting", answers: ["Rodando…"] });
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
    expect(delegationReply(rows, request, false)).toEqual({ state: "answered", text: "12 testes verdes.", answers: ["Vou rodar.", "12 testes verdes."] });
  });

  it("a message that joins the running turn does not end it: the request waits for the turn's last word", () => {
    // The chat delivers a queued message at a breather of the running turn (turnHasRoomForMore).
    const rows = [user("u1", request), answer("a1", "Vou rodar os testes."), user("u2", "e depois commita"), answer("a2", "Rodando…")];
    expect(delegationReply(rows, request, true)).toEqual({ state: "waiting", answers: ["Vou rodar os testes.", "Rodando…"] });
    const over = [...rows, answer("a3", "12 verdes e commitado.")];
    expect(delegationReply(over, request, false)).toMatchObject({ state: "answered", text: "12 verdes e commitado." });
  });

  it("a turn that ends with nothing said is told as such", () => {
    expect(delegationReply([user("u1", request)], request, false)).toEqual({ state: "silent", answers: [] });
  });
});
