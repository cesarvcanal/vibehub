import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
// board's routing can be asserted without a WebSocket or a canvas. It counts its own mounts: the
// deck's whole promise is that switching cards does NOT mount a second terminal for a card that is
// already open, and a placeholder that cannot see a remount cannot prove it.
const mounts: string[] = [];
vi.mock("@/features/board/components/CardTerminalView", async () => {
  const React = await import("react");
  return {
    CardTerminalView: ({
      cardId,
      active,
      onOpenMenu,
    }: {
      cardId: string;
      active?: boolean;
      onOpenMenu?: () => void;
    }) => {
      React.useEffect(() => {
        mounts.push(cardId);
      }, [cardId]);
      return (
        <div data-testid="terminal" data-card={cardId} data-active={active ? "true" : "false"}>
          {cardId}
          {/* The real bar owns this button (see CardTerminalView.test); here it stands in for it, so
              the page's drawer wiring can be exercised without a canvas or a WebSocket. */}
          {onOpenMenu ? (
            <button type="button" onClick={onOpenMenu}>
              Open the card list
            </button>
          ) : null}
        </div>
      );
    },
  };
});

/**
 * The terminal ON TOP, or null when the board is showing.
 *
 * Every card that has been opened is still mounted — that is the point of the deck — so "is the
 * terminal there" is no longer the question. The question is which pane is the active one.
 */
function activeTerminal(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-card-pane][data-active="true"] [data-testid="terminal"]');
}

