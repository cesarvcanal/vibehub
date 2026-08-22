import * as React from "react";
import { Outlet } from "react-router-dom";

/**
 * The chrome around every signed-in screen — which is now almost nothing.
 *
 * There is no top header. The three things it carried (the brand, the one destination, the account)
 * either had no job left or belong to the sidebar: a nav bar with a single destination is a label,
 * and the brand and the account menu do not need a band of height across the whole screen. What
 * they cost was the only thing this app is actually short of — vertical room for a terminal.
 *
 * So the page is: the screen, a small even gutter, and the route. The route itself lays out the
 * sidebar (which carries the brand at its top and the account row at its bottom) and the content
 * column beside it, and that content column now starts at the very top of the viewport.
 *
 * `--app-header-h` is published as 0 for anything still reading it, so a stale `calc()` cannot
 * silently reserve space for chrome that no longer exists.
 */
export function AppLayout() {
  React.useEffect(() => {
    document.documentElement.style.setProperty("--app-header-h", "0px");
  }, []);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden">
      <main className="min-h-0 w-full flex-1 overflow-y-auto">
        <div className="min-h-full w-full p-3">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
