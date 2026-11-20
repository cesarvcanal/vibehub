import type { Card } from "./registry.js";

export type WaitOutcome = "pr_merged" | "concluded" | "deleted";
export const WAIT_OUTCOMES: readonly WaitOutcome[] = ["pr_merged", "concluded", "deleted"];
export const WAIT_INSTRUCTION_MAX = 2000;

export interface WaitFailure {
  at: number;
  reason: string;
}

export interface CardWait {
  cardId: string;
  instruction: string;
  createdAt: number;
  createdBy: string;
  base?: string;
  readyAt?: number;
  outcome?: WaitOutcome;
  prNumber?: number;
  failure?: WaitFailure;
}

export interface WaitTrigger {
  outcome: WaitOutcome;
  base?: string;
  prNumber?: number;
}

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseWaitFailure(raw: unknown): WaitFailure | undefined {
  const failure = raw as Partial<WaitFailure> | null;
  if (!failure || typeof failure !== "object") return undefined;
  if (typeof failure.at !== "number" || typeof failure.reason !== "string") return undefined;
  return { at: failure.at, reason: failure.reason };
}

export function parseCardWait(raw: unknown): CardWait | undefined {
  const stored = raw as Partial<CardWait> | null;
  if (!stored || typeof stored !== "object") return undefined;
  if (!isFilledString(stored.cardId) || !isFilledString(stored.instruction) || !isFilledString(stored.createdBy)) return undefined;
  if (typeof stored.createdAt !== "number") return undefined;
  const ready = typeof stored.readyAt === "number";
  if (ready && !WAIT_OUTCOMES.includes(stored.outcome as WaitOutcome)) return undefined;
  const wait: CardWait = { cardId: stored.cardId, instruction: stored.instruction, createdAt: stored.createdAt, createdBy: stored.createdBy };
  if (isFilledString(stored.base)) wait.base = stored.base;
  if (ready) {
    wait.readyAt = stored.readyAt;
    wait.outcome = stored.outcome;
  }
  if (Number.isInteger(stored.prNumber)) wait.prNumber = stored.prNumber;
  const failure = parseWaitFailure(stored.failure);
  if (failure) wait.failure = failure;
  return wait;
}

function triggerReleasesWait(wait: CardWait, trigger: WaitTrigger): boolean {
  if (wait.readyAt !== undefined) return false;
  return trigger.outcome !== "pr_merged" || wait.base === undefined || wait.base === trigger.base;
}

export function markWaitsReady(cards: Card[], targetCardId: string, trigger: WaitTrigger, now: number): string[] {
  const released = cards.filter((card) => card.waitingFor?.cardId === targetCardId && triggerReleasesWait(card.waitingFor, trigger));
  for (const card of released) {
    const wait = card.waitingFor as CardWait;
    wait.readyAt = now;
    wait.outcome = trigger.outcome;
    if (trigger.prNumber !== undefined) wait.prNumber = trigger.prNumber;
  }
  return released.map((card) => card.id);
}