/** Every card that still holds a live pane, in render order. */
function livePanes(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-card-pane]")).map(
    (el) => el.getAttribute("data-card-pane") ?? "",
  );
}

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
    if (/^\/cards\/[^/]+\/messages$/.test(url)) return Promise.resolve({ pending: [], agent: "running" });
    if (/^\/cards\/[^/]+\/session$/.test(url)) {
      return Promise.resolve({ model: null, modelLabel: null, account: { slug: null, name: "" } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

/** The one sidebar — the same element on the board and beside an open card. */
function sidebar() {
  return screen.getByRole("navigation", { name: /projects/i });
}

/**
 * Opens a card's `⋯` menu from the board. The column is named because the same card also has a row
 * in the sidebar — two links with the same name, deliberately.
 */
async function openTileMenu(
  user: ReturnType<typeof userEvent.setup>,
  column: string,
  title: string,
) {
  const tile = within(screen.getByRole("region", { name: column })).getByRole("link", { name: title });
  await user.click(within(tile).getByRole("button", { name: `Actions for ${title}` }));
}

describe("BoardPage — the board", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("lists every project in sidebar order, on the board as well as beside a card", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });
    const rows = Array.from(sidebar().querySelectorAll("[data-project-row]")).map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("billing");
    expect(rows[1]).toContain("gateway");
  });

  it("renders the five columns as a life cycle: backlog, paused, waiting, working, done", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });
    const labels = screen.getAllByRole("region").map((r) => r.getAttribute("data-column"));
    expect(labels).toEqual(["backlog", "paused", "waiting", "working", "done"]);
  });

  it("puts each card in the column the server put it in", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const working = await screen.findByRole("region", { name: "Working" });
    expect(within(working).getByText("chase the flake")).toBeInTheDocument();
    const waiting = screen.getByRole("region", { name: "Waiting" });
    expect(within(waiting).getByText("waiting on review")).toBeInTheDocument();
    const backlog = screen.getByRole("region", { name: "Backlog" });
    expect(within(backlog).getByText("fix the totals")).toBeInTheDocument();
  });

  it("counts the cards instead of repeating the project's name", async () => {
    // The sidebar beside it already says which project is selected, in the same eyeful.
    renderApp(<BoardPage />, { route: "/?project=p1" });
    expect(await screen.findByText("3 cards")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "billing" })).not.toBeInTheDocument();
  });

  it("shows a status dot only for the cards the runner reported on", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Working" });
    expect(screen.getByRole("status", { name: "Working" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Waiting for you" })).toBeInTheDocument();
    // The backlog card has no status, so it must have no dot at all — not even a placeholder.
    expect(screen.queryAllByRole("status", { name: /working|waiting for you/i })).toHaveLength(2);
  });

  it("shows the card's own account and no model chip", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Working" });
    expect(screen.getByText("personal")).toBeInTheDocument();
    expect(screen.queryByText("opus")).not.toBeInTheDocument();
  });

  it("moves a card with a PATCH when it is finished from the ⋯ menu", async () => {
    mockPatch.mockResolvedValue({ card: { ...cards[0]!, column: "done" } });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });

    await openTileMenu(user, "Backlog", "fix the totals");
    await user.click(await screen.findByRole("menuitem", { name: "Finish (move to Done)" }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { column: "done", position: 0 }),
    );
  });

  it("pauses a card that has a session", async () => {
    mockPost.mockResolvedValue({ card: { ...cards[1]!, column: "paused" } });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Working" });

    await openTileMenu(user, "Working", "chase the flake");
    await user.click(await screen.findByRole("menuitem", { name: "Pause (ends the session)" }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/cards/c2/pause"));
  });

  it("offers no pause on a card that was never opened", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });

    await openTileMenu(user, "Backlog", "fix the totals");
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).not.toContain("Pause (ends the session)");
  });

  it("asks before deleting, because uncommitted work in the worktree is lost", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });

    await openTileMenu(user, "Backlog", "fix the totals");
    await user.click(await screen.findByRole("menuitem", { name: "Delete card" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(/Delete “fix the totals”\?/);
  });

  it("switches a card's Claude account from a dialog, saying what it costs", async () => {
    mockPatch.mockResolvedValue({ card: cards[1]! });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Working" });

    await openTileMenu(user, "Working", "chase the flake");
    await user.click(await screen.findByRole("menuitem", { name: "Claude account…" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Claude account for “chase the flake”/);
    expect(dialog).toHaveTextContent(/restarts this card's Claude session/);

    await user.selectOptions(within(dialog).getByLabelText("Account"), "");
    await user.click(within(dialog).getByRole("button", { name: "Switch account" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c2", { accountSlug: null }));
  });

  it("invites you to create the first project when there are none", async () => {
    serve({ projects: [] });
    renderApp(<BoardPage />);
    expect(await screen.findByText(/No projects yet/i)).toBeInTheDocument();
  });
});

describe("BoardPage — the sidebar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("unfolds the selected project's cards, and only that project's", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    // The active cards of the selected project, right under its row.
    expect(await within(nav).findByRole("link", { name: "chase the flake" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "waiting on review" })).toBeInTheDocument();
    // The backlog one hides behind "show more"; finished cards never appear at all.
    expect(within(nav).queryByRole("link", { name: "fix the totals" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "show more (1)" })).toBeInTheDocument();
  });

  it("reveals the idle cards, then puts them away again", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.click(await within(nav).findByRole("button", { name: "show more (1)" }));
    expect(within(nav).getByRole("link", { name: "fix the totals" })).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "show less" }));
    expect(within(nav).queryByRole("link", { name: "fix the totals" })).not.toBeInTheDocument();
  });

  /**
   * The card you just named has to be THERE. It used to need a round trip to the server AND a status
   * from the runner before it existed on screen: a new card lands in the backlog, and the sidebar
   * only listed the live columns — so you typed a title, got nothing, and clicked at a row that was
   * not there yet.
   */
  it("puts a card you just created in the list at once, without waiting for a refetch", async () => {
    const user = userEvent.setup();
    // The server keeps answering with the OLD list: only the local write can put the row on screen.
    mockPost.mockResolvedValue({
      card: {
        id: "c9", projectId: "p1", title: "brand new", column: "backlog", position: 1,
        tmuxSession: "card-c9", worktreeSlug: "brand-new-c9", createdAt: 9,
      },
    });
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.click(within(nav).getByRole("button", { name: "New card in billing" }));
    await user.type(await screen.findByLabelText("Title"), "brand new");
    // From here on the server never answers another card list: whatever shows up on screen is the
    // local write, not a refetch.
    const stale = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string) =>
      url.endsWith("/cards") ? new Promise(() => {}) : stale(url),
    );
    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(mockPost).toHaveBeenCalledWith("/cards", expect.objectContaining({ projectId: "p1", title: "brand new" }));
    // In the backlog, so it rides with the folded cards — but the count says it exists NOW.
    expect(await within(nav).findByRole("button", { name: "show more (2)" })).toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "show more (2)" }));
    expect(within(nav).getByRole("link", { name: "brand new" })).toBeInTheDocument();
    // And on the board itself, in the column it was created in.
    expect(within(screen.getByRole("region", { name: "Backlog" })).getByRole("link", { name: "brand new" }))
      .toBeInTheDocument();
  });

  it("keeps a row for the card you are IN, even when it sits in the backlog", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1&card=c1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });
    // c1 is a backlog card: it is on screen, so it is in the list — not hidden behind "show more".
    expect(await within(nav).findByRole("link", { name: "fix the totals" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /show more/ })).not.toBeInTheDocument();
  });

  it("deselects the project when its row is clicked a second time", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });
    await within(nav).findByRole("link", { name: "chase the flake" });

    await user.click(within(nav).getByRole("link", { name: "billing" }));

    // Deselected: the aggregated board, and no board of its own. The cards stay UNFOLDED — the
    // fold belongs to the chevron now, and navigating never closes a list you opened.
    expect(await screen.findByText(/4 cards · 2 projects/)).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "chase the flake" })).toBeInTheDocument();
  });

  it("unfolds another project from the chevron WITHOUT leaving the card you are in", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    const nav = sidebar();

    await user.click(within(nav).getByRole("button", { name: "Show gateway's cards" }));

    // The other project's cards are listed, and the terminal never went anywhere.
    expect(await within(nav).findByRole("link", { name: "rotate the key" })).toBeInTheDocument();
    expect(screen.getByTestId("terminal")).toHaveTextContent("c2");
  });

  it("folds a project away again from the same chevron", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });
    await within(nav).findByRole("link", { name: "chase the flake" });

    await user.click(within(nav).getByRole("button", { name: "Hide billing's cards" }));

    expect(within(nav).queryByRole("link", { name: "chase the flake" })).not.toBeInTheDocument();
    // And the project is still the selected one — folding is not navigating.
    expect(screen.getByRole("region", { name: "Working" })).toBeInTheDocument();
  });

  it("opens a card belonging to ANOTHER project in one click", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    const nav = sidebar();

    await user.click(within(nav).getByRole("button", { name: "Show gateway's cards" }));
    await user.click(await within(nav).findByRole("link", { name: "rotate the key" }));

    // Straight from one agent to another, without passing through the other project's board. The
    // card you came from is still mounted behind it — that is the deck — so the assertion is about
    // which pane is ON TOP, not about how many exist.
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c4"));
    // ...and the project came with it: the sidebar marks gateway as the one you are in.
    expect(within(sidebar()).getByRole("link", { name: "gateway" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("takes the open card up to its own board when its project's name is clicked", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");

    await user.click(within(sidebar()).getByRole("link", { name: "billing" }));

    // One level up: billing's board, NOT the aggregated one. The card's pane is parked, not gone.
    await waitFor(() => expect(activeTerminal()).toBeNull());
    expect(await screen.findByText(/3 cards/)).toBeInTheDocument();
    // Not the aggregated board, which is the one that counts projects alongside cards.
    expect(screen.queryByText(/cards · /)).not.toBeInTheDocument();
  });

  it("jumps straight to another project's board from wherever you are", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");

    await user.click(within(sidebar()).getByRole("link", { name: "gateway" }));

    // The board is what you are looking at; c2's pane is parked, still connected, off screen.
    await waitFor(() => expect(activeTerminal()).toBeNull());
    expect(await screen.findByRole("region", { name: "Waiting" })).toBeInTheDocument();
    expect(livePanes()).toEqual(["c2"]);
  });

  it("closes the card when its own row is clicked again, one level at a time", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });
    await screen.findByTestId("terminal");

    await user.click(await within(nav).findByRole("link", { name: "chase the flake" }));

    await waitFor(() => expect(activeTerminal()).toBeNull());
    expect(await screen.findByRole("region", { name: "Backlog" })).toBeInTheDocument();
  });

  it("has no 'back to board' row — the card's own row is the way out", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    expect(within(sidebar()).queryByText(/back to board/i)).not.toBeInTheDocument();
  });

  it("keeps the whole project list beside an open card, not just its cards", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    expect(within(sidebar()).getByRole("link", { name: "gateway" })).toBeInTheDocument();
  });

  it("renames a card in place from its menu, without opening the card", async () => {
    mockPatch.mockResolvedValue({ card: { ...cards[1]!, title: "chase the other flake" } });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.pointer({
      keys: "[MouseRight]",
      target: await within(nav).findByRole("link", { name: "chase the flake" }),
    });
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByLabelText("Rename card");
    await user.clear(input);
    await user.type(input, "chase the other flake{Enter}");

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/cards/c2", { title: "chase the other flake" }),
    );
  });

  it("abandons a rename on Escape", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.pointer({
      keys: "[MouseRight]",
      target: await within(nav).findByRole("link", { name: "chase the flake" }),
    });
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    await user.type(await screen.findByLabelText("Rename card"), "nonsense{Escape}");

    await waitFor(() => expect(screen.queryByLabelText("Rename card")).not.toBeInTheDocument());
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("offers the session actions on a card row's right-click", async () => {
    mockPost.mockResolvedValue({ card: cards[1]! });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });
    const row = await within(nav).findByRole("link", { name: "chase the flake" });

    await user.pointer({ keys: "[MouseRight]", target: row });
    const menu = await screen.findByRole("menu", { name: "Actions for chase the flake" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Rename",
      "Pause",
      "Restart",
      // Hibernate sits between the two ways of stopping and the way of ending: it closes the
      // terminal without moving the card anywhere.
      "Hibernate",
      "Finish",
    ]);
  });

  // A double-click used to be the way in, and its FIRST click opens (or, on the card already open,
  // closes) the card — the rename box arrived over a terminal that had just been torn down.
  it("does not rename on a double-click, and opens the card exactly once", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.dblClick(await within(nav).findByRole("link", { name: "chase the flake" }));

    expect(await screen.findByTestId("terminal")).toHaveTextContent("c2");
    expect(screen.queryByLabelText("Rename card")).not.toBeInTheDocument();
  });

  it("opens the card menu on a long press, and the press does not open the card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp(<BoardPage />, { route: "/?project=p1" });
      const nav = await screen.findByRole("navigation", { name: /projects/i });
      const row = await within(nav).findByRole("link", { name: "chase the flake" });

      fireEvent.touchStart(row, { touches: [{ clientX: 40, clientY: 120 }] });
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      fireEvent.touchEnd(row);
      fireEvent.click(row);

      expect(await screen.findByRole("menu", { name: "Actions for chase the flake" })).toBeInTheDocument();
      expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reorders a project from its right-click menu", async () => {
    mockPatch.mockResolvedValue({ projects });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.pointer({ keys: "[MouseRight]", target: within(nav).getByRole("link", { name: "gateway" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Move up" }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/projects/p2/order", { position: 0 }));
  });

  it("asks before deleting a project, from the same menu", async () => {
    mockDel.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.pointer({ keys: "[MouseRight]", target: within(nav).getByRole("link", { name: "gateway" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Delete project…" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(/Delete “gateway”\?/);
    await user.click(screen.getByRole("button", { name: /delete project/i }));
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith("/projects/p2"));
  });

  it("keeps a `+` on every row, whether or not the project is selected", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    // The row that is NOT selected still offers it — writing down the next task should not
    // require selecting the project first.
    await user.click(within(nav).getByRole("button", { name: "New card in gateway" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/New card/);
  });

  it("renders a context menu into the body, above the blurred columns", async () => {
    // The columns carry `backdrop-blur`, which makes them the containing block of any `fixed`
    // descendant: rendered in place, the panel would be positioned against the column instead of
    // the viewport and would open near the click rather than at it.
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Working" });

    const board = screen.getByRole("region", { name: "Working" });
    await user.pointer({ keys: "[MouseRight]", target: within(board).getByRole("link", { name: "chase the flake" }) });

    const menu = await screen.findByRole("menu", { name: "Actions for chase the flake" });
    expect(menu.parentElement).toBe(document.body);
  });
});

describe("BoardPage — one frame, two middles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("opens the terminal for the card named in the URL, keeping the sidebar", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c2"));
    expect(screen.getByTestId("card-layout")).toBeInTheDocument();
    expect(sidebar()).toBeInTheDocument();
  });

  it("shows the project's board when the URL names only a project", async () => {
    renderApp(<BoardPage />, { route: "/?project=p2" });
    expect(await screen.findByRole("region", { name: "Waiting" })).toBeInTheDocument();
    expect(activeTerminal()).toBeNull();
  });

  it("falls back to the AGGREGATED board when the URL names a project that is gone", async () => {
    // Showing someone else's board because the one you asked for was deleted is a lie; everything
    // at once is the honest answer.
    renderApp(<BoardPage />, { route: "/?project=deleted&card=c9" });
    expect(await screen.findByText(/4 cards · 2 projects/)).toBeInTheDocument();
    expect(activeTerminal()).toBeNull();
  });

  it("opening a card puts it in the URL, so a refresh lands in the same place", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const working = await screen.findByRole("region", { name: "Working" });
    await user.click(within(working).getByRole("link", { name: "chase the flake" }));
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c2"));
  });

  it("gives every card a real href, so it can be opened in another tab", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const working = await screen.findByRole("region", { name: "Working" });
    expect(within(working).getByRole("link", { name: "chase the flake" })).toHaveAttribute(
      "href",
      "?project=p1&card=c2",
    );
  });
});

