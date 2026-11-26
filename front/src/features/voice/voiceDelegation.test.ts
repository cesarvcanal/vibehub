import { describe, expect, it } from "vitest";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import type { VoiceTurn } from "./voiceTurns";
import {
  DELEGATION_FAILED,
  DELEGATION_INTERRUPTED,
  DELEGATION_NOT_SENT,
  DELEGATION_QUEUED,
  DELEGATION_RECOVERY_MS,
  DELEGATION_RESENT,
  DELEGATION_SLOW,
  DELEGATION_STARTED,
  DELEGATION_STOPPED,
  DELEGATION_TRANSCRIPT_MAX_CHARS,
  DELEGATION_UNDELIVERED,
  NO_RECOVERY,
  aboutRequestForVoice,
  delegationReply,
  delegationRetryRequest,
  agentAnswerForVoice,
  delegationRequest,
  nextRecoveryStep,
  parseVoiceRequest,
  type DelegationReply,
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

describe("parseVoiceRequest", () => {
  it("separa do pedido que o agente recebeu o pedido da pessoa e o contexto em volta", () => {
    const asked = "Faça uma revisão completa.\n\nNão altere código.";
    const request = delegationRequest(asked, [turn("user", "faz um review", 1), turn("assistant", "Tá, vou pedir", 2)]);
    const parsed = parseVoiceRequest(request);
    expect(parsed?.asked).toBe(asked);
    expect(parsed?.context).toContain("Pessoa: faz um review");
    expect(parsed?.context).toContain("Urgente");
    expect(parsed?.context).not.toContain(asked);
  });

  it.each([
    ["mensagem comum", "roda os testes"],
    ["só o marcador, sem pedido", "[pedido por voz]\n   "],
    ["marcador no meio do texto", "olha isso: [pedido por voz]\nroda"],
  ])("%s não é pedido por voz", (_case, text) => {
    expect(parseVoiceRequest(text)).toBeNull();
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
    ["DELEGATION_QUEUED", DELEGATION_QUEUED],
    ["DELEGATION_INTERRUPTED", DELEGATION_INTERRUPTED],
    ["DELEGATION_RESENT", DELEGATION_RESENT],
    ["DELEGATION_FAILED", DELEGATION_FAILED],
    ["DELEGATION_UNDELIVERED", DELEGATION_UNDELIVERED],
    ["DELEGATION_STOPPED", DELEGATION_STOPPED],
  ])("%s não manda a pessoa conferir, ver ou digitar no chat", (_name, text) => {
    expect(text).not.toMatch(/no chat/);
  });
});

describe("a voz nunca pergunta se a pessoa quer repetir um pedido que ela já fez", () => {
  it.each([
    ["DELEGATION_QUEUED", DELEGATION_QUEUED],
    ["DELEGATION_INTERRUPTED", DELEGATION_INTERRUPTED],
    ["DELEGATION_RESENT", DELEGATION_RESENT],
    ["DELEGATION_FAILED", DELEGATION_FAILED],
    ["DELEGATION_UNDELIVERED", DELEGATION_UNDELIVERED],
    ["DELEGATION_STOPPED", DELEGATION_STOPPED],
  ])("%s proíbe a pergunta e não oferece pedir de novo", (_name, text) => {
    expect(text).not.toMatch(/(?<!não )pergunte se ela quer/);
    expect(text).toContain("não pergunte se ela quer pedir de novo");
  });
});

describe("delegationRetryRequest — o reenvio automático de um pedido que ficou sem resposta", () => {
  const turns = [turn("user", "roda os testes do back", 1)];

  it("é o mesmo pedido por voz, com outras palavras: a âncora acha o reenvio e não o original", () => {
    const original = delegationRequest("Rode os testes do back.", turns);
    const retry = delegationRetryRequest("Rode os testes do back.", turns);
    expect(retry).not.toBe(original);
    expect(parseVoiceRequest(retry)?.asked).toBe("Rode os testes do back.");
  });

  it("manda o agente conferir o que já fez e não repetir ação concluída", () => {
    const retry = delegationRetryRequest("Crie o card de deploy.", turns);
    expect(retry).toContain("ficou sem resposta");
    expect(retry).toContain("confira o que já foi feito");
    expect(retry).toContain("não repita nenhuma ação que já foi concluída");
  });
});

describe("nextRecoveryStep — pedido sem resposta: esperar a retomada, reenviar uma vez, depois dizer a falha", () => {
  const answered: DelegationReply = { state: "answered", text: "12 verdes.", answers: ["12 verdes."] };
  const waiting: DelegationReply = { state: "waiting", answers: [] };
  const silent: DelegationReply = { state: "silent", answers: [] };
  const undelivered: DelegationReply = { state: "undelivered", answers: [] };

  it("resposta é resposta, em qualquer momento", () => {
    expect(nextRecoveryStep(answered, { ...NO_RECOVERY, stalledSince: 0, resent: true }, 10 * DELEGATION_RECOVERY_MS)).toEqual({ kind: "answered", text: "12 verdes." });
  });

  it("turno andando de novo zera o relógio da espera", () => {
    expect(nextRecoveryStep(waiting, { ...NO_RECOVERY, stalledSince: 5 }, 10)).toEqual({ kind: "wait", recovery: { ...NO_RECOVERY, stalledSince: null } });
  });

  it("o primeiro silêncio só começa a espera, e avisa a voz uma vez", () => {
    expect(nextRecoveryStep(silent, NO_RECOVERY, 1_000)).toEqual({ kind: "hold", recovery: { stalledSince: 1_000, resent: false, stallTold: true }, tell: true });
    const holding = { stalledSince: 1_000, resent: false, stallTold: true };
    expect(nextRecoveryStep(silent, holding, 1_000 + DELEGATION_RECOVERY_MS - 1)).toEqual({ kind: "hold", recovery: holding, tell: false });
  });

  it("silêncio por todo o prazo, sem reenvio ainda: reenvia e recomeça a espera, marcada como já reenviada", () => {
    expect(nextRecoveryStep(silent, { stalledSince: 0, resent: false, stallTold: true }, DELEGATION_RECOVERY_MS)).toEqual({
      kind: "resend",
      recovery: { stalledSince: null, resent: true, stallTold: true },
    });
  });

  it("silêncio por todo o prazo depois do reenvio: desiste com a falha dita, sem reenviar de novo", () => {
    expect(nextRecoveryStep(silent, { stalledSince: 0, resent: true, stallTold: true }, DELEGATION_RECOVERY_MS)).toEqual({ kind: "give_up", note: DELEGATION_FAILED });
  });

  it("pedido que não chegou ao agente nunca vira reenvio por cima do que o chat já tenta entregar", () => {
    expect(nextRecoveryStep(undelivered, NO_RECOVERY, 0)).toMatchObject({ kind: "hold" });
    expect(nextRecoveryStep(undelivered, { stalledSince: 0, resent: false, stallTold: true }, DELEGATION_RECOVERY_MS)).toEqual({ kind: "give_up", note: DELEGATION_UNDELIVERED });
  });

  it("o aviso de estado diz a que pedido se refere", () => {
    expect(aboutRequestForVoice("Rode os testes.", DELEGATION_FAILED)).toBe(`Sobre o pedido "Rode os testes.": ${DELEGATION_FAILED}`);
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

  it("o pedido que o servidor não confirmou é não entregue, não silêncio; o que ainda espera o recibo já conta a resposta", () => {
    const sending: SdkRow = { kind: "user", id: "u1", text: request, state: "sending" };
    const refused: SdkRow = { kind: "user", id: "u1", text: request, state: "undelivered" };
    expect(delegationReply([refused], { request }, false)).toEqual({ state: "undelivered", answers: [] });
    expect(delegationReply([sending, answer("a1", "12 verdes.")], { request }, false)).toMatchObject({ state: "answered", text: "12 verdes." });
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
