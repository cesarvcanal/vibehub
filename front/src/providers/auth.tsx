import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import type { MeResponse, SetupState, User } from "@/api/types";

export const SETUP_STATE_KEY = ["setup", "state"] as const;
export const ME_KEY = ["auth", "me"] as const;

export interface AuthValue {
  user: User | null;
  isAuthenticated: boolean;
  /** The install has never been configured — everything should funnel into /setup. */
  isFresh: boolean;
  setup: SetupState | undefined;
  /** Either the session or the setup probe is still in flight. */
  isLoading: boolean;
  refreshSetup: () => Promise<void>;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  // Public probe. It is the only thing that can tell us "this server has never been set up",
  // and it is what makes the wizard resumable across reloads.
  const setupQuery = useQuery({
    queryKey: SETUP_STATE_KEY,
    queryFn: () => get<SetupState>("/setup/state"),
    retry: false,
    staleTime: 2_000,
  });

  // `/auth/me` 401s when there is no session; that is an answer, not an error, so no retries
  // and no bounce (the interceptor deliberately ignores 401 on this route).
  const meQuery = useQuery({
    queryKey: ME_KEY,
    queryFn: () => get<MeResponse>("/auth/me").then((r) => r.user),
    retry: false,
    staleTime: 30_000,
  });

  const refreshSetup = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: SETUP_STATE_KEY });
  }, [queryClient]);

  const refreshSession = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
  }, [queryClient]);

  const signOut = React.useCallback(async () => {
    try {
      await post("/auth/logout");
    } finally {
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
    }
  }, [queryClient]);

  const value = React.useMemo<AuthValue>(
    () => ({
      user: meQuery.data ?? null,
      isAuthenticated: Boolean(meQuery.data),
      isFresh: setupQuery.data?.fresh === true,
      setup: setupQuery.data,
      isLoading: meQuery.isPending || setupQuery.isPending,
      refreshSetup,
      refreshSession,
      signOut,
    }),
    [
      meQuery.data,
      meQuery.isPending,
      setupQuery.data,
      setupQuery.isPending,
      refreshSetup,
      refreshSession,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
