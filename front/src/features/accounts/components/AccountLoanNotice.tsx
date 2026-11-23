import { ArrowLeftRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useNow } from "@/lib/useNow";
import type { AccountLoan } from "@/api/types";
import { formatResetAt } from "@/features/board/lib/planUsage";
import { isAccountLoanRenewed } from "../lib/accountLoan";

interface AccountLoanNoticeProps {
  loan: AccountLoan;
  currentAccount: string;
  returning: boolean;
  onReturn: () => void;
}

export function AccountLoanNotice({ loan, currentAccount, returning, onReturn }: AccountLoanNoticeProps) {
  const t = useT();
  const now = useNow(!isAccountLoanRenewed(loan, Date.now()));
  const original = loan.originalAccount;
  const renewed = isAccountLoanRenewed(loan, now);
  const message = loan.renewsAt === undefined
    ? t("accounts.loan.unknownRenewal", { current: currentAccount, original })
    : renewed
      ? t("accounts.loan.renewed", { original })
      : t("accounts.loan.borrowed", { current: currentAccount, original, time: formatResetAt(loan.renewsAt, now) });
  const tone = renewed && loan.renewsAt !== undefined
    ? "border-emerald-500/50 bg-emerald-500/10"
    : "border-sky-500/40 bg-sky-500/10";
  return (
    <div
      data-testid="account-loan-notice"
      role="status"
      className={`mt-1.5 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${tone}`}
    >
      <ArrowLeftRight className="h-4 w-4 shrink-0 text-sky-500" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {renewed ? (
        <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={returning} onClick={onReturn}>
          {returning ? <Loader2 className="animate-spin" /> : null}
          {t(loan.renewsAt === undefined ? "accounts.loan.retry" : "accounts.loan.return", { original })}
        </Button>
      ) : null}
    </div>
  );
}
