import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountRow } from "@/components/AccountRow";
import { renderApp, setupState } from "@/test/render";
import * as React from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PublicRoute } from "@/components/PublicRoute";
import { Paths } from "@/lib/paths";
import { get, post } from "@/lib/api";
import { toast } from "sonner";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const mockGet = vi.mocked(get);

/** Every path the router went through — a bounce shows up here whatever the render timing. */
function PathLog({ into }: { into: string[] }) {
  const { pathname } = useLocation();
  React.useEffect(() => { if (into[into.length - 1] !== pathname) into.push(pathname); }, [pathname, into]);
  return null;
}

function serveAs(role: "owner" | "member") {
  mockGet.mockImplementation((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "cesar", role } });
    if (url === "/setup/state") return Promise.resolve(setupState());
    return Promise.resolve({});
  });
}

/**
 * The footer's two doors: the GEAR (theme + the install's management, for the owner) and the USER
 * (your own account, sign out). The old cycling theme button read as a status; the old user menu
 * mixed "who am I" with "how the install works".
 */
describe("AccountRow — the gear", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers the three themes plus Settings and Access to the owner", async () => {
    serveAs("owner");
    renderApp(<AccountRow />);
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Light")).toBeInTheDocument();
    expect(within(menu).getByText("Dark")).toBeInTheDocument();
    expect(within(menu).getByText("System")).toBeInTheDocument();
    expect(within(menu).getByText("Settings")).toBeInTheDocument();
    expect(within(menu).getByText("Access")).toBeInTheDocument();
  });

  it("ends at the theme for a member — Settings and Access are the install's", async () => {
    serveAs("member");
    renderApp(<AccountRow />);
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Dark")).toBeInTheDocument();
    expect(within(menu).queryByText("Settings")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Access")).not.toBeInTheDocument();
  });

  it("applies a chosen theme to the document", async () => {
    serveAs("owner");
    renderApp(<AccountRow />);
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    await userEvent.click(await screen.findByText("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    // Leave the suite the way it was found.
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem("vibehub.theme");
  });
});

describe("AccountRow — the user", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers exactly Edit user and Sign out", async () => {
    serveAs("member");
    renderApp(<AccountRow />);
    await userEvent.click(await screen.findByRole("button", { name: /cesar/ }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Edit user", "Sign out"]);
  });

  it("Edit user opens the own-password form, for a member too", async () => {
    serveAs("member");
    renderApp(<AccountRow />);
    await userEvent.click(await screen.findByRole("button", { name: /cesar/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit user" }));
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
  });

  /**
   * The whole trip, through the real route guards — what a person sees, not what the provider holds.
   * Dropping the cache with `queryClient.clear()` left the session query rebuilt EMPTY and never
   * fetched: `isLoading` stayed true, PublicRoute sat on "Checking session" forever and only a
   * reload brought the login back (production, 2026-10-07).
   */
  it("Sign out lands on the login form — not on a spinner that only a reload clears", async () => {
    let signedIn = true;
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") {
        return signedIn
          ? Promise.resolve({ user: { id: "u1", username: "cesar", role: "owner" } })
          : Promise.reject(Object.assign(new Error("401"), { response: { status: 401, data: {} } }));
      }
      return Promise.resolve({});
    });
    vi.mocked(post).mockImplementation(async () => {
      signedIn = false;
      return {};
    });
    const paths: string[] = [];
    renderApp(
      <>
        <PathLog into={paths} />
        <Routes>
          <Route path={Paths.LOGIN} element={<PublicRoute><p>login form</p></PublicRoute>} />
          <Route path={Paths.BOARD} element={<ProtectedRoute><AccountRow /></ProtectedRoute>} />
        </Routes>
      </>,
      { route: Paths.BOARD },
    );
    await userEvent.click(await screen.findByRole("button", { name: /cesar/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByText("login form")).toBeInTheDocument();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    // ONE trip: navigating before React saw the dropped session bounced through the board again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(paths).toEqual([Paths.BOARD, Paths.LOGIN]);
  });

  /** The board behind the guard, with the account menu in it — the screen a person signs out from. */
  function boardWithAccountMenu() {
    return renderApp(
      <Routes>
        <Route path={Paths.LOGIN} element={<PublicRoute><p>login form</p></PublicRoute>} />
        <Route
          path={Paths.BOARD}
          element={<ProtectedRoute><p>the board</p><AccountRow /></ProtectedRoute>}
        />
      </Routes>,
      { route: Paths.BOARD },
    );
  }

  /**
   * A sign-out the SERVER never confirmed must not pretend: showing the login while the cookie is
   * still valid tells someone on a shared computer they left when they did not — a reload puts the
   * board back. The session is asked again, and the person is told the sign-out failed.
   */
  it("a sign-out the server refused keeps the board and says so — the session is still alive", async () => {
    serveAs("owner");
    vi.mocked(post).mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 502, data: {} } }));
    boardWithAccountMenu();
    await userEvent.click(await screen.findByRole("button", { name: /cesar/ }));
    const meCallsBefore = mockGet.mock.calls.filter(([url]) => url === "/auth/me").length;
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    await vi.waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    expect(mockGet.mock.calls.filter(([url]) => url === "/auth/me").length).toBeGreaterThan(meCallsBefore);
    expect(screen.getByText("the board")).toBeInTheDocument();
    expect(screen.queryByText("login form")).not.toBeInTheDocument();
  });

  it("a sign-out that failed on a session the server already dropped still lands on the login", async () => {
    let alive = true;
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") {
        return alive
          ? Promise.resolve({ user: { id: "u1", username: "cesar", role: "owner" } })
          : Promise.reject(Object.assign(new Error("401"), { response: { status: 401, data: {} } }));
      }
      return Promise.resolve({});
    });
    vi.mocked(post).mockImplementation(async () => {
      alive = false; // the session died, and the logout call itself failed on the way back
      throw Object.assign(new Error("boom"), { response: { status: 502, data: {} } });
    });
    boardWithAccountMenu();
    await userEvent.click(await screen.findByRole("button", { name: /cesar/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByText("login form")).toBeInTheDocument();
  });
});
