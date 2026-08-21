import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { CardTerminalView } from "@/features/board/components/CardTerminalView";
import { renderApp, testQueryClient } from "@/test/render";
import { get, patch, post } from "@/lib/api";
import { cardsKey, type BoardCard, type BoardProject } from "@/features/board/api";

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
    return Promise.reject(new Error(`unexpected GET ${url}`));
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

  it("switching the model reconnects the terminal on the same conversation", async () => {
    mockPatch.mockResolvedValue({ card: card({ openedAt: 10, model: "claude-sonnet-5" }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10 })]);

    const before = (await screen.findByTestId("xterm")).getAttribute("data-reconnect");
    await user.selectOptions(screen.getByLabelText("Model"), "claude-sonnet-5");
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { model: "claude-sonnet-5" }));
    await waitFor(() =>
      expect(screen.getByTestId("xterm").getAttribute("data-reconnect")).not.toBe(before),
    );
  });

  it("clears the account back to inherited with the empty option", async () => {
    mockPatch.mockResolvedValue({ card: card({ openedAt: 10 }) });
    const user = userEvent.setup();
    renderWithCache([card({ openedAt: 10, accountSlug: "personal" })]);
    await user.selectOptions(await screen.findByLabelText("Claude account"), "");
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { accountSlug: null }));
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

  it("shows where the card lives in the runner", async () => {
    renderWithCache([card({ openedAt: 10 })]);
    expect(await screen.findByText(/card\/fix-the-totals-abcd/)).toHaveTextContent(
      /from dev · card-abcdef12/,
    );
  });
});
