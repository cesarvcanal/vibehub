import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AllProjectsBoard } from "@/features/board/components/AllProjectsBoard";
import { renderApp } from "@/test/render";
import { get, patch, post } from "@/lib/api";
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
const mockPatch = vi.mocked(patch);
const mockPost = vi.mocked(post);

const projects: BoardProject[] = [
  { id: "p1", name: "billing", baseBranch: "dev", position: 0, createdAt: 1 },
  { id: "p2", name: "gateway", baseBranch: "main", position: 1, createdAt: 2 },
];

function card(overrides: Partial<BoardCard> & { id: string; projectId: string }): BoardCard {
  return {
    title: overrides.id,
    column: "backlog",
    position: 0,
    tmuxSession: `card-${overrides.id}`,
    worktreeSlug: overrides.id,
    createdAt: 1,
    ...overrides,
  };
}

const byProject: Record<string, BoardCard[]> = {
  p1: [
    card({ id: "c1", projectId: "p1", title: "fix the totals", column: "backlog" }),
    card({ id: "c2", projectId: "p1", title: "chase the flake", column: "working", status: "working", openedAt: 5 }),
  ],
  p2: [card({ id: "c3", projectId: "p2", title: "rotate the key", column: "waiting", status: "waiting", openedAt: 7 })],
};

function serve() {
  mockGet.mockImplementation((url: string) => {
    const match = /^\/projects\/(.+)\/cards$/.exec(url);
    if (match) return Promise.resolve({ cards: byProject[match[1] as string] ?? [] });
    return Promise.resolve({});
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  serve();
});

describe("AllProjectsBoard", () => {
  it("merges every project's cards into the one set of columns", async () => {
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);

    const working = await screen.findByRole("region", { name: "Working" });
    expect(within(working).getByText("chase the flake")).toBeInTheDocument();
    const waiting = screen.getByRole("region", { name: "Waiting" });
    // From the OTHER project — the point of the view.
    expect(within(waiting).getByText("rotate the key")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Backlog" })).getByText("fix the totals")).toBeInTheDocument();
  });

  it("reads one query per project, so both views share a cache instead of double-fetching", async () => {
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);
    await screen.findByText("chase the flake");
    expect(mockGet).toHaveBeenCalledWith("/projects/p1/cards");
    expect(mockGet).toHaveBeenCalledWith("/projects/p2/cards");
  });

  it("labels each card with the project it belongs to", async () => {
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);
    const tile = await screen.findByRole("button", { name: "rotate the key" });
    expect(within(tile).getByText("gateway")).toBeInTheDocument();
    const other = screen.getByRole("button", { name: "chase the flake" });
    expect(within(other).getByText("billing")).toBeInTheDocument();
  });

  it("counts the cards and the projects in the header", async () => {
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);
    expect(await screen.findByText("3 cards · 2 projects")).toBeInTheDocument();
  });

  it("opens a card with its own project, not the one that happens to be selected", async () => {
    const onOpenCard = vi.fn();
    const user = userEvent.setup();
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={onOpenCard} />);

    await user.click(await screen.findByRole("button", { name: "rotate the key" }));
    expect(onOpenCard).toHaveBeenCalledWith(expect.objectContaining({ id: "c3", projectId: "p2" }));
  });

  it("routes a cross-column drag through the card's OWN project", async () => {
    mockPatch.mockResolvedValue({ card: { ...byProject.p2![0], column: "done" } });
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);

    const tile = await screen.findByRole("button", { name: "rotate the key" });
    const done = screen.getByRole("region", { name: "Done" });

    dragTo(tile, done);

    // The PATCH is measured against p2's OWN cards — it has nothing in Done, so the card lands at
    // 0. Measuring against the mixed list on screen would have counted p1's cards too.
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c3", { column: "done", position: 0 }));
  });

  it("numbers the drop inside the owning project, ignoring other projects' cards", async () => {
    // p1 already has a card in Backlog at position 0, so p1's card moving there lands at 1 — while
    // p2's card moving to the same column starts from p2's own empty space.
    mockPatch.mockResolvedValue({ card: byProject.p2![0] });
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);

    const tile = await screen.findByRole("button", { name: "rotate the key" });
    dragTo(tile, screen.getByRole("region", { name: "Backlog" }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/cards/c3", { column: "backlog", position: 0 }),
    );
  });

  it("does not PATCH when a card is dropped back on its own column", async () => {
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);
    const tile = await screen.findByRole("button", { name: "rotate the key" });
    dragTo(tile, screen.getByRole("region", { name: "Waiting" }));
    await waitFor(() => expect(mockPatch).not.toHaveBeenCalled());
  });

  it("offers Pause and Restart on right-click for a card with a live session", async () => {
    mockPost.mockResolvedValue({ card: byProject.p2![0] });
    const user = userEvent.setup();
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);

    await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("button", { name: "rotate the key" }) });
    const menu = await screen.findByRole("menu", { name: "Actions for rotate the key" });
    await user.click(within(menu).getByRole("menuitem", { name: "Restart" }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/cards/c3/restart"));
  });

  it("shows an empty column rather than collapsing it", async () => {
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={vi.fn()} />);
    const paused = await screen.findByRole("region", { name: "Paused" });
    expect(within(paused).getByText("empty")).toBeInTheDocument();
  });
});

/**
 * Minimal HTML5 drag. `fireEvent` flushes React between the steps, which matters: a column only
 * attaches its drop handlers once a drag is actually in progress.
 */
function dragTo(tile: HTMLElement, zone: HTMLElement) {
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "" };
  fireEvent.dragStart(tile, { dataTransfer });
  fireEvent.dragEnter(zone, { dataTransfer });
  fireEvent.dragOver(zone, { dataTransfer });
  fireEvent.drop(zone, { dataTransfer });
}
