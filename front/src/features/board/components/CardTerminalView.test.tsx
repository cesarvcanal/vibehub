import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { CardTerminalView } from "@/features/board/components/CardTerminalView";
import { renderApp, testQueryClient } from "@/test/render";
import { get, patch, post } from "@/lib/api";
import { cardsKey, type BoardCard, type BoardProject } from "@/features/board/api";
import { MOBILE_QUERY } from "@/lib/useIsMobile";

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
    loading: vi.fn(() => "toast-id"),
    dismiss: vi.fn(),
  }),
}));

// xterm needs a real canvas and a WebSocket; the terminal itself has its own test file. Here we
// only care that it is mounted, and on which path.
vi.mock("@/features/board/components/XTerminal", () => ({
  XTerminal: ({ wsPath, reconnectKey }: { wsPath: string; reconnectKey?: string }) => (
    <div data-testid="xterm" data-ws={wsPath} data-reconnect={reconnectKey ?? ""} />
  ),
}));

vi.mock("@/features/board/components/VncPanel", () => ({
  VncPanel: ({ cardId }: { cardId: string }) => <div data-testid="vnc">{cardId}</div>,
}));

const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);
const mockPatch = vi.mocked(patch);

const project: BoardProject = {
  id: "p1",
  name: "billing",
  repoFullName: "acme/billing",
  baseBranch: "dev",
  position: 0,
  createdAt: 1,
};

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "c1",
    projectId: "p1",
    title: "fix the totals",
    column: "working",
    position: 0,
    base: "dev",
    tmuxSession: "card-abcdef12",
    worktreeSlug: "fix-the-totals-abcd",
    createdAt: 1,
    ...overrides,
  };
}

