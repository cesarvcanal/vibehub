import { ArrowLeftRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT, type Translate } from "@/i18n";
import type { AccountLoan } from "@/api/types";
import { useMinuteTick } from "@/features/board/components/AccountUsageBars";
import { formatResetAt } from "@/features/board/lib/planUsage";
import { accountLoanState, type AccountLoanState } from "../lib/accountLoan";

interface AccountLoanNoticeProps {
  loan: AccountLoan;
  currentAccount: string;
  returning: boolean;
  onReturn: () => void;
}

const TONES: Record<AccountLoanState, { box: string; icon: string }> = {
  borrowed: { box: "border-sky-500/40 bg-sky-500/10", icon: "text-sky-500" },
  unknownRenewal: { box: "border-sky-500/40 bg-sky-500/10", icon: "text-sky-500" },
  renewed: { box: "border-emerald-500/50 bg-emerald-500/10", icon: "text-emerald-500" },
};

function loanMessage(t: Translate, state: AccountLoanState, loan: AccountLoan, currentAccount: string, now: number): string {
  const original = loan.originalEffectiveAccount;
  switch (state) {
    case "unknownRenewal":
      return t("accounts.loan.unknownRenewal", { current: currentAccount, original });
    case "renewed":
      return t("accounts.loan.renewed", { original });
    case "borrowed":
      return t("accounts.loan.borrowed", { current: currentAccount, original, time: formatResetAt(loan.renewsAt ?? now, now) });
  }
}

export function AccountLoanNotice({ loan, currentAccount, returning, onReturn }: AccountLoanNoticeProps) {
  const t = useT();
  const now = useMinuteTick();
  const state = accountLoanState(loan, now);
  const tone = TONES[state];
  const original = loan.originalEffectiveAccount;
  return (
    <div
      data-testid="account-loan-notice"
      role="status"
      className={`mt-1.5 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${tone.box}`}
    >
      <ArrowLeftRight className={`h-4 w-4 shrink-0 ${tone.icon}`} aria-hidden />
      <span className="min-w-0 flex-1">{loanMessage(t, state, loan, currentAccount, now)}</span>
      {state === "borrowed" ? null : (
        <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={returning} onClick={onReturn}>
          {returning ? <Loader2 className="animate-spin" /> : null}
          {t(state === "unknownRenewal" ? "accounts.loan.retry" : "accounts.loan.return", { original })}
        </Button>
      )}
    </div>
  );
}
