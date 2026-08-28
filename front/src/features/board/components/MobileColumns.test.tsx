import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KanbanBoard } from "@/features/board/components/KanbanBoard";
import { AllProjectsBoard } from "@/features/board/components/AllProjectsBoard";
import { renderApp } from "@/test/render";
import { get, patch } from "@/lib/api";
import { MOBILE_QUERY } from "@/lib/useIsMobile";
import {
  SHOW_MORE_KEY,
  hiddenCount,
  visibleColumns,
} from "@/features/board/lib/mobileColumns";
import type { BoardCard, BoardProject } from "@/features/board/api";

/**
 * The phone board.
 *
 * The rule it encodes: on a screen one column wide you get WAITING and WORKING — the two columns
 * that answer "who needs me" — and the other three behind one tap. Every assertion here is either
 * "the phone shows only those two" or "the desktop is exactly what it always was", because the
 * failure mode of a responsive change is silently reshaping the layout nobody asked to change.
 */

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

const PROJECT: BoardProject = { id: "p1", name: "billing", baseBranch: "dev", position: 0, createdAt: 1 };

function card(overrides: Partial<BoardCard> & { id: string }): BoardCard {
  return {
    projectId: "p1",
    title: overrides.id,
    column: "backlog",
    position: 0,
    tmuxSession: `card-${overrides.id}`,
    worktreeSlug: overrides.id,
    createdAt: 1,
    ...overrides,
  };
}

/** One card in each of the five columns, so a hidden column is a visible failure. */
const CARDS: BoardCard[] = [
  card({ id: "c-backlog", title: "plan the migration", column: "backlog" }),
  card({ id: "c-paused", title: "parked refactor", column: "paused" }),
  card({ id: "c-waiting", title: "needs an answer", column: "waiting", status: "waiting" }),
  card({ id: "c-working", title: "running now", column: "working", status: "working" }),
  card({ id: "c-done", title: "shipped", column: "done" }),
];

const originalMatchMedia = window.matchMedia;

/** Drives the media query the board reads. `true` = a phone-width viewport. */
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

/** jsdom has no drag data store, so the handlers get one — same shape the browser hands them. */
function dragTo(tile: HTMLElement, zone: HTMLElement): void {
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "" };
  fireEvent.dragStart(tile, { dataTransfer });
  fireEvent.dragEnter(zone, { dataTransfer });
  fireEvent.dragOver(zone, { dataTransfer });
  fireEvent.drop(zone, { dataTransfer });
}

