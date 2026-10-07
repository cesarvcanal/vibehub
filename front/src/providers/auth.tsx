import * as React from "react";
import { hashKey, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import type { MeResponse, SetupState, User } from "@/api/types";

export const SETUP_STATE_KEY = ["setup", "state"] as const;
export const ME_KEY = ["auth", "me"] as const;

/**
 * Forget the session on this tab: after a logout, or when any request 401s.
 *
 * Not `queryClient.clear()`: that drops queries WITHOUT telling their observers. The
 * `useQuery(ME_KEY)` below then rebuilt an EMPTY session query that nothing fetched — `isLoading`
 * stayed true, the route guards sat on "Checking session" for good, and only a reload brought the
 * login back (production, 2026-10-07). Writing `null` into ME_KEY is the server's own answer ("no
 * session") and it does notify. Everything else is dropped, so no screen renders data from a dead
 * session; the setup probe stays, it is public and not tied to who is signed in.
 *
 * - A `/auth/me` already in flight is CANCELLED first, and awaited: its answer predates the logout,
 *   and landing after the `null` it would put the board back. (Cancelling restores the previous
 *   state in a microtask — written before that settles, the `null` would be undone.)
 * - Only those two EXACT keys are kept: a future `["auth", …]` must not outlive a session by accident.
 * - The mutation cache goes too, as `clear()` did: mutation variables hold passwords and tokens.
 */
export async function dropSession(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: ME_KEY, exact: true });
  queryClient.setQueryData<User | null>(ME_KEY, null);
  const kept = [hashKey(ME_KEY), hashKey(SETUP_STATE_KEY)];
  queryClient.removeQueries({ predicate: ({ queryHash }) => !kept.includes(queryHash) });
  queryClient.getMutationCache().clear();
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

  /**
   * Leaves only once the SERVER says the session is over. A logout that failed (network, 5xx) left
   * the cookie valid: showing the login anyway told someone on a shared computer they had signed
   * out when a reload put the board right back. So the session is asked again — a 401 means it is
   * gone after all (drop it, the login follows); anything else keeps the person signed in and the
   * error goes to the caller, who says the sign-out failed.
   */
  const signOut = React.useCallback(async () => {
    try {
      await post("/auth/logout");
    } catch (err) {
      const stillSignedIn = await get<MeResponse>("/auth/me").then(
        (r) => Boolean(r.user),
        (check: { response?: { status?: number } }) => check?.response?.status !== 401,
      );
      if (stillSignedIn) throw err;
    }
    await dropSession(queryClient);
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