describe("BoardPage — the tab title", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("leads with the project on a board", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });
    await waitFor(() => expect(document.title).toBe("billing · vibehub"));
  });

  it("is just the app on the aggregated board", async () => {
    renderApp(<BoardPage />);
    await screen.findByText(/4 cards · 2 projects/);
    await waitFor(() => expect(document.title).toBe("vibehub"));
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
    await screen.findByRole("region", { name: "Backlog" });
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog")).toHaveTextContent(/New card/);
  });

  it("opens it on Ctrl+T as well — the one the browser leaves alone", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });
    await user.keyboard("{Control>}t{/Control}");
    expect(await screen.findByRole("dialog")).toHaveTextContent(/New card/);
  });

  it("creates the card with just a title", async () => {
    mockPost.mockResolvedValue({ card: { ...cards[0]!, id: "new" } });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });
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

  it("leaves an open card on Escape", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(activeTerminal()).toBeNull());
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
    renderApp(<BoardPage />, { route: "/?project=p1" });
    expect(await screen.findByRole("button", { name: "Brain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /accounts/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MCP" })).toBeInTheDocument();
  });

  it("opens the brain editor from the board", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
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

  it("is where you land with nothing selected", async () => {
    renderApp(<BoardPage />);
    expect(await screen.findByText(/4 cards · 2 projects/)).toBeInTheDocument();
  });

  it("has no 'All projects' row to hunt for — the second click on a project is the way in", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });
    expect(screen.queryByRole("button", { name: "All projects" })).not.toBeInTheDocument();
  });

  it("merges both projects' cards and opens one into its OWN project", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />);

    // One card from each project, on one board.
    const waiting = await screen.findByRole("region", { name: "Waiting" });
    expect(within(waiting).getByRole("link", { name: "waiting on review" })).toBeInTheDocument();
    const other = within(waiting).getByRole("link", { name: "rotate the key" });

    await user.click(other);
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c4"));
  });

  it("keeps the managers but drops the runner chip and the New card button", async () => {
    // There is no single runner to report on here, and no project for a new card to belong to.
    renderApp(<BoardPage />);
    expect(await screen.findByRole("button", { name: "Brain" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New card$/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/running, claude installed/)).not.toBeInTheDocument();
  });
});

