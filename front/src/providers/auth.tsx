import * as React from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import type { MeResponse, SetupState, User } from "@/api/types";

export const SETUP_STATE_KEY = ["setup", "state"] as const;
export const ME_KEY = ["auth", "me"] as const;

/**
 * Forget the session on this tab: after a logout, or when any request 401s.
 *
 * Not `queryClient.clear()`: that drops queries WITHOUT telling their observers, so the
 * `useQuery(ME_KEY)` below kept rendering the old user — PublicRoute bounced /login back to the
 * board, the board 401'd, and round it went. Writing `null` into ME_KEY is the server's own answer
 * ("no session") and it does notify. Everything else is dropped, so no screen renders data from a
 * dead session; the setup probe stays, it is public and not tied to who is signed in.
 */
export function dropSession(queryClient: QueryClient): void {
  queryClient.setQueryData<User | null>(ME_KEY, null);
  queryClient.removeQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] !== ME_KEY[0] && queryKey[0] !== SETUP_STATE_KEY[0],
  });
}

export interface AuthValue {
  user: User | null;
  isAuthenticated: boolean;
  /**
   * The signed-in person runs this install. It decides what the UI even OFFERS — the managers, the
   * settings, the New project button. The server enforces the same thing on every route; this is
   * so a member is never shown a button that would 403.
   *
   * Unknown (no session yet) reads as false: show nothing until we know.
   */
  isOwner: boolean;
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
    // `null` is "no session" written by dropSession(); a 401 here lands as an error instead.
    queryFn: () => get<MeResponse>("/auth/me").then((r): User | null => r.user),
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
      dropSession(queryClient);
    }
  }, [queryClient]);

  const value = React.useMemo<AuthValue>(
    () => ({
      user: meQuery.data ?? null,
      isAuthenticated: Boolean(meQuery.data),
      isOwner: meQuery.data?.role === "owner",
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
