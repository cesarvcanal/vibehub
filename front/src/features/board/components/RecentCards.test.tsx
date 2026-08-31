import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecentCards } from "@/features/board/components/RecentCards";
import { renderApp } from "@/test/render";
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

const mockGet = vi.mocked(get);

const projects: BoardProject[] = [
  { id: "p1", name: "billing", baseBranch: "dev", position: 0, createdAt: 1 },
  { id: "p2", name: "gateway", baseBranch: "main", position: 1, createdAt: 2 },
];

function card(overrides: Partial<BoardCard> & { id: string; projectId: string }): BoardCard {
  return {
    title: overrides.id,
    column: "waiting",
    position: 0,
    tmuxSession: `card-${overrides.id}`,
    worktreeSlug: overrides.id,
    createdAt: 1,
    ...overrides,
  };
}

/** Answers `GET /cards` with whatever the test put on the board. */
function serve(cards: BoardCard[]) {
  mockGet.mockImplementation((url: string) =>
    url === "/cards" ? Promise.resolve({ cards }) : Promise.resolve({}),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("RecentCards", () => {
  it("lists the last conversations across projects, newest first, with the project underneath", async () => {
    serve([
      card({ id: "c1", projectId: "p1", title: "fix the totals", openedAt: 10 }),
      card({ id: "c2", projectId: "p2", title: "rotate the key", openedAt: 5, statusAt: 90 }),
      card({ id: "c3", projectId: "p1", title: "never opened", column: "backlog" }),
    ]);

    renderApp(<RecentCards projects={projects} activeCardId={null} onOpenCard={vi.fn()} />);

    const list = await screen.findByTestId("recent-cards");
    const titles = Array.from(list.querySelectorAll("a")).map((a) => a.textContent);
    // The card nobody has talked to is not a conversation you can go back to.
    expect(titles).toEqual(["rotate the keygateway", "fix the totalsbilling"]);
  });

  it("opens the card it was clicked on — with ITS project, not the selected one", async () => {
    serve([card({ id: "c2", projectId: "p2", title: "rotate the key", openedAt: 5 })]);
    const onOpenCard = vi.fn();

    renderApp(<RecentCards projects={projects} activeCardId={null} onOpenCard={onOpenCard} />);
    await userEvent.click(await screen.findByText("rotate the key"));

    expect(onOpenCard).toHaveBeenCalledWith("p2", "c2");
  });

  it("is a real link, so the browser's own habits still work", async () => {
    serve([card({ id: "c2", projectId: "p2", title: "rotate the key", openedAt: 5 })]);

    renderApp(<RecentCards projects={projects} activeCardId={null} onOpenCard={vi.fn()} />);
    const link = (await screen.findByText("rotate the key")).closest("a");

    expect(link).toHaveAttribute("href", "?project=p2&card=c2");
  });

  it("marks the conversation that is open", async () => {
    serve([
      card({ id: "c1", projectId: "p1", title: "fix the totals", openedAt: 10 }),
      card({ id: "c2", projectId: "p2", title: "rotate the key", openedAt: 5 }),
    ]);

    renderApp(<RecentCards projects={projects} activeCardId="c2" onOpenCard={vi.fn()} />);
    const open = (await screen.findByText("rotate the key")).closest("a");

    expect(open).toHaveAttribute("aria-current", "true");
    expect((await screen.findByText("fix the totals")).closest("a")).not.toHaveAttribute("aria-current");
  });

  it("shows a hibernated conversation with a grey dot instead of a status", async () => {
    serve([
      card({ id: "c1", projectId: "p1", title: "gone cold", openedAt: 10, status: null, hibernatedAt: 20 }),
    ]);

    renderApp(<RecentCards projects={projects} activeCardId={null} onOpenCard={vi.fn()} />);
    const row = (await screen.findByText("gone cold")).closest("a");
    const dot = row?.querySelector("[data-tone]");

    expect(dot).toHaveAttribute("data-tone", "cold");
    expect(dot?.className).toContain("bg-muted-foreground");
  });

  it("lists the WHOLE history — more than five — inside its own scrollable box", async () => {
    serve(
      Array.from({ length: 8 }, (_, i) =>
        card({ id: `c${i}`, projectId: "p1", title: `conversation ${i}`, openedAt: i + 1 }),
      ),
    );

    renderApp(<RecentCards projects={projects} activeCardId={null} onOpenCard={vi.fn()} />);

    const list = await screen.findByTestId("recent-cards-list");
    // Every conversation, newest first — the old five-row cut is gone.
    const titles = Array.from(list.querySelectorAll("a")).map((a) => a.textContent ?? "");
    expect(titles).toHaveLength(8);
    expect(titles[0]).toContain("conversation 7");
    expect(titles[7]).toContain("conversation 0");
    // The box scrolls instead of pushing the project list off the panel.
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toContain("max-h-");
  });

  it("renders nothing at all when there is no conversation to go back to", async () => {
    serve([card({ id: "c3", projectId: "p1", title: "never opened", column: "backlog" })]);

    renderApp(<RecentCards projects={projects} activeCardId={null} onOpenCard={vi.fn()} />);

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/cards"));
    expect(screen.queryByTestId("recent-cards")).toBeNull();
  });

  it("skips a card whose project is gone — there is nowhere to open it", async () => {
    serve([card({ id: "c9", projectId: "deleted", title: "orphan", openedAt: 99 })]);

    renderApp(<RecentCards projects={projects} activeCardId={null} onOpenCard={vi.fn()} />);

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/cards"));
    expect(screen.queryByText("orphan")).toBeNull();
  });
});
