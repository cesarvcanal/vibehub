import { describe, expect, it, onTestFinished, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { LiveVoiceSession, type LiveVoiceSnapshot, type ToolCallListener } from "./liveVoice";
import { useVoiceDelegation, type AgentDelivery, type UseVoiceDelegationOptions } from "./useVoiceDelegation";
import { QUESTION_ANSWER_SENT } from "./voiceQuestion";
import {
  ASK_WITHOUT_REQUEST,
  DELEGATION_FAILED,
  DELEGATION_INTERRUPTED,
  DELEGATION_NOT_SENT,
  DELEGATION_QUEUED,
  DELEGATION_RECOVERY_MS,
  DELEGATION_SLOW,
  DELEGATION_SLOW_MS,
  DELEGATION_STARTED,
  DELEGATION_STOPPED,
  DELEGATION_UNDELIVERED,
  aboutRequestForVoice,
} from "./voiceDelegation";
import type { VoiceTurn } from "./voiceTurns";

const said = (text: string): VoiceTurn[] => [{ vid: "vc-u1", role: "user", text, at: 1, final: true }];

function setup(options: Partial<Pick<UseVoiceDelegationOptions, "deliverToAgent" | "runAction" | "answerQuestion">> = {}) {
  const listeners: ToolCallListener[] = [];
  const call = {
    snap: { ...LiveVoiceSession.idleSnapshot, state: "live" } as LiveVoiceSnapshot,
    onToolCall: (listener: ToolCallListener) => {
      listeners.push(listener);
      return () => true;
    },
    answerToolCall: vi.fn<(callId: string, output: unknown) => boolean>(() => true),
    appendContext: vi.fn<(text: string) => boolean>(() => true),
    announceContext: vi.fn<(text: string) => boolean>(() => true),
  };
  const deliverToAgent = options.deliverToAgent ?? vi.fn((): AgentDelivery => "sent");
  const runAction = options.runAction ?? vi.fn(async () => ({ ok: true }));
  const answerQuestion = options.answerQuestion ?? vi.fn(() => true);
  const view = renderHook((props: Partial<UseVoiceDelegationOptions>) =>
    useVoiceDelegation({ call, rows: [], agentTurn: "idle", deliverToAgent, runAction, answerQuestion, ...props }),
  );
  const toolCall = (callId: string, name: string, args: unknown, turns: VoiceTurn[] = said("pedido")) =>
    act(() => listeners.at(-1)!({ callId, name, argumentsJson: JSON.stringify(args), turns }));
  const ask = (callId: string, request: string) => toolCall(callId, "ask_card_agent", { request });
  return { call, view, toolCall, ask, deliverToAgent, runAction, answerQuestion };
}

function sentRequest(send: unknown): string {
  return (send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
}

describe("useVoiceDelegation — ordens do board", () => {
  it("ordem do backend vai à rota e o resultado volta como saída da função", async () => {
    const runAction = vi.fn(async () => ({ cardId: "c9", title: "Relatório" }));
    const { call, toolCall, deliverToAgent } = setup({ runAction });
    toolCall("call_1", "create_card", { projectId: "p1", title: "Relatório" });
    expect(runAction).toHaveBeenCalledWith({ callId: "call_1", name: "create_card", arguments: '{"projectId":"p1","title":"Relatório"}' });
    await waitFor(() => expect(call.answerToolCall).toHaveBeenCalledWith("call_1", { cardId: "c9", title: "Relatório" }));
    expect(deliverToAgent).not.toHaveBeenCalled();
  });

  it("falha da rota volta como erro na saída da função, nunca fica sem resposta", async () => {
    const refusal = Object.assign(new Error("Request failed"), { response: { data: { error: "project not found" } } });
    const { call, toolCall } = setup({ runAction: vi.fn(async () => Promise.reject(refusal)) });
    toolCall("call_2", "create_card", { projectId: "inventado", title: "x" });
    await waitFor(() => expect(call.answerToolCall).toHaveBeenCalledWith("call_2", { error: "project not found" }));
  });
});

describe("useVoiceDelegation — pergunta ao agente do card", () => {
  it("ask_card_agent manda ao agente o pedido escrito pelo backend, com a transcrição, e responde que foi entregue", () => {
    const { call, toolCall, deliverToAgent } = setup();
    toolCall("call_3", "ask_card_agent", { request: "Investigue por que o teste de login falha." }, said("por que o login falha?"));
    const request = sentRequest(deliverToAgent);
    expect(request.startsWith("[pedido por voz]\nInvestigue por que o teste de login falha.")).toBe(true);
    expect(request).toContain("Pessoa: por que o login falha?");
    expect(call.answerToolCall.mock.calls).toEqual([["call_3", { ok: true, status: DELEGATION_STARTED }]]);
  });

  it("a resposta do agente é falada por commentary sem delegation_id, dizendo a que pedido responde", () => {
    const { call, view, ask, deliverToAgent } = setup();
    ask("call_4", "Rode os testes do back.");
    const rows: SdkRow[] = [
      { kind: "user", id: "u1", text: sentRequest(deliverToAgent), state: "sent" },
      { kind: "assistant", id: "a1", text: "12 verdes.", streaming: false },
    ];
    view.rerender({ rows });
    expect(call.announceContext).toHaveBeenCalledTimes(1);
    const told = call.announceContext.mock.calls[0]![0] as string;
    expect(told).toContain("Rode os testes do back.");
    expect(told).toContain("12 verdes.");
    expect(call.appendContext).not.toHaveBeenCalledWith(expect.stringContaining("12 verdes."));
  });

  it("pedido com a conexão caída fica guardado: a voz ouve que ele vai sozinho, e a resposta chega quando o pedido entra", () => {
    const { call, view, ask, deliverToAgent } = setup({ deliverToAgent: vi.fn((): AgentDelivery => "queued") });
    ask("call_6", "Rode os testes.");
    expect(call.answerToolCall.mock.calls).toEqual([["call_6", { ok: true, status: DELEGATION_QUEUED }]]);
    view.rerender({ rows: [], agentTurn: "idle" });
    expect(call.announceContext).not.toHaveBeenCalled();
    expect(call.appendContext).not.toHaveBeenCalledWith(expect.stringContaining(DELEGATION_INTERRUPTED));
    const request = sentRequest(deliverToAgent);
    view.rerender({ rows: [{ kind: "user", id: "u1", text: request, state: "sent" }, { kind: "assistant", id: "a1", text: "12 verdes.", streaming: false }] });
    expect(call.announceContext).toHaveBeenCalledWith(expect.stringContaining("12 verdes."));
  });

  it("ask_card_agent sem pedido devolve erro e não manda nada ao agente", () => {
    const { call, toolCall, deliverToAgent } = setup();
    toolCall("call_7", "ask_card_agent", { request: "   " });
    expect(deliverToAgent).not.toHaveBeenCalled();
    expect(call.answerToolCall).toHaveBeenCalledWith("call_7", { error: expect.any(String) });
  });

  it("resposta do agente depois do fim da chamada não envia nada", () => {
    const { call, view, ask, deliverToAgent } = setup();
    ask("call_8", "Recapitule a conversa.");
    const request = sentRequest(deliverToAgent);
    call.snap = { ...call.snap, state: "idle" };
    view.rerender({});
    call.snap = { ...call.snap, state: "live" };
    view.rerender({ rows: [{ kind: "user", id: "u1", text: request, state: "sent" }, { kind: "assistant", id: "a1", text: "Resumo pronto.", streaming: false }] });
    expect(call.announceContext).not.toHaveBeenCalled();
  });

  it("pedido sem resultado depois do prazo: a voz fica sabendo, uma vez, que o agente ainda não terminou", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { call, ask } = setup();
    ask("call_9", "Rode os testes.");
    act(() => vi.advanceTimersByTime(DELEGATION_SLOW_MS - 1));
    expect(call.appendContext).not.toHaveBeenCalledWith(DELEGATION_SLOW);
    act(() => vi.advanceTimersByTime(DELEGATION_SLOW_MS * 3));
    expect(call.appendContext.mock.calls.filter(([text]) => text === DELEGATION_SLOW)).toHaveLength(1);
  });

  it("desmontar o chat ou terminar a chamada com um pedido pendente cancela o aviso de demora", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const first = setup();
    first.ask("call_10", "Rode os testes.");
    first.view.unmount();
    const second = setup();
    second.ask("call_11", "Rode os testes.");
    second.call.snap = { ...second.call.snap, state: "idle" };
    second.view.rerender({});
    act(() => vi.advanceTimersByTime(DELEGATION_SLOW_MS * 2));
    expect(first.call.appendContext).not.toHaveBeenCalledWith(DELEGATION_SLOW);
    expect(second.call.appendContext).not.toHaveBeenCalledWith(DELEGATION_SLOW);
  });
});

