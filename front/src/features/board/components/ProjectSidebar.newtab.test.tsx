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
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "sam", role: "owner" } });
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

/**
 * The brand at the top of the panel is a REAL link home (the aggregated board), for the same
 * reason the project rows are: middle-click and Cmd/Ctrl/Shift-click must open a new tab natively,
 * while a plain click stays an in-app navigation.
 */
describe("ProjectSidebar — the logo is a link home", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "sam", role: "owner" } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  function renderSidebar(onShowAllProjects = vi.fn()) {
    renderApp(
      <ProjectSidebar
        projects={[project]}
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
        onShowAllProjects={onShowAllProjects}
      />,
    );
    return onShowAllProjects;
  }

  function logoLink(): HTMLElement {
    return screen.getByRole("link", { name: "All projects" });
  }

  it("exposes the aggregated board's URL as its href", () => {
    renderSidebar();
    expect(logoLink()).toHaveAttribute("href", "?");
  });

  it("navigates in-app on a plain click, cancelling the browser navigation", () => {
    const onShowAllProjects = renderSidebar();
    const notPrevented = fireEvent.click(logoLink());
    expect(notPrevented).toBe(false);
    expect(onShowAllProjects).toHaveBeenCalledTimes(1);
  });

  it("lets the browser open a new tab on Cmd/Ctrl/Shift/middle-click", () => {
    const onShowAllProjects = renderSidebar();
    const link = logoLink();

    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(link, { shiftKey: true })).toBe(true);
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onShowAllProjects).not.toHaveBeenCalled();
  });
});

/**
 * The project switcher — the header of an open project — is a link too. Its plain click opens the
 * menu, as it always did, but the browser's "open it somewhere else" gestures now reach the project
 * it NAMES, exactly like middle-clicking the brand reaches the aggregated board.
 */
describe("ProjectSidebar — the switcher opens the current project in a new tab", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "sam", role: "owner" } });
      if (url === "/projects/p1/cards") return Promise.resolve({ cards: [] });
      if (url === "/accounts") return Promise.resolve({ accounts: [], defaultLabel: "Main" });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  function renderFocused(onSelectProject = vi.fn()) {
    renderApp(
      <ProjectSidebar
        projects={[project]}
        selectedProjectId="p1"
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

  /** Still a button to a screen reader and to the keyboard: pressing it opens the menu. */
  const trigger = () => screen.getByRole("button", { name: "Switch project" });

  it("carries the open project's own URL as its href", () => {
    renderFocused();
    expect(trigger()).toHaveAttribute("href", "?project=p1");
  });

  it("still opens the menu on a plain click, without navigating", async () => {
    renderFocused();
    const user = userEvent.setup();

    await user.click(trigger());

    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("a plain click cancels the browser navigation", () => {
    renderFocused();
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.click(trigger())).toBe(false);
  });

  it("lets the browser open the project on middle-click, and leaves the menu shut", () => {
    renderFocused();
    const el = trigger();

    fireEvent.pointerDown(el, { button: 1 });
    const notPrevented = fireEvent.click(el, { button: 1 });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does the same for Cmd/Ctrl/Shift-click", () => {
    renderFocused();
    const el = trigger();

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      fireEvent.pointerDown(el, { button: 0, ...modifier });
      expect(fireEvent.click(el, modifier)).toBe(true);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    }
  });
});