function serve() {
  mockGet.mockImplementation((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "operator" } });
    if (url === "/setup/state") {
      return Promise.resolve({
        fresh: false,
        steps: { owner: true, runner: true, claude: true, github: true },
        runner: { running: true, exists: true, claudeInstalled: true, dockerReachable: true, container: "r" },
      });
    }
    if (url === "/accounts") {
      return Promise.resolve({
        accounts: [{ slug: "personal", name: "Personal", createdAt: 1 }],
        defaultLabel: "Main",
      });
    }
    if (url === "/transcribe") return Promise.resolve({ available: false, proofread: false, language: null });
    if (url === "/accounts/usage") {
      return Promise.resolve({
        bySlug: {
          default: {
            available: true,
            fiveHour: { utilization: 31, resetsAt: null },
            sevenDay: { utilization: 12, resetsAt: null },
            sevenDayOpus: { utilization: 74, resetsAt: null },
            fetchedAt: 1,
          },
          personal: { available: false, error: "no_credentials", fetchedAt: 1 },
        },
        fetchedAt: 1,
      });
    }
    // Nothing has answered yet: the route says so with nulls rather than inventing a model.
    if (url === "/cards/c1/session") {
      return Promise.resolve({ model: null, modelLabel: null, account: { slug: null, name: "" } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

/** Serves the session route with a live reading, on top of the usual fixtures. */
function serveSession(info: {
  model?: string | null;
  modelLabel?: string | null;
  account?: { slug: string | null; name: string };
}) {
  const base = mockGet.getMockImplementation();
  mockGet.mockImplementation((url: string, ...rest: unknown[]) => {
    if (url === "/cards/c1/session") {
      return Promise.resolve({
        model: info.model ?? null,
        modelLabel: info.modelLabel ?? null,
        account: info.account ?? { slug: null, name: "" },
      });
    }
    return (base as (u: string, ...r: unknown[]) => Promise<unknown>)(url, ...rest);
  });
}

/** Renders the view with `seed` already in the board cache — i.e. arriving from the board. */
function renderWithCache(seed: BoardCard[], client: QueryClient = testQueryClient()) {
  client.setQueryData(cardsKey(project.id), seed);
  return renderApp(
    <CardTerminalView project={project} cardId="c1" onBack={vi.fn()} onNewCard={vi.fn()} />,
    { queryClient: client },
  );
}

describe("CardTerminalView — instant open", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
  });

  it("attaches immediately for a card that has been opened before, and calls open in parallel", async () => {
    let resolveOpen: (value: unknown) => void = () => {};
    mockPost.mockImplementation(() => new Promise((resolve) => (resolveOpen = resolve)));

    renderWithCache([card({ openedAt: 10 })]);

    // The terminal is on screen BEFORE the open request has answered.
    expect(await screen.findByTestId("xterm")).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith("/cards/c1/open");
    resolveOpen({ card: card({ openedAt: 10 }) });
  });

  it("attaches immediately for a card that was pre-provisioned but never opened", async () => {
    mockPost.mockImplementation(() => new Promise(() => {}));
    renderWithCache([card({ preparedAt: 20, openedAt: undefined })]);
    expect(await screen.findByTestId("xterm")).toBeInTheDocument();
  });

  it("waits for the open on a card that has never been opened, and says why it may be slow", async () => {
    let resolveOpen: (value: unknown) => void = () => {};
    mockPost.mockImplementation(() => new Promise((resolve) => (resolveOpen = resolve)));

    renderWithCache([card({ column: "backlog" })]);

    expect(await screen.findByText(/Preparing the worktree and session/i)).toBeInTheDocument();
    expect(screen.getByText(/clones the whole repository/i)).toBeInTheDocument();
    expect(screen.queryByTestId("xterm")).not.toBeInTheDocument();

    resolveOpen({ card: card({ openedAt: 99 }) });
    expect(await screen.findByTestId("xterm")).toBeInTheDocument();
  });

  it("offers a retry when the first open fails", async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error("boom"), { response: { status: 502, data: { error: "runner unreachable" } } }),
    );
    renderWithCache([card({ column: "backlog" })]);
    expect(await screen.findByText("runner unreachable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("reads the card from the server on a deep link, then attaches", async () => {
    mockPost.mockResolvedValue({ card: card({ openedAt: 10 }) });
    mockGet.mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ card: card({ openedAt: 10 }) });
      if (url === "/accounts") return Promise.resolve({ accounts: [], defaultLabel: "" });
      if (url === "/transcribe") return Promise.resolve({ available: false, proofread: false, language: null });
      if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "operator" } });
      if (url === "/setup/state") return Promise.reject(new Error("not needed"));
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    // No cache seed at all: this is a refresh or a pasted link.
    renderApp(<CardTerminalView project={project} cardId="c1" onBack={vi.fn()} onNewCard={vi.fn()} />);
    expect(await screen.findByTestId("xterm")).toBeInTheDocument();
  });
});

