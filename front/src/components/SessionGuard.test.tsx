import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SessionGuard } from "@/components/SessionGuard";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PublicRoute } from "@/components/PublicRoute";
import { Paths } from "@/lib/paths";
import { apiReject, renderApp, setupState } from "@/test/render";
import { get, setUnauthorizedHandler } from "@/lib/api";
import { ME_KEY } from "@/providers/auth";

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

/** Every path the router went through (and its state) — a bounce shows up here whatever the timing. */
function PathLog({ paths, states }: { paths: string[]; states: unknown[] }) {
  const { pathname, state } = useLocation();
  React.useEffect(() => {
    if (paths[paths.length - 1] !== pathname) paths.push(pathname);
    states.push(state);
  }, [pathname, state, paths, states]);
  return null;
}

/** A page that moves on by itself through the app's router, the way a person clicks a link. */
function Page({ text, next }: { text: string; next?: string }) {
  const navigate = useNavigate();
  return (
    <>
      <p>{text}</p>
      {next && <button type="button" onClick={() => navigate(next)}>go on</button>}
    </>
  );
}

/** The server's view of the session: flipping it is what logout / expiry does. */
let sessionAlive = true;

/** The app's shape: login (public, guarded), setup wizard (public, NOT guarded), board (protected). */
function mount(route: string) {
  const paths: string[] = [];
  const states: unknown[] = [];
  mockGet.mockImplementation((url: string) => {
    if (url === "/setup/state") return Promise.resolve(setupState());
    if (url === "/auth/me") {
      return sessionAlive
        ? Promise.resolve({ user: { id: "u1", username: "cesar", role: "owner" } })
        : Promise.reject(apiReject(401, "no session"));
    }
    return Promise.resolve({});
  });
  const { queryClient } = renderApp(
    <>
      <PathLog paths={paths} states={states} />
      <SessionGuard />
      <Routes>
        <Route path={Paths.LOGIN} element={<PublicRoute><Page text="login form" next={Paths.SETUP} /></PublicRoute>} />
        <Route path={Paths.SETUP} element={<Page text="the wizard" />} />
        <Route path={Paths.BOARD} element={<ProtectedRoute><Page text="the board" /></ProtectedRoute>} />
      </Routes>
    </>,
    { route },
  );
  return { paths, states, queryClient };
}

/** What any request does when the server answers 401. */
function a401(): void {
  const onUnauthorized = mockSetUnauthorizedHandler.mock.calls.at(-1)?.[0];
  expect(onUnauthorized).toBeTypeOf("function");
  act(() => onUnauthorized!());
}

/** Lets the session query answer and every queued navigation run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * A 401 means the session is gone: SessionGuard drops it and the person lands on the login — ONCE.
 * Dropping the cache with `queryClient.clear()` rebuilt the session query EMPTY and never fetched it,
 * so the guards sat on "Checking session" until a reload (production, 2026-10-07).
 */
describe("SessionGuard — a 401", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionAlive = true;
  });

  it("under an open board lands on the login — once, remembering where the person was", async () => {
    const { paths, states } = mount(Paths.BOARD);
    expect(await screen.findByText("the board")).toBeInTheDocument();

    sessionAlive = false;
    a401();

    expect(await screen.findByText("login form")).toBeInTheDocument();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    await settle();
    // ONE trip. Navigating before React had seen the dropped session made PublicRoute (still
    // reading the old user) send the board back: "/" → "/login" → "/" → "/login".
    expect(paths).toEqual([Paths.BOARD, Paths.LOGIN]);
    // A guarded page is ProtectedRoute's to redirect — it keeps `from`, for after the login.
    expect(states.at(-1)).toMatchObject({ from: { pathname: Paths.BOARD } });
  });

  it("on the setup wizard while signed in (a public page no guard watches) lands on the login", async () => {
    const { paths } = mount(Paths.SETUP);
    expect(await screen.findByText("the wizard")).toBeInTheDocument();
    await settle(); // the session query answered: signed in

    sessionAlive = false;
    a401();

    expect(await screen.findByText("login form")).toBeInTheDocument();
    await settle();
    expect(paths).toEqual([Paths.SETUP, Paths.LOGIN]);
  });

  // The router matches "/setup" case-insensitively and with a trailing slash — so must the guard,
  // or a wizard opened from a typed URL is left with no way to the login.
  it.each(["/setup/", "/SETUP"])("on the setup wizard reached as %s, signed in, lands on the login", async (at) => {
    const { paths } = mount(at);
    expect(await screen.findByText("the wizard")).toBeInTheDocument();
    await settle();

    sessionAlive = false;
    a401();

    expect(await screen.findByText("login form")).toBeInTheDocument();
    await settle();
    expect(paths).toEqual([at, Paths.LOGIN]);
  });

  it("on the setup wizard with NO session already lands on the login too", async () => {
    sessionAlive = false;
    const { paths } = mount(Paths.SETUP);
    expect(await screen.findByText("the wizard")).toBeInTheDocument();
    await settle(); // the session query answered: nobody

    a401(); // a setup step past the owner, whose cookie never took

    expect(await screen.findByText("login form")).toBeInTheDocument();
    await settle();
    expect(paths).toEqual([Paths.SETUP, Paths.LOGIN]);
  });

  it("a late 401 of the OLD session, arriving while the person signs in again, does not undo the new one", async () => {
    sessionAlive = false;
    const { paths, queryClient } = mount(Paths.LOGIN);
    expect(await screen.findByText("login form")).toBeInTheDocument();
    await settle();

    // Signing in again: the new session is being confirmed (`/auth/me` in flight)…
    let confirm: (body: unknown) => void = () => {};
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") return new Promise((resolve) => { confirm = resolve; });
      return Promise.resolve({});
    });
    void queryClient.invalidateQueries({ queryKey: ME_KEY });
    await settle();
    // …when a request of the session that just ended answers 401, late. There is no session in
    // React to drop and the login is not a page that needs one: it must not cancel the new one.
    a401();
    confirm({ user: { id: "u1", username: "cesar", role: "owner" } });

    expect(await screen.findByText("the board")).toBeInTheDocument();
    await settle();
    expect(paths).toEqual([Paths.LOGIN, Paths.BOARD]);
  });

  it("a late 401 on the login page owes nothing — it does not hijack the next navigation", async () => {
    sessionAlive = false;
    const { paths } = mount(Paths.LOGIN);
    expect(await screen.findByText("login form")).toBeInTheDocument();
    await settle();

    a401(); // a poll of the session that just ended, answering late
    await settle();
    expect(paths).toEqual([Paths.LOGIN]);

    await userEvent.click(screen.getByRole("button", { name: "go on" }));
    expect(await screen.findByText("the wizard")).toBeInTheDocument();
    await settle();
    expect(paths).toEqual([Paths.LOGIN, Paths.SETUP]);
  });
});
