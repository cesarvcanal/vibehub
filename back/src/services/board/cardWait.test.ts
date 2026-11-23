import { describe, it, expect } from "vitest";
import { markWaitsReady, parseCardWait, type CardWait } from "./cardWait.js";
import type { Card } from "./registry.js";

const WAIT: CardWait = { cardId: "target", instruction: "faça o complemento", createdAt: 100, createdBy: "user-1" };

function waitingCard(id: string, waitingFor: CardWait | undefined): Card {
  return { id, waitingFor } as Card;
}

describe("parseCardWait", () => {
  it("lê uma espera completa como está", () => {
    const ready: CardWait = { ...WAIT, base: "prod", readyAt: 200, outcome: "pr_merged", prNumber: 7, failure: { at: 300, reason: "runner fora" } };
    expect(parseCardWait(ready)).toEqual(ready);
  });

  it.each([
    ["nada", undefined],
    ["texto solto", "card-x"],
    ["sem o card esperado", { ...WAIT, cardId: "" }],
    ["instrução vazia", { ...WAIT, instruction: "" }],
    ["sem quem criou", { ...WAIT, createdBy: undefined }],
    ["instante que não é número", { ...WAIT, createdAt: "ontem" }],
    ["desfecho desconhecido", { ...WAIT, readyAt: 200, outcome: "talvez" }],
  ])("descarta uma espera com %s", (_case, raw) => {
    expect(parseCardWait(raw)).toBeUndefined();
  });

  it("descarta só o campo opcional inválido e mantém a espera", () => {
    expect(parseCardWait({ ...WAIT, base: 42, prNumber: "7", failure: "x" })).toEqual(WAIT);
  });
});

describe("markWaitsReady", () => {
  it("marca como pronta a espera que aponta para o card que terminou e devolve quem espera", () => {
    const cards = [waitingCard("a", { ...WAIT }), waitingCard("b", undefined), waitingCard("c", { ...WAIT, cardId: "other" })];
    expect(markWaitsReady(cards, "target", { outcome: "concluded" }, 500)).toEqual(["a"]);
    expect(cards[0].waitingFor).toEqual({ ...WAIT, readyAt: 500, outcome: "concluded" });
    expect(cards[2].waitingFor?.readyAt).toBeUndefined();
  });

  it("não remarca uma espera que já estava pronta", () => {
    const cards = [waitingCard("a", { ...WAIT, readyAt: 200, outcome: "pr_merged", prNumber: 3 })];
    expect(markWaitsReady(cards, "target", { outcome: "concluded" }, 500)).toEqual([]);
    expect(cards[0].waitingFor).toMatchObject({ readyAt: 200, outcome: "pr_merged", prNumber: 3 });
  });

  it("merge numa base diferente da fixada na espera não a deixa pronta", () => {
    const cards = [waitingCard("a", { ...WAIT, base: "prod" })];
    expect(markWaitsReady(cards, "target", { outcome: "pr_merged", base: "dev", prNumber: 4 }, 500)).toEqual([]);
    expect(markWaitsReady(cards, "target", { outcome: "pr_merged", base: "prod", prNumber: 5 }, 600)).toEqual(["a"]);
    expect(cards[0].waitingFor).toMatchObject({ readyAt: 600, outcome: "pr_merged", prNumber: 5 });
  });

  it("a base fixada não impede a conclusão nem a remoção do card esperado", () => {
    const cards = [waitingCard("a", { ...WAIT, base: "prod" })];
    expect(markWaitsReady(cards, "target", { outcome: "deleted" }, 500)).toEqual(["a"]);
  });
});
