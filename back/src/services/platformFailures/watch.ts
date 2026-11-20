import { logger, onLogLine } from "../../utils/logger.js";
import { onCardEvent } from "../events/cardEvents.js";
import { buildBackendErrorReport } from "./backendError.js";
import { settleInvestigationOfCard } from "./investigation.js";
import { recordPlatformFailure } from "./platformFailures.js";
import {
  SLOW_FIRST_OUTPUT_MS, SLOW_TURNS_WINDOW_MS, STALLED_TURN_MS,
  getLastUserStop, markNewlyStalledTurns, onSlowTurns, type SlowTurn, type StalledTurn,
} from "./turnLatency.js";
import type { PlatformFailureReport } from "./types.js";

const CAPTURE_PAUSE_MS = 60_000;
export const STALL_CHECK_INTERVAL_MS = 30_000;

const backendCapture = { pausedUntil: 0 };
const pendingWatchTasks = new Set<Promise<unknown>>();

function buildSlowTurnsReport(cardId: string, slowTurns: SlowTurn[]): PlatformFailureReport {
  return {
    source: "slow_turn",
    component: "sdk/turn",
    symptom: `primeira resposta do agente acima de ${SLOW_FIRST_OUTPUT_MS / 1000}s em ${slowTurns.length} turnos em ${SLOW_TURNS_WINDOW_MS / 60_000} min`,
    evidence: slowTurns
      .map((slowTurn) => `${new Date(slowTurn.at).toISOString()}: ${Math.round(slowTurn.latencyMs / 1000)}s até a primeira saída`)
      .join("\n"),
    cardId,
  };
}

function buildStalledTurnReport(stalledTurn: StalledTurn): PlatformFailureReport {
  return {
    source: "stalled_turn",
    component: "sdk/turn",
    symptom: `turno parado: nenhum sinal do agente por mais de ${STALLED_TURN_MS / 60_000} min, sem ferramenta rodando`,
    evidence: [
      `turno enviado: ${new Date(stalledTurn.sentAt).toISOString()}`,
      `último sinal do agente: ${new Date(stalledTurn.lastSignalAt).toISOString()}`,
    ].join("\n"),
    cardId: stalledTurn.cardId,
  };
}

function trackWatchTask(watchTask: Promise<unknown>): void {
  pendingWatchTasks.add(watchTask);
  void watchTask.finally(() => pendingWatchTasks.delete(watchTask));
}

async function recordFromWatch(report: PlatformFailureReport): Promise<void> {
  try {
    await recordPlatformFailure(report);
  } catch (err) {
    backendCapture.pausedUntil = Date.now() + CAPTURE_PAUSE_MS;
    logger.warn({ detail: (err as Error).message, pausedForMs: CAPTURE_PAUSE_MS }, "could not record a platform failure — backend capture paused");
  }
}

export function startPlatformFailureWatch(): () => void {
  const stopLogCapture = onLogLine("error", (line) => {
    const now = Date.now();
    if (now < backendCapture.pausedUntil) return;
    const report = buildBackendErrorReport(line, getLastUserStop(), now);
    queueMicrotask(() => trackWatchTask(recordFromWatch(report)));
  });
  const stopSlowTurns = onSlowTurns((cardId, slowTurns) => trackWatchTask(recordFromWatch(buildSlowTurnsReport(cardId, slowTurns))));
  const stallCheck = setInterval(() => {
    for (const stalledTurn of markNewlyStalledTurns(Date.now())) trackWatchTask(recordFromWatch(buildStalledTurnReport(stalledTurn)));
  }, STALL_CHECK_INTERVAL_MS);
  stallCheck.unref();
  const stopConclusions = onCardEvent((event) => {
    if (event.kind !== "concluded") return;
    trackWatchTask(settleInvestigationOfCard(event.cardId).catch((err: unknown) => {
      logger.warn({ card: event.cardId, detail: (err as Error).message }, "could not settle the platform-failure investigation of a concluded card");
    }));
  });
  return () => {
    stopLogCapture();
    stopSlowTurns();
    clearInterval(stallCheck);
    stopConclusions();
  };
}

export async function waitForPlatformFailureWatch(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.all([...pendingWatchTasks]);
}
