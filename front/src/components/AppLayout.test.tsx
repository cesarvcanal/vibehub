import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { AppLayout } from "@/components/AppLayout";
import { renderApp, setupState } from "@/test/render";
import { get } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockGet = vi.mocked(get);

describe("AppLayout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "cesar" } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    document.documentElement.style.removeProperty("--app-header-h");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes the real header height as --app-header-h", () => {
    // jsdom lays nothing out, so offsetHeight is 0 unless we say otherwise. The point of the test
    // is that whatever the header actually measures is what lands in the variable — the open card
    // sizes itself off it with calc(100vh - var(--app-header-h) - 56px).
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(72);

    renderApp(<AppLayout />);

    expect(document.documentElement.style.getPropertyValue("--app-header-h")).toBe("72px");
    height.mockRestore();
  });

  it("re-publishes the height when the header resizes", () => {
    let measured = 64;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => measured);

    // Capture the observer callback so the test can play the part of the browser.
    let notify: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          notify = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    renderApp(<AppLayout />);
    expect(document.documentElement.style.getPropertyValue("--app-header-h")).toBe("64px");

    // The nav wrapped to a second row: the card has to shrink to match.
    measured = 104;
    notify?.();
    expect(document.documentElement.style.getPropertyValue("--app-header-h")).toBe("104px");

    vi.unstubAllGlobals();
  });

  it("renders the brand lockup and the destination pill group", async () => {
    renderApp(<AppLayout />);

    const board = await screen.findByRole("link", { name: "Board" });
    expect(board).toHaveClass("nav-pill", "nav-pill-active");
    expect(board).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("navigation", { name: "Sections" })).toContainElement(board);
  });

  it("puts the signed-in account and the theme toggle in the actions group", async () => {
    renderApp(<AppLayout />);

    const actions = screen.getByRole("navigation", { name: "Account" });
    expect(actions).toHaveClass("nav-pill-group");
    expect(await screen.findByRole("button", { name: "cesar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Theme:/ })).toBeInTheDocument();
  });
});