function columnNames(): string[] {
  return screen.getAllByRole("region").map((el) => el.getAttribute("data-column") ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  setViewport(false);
  mockGet.mockImplementation(async (url: string) => {
    if (/^\/projects\/.+\/cards$/.test(url)) return { cards: CARDS };
    if (url === "/accounts") return { accounts: [], defaultLabel: "" };
    if (url === "/auth/me") return { user: { id: "1", username: "operator", role: "owner" } };
    return {};
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("visibleColumns / hiddenCount", () => {
  it("leaves the desktop board alone — five columns, board order", () => {
    expect(visibleColumns(false, false).map((c) => c.key)).toEqual([
      "backlog",
      "paused",
      "waiting",
      "working",
      "done",
    ]);
    expect(visibleColumns(false, true).map((c) => c.key)).toEqual(visibleColumns(false, false).map((c) => c.key));
  });

  it("is Waiting then Working on a phone, with the other three behind the toggle", () => {
    expect(visibleColumns(true, false).map((c) => c.key)).toEqual(["waiting", "working"]);
    expect(visibleColumns(true, true).map((c) => c.key)).toEqual([
      "waiting",
      "working",
      "paused",
      "backlog",
      "done",
    ]);
  });

  it("counts only what is hidden: paused + backlog + done", () => {
    expect(hiddenCount({ backlog: [1, 2], paused: [3], waiting: [4, 5, 6], working: [7], done: [8] })).toBe(4);
    expect(hiddenCount({ backlog: [], paused: [], waiting: [1], working: [], done: [] })).toBe(0);
  });
});

describe("KanbanBoard on a phone", () => {
  it("renders only Waiting and Working, plus a toggle carrying the hidden count", async () => {
    setViewport(true);
    renderApp(<KanbanBoard project={PROJECT} onOpenCard={() => {}} onNewCard={() => {}} onNewBacklogCard={() => {}} />);

    await waitFor(() => expect(columnNames()).toEqual(["waiting", "working"]));
    expect(screen.getByText("needs an answer")).toBeInTheDocument();
    expect(screen.getByText("running now")).toBeInTheDocument();
    expect(screen.queryByText("plan the migration")).toBeNull();
    expect(screen.queryByText("shipped")).toBeNull();
    // one card each in paused, backlog and done
    expect(screen.getByRole("button", { name: /Show more \(3\)/ })).toBeInTheDocument();
  });

  it("expands the other three in board order, and the button flips to Show less", async () => {
    setViewport(true);
    renderApp(<KanbanBoard project={PROJECT} onOpenCard={() => {}} onNewCard={() => {}} onNewBacklogCard={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Show more/ }));

    await waitFor(() =>
      expect(columnNames()).toEqual(["waiting", "working", "paused", "backlog", "done"]),
    );
    expect(screen.getByText("plan the migration")).toBeInTheDocument();
    expect(screen.getByText("shipped")).toBeInTheDocument();

    const less = screen.getByRole("button", { name: "Show less" });
    expect(less).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(less);
    await waitFor(() => expect(columnNames()).toEqual(["waiting", "working"]));
  });

  it("remembers the choice for the session", async () => {
    setViewport(true);
    const first = renderApp(<KanbanBoard project={PROJECT} onOpenCard={() => {}} onNewCard={() => {}} onNewBacklogCard={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Show more/ }));
    await waitFor(() => expect(sessionStorage.getItem(SHOW_MORE_KEY)).toBe("1"));
    first.unmount();

    renderApp(<KanbanBoard project={PROJECT} onOpenCard={() => {}} onNewCard={() => {}} onNewBacklogCard={() => {}} />);
    await waitFor(() =>
      expect(columnNames()).toEqual(["waiting", "working", "paused", "backlog", "done"]),
    );
  });

  it("keeps the new-card button at the top, above the columns", async () => {
    setViewport(true);
    renderApp(<KanbanBoard project={PROJECT} onOpenCard={() => {}} onNewCard={() => {}} onNewBacklogCard={() => {}} />);
    const button = await screen.findByRole("button", { name: /New card/ });
    const waiting = await screen.findByRole("region", { name: "Waiting" });
    expect(button.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still drops a card onto an expanded column", async () => {
    setViewport(true);
    mockPatch.mockResolvedValue({ card: {} });
    renderApp(<KanbanBoard project={PROJECT} onOpenCard={() => {}} onNewCard={() => {}} onNewBacklogCard={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Show more/ }));
    await screen.findByRole("region", { name: "Done" });

    const tile = screen.getByText("needs an answer").closest("[draggable]") as HTMLElement;
    dragTo(tile, screen.getByRole("region", { name: "Done" }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        "/cards/c-waiting",
        expect.objectContaining({ column: "done" }),
      ),
    );
  });

  it("leaves the desktop board with all five columns and no toggle", async () => {
    renderApp(<KanbanBoard project={PROJECT} onOpenCard={() => {}} onNewCard={() => {}} onNewBacklogCard={() => {}} />);
    await waitFor(() =>
      expect(columnNames()).toEqual(["backlog", "paused", "waiting", "working", "done"]),
    );
    expect(screen.queryByRole("button", { name: /Show more|Show less/ })).toBeNull();
  });
});

describe("AllProjectsBoard on a phone", () => {
  const projects: BoardProject[] = [PROJECT];

  it("shows the same two columns and the same toggle", async () => {
    setViewport(true);
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={() => {}} onNewCard={() => {}} />);
    await waitFor(() => expect(columnNames()).toEqual(["waiting", "working"]));

    await userEvent.click(screen.getByRole("button", { name: /Show more \(3\)/ }));
    await waitFor(() =>
      expect(columnNames()).toEqual(["waiting", "working", "paused", "backlog", "done"]),
    );
    expect(within(screen.getByRole("region", { name: "Done" })).getByText("shipped")).toBeInTheDocument();
  });

  it("is unchanged on the desktop", async () => {
    renderApp(<AllProjectsBoard projects={projects} onOpenCard={() => {}} onNewCard={() => {}} />);
    await waitFor(() =>
      expect(columnNames()).toEqual(["backlog", "paused", "waiting", "working", "done"]),
    );
    expect(screen.queryByRole("button", { name: /Show more|Show less/ })).toBeNull();
  });
});
