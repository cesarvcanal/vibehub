import { describe, it, expect, beforeEach } from "vitest";
import {
  SLOW_FIRST_OUTPUT_MS, SLOW_TURNS_TO_REPORT, SLOW_TURNS_WINDOW_MS,
  lastUserStop, noteDriverGone, noteTurnEvent, noteTurnSent, noteUserStop, onSlowTurns, resetTurnLatencyForTesting, type SlowTurn,
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
    expect(lastUserStop()).toEqual({ cardId: "card-9", cardLabel: "erp-feat", at: 123 });
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
