import * as React from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Settings2, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth";
import { Paths } from "@/lib/paths";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { useT } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Who you are and how the app looks — the last row of the sidebar.
 *
 * This used to be the right-hand end of a top header. The header is gone: it cost a whole band of
 * height across the screen to say two things that never change while you work, and the terminal
 * wants that height. Parked at the BOTTOM of the sidebar it is always reachable and never in the
 * way, which is the correct weight for settings and signing out.
 */
export function AccountRow({ className }: { className?: string }) {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const t = useT();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  async function onSignOut() {
    await signOut();
    navigate(Paths.LOGIN, { replace: true });
  }

  return (
    <div
      aria-label={t("account.group")}
      role="group"
      className={cn(
        "flex shrink-0 items-center gap-1 border-t border-border/60 px-2 py-1.5",
        className,
      )}
    >
      <ThemeToggle className="px-2 py-1 text-xs" />
      <span className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger className="nav-pill min-w-0 max-w-[9rem] gap-1.5 px-2 py-1 text-xs">
          <UserRound className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{user?.username ?? t("account.fallback")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuLabel>{t("account.signedIn")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            <Settings2 />
            {t("account.settings")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onSignOut()}>
            <LogOut />
            {t("account.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