describe("BoardPage — narrow screens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("offers one drawer handle per screen: in the board's header row, and in the card bar", async () => {
    const { unmount } = renderApp(<BoardPage />, { route: "/?project=p1" });
    // On the board it sits INSIDE the header row next to the card count, not on a line of its own.
    const handle = await screen.findByRole("button", { name: "Open the projects and cards" });
    expect(handle.className).toContain("lg:hidden");
    unmount();

    // Beside an open card the card bar carries its own, and the page adds nothing above it: that
    // row was a whole line of a phone's height spent on a second button for the same drawer.
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    expect(await screen.findByRole("button", { name: "Open the card list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open the projects and cards" })).not.toBeInTheDocument();
  });

  it("opens the sidebar as a drawer and closes it again on navigation", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");

    await user.click(screen.getByRole("button", { name: "Open the card list" }));
    expect(screen.getByTestId("sidebar-backdrop")).toBeInTheDocument();

    await user.click(await within(sidebar()).findByRole("link", { name: "waiting on review" }));

    // The drawer covers the terminal it just navigated to, so it has to get out of the way.
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c3"));
    await waitFor(() => expect(screen.queryByTestId("sidebar-backdrop")).not.toBeInTheDocument());
  });
});

describe("BoardPage — the terminal deck", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mounts.length = 0;
    serve();
  });

  it("keeps the terminal you came from alive and does not remount the one you go back to", async () => {
    // The whole point: hopping between two agents is a change of which pane is visible, not a
    // teardown and a fresh attach. A remount here would be a dropped websocket in the real app.
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c2"));

    await user.click(await within(sidebar()).findByRole("link", { name: "waiting on review" }));
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c3"));
    // Both are live; only one is on top.
    expect(livePanes()).toEqual(["c2", "c3"]);

    const before = document.querySelector('[data-card-pane="c2"] [data-testid="terminal"]');
    await user.click(within(sidebar()).getByRole("link", { name: "chase the flake" }));
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c2"));

    // The SAME element, and no second mount for c2: nothing reconnected.
    expect(document.querySelector('[data-card-pane="c2"] [data-testid="terminal"]')).toBe(before);
    expect(mounts).toEqual(["c2", "c3"]);
  });

  it("parks the deck when you go back to the board, and finds it there when you return", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    const pane = await waitFor(() => {
      const el = document.querySelector('[data-card-pane="c2"] [data-testid="terminal"]');
      expect(el).not.toBeNull();
      return el;
    });

    await user.keyboard("{Escape}");
    await screen.findByRole("region", { name: "Backlog" });
    // Off screen, out of the flow — but still mounted and still connected.
    expect(activeTerminal()).toBeNull();
    expect(screen.getByTestId("terminal-deck")).toHaveAttribute("data-parked", "true");

    const working = screen.getByRole("region", { name: "Working" });
    await user.click(within(working).getByRole("link", { name: "chase the flake" }));

    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c2"));
    expect(document.querySelector('[data-card-pane="c2"] [data-testid="terminal"]')).toBe(pane);
    expect(mounts).toEqual(["c2"]);
  });

  it("holds cards from different projects at once", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c2"));

    // Straight into the other project's card, from the sidebar.
    await user.click(within(sidebar()).getByRole("button", { name: "gateway" }));
    await user.click(await within(sidebar()).findByRole("link", { name: "rotate the key" }));

    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c4"));
    expect(livePanes()).toEqual(["c2", "c4"]);
  });

  it("takes the keyboard away from the pane it hides", async () => {
    // The pane you left still holds a focused terminal. Leaving it reachable would send your next
    // keystrokes to an agent you are not looking at.
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c2"));

    const inside = screen.getByRole("button", { name: "Open the card list" });
    inside.focus();
    expect(document.activeElement).toBe(inside);

    await user.click(await within(sidebar()).findByRole("link", { name: "waiting on review" }));
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c3"));

    const hidden = document.querySelector('[data-card-pane="c2"]')!;
    expect(hidden).toHaveAttribute("inert");
    expect(hidden.contains(document.activeElement)).toBe(false);
  });

  it("drops a project's panes when the project is deleted", async () => {
    // Deleting a project takes its worktrees — and its sessions — with it. A pane left in the deck
    // would be a socket retrying against nothing.
    mockDel.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await waitFor(() => expect(activeTerminal()).toHaveTextContent("c2"));

    const nav = sidebar();
    await user.pointer({ keys: "[MouseRight]", target: within(nav).getByRole("button", { name: "billing" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Delete project…" }));
    // What the server answers from here on: billing is gone.
    serve({ projects: [projects[1]!] });
    await user.click(screen.getByRole("button", { name: /delete project/i }));

    await waitFor(() => expect(livePanes()).toEqual([]));
  });
});
