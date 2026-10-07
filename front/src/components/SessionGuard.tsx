import { useCallback, useEffect, useRef } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "@/lib/api";
import { dropSession, useAuth } from "@/providers/auth";
import { Paths } from "@/lib/paths";

/**
 * Pages no route guard watches (see routes.tsx): a 401 there has nobody else to send the person to
 * the login. Guarded pages are ProtectedRoute's to redirect — it keeps `from`, for after the login —
 * and the login page itself is where the trip ends. Keep in step with routes.tsx.
 */
const UNGUARDED_PATHS: readonly string[] = [Paths.SETUP];

/** Matched the way <Routes> matches: case-insensitive, trailing slash allowed ("/setup/", "/SETUP"). */
function isUnguarded(pathname: string): boolean {
  return UNGUARDED_PATHS.some((path) => matchPath({ path }, pathname) !== null);
}

/**
 * Lives inside the router and the query client, so it can do two things nothing else can:
 *
 * 1. When any request 401s, drop the cache (never render data from a dead session) and route to
 *    /login through the SPA instead of a full page reload.
 * 2. When the tab regains focus, re-validate quietly. A laptop that slept for a day should find
 *    out its session expired the moment you look at it, not when you click something.
 */
export function SessionGuard() {
  const { isAuthenticated, refreshSession } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const revalidating = useRef(false);
  const { pathname } = useLocation();
  /**
   * What React has RENDERED, for the 401 handler — which outlives any one render. `navigate` rides
   * along: its identity changes on every route change, and the handler need not be re-registered.
   */
  const rendered = useRef({ isAuthenticated, pathname, navigate });
  rendered.current = { isAuthenticated, pathname, navigate };
  /** A 401 while signed in owes a trip to the login, paid once the dropped session has rendered. */
  const loginOwed = useRef(false);

  /** Read at the moment of the trip — the page may have changed since the 401. */
  const toLoginIfUnguarded = useCallback((): void => {
    const { pathname: at, navigate: go } = rendered.current;
    if (isUnguarded(at)) go(Paths.LOGIN, { replace: true });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Never clear(): see dropSession — it froze the login on a spinner.
      const signedIn = rendered.current.isAuthenticated;
      // No session on screen and no page that needs one: nothing to drop. Typically a request of
      // the session that just ended, answering late while the person signs in AGAIN — dropping
      // here would cancel the new session's `/auth/me` and send them back to the login.
      if (!signedIn && !isUnguarded(rendered.current.pathname)) return;
      void dropSession(queryClient).then(() => {
        // Signed out ALREADY (a setup step whose cookie never took): React shows no session, so no
        // guard can bounce back — go now. And owe nothing: a late 401 of a session that just ended
        // must not hijack some navigation later on.
        if (!signedIn) toLoginIfUnguarded();
      });
      if (signedIn) loginOwed.current = true;
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient, toLoginIfUnguarded]);

  // Signed in when the 401 came: the trip waits for `isAuthenticated` to turn false. react-query
  // tells React about the dropped session on a later tick, and navigating before that let
  // PublicRoute (still reading the old user) send the board back — a bounce "/" → "/login" → "/" →
  // "/login".
  useEffect(() => {
    if (isAuthenticated || !loginOwed.current) return;
    loginOwed.current = false;
    toLoginIfUnguarded();
  }, [isAuthenticated, pathname, toLoginIfUnguarded]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const revalidate = () => {
      if (document.visibilityState !== "visible") return;
      if (revalidating.current) return;
      revalidating.current = true;
      void refreshSession()
        .catch(() => undefined)
        .finally(() => {
          revalidating.current = false;
        });
    };

    const onVisibility = () => revalidate();
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isAuthenticated, refreshSession]);

  return null;
}
