import * as React from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { Columns3, LogOut, Settings2, UserRound } from "lucide-react";
import { useAuth } from "@/providers/auth";
import { Paths } from "@/lib/paths";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Publishes the header's real height as `--app-header-h` on <html>.
 *
 * The header has no fixed height — on a narrow screen the nav wraps to a second row — so anything
 * sizing itself against "the viewport minus the chrome" (the open card fills
 * `calc(100vh - var(--app-header-h) - 56px)`, the 56px being this layout's `py-7`) has to measure
 * it rather than assume 64px.
 */
function useHeaderHeight(ref: React.RefObject<HTMLElement>) {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty("--app-header-h", `${el.offsetHeight}px`);
    publish();
    if (typeof ResizeObserver === "undefined") return; // jsdom has none; the value above still stands
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}

/** The chrome around every signed-in screen: the brand bar, then the page fills the rest. */
export function AppLayout() {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const headerRef = React.useRef<HTMLElement>(null);
  useHeaderHeight(headerRef);

  async function onSignOut() {
    await signOut();
    navigate(Paths.LOGIN, { replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header
        ref={headerRef}
        className="sticky top-0 z-30 border-b border-border/70 bg-background/70 backdrop-blur-xl"
      >
        <div className="mx-auto flex min-h-16 max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2">
          <span className="shrink-0">
            <Logo />
          </span>

          {/* Destinations. There is one today; it still lives in the bordered group so the bar
              keeps its shape as more arrive. */}
          <nav aria-label="Sections" className="nav-pill-group">
            <Link to={Paths.BOARD} className="nav-pill nav-pill-active" aria-current="page">
              <Columns3 className="h-4 w-4" />
              Board
            </Link>
          </nav>

          {/* Actions — same bordered pill group as the destinations, so the header reads as one
              system instead of two different button styles. */}
          <nav aria-label="Account" className="nav-pill-group ml-auto shrink-0">
            <ThemeToggle />
            <div className="nav-pill-divider" />
            <DropdownMenu>
              <DropdownMenuTrigger className="nav-pill">
                <UserRound className="h-4 w-4" />
                {user?.username ?? "account"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Signed in</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                  <Settings2 />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void onSignOut()}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>
        </div>
      </header>

      <main className="min-h-0 w-full flex-1">
        <div className="h-full w-full px-6 py-7">
          <Outlet />
        </div>
      </main>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
