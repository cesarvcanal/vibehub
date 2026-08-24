import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSidebar } from "@/features/board/components/ProjectSidebar";
import type { BoardProject } from "@/features/board/api";
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

const project: BoardProject = {
  id: "p1",
  name: "billing",
  repoFullName: "acme/billing",
  baseBranch: "dev",
  position: 0,
  createdAt: 1,
};

/**
 * A project row is a REAL link (like a card row), so the browser's own habits keep working:
 * middle-click and Cmd/Ctrl/Shift-click open the project in a new tab, while a plain click is
 * intercepted and handled in-app.
 */
describe("ProjectSidebar — a project row is a navigable link", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "cesar" } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  function renderSidebar(onSelectProject = vi.fn()) {
    renderApp(
      <ProjectSidebar
        projects={[project]}
        selectedProjectId={null}
        selectedCardId={null}
        mobileOpen={false}
        onCloseMobile={vi.fn()}
        onSelectProject={onSelectProject}
        onOpenCard={vi.fn()}
        onReorder={vi.fn()}
        onNewProject={vi.fn()}
        onNewCard={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );
    return onSelectProject;
  }

  it("exposes the project's own URL as the row's href, so hover and copy-link both work", () => {
    renderSidebar();
    const link = screen.getByRole("link", { name: "billing" });
    expect(link).toHaveAttribute("href", "?project=p1");
  });

  it("selects the project in-app on a plain click, and prevents the browser navigation", async () => {
    const onSelectProject = renderSidebar();
    const user = userEvent.setup();

    const link = screen.getByRole("link", { name: "billing" });
    await user.click(link);

    expect(onSelectProject).toHaveBeenCalledWith("p1");
  });

  it("a plain click cancels the default navigation (the SPA takes over)", () => {
    renderSidebar();
    const link = screen.getByRole("link", { name: "billing" });
    // fireEvent returns false when the handler called preventDefault.
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
  });

  it("lets the browser open a new tab on Cmd-click: no in-app select, no preventDefault", () => {
    const onSelectProject = renderSidebar();
    const link = screen.getByRole("link", { name: "billing" });

    const notPrevented = fireEvent.click(link, { metaKey: true });

    expect(onSelectProject).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("does the same for Ctrl-click (Windows/Linux new tab)", () => {
    const onSelectProject = renderSidebar();
    const link = screen.getByRole("link", { name: "billing" });

    const notPrevented = fireEvent.click(link, { ctrlKey: true });

    expect(onSelectProject).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("does the same for Shift-click and middle-click", () => {
    const onSelectProject = renderSidebar();
    const link = screen.getByRole("link", { name: "billing" });

    expect(fireEvent.click(link, { shiftKey: true })).toBe(true);
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onSelectProject).not.toHaveBeenCalled();
  });
});
