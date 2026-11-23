import { describe, it, expect } from "vitest";
import { accountLoanState } from "./accountLoan";

const NOW = 1_800_000_000_000;

describe("accountLoanState", () => {
  it.each([
    ["antes do horário de renovação, ainda emprestado", NOW + 60_000, "borrowed"],
    ["no horário de renovação, renovou", NOW, "renewed"],
    ["depois do horário, renovou", NOW - 1, "renewed"],
    ["sem horário conhecido, a volta fica liberada para tentar", undefined, "unknownRenewal"],
  ])("%s", (_case, renewsAt, expected) => {
    const loan = { originalEffectiveAccount: "albert", exhausted: [], ...(renewsAt !== undefined ? { renewsAt } : {}) };

    expect(accountLoanState(loan, NOW)).toBe(expected);
  });
});
