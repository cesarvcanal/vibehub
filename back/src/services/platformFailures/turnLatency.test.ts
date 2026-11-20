import { describe, it, expect, beforeEach } from "vitest";
import {
  SLOW_FIRST_OUTPUT_MS, SLOW_TURNS_TO_REPORT, SLOW_TURNS_WINDOW_MS, STALLED_TURN_MS,
  getLastUserStop, markNewlyStalledTurns, noteDriverGone, noteTurnEvent, noteTurnSent, noteUserStop, onSlowTurns,
  resetTurnLatencyForTesting, type SlowTurn,
} from "./turnLatency.js";

const SLOW = SLOW_FIRST_OUTPUT_MS + 1;

function runTurn(cardId: string, startAt: number, latencyMs: number, beforeOutput: () => void = () => {}): void {
  noteTurnSent(cardId, startAt);
  beforeOutput();
  noteTurnEvent(cardId, { type: "assistant_delta" }, startAt + latencyMs);
  noteTurnEvent(cardId, { type: "result" }, startAt + latencyMs + 1);
}

function listenSlowTurns(): Array<{ cardId: string; slowTurns: SlowTurn[] }> {
  const reports: Array<{ cardId: string; slowTurns: SlowTurn[] }> = [];
  onSlowTurns((cardId, slowTurns) => reports.push({ cardId, slowTurns }));
  return reports;
}

beforeEach(() => resetTurnLatencyForTesting());

describe("turno lento repetido", () => {
  it("avisa uma vez quando o mesmo card passa do limite 3 vezes dentro de 30 min", () => {
    const reports = listenSlowTurns();
    for (const turnIndex of [0, 1, 2]) runTurn("card-1", turnIndex * 60_000, SLOW);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ cardId: "card-1" });
    expect(reports[0]!.slowTurns).toHaveLength(SLOW_TURNS_TO_REPORT);
    runTurn("card-1", 4 * 60_000, SLOW);
    expect(reports).toHaveLength(1);
  });

  it("não soma turnos lentos fora da janela de 30 min", () => {
    const reports = listenSlowTurns();
    runTurn("card-1", 0, SLOW);
    runTurn("card-1", 60_000, SLOW);
    runTurn("card-1", SLOW_TURNS_WINDOW_MS + 120_000, SLOW);
    expect(reports).toHaveLength(0);
  });

  it("subagente falando não conta como a primeira resposta", () => {
    const reports = listenSlowTurns();
    for (const turnIndex of [0, 1, 2]) {
      const startAt = turnIndex * 60_000;
      noteTurnSent("card-1", startAt);
      noteTurnEvent("card-1", { type: "assistant_delta", parentToolUseId: "t1" }, startAt + 1_000);
      noteTurnEvent("card-1", { type: "assistant_text" }, startAt + SLOW);
      noteTurnEvent("card-1", { type: "result" }, startAt + SLOW + 1);
    }
    expect(reports).toHaveLength(1);
  });

  it.each([
    ["compactação", (cardId: string, at: number) => noteTurnEvent(cardId, { type: "compaction", phase: "started" }, at)],
    ["pergunta ao usuário", (cardId: string, at: number) => noteTurnEvent(cardId, { type: "user_question" }, at)],
    ["permissão pedida", (cardId: string, at: number) => noteTurnEvent(cardId, { type: "permission_request" }, at)],
    ["stop do usuário", (cardId: string, at: number) => noteUserStop(cardId, "erp-feat", at)],
  ])("turno com %s no meio não conta como lento", (_cause, disturb) => {
    const reports = listenSlowTurns();
    for (const turnIndex of [0, 1, 2]) runTurn("card-1", turnIndex * 60_000, SLOW, () => disturb("card-1", turnIndex * 60_000 + 10));
    expect(reports).toHaveLength(0);
  });

  it("turno que termina em erro antes de responder não conta como lento", () => {
    const reports = listenSlowTurns();
    for (const turnIndex of [0, 1, 2]) {
      noteTurnSent("card-1", turnIndex * 60_000);
      noteTurnEvent("card-1", { type: "result" }, turnIndex * 60_000 + SLOW);
    }
    expect(reports).toHaveLength(0);
  });

  it("guarda o último stop do usuário com card e instante", () => {
    noteUserStop("card-9", "erp-feat", 123);
    expect(getLastUserStop()).toEqual({ cardId: "card-9", cardWorktreeSlug: "erp-feat", at: 123 });
  });

  it("mensagem enviada com o turno em andamento não abre uma espera nova: tarefa longa não é lentidão", () => {
    const reports = listenSlowTurns();
    for (const turnIndex of [0, 1, 2]) {
      const startAt = turnIndex * 400_000;
      noteTurnSent("card-1", startAt);
      noteTurnEvent("card-1", { type: "tool_use" }, startAt + 1_000);
      noteTurnSent("card-1", startAt + 60_000);
      noteTurnEvent("card-1", { type: "tool_result" }, startAt + 300_000);
      noteTurnEvent("card-1", { type: "assistant_text" }, startAt + 300_100);
      noteTurnEvent("card-1", { type: "result" }, startAt + 300_200);
    }
    expect(reports).toHaveLength(0);
  });

  it("driver que morre antes de responder encerra a espera: o turno seguinte mede do próprio envio", () => {
    const reports = listenSlowTurns();
    for (const turnIndex of [0, 1, 2]) {
      const startAt = turnIndex * 200_000;
      noteTurnSent("card-1", startAt);
      noteDriverGone("card-1");
      noteTurnSent("card-1", startAt + 100_000);
      noteTurnEvent("card-1", { type: "assistant_text" }, startAt + 101_000);
      noteTurnEvent("card-1", { type: "result" }, startAt + 101_001);
    }
    expect(reports).toHaveLength(0);
  });
});

