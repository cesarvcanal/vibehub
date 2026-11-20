import { describe, it, expect } from "vitest";
import { cardWaitPhase } from "./cardWait";
import type { CardWait } from "@/api/types";

const WAIT: CardWait = { cardId: "target", instruction: "faça o complemento", createdAt: 1, createdBy: "user-1" };

describe("cardWaitPhase", () => {
  it.each([
    { name: "card esperado ainda trabalhando", wait: WAIT, phase: "waiting" },
    { name: "card esperado terminou e o card aguarda sair de Pausado", wait: { ...WAIT, readyAt: 2, outcome: "concluded" }, phase: "ready" },
    { name: "a última tentativa de acordar falhou", wait: { ...WAIT, readyAt: 2, outcome: "concluded", failure: { at: 3, reason: "runner fora" } }, phase: "failed" },
  ] as const)("$name → $phase", ({ wait, phase }) => {
    expect(cardWaitPhase(wait)).toBe(phase);
  });
});
