import { describe, expect, it, onTestFinished, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { LiveVoiceSession, type LiveVoiceSnapshot, type ToolCallListener } from "./liveVoice";
import { useVoiceDelegation, type UseVoiceDelegationOptions } from "./useVoiceDelegation";
import { DELEGATION_NOT_SENT, DELEGATION_SILENT, DELEGATION_SLOW, DELEGATION_SLOW_MS, DELEGATION_STARTED } from "./voiceDelegation";
import type { VoiceTurn } from "./voiceTurns";

const said = (text: string): VoiceTurn[] => [{ vid: "vc-u1", role: "user", text, at: 1, final: true }];

function setup(options: Partial<Pick<UseVoiceDelegationOptions, "sendUrgentToAgent" | "runAction">> = {}) {
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
  const sendUrgentToAgent = options.sendUrgentToAgent ?? vi.fn();
  const runAction = options.runAction ?? vi.fn(async () => ({ ok: true }));
  const view = renderHook((props: Partial<UseVoiceDelegationOptions>) =>
    useVoiceDelegation({ call, rows: [], turnRunning: false, sendUrgentToAgent, runAction, ...props }),
  );
  const toolCall = (callId: string, name: string, args: unknown, turns: VoiceTurn[] = said("pedido")) =>
    act(() => listeners.at(-1)!({ callId, name, argumentsJson: JSON.stringify(args), turns }));
  const ask = (callId: string, request: string) => toolCall(callId, "ask_card_agent", { request });
  return { call, view, toolCall, ask, sendUrgentToAgent, runAction };
}

function sentRequest(send: unknown): string {
  return (send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
}

describe("useVoiceDelegation — ordens do board", () => {
  it("ordem do backend vai à rota e o resultado volta como saída da função", async () => {
    const runAction = vi.fn(async () => ({ cardId: "c9", title: "Relatório" }));
    const { call, toolCall, sendUrgentToAgent } = setup({ runAction });
    toolCall("call_1", "create_card", { projectId: "p1", title: "Relatório" });
    expect(runAction).toHaveBeenCalledWith({ callId: "call_1", name: "create_card", arguments: '{"projectId":"p1","title":"Relatório"}' });
    await waitFor(() => expect(call.answerToolCall).toHaveBeenCalledWith("call_1", { cardId: "c9", title: "Relatório" }));
    expect(sendUrgentToAgent).not.toHaveBeenCalled();
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
    const { call, toolCall, sendUrgentToAgent } = setup();
    toolCall("call_3", "ask_card_agent", { request: "Investigue por que o teste de login falha." }, said("por que o login falha?"));
    const request = sentRequest(sendUrgentToAgent);
    expect(request.startsWith("[pedido por voz]\nInvestigue por que o teste de login falha.")).toBe(true);
    expect(request).toContain("Pessoa: por que o login falha?");
    expect(call.answerToolCall.mock.calls).toEqual([["call_3", { ok: true, status: DELEGATION_STARTED }]]);
  });

  it("a resposta do agente é falada por commentary sem delegation_id, dizendo a que pedido responde", () => {
    const { call, view, ask, sendUrgentToAgent } = setup();
    ask("call_4", "Rode os testes do back.");
    const rows: SdkRow[] = [
      { kind: "user", id: "u1", text: sentRequest(sendUrgentToAgent), state: "sent" },
      { kind: "assistant", id: "a1", text: "12 verdes.", streaming: false },
    ];
    view.rerender({ rows });
    expect(call.announceContext).toHaveBeenCalledTimes(1);
    const told = call.announceContext.mock.calls[0]![0] as string;
    expect(told).toContain("Rode os testes do back.");
    expect(told).toContain("12 verdes.");
    expect(call.appendContext).not.toHaveBeenCalledWith(expect.stringContaining("12 verdes."));
  });

  it("um turno que acabou sem texto é dito assim, com a oferta de pedir de novo", () => {
    const { call, view, ask, sendUrgentToAgent } = setup();
    ask("call_5", "Explique o que falta para o merge.");
    view.rerender({ rows: [{ kind: "user", id: "u1", text: sentRequest(sendUrgentToAgent), state: "sent" }], turnRunning: false });
    expect(call.announceContext).toHaveBeenCalledWith(expect.stringContaining(DELEGATION_SILENT));
  });

  it("pedido que não chega ao agente devolve erro na saída da função", () => {
    const { call, ask } = setup({
      sendUrgentToAgent: () => {
        throw new Error("offline");
      },
    });
    ask("call_6", "Rode os testes.");
    expect(call.answerToolCall.mock.calls).toEqual([["call_6", { error: DELEGATION_NOT_SENT }]]);
  });

  it("ask_card_agent sem pedido devolve erro e não manda nada ao agente", () => {
    const { call, toolCall, sendUrgentToAgent } = setup();
    toolCall("call_7", "ask_card_agent", { request: "   " });
    expect(sendUrgentToAgent).not.toHaveBeenCalled();
    expect(call.answerToolCall).toHaveBeenCalledWith("call_7", { error: expect.any(String) });
  });

  it("resposta do agente depois do fim da chamada não envia nada", () => {
    const { call, view, ask, sendUrgentToAgent } = setup();
    ask("call_8", "Recapitule a conversa.");
    const request = sentRequest(sendUrgentToAgent);
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
