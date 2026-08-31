import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardPage } from "@/features/board/BoardPage";
import { renderApp } from "@/test/render";
import { del, get, patch, post } from "@/lib/api";
import { MOBILE_QUERY } from "@/lib/useIsMobile";
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
    if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "operator", role: "owner" } });
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

  it("lists every project in sidebar order on the aggregated board", async () => {
    // All projects show when NONE is focused. Inside a project the sidebar is just that project's
    // cards (see the focused-sidebar tests) — you switch from the name at the top.
    renderApp(<BoardPage />, { route: "/" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });
    await waitFor(() => expect(nav.querySelectorAll("[data-project-row]").length).toBe(2));
    const rows = Array.from(nav.querySelectorAll("[data-project-row]")).map((row) => row.textContent ?? "");
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
  it("puts a card you just created in the MAIN list at once, on top — never behind show-more", async () => {
    const user = userEvent.setup();
    // The server keeps answering with the OLD list: only the local write can put the row on screen.
    mockPost.mockResolvedValue({
      card: {
        id: "c9", projectId: "p1", title: "brand new", column: "backlog", position: 0,
        tmuxSession: "card-c9", worktreeSlug: "brand-new-c9", createdAt: Date.now(),
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
    // Fresh means VISIBLE: the card you just named is the FIRST row of the list, not an entry you
    // have to dig out of "show more" (the regression this window exists for).
    const created = await within(nav).findByRole("link", { name: "brand new" });
    expect(created).toBeInTheDocument();
    const cardRows = within(nav)
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href")?.includes("card="))
      .map((l) => l.textContent ?? "");
    expect(cardRows[0]).toContain("brand new");
    // The stale backlog card stays folded, alone.
    expect(within(nav).getByRole("button", { name: "show more (1)" })).toBeInTheDocument();
    // And on the board itself, in the column it was created in.
    expect(within(screen.getByRole("region", { name: "Backlog" })).getByRole("link", { name: "brand new" }))
      .toBeInTheDocument();
  });

  /**
   * WHERE the card was created from decides whether it opens. From inside a card, creating one is
   * "start the next conversation": the terminal swaps to it at once. From the board, the sidebar's
   * `+` stays a jot-it-down: the board keeps still and the new row appears at the top.
   */
  it("opens the card right away when it was created from beside an open card", async () => {
    const user = userEvent.setup();
    mockPost.mockImplementation((url: string) => {
      if (url === "/cards") {
        return Promise.resolve({
          card: {
            id: "c9", projectId: "p1", title: "next thing", column: "backlog", position: 0,
            tmuxSession: "card-c9", worktreeSlug: "next-thing-c9", createdAt: Date.now(),
          },
        });
      }
      return Promise.resolve({});
    });
    // Inside c2's terminal: the sidebar is focused on billing, its `+` sits beside the switcher.
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.click(within(nav).getByRole("button", { name: "New card in billing" }));
    await user.type(await screen.findByLabelText("Title"), "next thing");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    // The page jumped INTO the new card: its pane is the active one.
    await waitFor(() => expect(activeTerminal()?.getAttribute("data-card")).toBe("c9"));
  });

  it("does NOT open the card when it was created from the board's sidebar", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({
      card: {
        id: "c9", projectId: "p1", title: "later thing", column: "backlog", position: 0,
        tmuxSession: "card-c9", worktreeSlug: "later-thing-c9", createdAt: Date.now(),
      },
    });
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.click(within(nav).getByRole("button", { name: "New card in billing" }));
    await user.type(await screen.findByLabelText("Title"), "later thing");
    // Freeze the card list from here on, so the row on screen is the local write and the poll
    // cannot race it away before the assertion runs.
    const stale = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string) =>
      url.endsWith("/cards") ? new Promise(() => {}) : stale(url),
    );
    await user.click(screen.getByRole("button", { name: "Create card" }));

    // The row exists, the board is still the middle, no terminal took over.
    expect(await within(nav).findByRole("link", { name: "later thing" })).toBeInTheDocument();
    expect(activeTerminal()).toBeNull();
  });

  it("keeps a row for the card you are IN, even when it sits in the backlog", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1&card=c1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });
    // c1 is a backlog card: it is on screen, so it is in the list — not hidden behind "show more".
    expect(await within(nav).findByRole("link", { name: "fix the totals" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /show more/ })).not.toBeInTheDocument();
  });

  it("leaves the focused project for the aggregated board via the switcher's 'All projects'", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });
    await within(nav).findByRole("link", { name: "chase the flake" });

    await user.click(within(nav).getByRole("button", { name: "Switch project" }));
    await user.click(await screen.findByRole("menuitem", { name: "All projects" }));

    // The aggregated board — the one that counts projects alongside cards.
    expect(await screen.findByText(/4 cards · 2 projects/)).toBeInTheDocument();
  });

  it("beside an open card, focuses on ONLY that project — no other projects, no chevron", async () => {
    // The whole point of the change: working inside one project, the sidebar is just its cards.
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    const nav = sidebar();

    expect(await within(nav).findByRole("link", { name: "chase the flake" })).toBeInTheDocument();
    // The other project is not a row on screen, and there is no chevron to unfold one.
    expect(within(nav).queryByRole("link", { name: "gateway" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /Show .*cards/ })).not.toBeInTheDocument();
  });

  it("reaches another project from the name switcher, parking the card you leave", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    const nav = sidebar();

    await user.click(within(nav).getByRole("button", { name: "Switch project" }));
    await user.click(await screen.findByRole("menuitem", { name: "gateway" }));

    // gateway's board is what you see; c2's pane is parked, still connected, off screen.
    await waitFor(() => expect(activeTerminal()).toBeNull());
    expect(await screen.findByRole("region", { name: "Waiting" })).toBeInTheDocument();
    expect(livePanes()).toEqual(["c2"]);
  });

  it("the switcher's project items are real links, so Cmd/middle-click opens a new tab", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("navigation", { name: /projects/i });

    await user.click(screen.getByRole("button", { name: "Switch project" }));
    const gateway = await screen.findByRole("menuitem", { name: "gateway" });
    expect(gateway.tagName).toBe("A");
    expect(gateway.getAttribute("href")).toContain("p2");
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

  it("hibernating the card you are IN closes it, so the view stops reopening in a loop", async () => {
    // Hibernate kills the session; leaving the card open just reconnects and reopens it — a loop.
    mockPost.mockResolvedValue({ card: { ...cards[1]!, openedAt: null, hibernatedAt: "2026-08-25T00:00:00Z" } });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/?project=p1&card=c2" });
    await screen.findByTestId("terminal");
    const nav = sidebar();

    await user.pointer({ keys: "[MouseRight]", target: within(nav).getByRole("link", { name: "chase the flake" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Hibernate" }));

    // Taken up one level — the terminal is gone, not endlessly reconnecting.
    await waitFor(() => expect(activeTerminal()).toBeNull());
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
    // The overview lists every project; the row menu lives there (a focused sidebar has one project).
    renderApp(<BoardPage />, { route: "/" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.pointer({ keys: "[MouseRight]", target: within(nav).getByRole("link", { name: "gateway" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Move up" }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/projects/p2/order", { position: 0 }));
  });

  it("asks before deleting a project, from the same menu", async () => {
    mockDel.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    await user.pointer({ keys: "[MouseRight]", target: within(nav).getByRole("link", { name: "gateway" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Delete project…" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(/Delete “gateway”\?/);
    await user.click(screen.getByRole("button", { name: /delete project/i }));
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith("/projects/p2"));
  });

  it("keeps a `+` on every row in the overview", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />, { route: "/" });
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    // Every row offers it — writing down the next task should not require selecting the project first.
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

  it("is just the project name", async () => {
    renderApp(<BoardPage />, { route: "/?project=p1" });
    await screen.findByRole("region", { name: "Backlog" });
    await waitFor(() => expect(document.title).toBe("billing"));
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

  it("keeps the managers AND the New card button, but drops the runner chip", async () => {
    // There is no single runner to report on here. There IS a New card button now: it has no project
    // to imply, so the dialog asks which — creating from the aggregated board is a real thing to do.
    renderApp(<BoardPage />);
    expect(await screen.findByRole("button", { name: "Brain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New card$/ })).toBeInTheDocument();
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

/**
 * On a phone, the homepage is the MENU, not the kanban.
 *
 * With nothing open on a narrow screen the aggregated board is five columns crushed into one, which
 * is not what you reach for on a phone — the question there is which project, which card. So the
 * sidebar becomes the main view (in-flow, no drawer), and a `+` beside the brand creates a card
 * from nowhere in particular. Every assertion is paired with "the desktop / an open card is exactly
 * as it was", because the failure mode of a responsive change is reshaping the layout nobody asked
 * to change.
 */
describe("BoardPage — the phone homepage menu", () => {
  const originalMatchMedia = window.matchMedia;

  function setViewport(mobile: boolean): void {
    window.matchMedia = ((query: string) => ({
      matches: query === MOBILE_QUERY ? mobile : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    setViewport(true);
    serve();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("shows the project menu as the main view, not the aggregated board", async () => {
    renderApp(<BoardPage />);
    const nav = await screen.findByRole("navigation", { name: /projects/i });

    // The list is the page: both projects are on it, in the flow rather than behind a handle.
    expect(within(nav).getByRole("link", { name: "billing" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "gateway" })).toBeInTheDocument();
    // In-flow, not an overlay: no backdrop, no drawer handle.
    expect(screen.queryByTestId("sidebar-backdrop")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open the projects and cards" })).not.toBeInTheDocument();
    // And the squeezed aggregated board is NOT what fills the screen.
    expect(screen.queryByText(/cards · /)).not.toBeInTheDocument();
  });

  it("creates a card from the `+` beside the brand, letting the dialog ask which project", async () => {
    const user = userEvent.setup();
    renderApp(<BoardPage />);
    await screen.findByRole("navigation", { name: /projects/i });

    await user.click(screen.getByRole("button", { name: "New card…" }));

    // No project is implied — the dialog is the global one, which offers the project picker.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/New card/);
    expect(within(dialog).getByLabelText(/project/i)).toBeInTheDocument();
  });

  it("keeps the kanban on a phone once a project is selected", async () => {
    // Only the homepage becomes the menu. Selecting a project is asking for that board, and the
    // sidebar goes back to being the drawer behind its handle.
    renderApp(<BoardPage />, { route: "/?project=p1" });
    expect(await screen.findByRole("region", { name: "Working" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the projects and cards" })).toBeInTheDocument();
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

    // Into the other project via the name switcher, then its card.
    await user.click(within(sidebar()).getByRole("button", { name: "Switch project" }));
    await user.click(await screen.findByRole("menuitem", { name: "gateway" }));
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

    // Deleting a project lives in the overview (the focused sidebar shows one project). The card's
    // pane stays parked in the deck while we go there.
    await user.click(within(sidebar()).getByRole("button", { name: "Switch project" }));
    await user.click(await screen.findByRole("menuitem", { name: "All projects" }));
    const nav = sidebar();
    await user.pointer({ keys: "[MouseRight]", target: within(nav).getByRole("link", { name: "billing" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Delete project…" }));
    // What the server answers from here on: billing is gone.
    serve({ projects: [projects[1]!] });
    await user.click(screen.getByRole("button", { name: /delete project/i }));

    await waitFor(() => expect(livePanes()).toEqual([]));
  });
});