describe("CardTerminalView — the card bar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
    mockPost.mockResolvedValue({ card: card({ openedAt: 10 }) });
  });

  it("shows the title, the project and the status dot", async () => {
    mockPost.mockResolvedValue({ card: card({ openedAt: 10, status: "working" }) });
    renderWithCache([card({ openedAt: 10, status: "working" })]);
    expect(await screen.findByRole("heading", { name: "fix the totals" })).toBeInTheDocument();
    expect(screen.getByText("· billing")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Working" })).toBeInTheDocument();
  });

  it("renames the card inline", async () => {
    mockPatch.mockResolvedValue({ card: card({ openedAt: 10, title: "new title" }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);

    await user.click(await screen.findByRole("heading", { name: "fix the totals" }));
    const input = await screen.findByLabelText("Card title");
    await user.clear(input);
    await user.type(input, "new title{Enter}");

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { title: "new title" }));
  });

  it("abandons a rename on Escape", async () => {
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);
    await user.click(await screen.findByRole("heading", { name: "fix the totals" }));
    await user.type(await screen.findByLabelText("Card title"), "junk{Escape}");
    expect(mockPatch).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "fix the totals" })).toBeInTheDocument();
  });

  it("pauses, which ends the session and returns to the board", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    const client = testQueryClient();
    client.setQueryData(cardsKey(project.id), [card({ openedAt: 10 })]);
    renderApp(<CardTerminalView project={project} cardId="c1" onBack={onBack} onNewCard={vi.fn()} />, {
      queryClient: client,
    });

    await user.click(await screen.findByRole("button", { name: /pause/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/cards/c1/pause"));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it("finishing is a manual move to done", async () => {
    mockPatch.mockResolvedValue({ card: card({ column: "done" }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);
    await user.click(await screen.findByRole("button", { name: /^done$/i }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { column: "done", position: 0 }),
    );
  });

  it("hides pause and restart on a card with no live session", async () => {
    const prepared = card({ column: "backlog", openedAt: undefined, preparedAt: 5 });
    mockPost.mockResolvedValue({ card: prepared });
    renderWithCache([prepared]);
    await screen.findByTestId("xterm");
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();
  });

  /** Opens one of the two bar menus and hands back its items. */
  async function openMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.click(await screen.findByLabelText(label));
    return within(await screen.findByRole("menu")).getAllByRole("menuitemcheckbox");
  }

  it("switching the model reconnects the terminal on the same conversation", async () => {
    mockPatch.mockResolvedValue({ card: card({ openedAt: 10, model: "claude-sonnet-5" }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);

    const before = (await screen.findByTestId("xterm")).getAttribute("data-reconnect");
    await openMenu(user, "Model");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Sonnet" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { model: "claude-sonnet-5" }));
    await waitFor(() =>
      expect(screen.getByTestId("xterm").getAttribute("data-reconnect")).not.toBe(before),
    );
  });

  it("the model menu is the FIXED list — the trigger is what names the model in use", async () => {
    serveSession({ model: "claude-opus-5", modelLabel: "Opus" });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10, model: undefined })]);

    // The pill answers "what am I talking to".
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveTextContent("Opus"));

    const items = await openMenu(user, "Model");
    expect(items.map((i) => i.textContent)).toEqual(["Fable", "Opus", "Sonnet", "Haiku"]);
    // "Default model" was the one answer nobody wants: the question is which model is answering.
    expect(screen.queryByRole("menuitem", { name: "Default model" })).not.toBeInTheDocument();
    // The check marks the model IN USE, even though the card pins none…
    expect(screen.getByRole("menuitemcheckbox", { name: "Opus" })).toHaveAttribute("aria-checked", "true");
    // …and clearing the pin is an ACTION, so it carries no competing check.
    expect(screen.getByRole("menuitem", { name: "Use account default" })).toBeInTheDocument();
  });

  it("names a model the whitelist has never heard of from the server's own label", async () => {
    serveSession({ model: "claude-experimental-9", modelLabel: "Experimental" });
    renderWithCache([card({ openedAt: 10 })]);
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveTextContent("Experimental"));
  });

  it("assumes Claude Code's own default until the first reply, and says so in the title", async () => {
    renderWithCache([card({ openedAt: 10 })]);

    const pill = await screen.findByLabelText("Model");
    expect(pill).toHaveTextContent("Fable");
    expect(pill).toHaveAttribute("title", "Claude Code's default until the first reply");
  });

  it("the card's own pin wins over the transcript — that is what the next session starts on", async () => {
    serveSession({ model: "claude-opus-5", modelLabel: "Opus" });
    mockPost.mockResolvedValue({ card: card({ openedAt: 10, model: "claude-haiku-4-5" }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10, model: "claude-haiku-4-5" })]);

    expect(await screen.findByLabelText("Model")).toHaveTextContent("Haiku");
    await openMenu(user, "Model");
    expect(screen.getByRole("menuitemcheckbox", { name: "Haiku" })).toHaveAttribute("aria-checked", "true");
  });

  it("names the account in USE on the pill, with no (default) or (inherited) suffix", async () => {
    serveSession({ account: { slug: null, name: "Main" } });
    renderWithCache([card({ openedAt: 10 })]);

    const pill = await screen.findByLabelText("Claude account");
    await waitFor(() => expect(pill).toHaveTextContent("Main"));
    expect(pill.textContent).not.toMatch(/\(default\)/);
    expect(pill.textContent).not.toMatch(/inherited/i);
  });

  it("the account menu is one EXPLICIT row per account, the built-in profile first", async () => {
    serveSession({ account: { slug: null, name: "Main" } });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);

    const items = await openMenu(user, "Claude account");
    // Two accounts, two rows, each named for itself — never for whatever is in use right now.
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Main");
    expect(items[1]).toHaveTextContent("Personal");
    expect(items[0]).toHaveAttribute("aria-checked", "true");
  });

  it("keeps both labels distinct after switching account — the menu never renames itself", async () => {
    // The bug this pins: the first row used to be labelled with the account IN USE, so switching to
    // "Personal" made the menu show "Personal" twice, and switching back flipped the labels again.
    serveSession({ account: { slug: "personal", name: "Personal" } });
    mockPost.mockResolvedValue({ card: card({ openedAt: 10, accountSlug: "personal" }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10, accountSlug: "personal" })]);

    await waitFor(() => expect(screen.getByLabelText("Claude account")).toHaveTextContent("Personal"));
    const items = await openMenu(user, "Claude account");
    expect(items[0]).toHaveTextContent("Main");
    expect(items[1]).toHaveTextContent("Personal");
    expect(items[1]).toHaveAttribute("aria-checked", "true");
  });

  it("lists the install's OWN names: the default profile's label, then each account", async () => {
    // The exact bug the owner hit: with the built-in profile signed in as cesarvcanal@gmail.com and
    // one account "tech", the first row was labelled with whatever was in use — so he saw
    // "tech / ✓ tech", and picking one renamed the other.
    mockGet.mockImplementation((url: string) => {
      if (url === "/accounts") {
        return Promise.resolve({
          accounts: [{ slug: "tech", name: "tech", createdAt: 1 }],
          defaultLabel: "cesarvcanal@gmail.com",
        });
      }
      if (url === "/cards/c1/session") {
        return Promise.resolve({ model: null, modelLabel: null, account: { slug: "tech", name: "tech" } });
      }
      if (url === "/transcribe") return Promise.resolve({ available: false, proofread: false, language: null });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);

    const items = await openMenu(user, "Claude account");
    expect(items.map((i) => i.textContent)).toEqual(["cesarvcanal@gmail.com", "tech"]);
    // The check follows the account the SESSION is signed in to, not the card's (absent) pin.
    expect(items[1]).toHaveAttribute("aria-checked", "true");
    expect(items[0]).toHaveAttribute("aria-checked", "false");
  });

  it("falls back to the profile's own slug when the session says nothing and nobody renamed it", async () => {
    mockGet.mockImplementation((url: string) => {
      // "" is what the server sends for "never named" — an empty pill would be worse than a slug.
      if (url === "/accounts") return Promise.resolve({ accounts: [], defaultLabel: "" });
      if (url === "/transcribe") return Promise.resolve({ available: false, proofread: false, language: null });
      return Promise.resolve({});
    });
    renderWithCache([card({ openedAt: 10 })]);
    expect(await screen.findByLabelText("Claude account")).toHaveTextContent("default");
  });

  it("choosing the built-in profile clears the card's pin", async () => {
    mockPatch.mockResolvedValue({ card: card({ openedAt: 10 }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10, accountSlug: "personal" })]);

    await openMenu(user, "Claude account");
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Main/ }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { accountSlug: null }));
  });

  it("choosing a named account pins it", async () => {
    mockPatch.mockResolvedValue({ card: card({ openedAt: 10, accountSlug: "personal" }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);

    await openMenu(user, "Claude account");
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Personal/ }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { accountSlug: "personal" }));
  });
});