describe("useVoiceDelegation — pedido que ficou sem resposta (interrupção, deploy, queda)", () => {
  function stalled(options: Parameters<typeof setup>[0] = {}) {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const harness = setup(options);
    harness.ask("call_r", "Rode os testes do back.");
    const request = sentRequest(harness.deliverToAgent);
    const requestRow: SdkRow = { kind: "user", id: "u1", text: request, state: "sent" };
    harness.view.rerender({ rows: [requestRow], agentTurn: "idle" });
    return { ...harness, request, requestRow };
  }
  const deliveredTexts = (deliver: unknown) => (deliver as ReturnType<typeof vi.fn>).mock.calls.map(([text]) => text as string);

  it("turno que acabou sem texto não vira pergunta: a voz só fica sabendo que o painel retoma, e o pedido segue esperando", () => {
    const { call } = stalled();
    expect(call.announceContext).not.toHaveBeenCalled();
    expect(call.appendContext).toHaveBeenCalledWith(aboutRequestForVoice("Rode os testes do back.", DELEGATION_INTERRUPTED));
  });

  it("a retomada do painel traz a resposta, falada uma vez, mesmo com o turno retomado passando do prazo", () => {
    const { call, view, requestRow, deliverToAgent } = stalled();
    view.rerender({ rows: [requestRow, { kind: "note", id: "n1", text: "retomando…" }], agentTurn: "running" });
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS * 2));
    view.rerender({ rows: [requestRow, { kind: "note", id: "n1", text: "retomando…" }, { kind: "assistant", id: "a1", text: "12 verdes.", streaming: false }], agentTurn: "idle" });
    expect(deliveredTexts(deliverToAgent)).toHaveLength(1);
    expect(call.announceContext.mock.calls).toEqual([[expect.stringContaining("12 verdes.")]]);
  });

  it("sem retomada no prazo, a voz diz a falha uma vez, sem pergunta, e nada vai de novo ao agente", () => {
    const { call, deliverToAgent } = stalled();
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS - 1));
    expect(call.announceContext).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS * 3));
    expect(deliveredTexts(deliverToAgent)).toHaveLength(1);
    expect(call.announceContext.mock.calls).toEqual([[aboutRequestForVoice("Rode os testes do back.", DELEGATION_FAILED)]]);
  });

  it("resposta que chega depois da falha dita ainda é falada à pessoa, como resposta ao pedido", () => {
    const { call, view, requestRow } = stalled();
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS));
    view.rerender({ rows: [requestRow], agentTurn: "running" });
    view.rerender({ rows: [requestRow, { kind: "assistant", id: "a1", text: "12 verdes.", streaming: false }], agentTurn: "idle" });
    expect(call.announceContext.mock.calls).toEqual([
      [aboutRequestForVoice("Rode os testes do back.", DELEGATION_FAILED)],
      [expect.stringContaining("12 verdes.")],
    ]);
    expect(call.appendContext).not.toHaveBeenCalledWith(expect.stringContaining("12 verdes."));
  });

  it("chat reconectando sem parar (driver que cai antes de ficar pronto): a voz diz a falha no fim do prazo", () => {
    const { call, view, requestRow } = stalled();
    view.rerender({ rows: [], agentTurn: "unknown" });
    view.rerender({ rows: [requestRow], agentTurn: "unknown" });
    view.rerender({ rows: [], agentTurn: "unknown" });
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS));
    expect(call.announceContext.mock.calls).toEqual([[aboutRequestForVoice("Rode os testes do back.", DELEGATION_FAILED)]]);
  });

  it("deploy depois de o agente começar a falar: o texto do meio não vira resposta, a da retomada sim", () => {
    const { call, view, requestRow } = stalled();
    const halfway: SdkRow = { kind: "assistant", id: "a1", text: "Vou rodar a suíte.", streaming: false };
    const resuming: SdkRow = { kind: "note", id: "n1", text: "retomando…" };
    view.rerender({ rows: [requestRow, halfway, resuming], agentTurn: "idle" });
    expect(call.announceContext).not.toHaveBeenCalled();
    expect(call.appendContext).not.toHaveBeenCalledWith(expect.stringContaining("Vou rodar a suíte."));
    view.rerender({ rows: [requestRow, halfway, resuming, { kind: "assistant", id: "a2", text: "12 verdes.", streaming: false }], agentTurn: "idle" });
    expect(call.announceContext.mock.calls).toEqual([[expect.stringContaining("12 verdes.")]]);
  });

  it("pedido que ficou na fila sem conexão por todo o prazo: a voz diz que ele ficou guardado, sem pergunta", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { call, view, ask } = setup({ deliverToAgent: vi.fn((): AgentDelivery => "queued") });
    ask("call_q", "Rode os testes.");
    view.rerender({ rows: [], agentTurn: "idle" });
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS));
    expect(call.announceContext.mock.calls).toEqual([[aboutRequestForVoice("Rode os testes.", DELEGATION_UNDELIVERED)]]);
  });

  it("pedido que o servidor não confirmou: a voz diz no fim do prazo que ele ficou como não entregue", () => {
    const { call, view, deliverToAgent, request } = stalled();
    view.rerender({ rows: [{ kind: "user", id: "u1", text: request, state: "undelivered" }], agentTurn: "idle" });
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS * 3));
    expect(deliveredTexts(deliverToAgent)).toHaveLength(1);
    expect(call.announceContext.mock.calls).toEqual([[aboutRequestForVoice("Rode os testes do back.", DELEGATION_UNDELIVERED)]]);
  });

  it("a pessoa parou o agente: a voz fica sabendo e o pedido não é reenviado", () => {
    const { call, view, deliverToAgent } = stalled();
    act(() => view.result.current.stopPendingAsks());
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS * 3));
    expect(deliveredTexts(deliverToAgent)).toHaveLength(1);
    expect(call.appendContext).toHaveBeenCalledWith(aboutRequestForVoice("Rode os testes do back.", DELEGATION_STOPPED));
    expect(call.announceContext).not.toHaveBeenCalled();
  });
});

