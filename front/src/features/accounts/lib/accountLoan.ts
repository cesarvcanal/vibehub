import type { AccountLoan } from "@/api/types";

export type AccountLoanState = "borrowed" | "renewed" | "unknownRenewal";

export function accountLoanState(loan: AccountLoan, now: number): AccountLoanState {
  if (loan.renewsAt === undefined) return "unknownRenewal";
  return loan.renewsAt <= now ? "renewed" : "borrowed";
}
