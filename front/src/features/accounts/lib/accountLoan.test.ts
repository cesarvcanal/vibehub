import { describe, it, expect } from "vitest";
import { isAccountLoanRenewed } from "./accountLoan";

const NOW = 1_800_000_000_000;

describe("isAccountLoanRenewed", () => {
  it.each([
    ["antes do horário de renovação, ainda emprestado", NOW + 60_000, false],
    ["no horário de renovação, renovou", NOW, true],
    ["depois do horário, renovou", NOW - 1, true],
    ["sem horário conhecido, a volta fica liberada", undefined, true],
  ])("%s", (_case, renewsAt, expected) => {
    expect(isAccountLoanRenewed({ originalAccount: "albert", exhausted: [], ...(renewsAt !== undefined ? { renewsAt } : {}) }, NOW)).toBe(expected);
  });
});
