import type { UserStopMark } from "./types.js";

export const SLOW_FIRST_OUTPUT_MS = 90_000;
export const SLOW_TURNS_TO_REPORT = 3;
export const SLOW_TURNS_WINDOW_MS = 30 * 60_000;

export interface SlowTurn {
  at: number;
  latencyMs: number;
}

type SlowTurnsListener = (cardId: string, slowTurns: SlowTurn[]) => void;

const FIRST_OUTPUT_EVENTS = new Set(["assistant_delta", "assistant_text", "thinking_delta", "thinking", "tool_use_start", "tool_use"]);
const WAIT_DISTURBING_EVENTS = new Set(["user_question", "permission_request"]);

const openTurns = new Map<string, { since: number; disturbed: boolean; answered: boolean }>();
const slowTurnsByCard = new Map<string, SlowTurn[]>();
const slowTurnsListeners = new Set<SlowTurnsListener>();
const userStops: { last?: UserStopMark } = {};

function countSlowTurn(cardId: string, slowTurn: SlowTurn): void {
  const recentSlowTurns = [...(slowTurnsByCard.get(cardId) ?? []), slowTurn]
    .filter((earlierSlowTurn) => slowTurn.at - earlierSlowTurn.at <= SLOW_TURNS_WINDOW_MS);
  if (recentSlowTurns.length < SLOW_TURNS_TO_REPORT) {
    slowTurnsByCard.set(cardId, recentSlowTurns);
    return;
  }
  slowTurnsByCard.delete(cardId);
  for (const listener of slowTurnsListeners) listener(cardId, recentSlowTurns);
}

export function noteTurnSent(cardId: string, at: number): void {
  if (!openTurns.has(cardId)) openTurns.set(cardId, { since: at, disturbed: false, answered: false });
}

export function noteTurnEvent(cardId: string, event: { type: string; parentToolUseId?: unknown; phase?: unknown }, at: number): void {
  const openTurn = openTurns.get(cardId);
  if (!openTurn) return;
  if (event.type === "result") {
    openTurns.delete(cardId);
    return;
  }
  if (WAIT_DISTURBING_EVENTS.has(event.type) || (event.type === "compaction" && event.phase === "started")) {
    openTurn.disturbed = true;
    return;
  }
  const isFirstMainAgentOutput = !openTurn.answered && FIRST_OUTPUT_EVENTS.has(event.type) && !event.parentToolUseId;
  if (!isFirstMainAgentOutput) return;
  openTurn.answered = true;
  const latencyMs = at - openTurn.since;
  if (!openTurn.disturbed && latencyMs > SLOW_FIRST_OUTPUT_MS) countSlowTurn(cardId, { at, latencyMs });
}

export function noteDriverGone(cardId: string): void {
  openTurns.delete(cardId);
}

export function noteUserStop(cardId: string, cardWorktreeSlug: string, at: number): void {
  const openTurn = openTurns.get(cardId);
  if (openTurn) openTurn.disturbed = true;
  userStops.last = { cardId, cardWorktreeSlug, at };
}

export function getLastUserStop(): UserStopMark | undefined {
  return userStops.last;
}

export function onSlowTurns(listener: SlowTurnsListener): () => void {
  slowTurnsListeners.add(listener);
  return () => {
    slowTurnsListeners.delete(listener);
  };
}

export function resetTurnLatencyForTesting(): void {
  openTurns.clear();
  slowTurnsByCard.clear();
  slowTurnsListeners.clear();
  userStops.last = undefined;
}