describe("CardTerminalView — the account pill knows how much plan is left", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
    mockPost.mockResolvedValue({ card: card({ openedAt: 10 }) });
  });

  it("appends the 5-hour utilization of the account IN USE", async () => {
    serveSession({ account: { slug: null, name: "Main" } });
    renderWithCache([card({ openedAt: 10 })]);
    await waitFor(() => expect(screen.getByLabelText("Claude account")).toHaveTextContent("31%"));
  });

  it("shows the percentage of each account in the menu, so the choice is informed", async () => {
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);
    await user.click(await screen.findByLabelText("Claude account"));
    const rows = within(await screen.findByRole("menu")).getAllByRole("menuitemcheckbox");
    expect(rows[0]).toHaveTextContent("31%");
    // The account with no interactive login has no number to show — and no fake one either.
    expect(rows[1].textContent).not.toMatch(/%/);
  });

  it("says what to do about an account that never logged in, instead of a blank bar", async () => {
    serveSession({ account: { slug: "personal", name: "Personal" } });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10, accountSlug: "personal" })]);

    // The pill carries no percentage at all for that account…
    await waitFor(() => expect(screen.getByLabelText("Claude account")).toHaveTextContent("Personal"));
    expect(screen.getByLabelText("Claude account").textContent).not.toMatch(/%/);

    // …and the tooltip says the command that fixes it, naming the profile directory.
    await user.hover(screen.getByLabelText("Claude account"));
    const tip = await screen.findAllByText(/no interactive login on the runner/i);
    expect(tip[0]).toHaveTextContent("/root/.claude-profiles/personal");
  });
});

