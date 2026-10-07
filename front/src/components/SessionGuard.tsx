import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "@/lib/api";
import { dropSession, useAuth } from "@/providers/auth";
import { Paths } from "@/lib/paths";

/**
 * Lives inside the router and the query client, so it can do two things nothing else can:
 *
 * 1. When any request 401s, drop the cache (never render data from a dead session) and route to
 *    /login through the SPA instead of a full page reload.
 * 2. When the tab regains focus, re-validate quietly. A laptop that slept for a day should find
 *    out its session expired the moment you look at it, not when you click something.
 */
/**
 * Pages no route guard watches (see routes.tsx): a 401 there has nobody else to send the person to
 * the login. Guarded pages are ProtectedRoute's to redirect — it keeps `from`, for after the login —
 * and the login page itself is where the trip ends. Keep in step with routes.tsx.
 */
const UNGUARDED_PATHS: readonly string[] = [Paths.SETUP];

export function SessionGuard() {
  const { isAuthenticated, refreshSession } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const revalidating = useRef(false);
  const { pathname } = useLocation();
  /** What React has RENDERED, for the 401 handler — which outlives any one render. */
  const rendered = useRef({ isAuthenticated, pathname });
  rendered.current = { isAuthenticated, pathname };
  /** A 401 while signed in owes a trip to the login, paid once the dropped session has rendered. */
  const loginOwed = useRef(false);

  const toLoginIfUnguarded = useCallback(
    (at: string) => {
      if (UNGUARDED_PATHS.includes(at)) navigate(Paths.LOGIN, { replace: true });
    },
    [navigate],
  );

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Never clear(): see dropSession — it froze the login on a spinner.
      const { isAuthenticated: signedIn, pathname: at } = rendered.current;
      void dropSession(queryClient).then(() => {
        // Signed out ALREADY (a setup step whose cookie never took): React shows no session, so no
        // guard can bounce back — go now. And owe nothing: a late 401 of a session that just ended
        // must not hijack some navigation later on.
        if (!signedIn) toLoginIfUnguarded(at);
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
    toLoginIfUnguarded(pathname);
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
