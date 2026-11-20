import { findUser } from "../../auth/users.js";
import { logger } from "../../utils/logger.js";
import { recordCardActor } from "../board/actor.js";
import { WAIT_INSTRUCTION_MAX, type CardWait } from "../board/cardWait.js";
import * as registry from "../board/registry.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { SEND_READY_WAIT_MS, sendToTerminal } from "../maestro/maestro.js";

const CARD_WAIT_ORIGIN: MessageOrigin = { kind: "system", name: "espera de card" };

export interface CreateCardWaitInput {
  waitingCardId: string;
  targetCardId: string;
  instruction: string;
  base?: string;
  createdBy: string;
}

export type FireResult = "sent" | "not_ready";

function describeOutcome(wait: CardWait): string {
  switch (wait.outcome) {
    case "pr_merged":
      return `o PR #${wait.prNumber} foi mergeado`;
    case "concluded":
      return "foi concluído (sem PR mergeado pelo vibehub desde que a espera foi criada)";
    case "deleted":
      return "foi apagado do board";
    case undefined:
      throw new Error("the wait is not ready: the awaited card has not finished");
  }
}

export function buildWakeMessage(wait: CardWait, targetTitle: string | undefined): string {
  const target = targetTitle ? `"${targetTitle}" (${wait.cardId})` : wait.cardId;
  return [
    `[vibehub · espera de card] O card ${target}, que você estava aguardando, terminou: ${describeOutcome(wait)}.`,
    "",
    "Instrução combinada ao criar a espera:",
    wait.instruction,
  ].join("\n");
}

function normalizeInstruction(instruction: string): string {
  const trimmed = instruction.trim();
  if (!trimmed) throw new Error("instruction is required: say what to do when the awaited card finishes");
  if (trimmed.length > WAIT_INSTRUCTION_MAX) throw new Error(`instruction is too long (max ${WAIT_INSTRUCTION_MAX} characters)`);
  return trimmed;
}

function closesWaitCycle(cards: registry.Card[], waitingCardId: string, targetCardId: string): boolean {
  const waitedBy = new Map(cards.map((card) => [card.id, card.waitingFor?.cardId]));
  const visited = new Set<string>();
  const step = (cardId: string | undefined): boolean => {
    if (cardId === undefined || visited.has(cardId)) return false;
    if (cardId === waitingCardId) return true;
    visited.add(cardId);
    return step(waitedBy.get(cardId));
  };
  return step(targetCardId);
}

export async function createCardWait(input: CreateCardWaitInput): Promise<{ wait: CardWait; targetTitle: string }> {
  const instruction = normalizeInstruction(input.instruction);
  const base = input.base === undefined ? undefined : registry.assertBranchName(input.base);
  if (input.waitingCardId === input.targetCardId) throw new Error("a card cannot wait for itself");
  const cards = await registry.listAllCards();
  const target = cards.find((card) => card.id === input.targetCardId);
  if (!target) throw new Error("card not found");
  if (!cards.some((card) => card.id === input.waitingCardId)) throw new Error("card not found");
  if (target.column === "done") throw new Error(`card "${target.title}" already finished (it is in done): go on now instead of waiting`);
  if (closesWaitCycle(cards, input.waitingCardId, target.id)) {
    throw new Error(`card "${target.title}" already waits, directly or through other cards, for this one: the wait would be a cycle`);
  }
  const wait: CardWait = { cardId: target.id, instruction, createdAt: Date.now(), createdBy: input.createdBy };
  if (base !== undefined) wait.base = base;
  await registry.setCardWait(input.waitingCardId, wait);
  logger.info({ audit: true, action: "wait.create", card: input.waitingCardId, target: target.id, base, by: input.createdBy }, "card wait created");
  return { wait, targetTitle: target.title };
}

export async function cancelCardWait(cardId: string): Promise<void> {
  const removed = await registry.removeCardWait(cardId);
  if (!removed) throw new Error("no wait: this card is not waiting for another card");
  logger.info({ audit: true, action: "wait.cancel", card: cardId, target: removed.cardId }, "card wait cancelled");
}

export async function fireCardWait(cardId: string): Promise<FireResult> {
  const wait = await registry.takeReadyCardWait(cardId);
  if (!wait) return "not_ready";
  try {
    const target = await registry.getCard(wait.cardId);
    const creator = await findUser(wait.createdBy);
    await sendToTerminal(cardId, buildWakeMessage(wait, target?.title), {
      by: `card-wait:${wait.cardId}`,
      origin: CARD_WAIT_ORIGIN,
      wake: true,
      requireAgent: true,
      guardInteractiveMenu: true,
      readyWaitMs: SEND_READY_WAIT_MS,
      viaNativeChat: true,
      beforeDeliver: () => recordCardActor(creator, cardId),
    });
  } catch (err) {
    await registry.restoreFailedCardWait(cardId, wait, { at: Date.now(), reason: (err as Error).message });
    throw err;
  }
  logger.info({ audit: true, action: "wait.fire", card: cardId, target: wait.cardId, outcome: wait.outcome }, "waiting card woken");
  return "sent";
}

async function fireInBackground(cardId: string): Promise<void> {
  try {
    await fireCardWait(cardId);
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not wake the waiting card — the wait stays ready with the reason");
  }
}

export async function startCardWaitWatch(): Promise<() => void> {
  const stop = registry.onWaitsReady((waitingCardIds) => {
    for (const cardId of waitingCardIds) void fireInBackground(cardId);
  });
  const readyCards = (await registry.listAllCards()).filter((card) => card.waitingFor?.readyAt !== undefined);
  for (const card of readyCards) void fireInBackground(card.id);
  return stop;
}