describe("CardTerminalView — extra panes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
    mockPost.mockResolvedValue({ card: card({ openedAt: 10 }) });
  });

  it("opens a plain shell on the same worktree with ?shell=1", async () => {
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);
    await screen.findByTestId("xterm");

    await user.click(screen.getByRole("button", { name: /shell/i }));
    const paths = (await screen.findAllByTestId("xterm")).map((el) => el.getAttribute("data-ws"));
    expect(paths).toContain("/api/cards/c1/terminal");
    expect(paths).toContain("/api/cards/c1/terminal?shell=1");
  });

  it("closes the shell again", async () => {
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);
    await screen.findByTestId("xterm");
    await user.click(screen.getByRole("button", { name: /shell/i }));
    await user.click(await screen.findByRole("button", { name: /close shell/i }));
    expect(await screen.findAllByTestId("xterm")).toHaveLength(1);
  });

  it("opens the card browser", async () => {
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);
    await screen.findByTestId("xterm");
    await user.click(screen.getByRole("button", { name: /browser/i }));
    expect(await screen.findByTestId("vnc")).toHaveTextContent("c1");
  });

  it("keeps where the card lives in the runner in the title's tooltip, not in a footer row", async () => {
    renderWithCache([card({ openedAt: 10 })]);
    // The footer line cost a row of terminal height to say three things you need roughly never.
    expect(screen.queryByText(/card\/fix-the-totals-abcd/)).not.toBeInTheDocument();
    const title = await screen.findByRole("button", { name: /fix the totals/ });
    expect(title.getAttribute("title")).toContain(
      "card/fix-the-totals-abcd · base dev · tmux card-abcdef12",
    );
  });

  it("puts Browser and Shell in the card bar, and keeps New card out of it", async () => {
    renderWithCache([card({ openedAt: 10 })]);
    await screen.findByTestId("xterm");
    // "New card" lives on the board's chrome and in ⌘K; a third copy here only competed with the
    // controls that are actually about the card you are looking at.
    expect(screen.queryByRole("button", { name: /new card/i })).not.toBeInTheDocument();
    const bar = screen.getByTestId("card-bar");
    expect(bar).toContainElement(screen.getByRole("button", { name: /browser/i }));
    expect(bar).toContainElement(screen.getByRole("button", { name: /shell/i }));
  });
});

