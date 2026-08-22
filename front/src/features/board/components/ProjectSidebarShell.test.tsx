import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ProjectSidebar } from "@/features/board/components/ProjectSidebar";
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

/**
 * The sidebar is the app's ONLY chrome now: brand at the top, account at the bottom. Those two
 * positions are the whole point — the header they replace was a band of height across the screen
 * that the terminal wanted.
 */
describe("ProjectSidebar — the shell", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "cesar" } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  function renderSidebar() {
    return renderApp(
      <ProjectSidebar
        projects={[]}
        selectedProjectId={null}
        selectedCardId={null}
        mobileOpen={false}
        onCloseMobile={vi.fn()}
        onSelectProject={vi.fn()}
        onOpenCard={vi.fn()}
        onReorder={vi.fn()}
        onNewProject={vi.fn()}
        onNewCard={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );
  }

  it("carries the brand lockup as its first row", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Projects" });
    const brand = nav.firstElementChild as HTMLElement;
    expect(brand).toHaveTextContent("vibehub");
    expect(brand.querySelector("svg")).toBeTruthy();
  });

  it("carries the account row as its last row: theme, then the signed-in user", async () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Projects" });
    const account = nav.lastElementChild as HTMLElement;

    expect(account).toContainElement(screen.getByRole("button", { name: /^Theme:/ }));
    expect(account).toContainElement(await screen.findByRole("button", { name: /cesar/ }));
  });

  it("is a full-height sticky column, so the bottom row never scrolls out of reach", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Projects" });
    expect(nav.className).toContain("lg:sticky");
    expect(nav.className).toContain("lg:h-[calc(100vh-1.5rem)]");
  });
});
