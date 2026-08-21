import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "@/lib/api";
import { useAuth, ME_KEY } from "@/providers/auth";
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

  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.clear();
      navigate(Paths.LOGIN, { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate, queryClient]);

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
