import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { XTerminal } from "@/features/board/components/XTerminal";
import { useT } from "@/i18n";

/** The account a login terminal opens into: the slug addresses the profile, the name is what the person reads. */
export interface LoginAccount {
  slug: string;
  name: string;
}

/**
 * LOGIN, on screen: a terminal already inside THIS account's profile running `claude /login` (owner route). Shared
 * by the accounts panel and the chat's "login died" warning, so reconnecting is the same flow from both places.
 */
export function AccountLoginDialog({ account, onClose }: { account: LoginAccount | null; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog open={Boolean(account)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("accounts.signInFor", { name: account?.name })}</DialogTitle>
          <DialogDescription>{t("accounts.loginHelp")}</DialogDescription>
        </DialogHeader>
        {account ? (
          <div className="h-[26rem] overflow-hidden rounded-md border border-border/60">
            <XTerminal
              wsPath={`/api/accounts/${encodeURIComponent(account.slug)}/login-terminal`}
              zoomControl
              ariaLabel={t("accounts.loginTerminalAria", { name: account.name })}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
