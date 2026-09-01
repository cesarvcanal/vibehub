import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CardTile } from "@/features/board/components/CardTile";
import { KanbanBoard } from "@/features/board/components/KanbanBoard";
import { ProjectSidebar } from "@/features/board/components/ProjectSidebar";
import { renderApp, setupState } from "@/test/render";
import { get } from "@/lib/api";
import type { BoardCard, BoardProject } from "@/features/board/api";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const mockGet = vi.mocked(get);

const project: BoardProject = {
  id: "p1", name: "billing", repoFullName: "acme/billing", baseBranch: "dev", position: 0, createdAt: 1,
};

const cards: BoardCard[] = [
  {
    id: "c1", projectId: "p1", title: "fix the totals", column: "working", position: 0,
    tmuxSession: "card-c1", worktreeSlug: "fix-the-totals-c1", status: "working", openedAt: 5, createdAt: 1,
  },
];

/**
 * WHO the signed-in person is decides what the UI even offers. The server enforces the same split
 * on every route — these tests are about never showing a member a button that would answer 403.
 */
function serveAs(role: "owner" | "member") {
  mockGet.mockImplementation((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "person", role } });
    if (url === "/setup/state") return Promise.resolve(setupState());
    if (url === "/projects/p1/cards") return Promise.resolve({ cards });
    if (url === "/accounts") return Promise.resolve({ accounts: [], defaultLabel: "Main" });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe("role-aware UI — the card tile's menu", () => {
  beforeEach(() => vi.clearAllMocks());

  async function openMenu() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for fix the totals" }));
    return user;
  }

  function renderTile() {
    renderApp(
      <CardTile card={cards[0]} onOpen={vi.fn()} onDone={vi.fn()} onPause={vi.fn()}
        onAccount={vi.fn()} onDelete={vi.fn()} />,
    );
  }

  it("offers the owner the account switch, the share and the delete", async () => {
    serveAs("owner");
    renderTile();
    await openMenu();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Claude account…")).toBeInTheDocument();
    expect(within(menu).getByText("Share…")).toBeInTheDocument();
    expect(within(menu).getByText("Delete card")).toBeInTheDocument();
  });

  it("hides all three from a member — the routes behind them are the owner's", async () => {
    serveAs("member");
    renderTile();
    await openMenu();
    const menu = await screen.findByRole("menu");
    // The work-level actions stay: pausing and finishing go through requireCardWork.
    expect(within(menu).getByText("Finish (move to Done)")).toBeInTheDocument();
    expect(within(menu).queryByText("Claude account…")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Share…")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Delete card")).not.toBeInTheDocument();
  });
});

describe("role-aware UI — the kanban's create buttons", () => {
  beforeEach(() => vi.clearAllMocks());

  function renderBoard() {
    renderApp(
      <KanbanBoard project={project} onOpenCard={vi.fn()} onNewCard={vi.fn()} onNewBacklogCard={vi.fn()} />,
    );
  }

  it("shows the owner New card and the backlog's add button", async () => {
    serveAs("owner");
    renderBoard();
    expect(await screen.findByRole("button", { name: /New card/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Add to backlog/ })).toBeInTheDocument();
  });

  it("hides both from a member — POST /api/cards is the owner's", async () => {
    serveAs("member");
    renderBoard();
    // Wait for the board to actually render its cards before asserting absence.
    await screen.findByRole("link", { name: "fix the totals" });
    expect(screen.queryByRole("button", { name: /New card/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to backlog/ })).not.toBeInTheDocument();
  });
});

describe("role-aware UI — the sidebar without management", () => {
  beforeEach(() => vi.clearAllMocks());

  function renderSidebar(selectedProjectId: string | null) {
    renderApp(
      <ProjectSidebar
        projects={[project]}
        selectedProjectId={selectedProjectId}
        selectedCardId={null}
        mobileOpen={false}
        onCloseMobile={vi.fn()}
        onSelectProject={vi.fn()}
        onOpenCard={vi.fn()}
        onReorder={vi.fn()}
        onNewProject={vi.fn()}
        onNewCard={vi.fn()}
        onDeleteProject={vi.fn()}
        canManage={false}
      />,
    );
  }

  it("offers no New project and no per-row new card on the project list", async () => {
    serveAs("member");
    renderSidebar(null);
    await screen.findByRole("navigation", { name: "Projects" });
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New card in billing" })).not.toBeInTheDocument();
  });

  it("offers no New project row in the switcher of a focused project", async () => {
    serveAs("member");
    renderSidebar("p1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Switch project" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("New project")).not.toBeInTheDocument();
    // And the switcher's `+` (new card in this project) is gone too.
    expect(screen.queryByRole("button", { name: "New card in billing" })).not.toBeInTheDocument();
  });

  it("keeps both for the owner (canManage)", async () => {
    serveAs("owner");
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
        canManage
      />,
    );
    expect(await screen.findByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "New card in billing" })).toBeInTheDocument();
  });
});
