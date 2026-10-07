import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { get, setUnauthorizedHandler } from "@/lib/api";
import type { MeResponse } from "@/api/types";
import { dropSession, useAuth } from "@/providers/auth";
import { Paths } from "@/lib/paths";

/**
 * Lives inside the router and the query client, so it can do two things nothing else can:
 *
 * 1. When any request 401s, drop the cache (never render data from a dead session) and route to
 *    /login through the SPA instead of a full page reload — once `/auth/me` CONFIRMS the session is
 *    gone. A 401 can outlive the session it was about: changing your own password revokes every
 *    cookie signed before it, so a poll already in flight with the old cookie 401s while the fresh
 *    cookie is on its way back. Logging the person out for that would undo a change that worked.
 * 2. When the tab regains focus, re-validate quietly. A laptop that slept for a day should find
 *    out its session expired the moment you look at it, not when you click something.
 */
export function SessionGuard() {
  const { isAuthenticated, refreshSession } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const revalidating = useRef(false);
  /** One confirmation for a burst of 401s (every poll on the page fails together). */
  const confirming = useRef(false);

  useEffect(() => {
    const signOutHere = (): void => {
      dropSession(queryClient);
      navigate(Paths.LOGIN, { replace: true });
    };
    setUnauthorizedHandler(() => {
      if (confirming.current) return;
      confirming.current = true;
      // `/auth/me` is a silent route: its own 401 never re-enters this handler.
      void get<MeResponse>("/auth/me")
        .then(({ user }) => {
          if (!user) return signOutHere();
          // Still signed in: what 401'd only raced a cookie swap — fetch it again with the new one.
          void queryClient.invalidateQueries({ predicate: (query) => query.state.status === "error" });
        })
        .catch(signOutHere)
        .finally(() => {
          confirming.current = false;
        });
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