describe("CardTerminalView — narrow screens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve();
    mockPost.mockResolvedValue({ card: card({ openedAt: 10 }) });
  });

  it("offers a menu button that asks the page to open the card list", async () => {
    const user = userEvent.setup();
    const onOpenMenu = vi.fn();
    renderApp(
      <CardTerminalView
        project={project}
        cardId="c1"
        onBack={vi.fn()}
        onNewCard={vi.fn()}
        onOpenMenu={onOpenMenu}
      />,
    );

    const button = await screen.findByRole("button", { name: "Open the card list" });
    // Only on narrow screens: the real list is a permanent column from `lg` up.
    expect(button.className).toContain("lg:hidden");
    await user.click(button);
    expect(onOpenMenu).toHaveBeenCalled();
  });

  it("renders no menu button when the page does not offer a drawer", async () => {
    renderApp(<CardTerminalView project={project} cardId="c1" onBack={vi.fn()} onNewCard={vi.fn()} />);
    await screen.findByTestId("card-bar");
    expect(screen.queryByRole("button", { name: "Open the card list" })).not.toBeInTheDocument();
  });
});

/**
 * The phone.
 *
 * Four separate reports, one screen: no way back except the drawer, a bar whose controls sat on top
 * of each other at 390px, a page that scrolled while the terminal did not, and a keyboard that
 * zoomed everything. What is asserted here is the STRUCTURE those fixes depend on — two rows on a
 * phone, one row on a desktop, and an arrow that goes back from either.
 */
describe("CardTerminalView — the phone", () => {
  const originalMatchMedia = window.matchMedia;

  /** Drives the media query the view reads. `true` = a phone-width viewport. */
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
    serve();
    mockPost.mockResolvedValue({ card: card({ openedAt: 10 }) });
    setViewport(false);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    document.documentElement.classList.remove("card-view-locked");
  });

  it("goes back to the board from the arrow, on a phone and on a desktop alike", async () => {
    for (const mobile of [true, false]) {
      setViewport(mobile);
      const user = userEvent.setup();
      const onBack = vi.fn();
      const { unmount } = renderApp(
        <CardTerminalView project={project} cardId="c1" onBack={onBack} onNewCard={vi.fn()} />,
      );

      await user.click(await screen.findByTestId("card-back"));
      expect(onBack).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("splits the bar into identity and a scrolling action strip on a phone", async () => {
    setViewport(true);
    renderApp(<CardTerminalView project={project} cardId="c1" onBack={vi.fn()} onNewCard={vi.fn()} />);

    const identity = await screen.findByTestId("card-bar-identity");
    const actions = screen.getByTestId("card-bar-actions");

    // Row one is who you are looking at; row two is everything you can do to it.
    expect(within(identity).getByTestId("card-back")).toBeInTheDocument();
    expect(within(identity).getByRole("heading", { name: "fix the totals" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Browser" })).toBeInTheDocument();
    // Sideways, never wrapped: a wrapped row is what stacked on itself in the first place.
    expect(actions.className).toContain("overflow-x-auto");
    expect(actions.className).toContain("whitespace-nowrap");
    expect(screen.getByTestId("card-bar").className).toContain("flex-col");
  });

  it("leaves the desktop bar as the single row it has always been", async () => {
    renderApp(<CardTerminalView project={project} cardId="c1" onBack={vi.fn()} onNewCard={vi.fn()} />);

    const bar = await screen.findByTestId("card-bar");
    expect(screen.queryByTestId("card-bar-identity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-bar-actions")).not.toBeInTheDocument();
    expect(bar.className).toContain("items-center");
    expect(bar.className).not.toContain("flex-col");
  });

  it("locks the page while a card is open on a phone, and unlocks it on the way out", async () => {
    setViewport(true);
    const { unmount } = renderApp(
      <CardTerminalView project={project} cardId="c1" onBack={vi.fn()} onNewCard={vi.fn()} />,
    );

    await screen.findByTestId("card-bar");
    // The document must not scroll: the scroller is xterm's own viewport, and a scrollable page
    // eats the touch before the terminal ever sees it.
    expect(document.documentElement.classList.contains("card-view-locked")).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains("card-view-locked")).toBe(false);
  });

  it("never locks the page on a desktop, where the board behind still scrolls", async () => {
    renderApp(<CardTerminalView project={project} cardId="c1" onBack={vi.fn()} onNewCard={vi.fn()} />);
    await screen.findByTestId("card-bar");
    expect(document.documentElement.classList.contains("card-view-locked")).toBe(false);
  });
});
