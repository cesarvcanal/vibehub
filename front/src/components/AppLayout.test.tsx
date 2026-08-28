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
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "cesar", role: "owner" } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    document.documentElement.style.removeProperty("--app-header-h");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has no top header at all — the page belongs to the content column", () => {
    renderApp(<AppLayout />);

    // The three things the header carried moved into the sidebar (brand, account) or were dropped
    // (a nav bar with one destination). What it cost was terminal height.
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Sections" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Board" })).not.toBeInTheDocument();
  });

  it("publishes a zero header height, so no stale calc() reserves space for chrome that is gone", () => {
    renderApp(<AppLayout />);
    expect(document.documentElement.style.getPropertyValue("--app-header-h")).toBe("0px");
  });

  it("gives the route the full screen with one small even gutter", () => {
    const { container } = renderApp(<AppLayout />);

    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain("h-screen");
    const gutter = container.querySelector("main > div") as HTMLElement;
    expect(gutter.className).toContain("p-3");
    expect(gutter.className).not.toContain("py-7");
  });
});