describe("turno parado", () => {
  const STALLED = STALLED_TURN_MS + 1;

  it("turno sem nenhum sinal do agente além do limite e sem ferramenta rodando é marcado parado uma vez só", () => {
    noteTurnSent("card-1", 0);
    noteTurnEvent("card-1", { type: "assistant_text" }, 2_000);
    expect(markNewlyStalledTurns(2_000 + STALLED_TURN_MS)).toEqual([]);
    expect(markNewlyStalledTurns(2_000 + STALLED)).toEqual([{ cardId: "card-1", sentAt: 0, lastSignalAt: 2_000 }]);
    expect(markNewlyStalledTurns(2_000 + 2 * STALLED)).toEqual([]);
  });

  it("turno que nunca respondeu também é marcado parado, contando do envio", () => {
    noteTurnSent("card-1", 0);
    expect(markNewlyStalledTurns(STALLED)).toEqual([{ cardId: "card-1", sentAt: 0, lastSignalAt: 0 }]);
  });

  it("ferramenta do agente principal rodando não é turno parado: é espera do comando", () => {
    noteTurnSent("card-1", 0);
    noteTurnEvent("card-1", { type: "tool_use", id: "tool-1" }, 1_000);
    expect(markNewlyStalledTurns(1_000 + 10 * STALLED_TURN_MS)).toEqual([]);
  });

  it("bloco de ferramenta aberto e abandonado sem o tool_use não deixa o turno imune", () => {
    noteTurnSent("card-1", 0);
    noteTurnEvent("card-1", { type: "tool_use_start", id: "tool-abortado" }, 1_000);
    expect(markNewlyStalledTurns(1_000 + STALLED)).toEqual([{ cardId: "card-1", sentAt: 0, lastSignalAt: 1_000 }]);
  });

  it.each(["background_tasks", "btw_answer", "context_usage"] as const)("evento %s não é sinal do agente: não adia o turno parado", (type) => {
    noteTurnSent("card-1", 0);
    noteTurnEvent("card-1", { type: "assistant_text" }, 1_000);
    noteTurnEvent("card-1", { type }, 1_000 + STALLED_TURN_MS);
    expect(markNewlyStalledTurns(1_000 + STALLED)).toEqual([{ cardId: "card-1", sentAt: 0, lastSignalAt: 1_000 }]);
  });

  it.each([
    ["a compactação terminou", { type: "compaction", phase: "started" }, { type: "compaction", phase: "done" }],
    ["a compactação falhou", { type: "compaction", phase: "started" }, { type: "compaction", phase: "failed" }],
    ["a pergunta foi respondida", { type: "user_question" }, { type: "question_result" }],
    ["a permissão foi decidida", { type: "permission_request" }, { type: "permission" }],
    ["o agente voltou a falar depois do login caído", { type: "login_failed" }, { type: "assistant_text" }],
    ["o agente voltou a falar depois do limite de uso", { type: "usage_limited" }, { type: "assistant_delta" }],
  ] as const)("depois que %s, o silêncio volta a contar como turno parado", (_case, waitStarted, waitEnded) => {
    noteTurnSent("card-1", 0);
    noteTurnEvent("card-1", waitStarted, 1_000);
    noteTurnEvent("card-1", waitEnded, 400_000);
    expect(markNewlyStalledTurns(400_000 + STALLED_TURN_MS)).toEqual([]);
    expect(markNewlyStalledTurns(400_000 + STALLED)).toEqual([{ cardId: "card-1", sentAt: 0, lastSignalAt: 400_000 }]);
  });

  it("ferramenta que devolveu resultado volta a contar o silêncio a partir do resultado", () => {
    noteTurnSent("card-1", 0);
    noteTurnEvent("card-1", { type: "tool_use", id: "tool-1" }, 2_000);
    noteTurnEvent("card-1", { type: "tool_result", id: "tool-1" }, 500_000);
    expect(markNewlyStalledTurns(500_000 + STALLED_TURN_MS)).toEqual([]);
    expect(markNewlyStalledTurns(500_000 + STALLED)).toEqual([{ cardId: "card-1", sentAt: 0, lastSignalAt: 500_000 }]);
  });

  it("ferramenta de subagente não segura o turno: só a do agente principal é espera de comando", () => {
    noteTurnSent("card-1", 0);
    noteTurnEvent("card-1", { type: "tool_use", id: "sub-tool", parentToolUseId: "agent-1" }, 1_000);
    expect(markNewlyStalledTurns(1_000 + STALLED)).toEqual([{ cardId: "card-1", sentAt: 0, lastSignalAt: 1_000 }]);
  });

  it.each([
    ["pergunta ao usuário", (at: number) => noteTurnEvent("card-1", { type: "user_question" }, at)],
    ["permissão pedida", (at: number) => noteTurnEvent("card-1", { type: "permission_request" }, at)],
    ["compactação", (at: number) => noteTurnEvent("card-1", { type: "compaction", phase: "started" }, at)],
    ["limite de uso da conta", (at: number) => noteTurnEvent("card-1", { type: "usage_limited" }, at)],
    ["login da conta caído", (at: number) => noteTurnEvent("card-1", { type: "login_failed" }, at)],
    ["stop do usuário", (at: number) => noteUserStop("card-1", "erp-feat", at)],
  ])("turno com %s não é marcado parado: a espera tem outro aviso", (_cause, disturb) => {
    noteTurnSent("card-1", 0);
    disturb(1_000);
    expect(markNewlyStalledTurns(1_000 + STALLED)).toEqual([]);
  });

  it.each([
    ["fechou com result", () => noteTurnEvent("card-1", { type: "result" }, 1_000)],
    ["perdeu o driver", () => noteDriverGone("card-1")],
  ])("turno que %s não é marcado parado", (_cause, closeTurn) => {
    noteTurnSent("card-1", 0);
    closeTurn();
    expect(markNewlyStalledTurns(STALLED)).toEqual([]);
  });
});
