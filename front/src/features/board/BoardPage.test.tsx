import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardPage } from "@/features/board/BoardPage";
import { renderApp } from "@/test/render";
import { del, get, patch, post } from "@/lib/api";
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

// The terminal is exercised in its own file; here it only has to be a mountable placeholder so the
// board's routing can be asserted without a WebSocket or a canvas.
vi.mock("@/features/board/components/CardTerminalView", () => ({
  CardTerminalView: ({ cardId, onOpenMenu }: { cardId: string; onOpenMenu?: () => void }) => (
    <div data-testid="terminal">
      {cardId}
      {/* The real bar owns this button (see CardTerminalView.test); here it stands in for it, so
          the page's drawer wiring can be exercised without a canvas or a WebSocket. */}
      {onOpenMenu ? (
        <button type="button" onClick={onOpenMenu}>
          Open the card list
        </button>
      ) : null}
    </div>
  ),
}));

const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);
const mockPatch = vi.mocked(patch);
const mockDel = vi.mocked(del);

const projects: BoardProject[] = [
  { id: "p1", name: "billing", repoFullName: "acme/billing", baseBranch: "dev", position: 0, createdAt: 1 },
  { id: "p2", name: "gateway", repoFullName: "acme/gateway", baseBranch: "main", position: 1, createdAt: 2 },
];

const cards: BoardCard[] = [
  {
    id: "c1", projectId: "p1", title: "fix the totals", column: "backlog", position: 0,
    tmuxSession: "card-c1", worktreeSlug: "fix-the-totals-c1", createdAt: 1,
  },
  {
    id: "c2",
    projectId: "p1",
    title: "chase the flake",
    column: "working",
    position: 0,
    tmuxSession: "card-c2",
    worktreeSlug: "chase-the-flake-c2",
    status: "working",
    openedAt: 10,
    accountSlug: "personal",
    model: "claude-opus-5",
    createdAt: 2,
  },
  {
    id: "c3",
    projectId: "p1",
    title: "waiting on review",
    column: "waiting",
    tmuxSession: "card-c3",
    worktreeSlug: "waiting-on-review-c3",
    position: 0,
    status: "waiting",
    openedAt: 5,
    createdAt: 3,
  },
];

/** The other project's cards, so nothing is listed twice on the aggregated board. */
const gatewayCards: BoardCard[] = [
  {
    id: "c4",
    projectId: "p2",
    title: "rotate the key",
    column: "waiting",
    position: 0,
    tmuxSession: "card-c4",
    worktreeSlug: "rotate-the-key-c4",
    status: "waiting",
    openedAt: 8,
    createdAt: 4,
  },
];

