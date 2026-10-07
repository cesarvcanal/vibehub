import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import * as React from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { SessionGuard } from "@/components/SessionGuard";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PublicRoute } from "@/components/PublicRoute";
import { Paths } from "@/lib/paths";
import { apiReject, renderApp, setupState } from "@/test/render";
import { get, setUnauthorizedHandler } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockGet = vi.mocked(get);
const mockSetUnauthorizedHandler = vi.mocked(setUnauthorizedHandler);

/**
 * A session that expires under an open board: the next request 401s and SessionGuard routes to the
 * login. Dropping the cache with `queryClient.clear()` rebuilt the session query EMPTY and never
 * fetched it, so the guards sat on "Checking session" until a reload (production, 2026-10-07).
 */
/** Every path the router went through — a bounce shows up here whatever the render timing. */
function PathLog({ into }: { into: string[] }) {
  const { pathname } = useLocation();
  React.useEffect(() => { if (into[into.length - 1] !== pathname) into.push(pathname); }, [pathname, into]);
  return null;
}

describe("SessionGuard — a 401 under an open board", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lands on the login form, not on a spinner that only a reload clears", async () => {
    let sessionAlive = true;
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") {
        return sessionAlive
          ? Promise.resolve({ user: { id: "u1", username: "cesar", role: "owner" } })
          : Promise.reject(apiReject(401, "no session"));
      }
      return Promise.resolve({});
    });
    const paths: string[] = [];
    renderApp(
      <>
        <PathLog into={paths} />
        <SessionGuard />
        <Routes>
          <Route path={Paths.LOGIN} element={<PublicRoute><p>login form</p></PublicRoute>} />
          <Route path={Paths.BOARD} element={<ProtectedRoute><p>the board</p></ProtectedRoute>} />
        </Routes>
      </>,
      { route: Paths.BOARD },
    );
    expect(await screen.findByText("the board")).toBeInTheDocument();

    sessionAlive = false;
    const onUnauthorized = mockSetUnauthorizedHandler.mock.calls.at(-1)?.[0];
    expect(onUnauthorized).toBeTypeOf("function");
    act(() => onUnauthorized!());

    expect(await screen.findByText("login form")).toBeInTheDocument();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    // ONE trip to the login. Navigating before React had seen the dropped session made PublicRoute
    // (still reading the old user) send the board back, and the guards bounced: "/" → "/login" →
    // "/" → "/login" — a flicker for a person, a detached login node for a test under load.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(paths).toEqual([Paths.BOARD, Paths.LOGIN]);
  });
});
