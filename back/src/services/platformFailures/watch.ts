import { logger, onLogLine } from "../../utils/logger.js";
import { onCardEvent } from "../events/cardEvents.js";
import { reportFromBackendError } from "./backendError.js";
import { settleInvestigationOfCard } from "./investigation.js";
import { recordPlatformFailure } from "./platformFailures.js";
import { SLOW_FIRST_OUTPUT_MS, SLOW_TURNS_WINDOW_MS, lastUserStop, onSlowTurns, type SlowTurn } from "./turnLatency.js";
import type { PlatformFailureReport } from "./types.js";

const CAPTURE_PAUSE_MS = 60_000;

const backendCapture = { pausedUntil: 0 };
const pendingRecords = new Set<Promise<unknown>>();

function reportFromSlowTurns(cardId: string, slowTurns: SlowTurn[]): PlatformFailureReport {
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

function trackRecord(recording: Promise<unknown>): void {
  pendingRecords.add(recording);
  void recording.finally(() => pendingRecords.delete(recording));
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
    const report = reportFromBackendError(line, lastUserStop(), now);
    queueMicrotask(() => trackRecord(recordFromWatch(report)));
  });
  const stopSlowTurns = onSlowTurns((cardId, slowTurns) => trackRecord(recordFromWatch(reportFromSlowTurns(cardId, slowTurns))));
  const stopConclusions = onCardEvent((event) => {
    if (event.kind !== "concluded") return;
    trackRecord(settleInvestigationOfCard(event.cardId).catch((err: unknown) => {
      logger.warn({ card: event.cardId, detail: (err as Error).message }, "could not settle the platform-failure investigation of a concluded card");
    }));
  });
  return () => {
    stopLogCapture();
    stopSlowTurns();
    stopConclusions();
  };
}

export async function platformFailureWatchSettled(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.all([...pendingRecords]);
}
