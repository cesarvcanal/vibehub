import { describe, it, expect } from "vitest";
import { cardWaitPhase } from "./cardWait";
import type { CardWait } from "@/api/types";

const WAIT: CardWait = { cardId: "target", instruction: "faça o complemento", createdAt: 1, createdBy: "user-1" };

const RUNNING_CARD = { column: "working", pausedAt: null } as const;
const PAUSED_CARD = { column: "paused", pausedAt: 5 } as const;
const PENDING_PAUSE_CARD = { column: "paused", pausedAt: null } as const;
const READY_WAIT: CardWait = { ...WAIT, readyAt: 2, outcome: "concluded" };

describe("cardWaitPhase", () => {
  it.each([
    { name: "card esperado ainda trabalhando", wait: WAIT, card: RUNNING_CARD, phase: "waiting" },
    { name: "card esperado terminou com o card pausado", wait: READY_WAIT, card: PAUSED_CARD, phase: "paused" },
    { name: "card esperado terminou com a pausa ainda pendente", wait: READY_WAIT, card: PENDING_PAUSE_CARD, phase: "paused" },
    { name: "card esperado terminou e o card fora de Pausado está sendo acordado", wait: READY_WAIT, card: RUNNING_CARD, phase: "waking" },
    { name: "a última tentativa de acordar falhou", wait: { ...READY_WAIT, failure: { at: 3, reason: "runner fora" } }, card: PAUSED_CARD, phase: "failed" },
  ] as const)("$name → $phase", ({ wait, card, phase }) => {
    expect(cardWaitPhase(wait, card)).toBe(phase);
  });
});
