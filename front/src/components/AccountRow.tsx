import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Check, LogOut, Monitor, Moon, Settings2, Sun, UserRound, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth";
import { Paths } from "@/lib/paths";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { AccessDialog, OwnPasswordForm } from "@/features/settings/AccessDialog";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
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
 * TWO doors, each answering one question. The GEAR answers "how does this place work": the theme
 * (a menu of the three choices, instead of a cycling button whose label read as a status), and —
 * for the owner — Settings and Access, the install's management. The USER answers "who am I":
 * editing your own account (the password) and signing out. A member's gear is just the theme;
 * everything the server would refuse them stays out of both menus.
 */
export function AccountRow({ className }: { className?: string }) {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [accessOpen, setAccessOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [theme, setTheme] = React.useState<ThemeChoice>(() => readTheme());
  const t = useT();
  const { user, signOut, isOwner } = useAuth();
  const navigate = useNavigate();

  async function onSignOut() {
    await signOut();
    navigate(Paths.LOGIN, { replace: true });
  }

  function chooseTheme(next: ThemeChoice) {
    applyTheme(next);
    setTheme(next);
  }

  const themeItem = (choice: ThemeChoice, Icon: typeof Sun, label: string) => (
    <DropdownMenuItem onSelect={() => chooseTheme(choice)}>
      <Icon />
      {label}
      <Check className={cn("ml-auto h-3.5 w-3.5", theme === choice ? "opacity-100" : "opacity-0")} />
    </DropdownMenuItem>
  );

  return (
    <div
      aria-label={t("account.group")}
      role="group"
      className={cn(
        "flex shrink-0 items-center gap-1 border-t border-border/60 px-2 py-1.5",
        className,
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("account.preferences")}
          title={t("account.preferences")}
          className="nav-pill gap-1.5 px-2 py-1 text-xs"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuLabel>{t("theme.menuLabel")}</DropdownMenuLabel>
          {themeItem("light", Sun, t("theme.light"))}
          {themeItem("dark", Moon, t("theme.dark"))}
          {themeItem("system", Monitor, t("theme.system"))}
          {/* Settings and Access are the INSTALL's — the routes behind them answer 403 to a
              member, so a member's gear ends at the theme. */}
          {isOwner ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                <Settings2 />
                {t("account.settings")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAccessOpen(true)}>
                <Users />
                {t("account.access")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger className="nav-pill min-w-0 max-w-[9rem] gap-1.5 px-2 py-1 text-xs">
          <UserRound className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{user?.username ?? t("account.fallback")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuLabel>{t("account.signedIn")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <UserRound />
            {t("account.editUser")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onSignOut()}>
            <LogOut />
            {t("account.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isOwner ? <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} /> : null}
      {isOwner ? <AccessDialog open={accessOpen} onOpenChange={setAccessOpen} /> : null}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("account.editUser")}</DialogTitle>
            <DialogDescription>{t("account.editUserHint", { name: user?.username ?? "" })}</DialogDescription>
          </DialogHeader>
          <OwnPasswordForm />
        </DialogContent>
      </Dialog>
    </div>
  );
}
