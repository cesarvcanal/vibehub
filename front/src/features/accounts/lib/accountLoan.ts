import type { AccountLoan } from "@/api/types";

export function isAccountLoanRenewed(loan: AccountLoan, now: number): boolean {
  return loan.renewsAt === undefined || loan.renewsAt <= now;
}