describe("useVoiceDelegation — pergunta do agente aberta", () => {
  const question: SdkRow = {
    kind: "question",
    id: "q_1",
    questions: [{ question: "Qual caminho?", options: [{ label: "A" }, { label: "B" }] }],
    outcome: "pending",
  };

  it("a voz lê a pergunta aberta por commentary, uma vez", () => {
    const { call, view } = setup();
    view.rerender({ rows: [question], agentTurn: "running" });
    view.rerender({ rows: [question], agentTurn: "running" });
    expect(call.announceContext).toHaveBeenCalledTimes(1);
    expect(call.announceContext).toHaveBeenCalledWith(expect.stringContaining("Qual caminho?"));
  });

  it("ask_card_agent com a pergunta aberta responde a pergunta com a fala da pessoa, sem envio urgente", () => {
    const { call, view, toolCall, deliverToAgent, answerQuestion } = setup();
    view.rerender({ rows: [question], agentTurn: "running" });
    toolCall("call_q1", "ask_card_agent", { request: "A pessoa escolheu B." }, said("a B"));
    expect(answerQuestion).toHaveBeenCalledWith("q_1", [{ selected: [expect.stringContaining("a B")] }]);
    expect(deliverToAgent).not.toHaveBeenCalled();
    expect(call.answerToolCall).toHaveBeenCalledWith("call_q1", { ok: true, status: QUESTION_ANSWER_SENT });
  });

  it("uma escolha que o chat não consegue entregar volta como erro na saída da função", () => {
    const { call, view, toolCall, deliverToAgent } = setup({ answerQuestion: vi.fn(() => false) });
    view.rerender({ rows: [question], agentTurn: "running" });
    toolCall("call_q2", "ask_card_agent", { request: "B" }, said("a B"));
    expect(deliverToAgent).not.toHaveBeenCalled();
    expect(call.answerToolCall.mock.calls).toEqual([["call_q2", { error: DELEGATION_NOT_SENT }]]);
  });

  it("escolha entregue cujo turno some sem texto nunca vira mensagem nova ao agente: depois da espera, a voz diz a falha", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { call, view, toolCall, deliverToAgent } = setup();
    view.rerender({ rows: [question], agentTurn: "running" });
    toolCall("call_q5", "ask_card_agent", { request: "A pessoa escolheu B." }, said("a B"));
    const answered: SdkRow = { ...question, outcome: "answered" };
    view.rerender({ rows: [answered], agentTurn: "idle" });
    act(() => vi.advanceTimersByTime(DELEGATION_RECOVERY_MS * 3));
    expect(deliverToAgent).not.toHaveBeenCalled();
    expect(call.announceContext).toHaveBeenLastCalledWith(aboutRequestForVoice("A pessoa escolheu B.", DELEGATION_FAILED));
  });

  it("nada ouvido não responde a pergunta por ninguém", () => {
    const { call, view, toolCall, answerQuestion } = setup();
    view.rerender({ rows: [question], agentTurn: "running" });
    toolCall("call_q3", "ask_card_agent", { request: "B" }, []);
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(call.answerToolCall.mock.calls).toEqual([["call_q3", { error: ASK_WITHOUT_REQUEST }]]);
  });

  it("a pergunta que chega com um pedido esperando encerra esse pedido: a resposta do agente não é falada duas vezes", () => {
    const { call, view, ask, deliverToAgent } = setup();
    ask("call_q4", "Organize as metas.");
    const request = sentRequest(deliverToAgent);
    view.rerender({ rows: [{ kind: "user", id: "u1", text: request, state: "sent" }, { ...question }], agentTurn: "running" });
    view.rerender({ rows: [{ kind: "user", id: "u1", text: request, state: "sent" }, { ...question }], agentTurn: "idle" });
    expect(call.announceContext.mock.calls).toEqual([[expect.stringContaining("Qual caminho?")]]);
  });

  it("uma chamada nova lê de novo a pergunta que continua aberta", () => {
    const { call, view } = setup();
    view.rerender({ rows: [question], agentTurn: "running" });
    call.snap = { ...call.snap, state: "idle" };
    view.rerender({ rows: [question], agentTurn: "running" });
    call.snap = { ...call.snap, state: "live" };
    view.rerender({ rows: [question], agentTurn: "running" });
    expect(call.announceContext).toHaveBeenCalledTimes(2);
  });
});
