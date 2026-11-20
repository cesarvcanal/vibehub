import type { DriverEvent } from "../sdk/protocol.js";
import type { UserStopMark } from "./types.js";

export const SLOW_FIRST_OUTPUT_MS = 90_000;
export const SLOW_TURNS_TO_REPORT = 3;
export const SLOW_TURNS_WINDOW_MS = 30 * 60_000;
export const STALLED_TURN_MS = 3 * 60_000;

export interface SlowTurn {
  at: number;
  latencyMs: number;
}

export interface StalledTurn {
  cardId: string;
  sentAt: number;
  lastSignalAt: number;
}

type SlowTurnsListener = (cardId: string, slowTurns: SlowTurn[]) => void;

const FIRST_OUTPUT_EVENTS: ReadonlySet<DriverEvent["type"]> = new Set(["assistant_delta", "assistant_text", "thinking_delta", "thinking", "tool_use_start", "tool_use"]);
const WAIT_DISTURBING_EVENTS: ReadonlySet<DriverEvent["type"]> = new Set(["user_question", "permission_request", "usage_limited", "login_failed"]);
const TOOL_OPENING_EVENTS: ReadonlySet<DriverEvent["type"]> = new Set(["tool_use_start", "tool_use"]);

interface OpenTurn {
  since: number;
  disturbed: boolean;
  answered: boolean;
  lastSignalAt: number;
  openToolIds: Set<string>;
  stallMarked: boolean;
}

const openTurns = new Map<string, OpenTurn>();
const slowTurnsByCard = new Map<string, SlowTurn[]>();
const slowTurnsListeners = new Set<SlowTurnsListener>();
const userStops: { last?: UserStopMark } = {};

function keepSlowTurnsWithinWindow(earlierSlowTurns: readonly SlowTurn[], slowTurn: SlowTurn): SlowTurn[] {
  return [...earlierSlowTurns, slowTurn].filter((earlierSlowTurn) => slowTurn.at - earlierSlowTurn.at <= SLOW_TURNS_WINDOW_MS);
}

function recordSlowTurn(cardId: string, slowTurn: SlowTurn): void {
  const recentSlowTurns = keepSlowTurnsWithinWindow(slowTurnsByCard.get(cardId) ?? [], slowTurn);
  if (recentSlowTurns.length < SLOW_TURNS_TO_REPORT) {
    slowTurnsByCard.set(cardId, recentSlowTurns);
    return;
  }
  slowTurnsByCard.delete(cardId);
  notifySlowTurnsListeners(cardId, recentSlowTurns);
}

function notifySlowTurnsListeners(cardId: string, slowTurns: SlowTurn[]): void {
  for (const listener of slowTurnsListeners) listener(cardId, slowTurns);
}

export function noteTurnSent(cardId: string, at: number): void {
  if (!openTurns.has(cardId)) {
    openTurns.set(cardId, { since: at, disturbed: false, answered: false, lastSignalAt: at, openToolIds: new Set(), stallMarked: false });
  }
}

function trackMainAgentTool(openTurn: OpenTurn, event: { type: DriverEvent["type"]; id?: unknown; parentToolUseId?: unknown }): void {
  if (typeof event.id !== "string") return;
  if (event.type === "tool_result") openTurn.openToolIds.delete(event.id);
  else if (TOOL_OPENING_EVENTS.has(event.type) && !event.parentToolUseId) openTurn.openToolIds.add(event.id);
}

export function noteTurnEvent(
  cardId: string,
  event: { type: DriverEvent["type"]; id?: unknown; parentToolUseId?: unknown; phase?: unknown },
  at: number,
): void {
  const openTurn = openTurns.get(cardId);
  if (!openTurn) return;
  if (event.type === "result") {
    openTurns.delete(cardId);
    return;
  }
  openTurn.lastSignalAt = at;
  trackMainAgentTool(openTurn, event);
  if (WAIT_DISTURBING_EVENTS.has(event.type) || (event.type === "compaction" && event.phase === "started")) {
    openTurn.disturbed = true;
    return;
  }
  const isFirstMainAgentOutput = !openTurn.answered && FIRST_OUTPUT_EVENTS.has(event.type) && !event.parentToolUseId;
  if (!isFirstMainAgentOutput) return;
  openTurn.answered = true;
  const latencyMs = at - openTurn.since;
  if (!openTurn.disturbed && latencyMs > SLOW_FIRST_OUTPUT_MS) recordSlowTurn(cardId, { at, latencyMs });
}

export function markNewlyStalledTurns(now: number): StalledTurn[] {
  const newlyStalledTurns: StalledTurn[] = [];
  for (const [cardId, openTurn] of openTurns) {
    const isStalled = !openTurn.stallMarked && !openTurn.disturbed && openTurn.openToolIds.size === 0
      && now - openTurn.lastSignalAt > STALLED_TURN_MS;
    if (!isStalled) continue;
    openTurn.stallMarked = true;
    newlyStalledTurns.push({ cardId, sentAt: openTurn.since, lastSignalAt: openTurn.lastSignalAt });
  }
  return newlyStalledTurns;
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