function serve(overrides: { cards?: BoardCard[]; projects?: BoardProject[] } = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "operator" } });
    if (url === "/setup/state") {
      return Promise.resolve({
        fresh: false,
        steps: { owner: true, runner: true, claude: true, github: true },
        runner: { running: true, exists: true, claudeInstalled: true, dockerReachable: true, container: "runner" },
      });
    }
    if (url === "/projects") return Promise.resolve({ projects: overrides.projects ?? projects });
    // Per project: the aggregated board is only meaningful when the projects differ.
    if (url === "/projects/p2/cards") return Promise.resolve({ cards: overrides.cards ?? gatewayCards });
    if (url.endsWith("/cards")) return Promise.resolve({ cards: overrides.cards ?? cards });
    if (url === "/accounts") {
      return Promise.resolve({
        accounts: [{ slug: "personal", name: "Personal", createdAt: 1 }],
        defaultLabel: "Main",
      });
    }
    if (url === "/accounts/tokens") return Promise.resolve({ bySlug: {}, defaultHasToken: false });
    if (url === "/mcps") return Promise.resolve({ mcps: [] });
    if (url === "/mcps/secrets") return Promise.resolve({ byMcp: {} });
    if (url === "/brain") return Promise.resolve({ text: "# rules", defaultText: "# rules" });
    if (url === "/runner") {
      return Promise.resolve({
        running: true,
        exists: true,
        claudeInstalled: true,
        dockerReachable: true,
        container: "vibehub-runner",
      });
    }
    if (url === "/github") return Promise.resolve({ connected: true, login: "operator" });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe("BoardPage — the board", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("lists the projects in sidebar order and selects the first one", async () => {
    renderApp(<BoardPage />);
    const sidebar = await screen.findByRole("navigation", { name: /projects/i });
    const rows = Array.from(sidebar.querySelectorAll("[data-project-row]")).map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("billing");
    expect(rows[1]).toContain("gateway");
    expect(await screen.findByRole("heading", { name: "billing" })).toBeInTheDocument();
  });

  it("renders the five columns, waiting before working", async () => {
    renderApp(<BoardPage />);
    await screen.findByRole("region", { name: "Backlog" });
    const labels = screen.getAllByRole("region").map((r) => r.getAttribute("data-column"));
    expect(labels).toEqual(["backlog", "waiting", "working", "paused", "done"]);
  });

  it("puts each card in the column the server put it in", async () => {
    renderApp(<BoardPage />);
    const working = await screen.findByRole("region", { name: "Working" });
    expect(within(working).getByText("chase the flake")).toBeInTheDocument();
    const waiting = screen.getByRole("region", { name: "Waiting" });
    expect(within(waiting).getByText("waiting on review")).toBeInTheDocument();
    const backlog = screen.getByRole("region", { name: "Backlog" });
    expect(within(backlog).getByText("fix the totals")).toBeInTheDocument();
  });

  it("shows a status dot only for the cards the runner reported on", async () => {
    renderApp(<BoardPage />);
    await screen.findByText("chase the flake");
    expect(screen.getByRole("status", { name: "Working" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Waiting for you" })).toBeInTheDocument();
    // The backlog card has no status, so it must have no dot at all.
    expect(screen.queryAllByRole("status", { name: /working|waiting for you/i })).toHaveLength(2);
  });

  it("shows the account and model chips of a card", async () => {
    renderApp(<BoardPage />);
    await screen.findByText("chase the flake");
    expect(screen.getByText("personal")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
  });

  it("moves a card with a PATCH when it is finished", async () => {
    mockPatch.mockResolvedValue({ card: { ...cards[0]!, column: "done" } });
    const user = userEvent.setup();
    renderApp(<BoardPage />);
    await screen.findByText("fix the totals");
    await user.click(screen.getByRole("button", { name: "Finish fix the totals" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { column: "done", position: 0 }),
    );
  });

  it("pauses a card that has a session", async () => {
    mockPost.mockResolvedValue({ card: { ...cards[1]!, column: "paused" } });
    const user = userEvent.setup();
    renderApp(<BoardPage />);
    await screen.findByText("chase the flake");
    await user.click(screen.getByRole("button", { name: "Pause chase the flake" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/cards/c2/pause"));
  });

  it("offers no pause on a card that was never opened", async () => {
    renderApp(<BoardPage />);
    await screen.findByText("fix the totals");
    expect(screen.queryByRole("button", { name: "Pause fix the totals" })).not.toBeInTheDocument();
  });

  it("asks before deleting, because uncommitted work in the worktree is lost", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />);
    await screen.findByText("fix the totals");
    await user.click(screen.getByRole("button", { name: "Delete fix the totals" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/Delete “fix the totals”\?/);
  });

  it("reorders a project with the keyboard-reachable buttons", async () => {
    mockPatch.mockResolvedValue({ projects });
    const user = userEvent.setup();
    renderApp(<BoardPage />);
    await screen.findByRole("heading", { name: "billing" });
    await user.click(screen.getByRole("button", { name: "Move gateway up" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/projects/p2/order", { position: 0 }));
  });

  it("asks before deleting a project, then deletes it", async () => {
    mockDel.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderApp(<BoardPage />);
    await screen.findByRole("heading", { name: "billing" });
    await user.click(screen.getByRole("button", { name: "Delete project gateway" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/Delete “gateway”\?/);
    await user.click(screen.getByRole("button", { name: /delete project/i }));
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith("/projects/p2"));
  });

  it("invites you to create the first project when there are none", async () => {
    serve({ projects: [] });
    renderApp(<BoardPage />);
    expect(await screen.findByText(/No projects yet/i)).toBeInTheDocument();
  });
});

describe("BoardPage — deep links", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("opens the terminal for the card named in the URL", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    expect(await screen.findByTestId("terminal")).toHaveTextContent("c2");
    expect(screen.getByTestId("focus-layout")).toBeInTheDocument();
  });

  it("shows the project's board when the URL names only a project", async () => {
    renderApp(<BoardPage />, { route: "/?project=p2" });
    expect(await screen.findByRole("heading", { name: "gateway" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  });

  it("falls back to the first project when the URL names one that is gone", async () => {
    renderApp(<BoardPage />, { route: "/?project=deleted&card=c9" });
    expect(await screen.findByRole("heading", { name: "billing" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  });

  it("opening a card puts it in the URL, so a refresh lands in the same place", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await user.click(await screen.findByRole("button", { name: "chase the flake" }));
    expect(await screen.findByTestId("terminal")).toHaveTextContent("c2");
  });
});

describe("BoardPage — keyboard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("opens the new-card dialog on Cmd+K", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByText("fix the totals");
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog")).toHaveTextContent(/New card/);
  });

  it("creates the card with just a title", async () => {
    mockPost.mockResolvedValue({ card: { ...cards[0]!, id: "new" } });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByText("fix the totals");
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByLabelText("Title"), "write the migration");
    await user.click(screen.getByRole("button", { name: /create card/i }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/cards", {
        projectId: "p1",
        title: "write the migration",
      }),
    );
  });

  it("leaves focus mode on Escape", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("terminal")).not.toBeInTheDocument());
  });
});

describe("BoardPage — the install-wide managers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("puts the brain within reach of the board, beside accounts and MCP", async () => {
    // The route has existed with no way to reach it; a shared CLAUDE.md nobody can edit is a
    // feature that does not exist.
    renderApp(<BoardPage />);
    expect(await screen.findByRole("button", { name: "Brain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accounts/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MCP" })).toBeInTheDocument();
  });

  it("opens the brain editor from the board", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />);
    await user.click(await screen.findByRole("button", { name: "Brain" }));
    expect(await screen.findByLabelText("Brain text")).toBeInTheDocument();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/brain"));
  });
});

describe("BoardPage — the aggregated board", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("offers 'All projects' in the sidebar once there is more than one", async () => {
    renderApp(<BoardPage />);
    expect(await screen.findByRole("button", { name: "All projects" })).toBeInTheDocument();
  });

  it("hides it when there is only one project — there is nothing to aggregate", async () => {
    serve({ projects: [projects[0] as BoardProject] });
    renderApp(<BoardPage />);
    await screen.findByRole("heading", { name: "billing" });
    expect(screen.queryByRole("button", { name: "All projects" })).not.toBeInTheDocument();
  });

  it("shows every project's cards on one board when it is chosen", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />);
    await user.click(await screen.findByRole("button", { name: "All projects" }));
    expect(await screen.findByRole("heading", { name: "All projects" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "billing" })).not.toBeInTheDocument();
  });

  it("survives a refresh — the choice lives in the URL like any other", async () => {
    renderApp(<BoardPage />, { route: "/?project=*" });
    expect(await screen.findByRole("heading", { name: "All projects" })).toBeInTheDocument();
  });

  it("still redirects a URL that names a project which is gone", async () => {
    // The sentinel must not turn the reconciler off for real ids.
    renderApp(<BoardPage />, { route: "/?project=deleted" });
    expect(await screen.findByRole("heading", { name: "billing" })).toBeInTheDocument();
  });

  it("merges both projects' cards and opens one into its OWN project", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=*" });

    // One card from each project, on one board.
    expect(await screen.findByRole("button", { name: "chase the flake" })).toBeInTheDocument();
    const other = await screen.findByRole("button", { name: "rotate the key" });

    await user.click(other);
    expect(await screen.findByTestId("terminal")).toHaveTextContent("c4");
  });
});

describe("BoardPage — narrow screens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("offers a menu button in an open card, since the card list column is hidden", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    expect(await screen.findByRole("button", { name: "Open the card list" })).toBeInTheDocument();
  });

  it("opens the card list as a drawer and switches card from inside it", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });

    await user.click(await screen.findByRole("button", { name: "Open the card list" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: /waiting on review/ }));

    // The drawer covers the terminal it just navigated to, so it has to get out of the way.
    await waitFor(() => expect(screen.getByTestId("terminal")).toHaveTextContent("c3"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("goes back to the board from inside the drawer", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });

    await user.click(await screen.findByRole("button", { name: "Open the card list" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: /back to board/i }));

    expect(await screen.findByRole("heading", { name: "billing" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  });
});
