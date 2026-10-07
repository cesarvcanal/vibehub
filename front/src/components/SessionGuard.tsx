import { useEffect, useRef } from "react";
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
export function SessionGuard() {
  const { isAuthenticated, refreshSession } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const revalidating = useRef(false);
  /** A 401 owes a trip to the login — paid once React has RENDERED the dropped session (below). */
  const loginOwed = useRef(false);
  const { pathname } = useLocation();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Never clear(): see dropSession — it froze the login on a spinner.
      loginOwed.current = true;
      void dropSession(queryClient);
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  // The trip itself waits for `isAuthenticated` to turn false: react-query tells React about the
  // dropped session on a later tick, and navigating before that let PublicRoute (still reading the
  // old user) send the board back — a bounce "/" → "/login" → "/" → "/login". On a guarded page
  // ProtectedRoute redirects on its own (keeping where you were); this covers the public ones,
  // like the setup wizard, that no guard watches.
  useEffect(() => {
    if (isAuthenticated || !loginOwed.current) return;
    loginOwed.current = false;
    if (pathname !== Paths.LOGIN) navigate(Paths.LOGIN, { replace: true });
  }, [isAuthenticated, pathname, navigate]);

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
