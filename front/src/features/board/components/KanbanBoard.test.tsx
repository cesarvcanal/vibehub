import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, screen, waitFor } from "@testing-library/react";
import { KanbanBoard, insertionLine } from "@/features/board/components/KanbanBoard";
import { renderApp } from "@/test/render";
import { get, patch } from "@/lib/api";
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

const project: BoardProject = { id: "p1", name: "billing", baseBranch: "dev", position: 0, createdAt: 1 };

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

/** Three cards stacked in the backlog, in order. */
const cards: BoardCard[] = [
  card({ id: "c1", title: "first", position: 0 }),
  card({ id: "c2", title: "second", position: 1 }),
  card({ id: "c3", title: "third", position: 2 }),
];

beforeEach(() => {
  vi.resetAllMocks();
  mockGet.mockImplementation((url: string) =>
    /\/cards$/.test(url) ? Promise.resolve({ cards }) : Promise.resolve({}),
  );
  mockPatch.mockResolvedValue({ card: cards[0] });
});

function board() {
  return renderApp(<KanbanBoard project={project} onOpenCard={vi.fn()} onNewCard={vi.fn()} onNewBacklogCard={vi.fn()} />);
}

/** The draggable tile for a card title, and the slot around it that owns the drop maths. */
function tile(title: string): { handle: HTMLElement; slot: HTMLElement } {
  const handle = screen.getByRole("link", { name: title });
  return { handle, slot: handle.parentElement as HTMLElement };
}

/** jsdom builds drag events without one, and every handler here writes to it. */
function transfer() {
  return { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "" };
}

/**
 * A dragover at a given height. jsdom has no `DragEvent`, so testing-library falls back to a plain
 * Event and the pointer coordinate — the whole point of this gesture — never arrives. It is set on
 * the event by hand.
 */
function dragOverAt(el: HTMLElement, clientY: number, dataTransfer: unknown) {
  const event = createEvent.dragOver(el, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(el, event);
}

/** Drags `from` onto the half of `to` given by `below`, and drops. */
function dragOnto(from: string, to: string, below: boolean) {
  const dataTransfer = transfer();
  const source = tile(from);
  const target = tile(to);
  // jsdom has no layout: the slot is 40px tall at y=0, so 30 is its bottom half and 10 its top.
  target.slot.getBoundingClientRect = () => ({ top: 0, height: 40 }) as DOMRect;
  fireEvent.dragStart(source.handle, { dataTransfer });
  dragOverAt(target.slot, below ? 30 : 10, dataTransfer);
  fireEvent.drop(target.slot.closest("section") as HTMLElement, { dataTransfer });
}

describe("KanbanBoard reordering", () => {
  it("moves a card UP inside its own column", async () => {
    board();
    await screen.findByText("third");

    dragOnto("third", "first", false);

    // Position is the index AFTER the card has been taken out — the top of the column is 0.
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c3", { column: "backlog", position: 0 }));
  });

  it("moves a card DOWN inside its own column", async () => {
    board();
    await screen.findByText("first");

    dragOnto("first", "third", true);

    // [c1, c2, c3] with c1 lifted out is [c2, c3]; dropping below c3 is index 2.
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { column: "backlog", position: 2 }));
  });

  it("does nothing when the card is dropped back where it already was", async () => {
    board();
    await screen.findByText("second");

    dragOnto("second", "second", false);

    await waitFor(() => expect(screen.getByText("second")).toBeInTheDocument());
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("drops into ANOTHER column at the point it was aimed at, not at the end", async () => {
    mockGet.mockImplementation((url: string) =>
      /\/cards$/.test(url)
        ? Promise.resolve({
            cards: [
              ...cards,
              card({ id: "c4", title: "parked", column: "paused", position: 0 }),
              card({ id: "c5", title: "also parked", column: "paused", position: 1 }),
            ],
          })
        : Promise.resolve({}),
    );
    board();
    await screen.findByText("parked");

    // Above the first card of Paused, which the old board could not express at all.
    dragOnto("first", "parked", false);

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { column: "paused", position: 0 }));
  });

  it("drops at the END when the pointer is on the column's empty space", async () => {
    board();
    await screen.findByText("first");

    const dataTransfer = transfer();
    const source = tile("first");
    const done = screen.getByRole("region", { name: "Done" });
    fireEvent.dragStart(source.handle, { dataTransfer });
    fireEvent.dragOver(done, { dataTransfer });
    fireEvent.drop(done, { dataTransfer });

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/cards/c1", { column: "done", position: 0 }));
  });

  it("shows the insertion line on the seam the pointer is over", async () => {
    board();
    await screen.findByText("third");

    const dataTransfer = transfer();
    const source = tile("third");
    const target = tile("first");
    target.slot.getBoundingClientRect = () => ({ top: 0, height: 40 }) as DOMRect;
    fireEvent.dragStart(source.handle, { dataTransfer });
    dragOverAt(target.slot, 10, dataTransfer);

    const column = screen.getByRole("region", { name: "Backlog" });
    expect(column.querySelectorAll("[data-drop-line]")).toHaveLength(1);
    expect(column.querySelector("[data-drop-line]")?.getAttribute("data-drop-line")).toBe("top");
  });
});

/**
 * Pointer events with coordinates, built by hand — jsdom has no PointerEvent, so the coordinate
 * has to be planted on the event (same trick as `dragOverAt`). An Element goes through
 * testing-library so React's delegated handler hears it; `window` takes a raw dispatch, which is
 * all the marquee's own window listeners need.
 */
function firePointer(target: EventTarget, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number) {
  const event =
    target instanceof Element
      ? createEvent[type === "pointerdown" ? "pointerDown" : type === "pointermove" ? "pointerMove" : "pointerUp"](target)
      : new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: x });
  Object.defineProperty(event, "clientY", { value: y });
  Object.defineProperty(event, "button", { value: 0 });
  fireEvent(target as Element, event);
}

/** Plants a client rectangle on a card's tile so the marquee has something to intersect. */
function placeTile(title: string, left: number, top: number, size = 20) {
  tile(title).handle.getBoundingClientRect = () =>
    ({ left, top, right: left + size, bottom: top + size, width: size, height: size }) as DOMRect;
}

function selectedTitles(): string[] {
  return [...document.querySelectorAll("[data-selected]")].map(
    (el) => el.getAttribute("aria-label") ?? "",
  );
}

describe("KanbanBoard multi-selection", () => {
  it("shift-click toggles a card in and out without opening it", async () => {
    const onOpen = vi.fn();
    renderApp(
      <KanbanBoard project={project} onOpenCard={onOpen} onNewCard={vi.fn()} onNewBacklogCard={vi.fn()} />,
    );
    await screen.findByText("first");

    fireEvent.click(tile("first").handle, { shiftKey: true });
    fireEvent.click(tile("second").handle, { shiftKey: true });
    expect(selectedTitles()).toEqual(["first", "second"]);

    fireEvent.click(tile("second").handle, { shiftKey: true });
    expect(selectedTitles()).toEqual(["first"]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Esc clears the selection; a plain click opens the card and clears it too", async () => {
    const onOpen = vi.fn();
    renderApp(
      <KanbanBoard project={project} onOpenCard={onOpen} onNewCard={vi.fn()} onNewBacklogCard={vi.fn()} />,
    );
    await screen.findByText("first");

    fireEvent.click(tile("first").handle, { shiftKey: true });
    expect(selectedTitles()).toEqual(["first"]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(selectedTitles()).toEqual([]);

    fireEvent.click(tile("second").handle, { shiftKey: true });
    fireEvent.click(tile("first").handle);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    expect(selectedTitles()).toEqual([]);
  });

  it("marquee on empty board selects the cards it touches; a click on nothing clears", async () => {
    board();
    await screen.findByText("third");
    placeTile("first", 0, 0);
    placeTile("second", 0, 40);
    placeTile("third", 0, 400);
    const column = screen.getByRole("region", { name: "Backlog" });

    // Drag a band from (5,5) to (30,70): it crosses first and second, not third.
    firePointer(column, "pointerdown", 5, 5);
    firePointer(window, "pointermove", 30, 70);
    expect(document.querySelector("[data-marquee-band]")).not.toBeNull();
    expect(selectedTitles()).toEqual(["first", "second"]);
    firePointer(window, "pointerup", 30, 70);
    expect(document.querySelector("[data-marquee-band]")).toBeNull();
    expect(selectedTitles()).toEqual(["first", "second"]);

    // Press-and-release on the background without travelling: a click, and it clears.
    firePointer(column, "pointerdown", 300, 300);
    firePointer(window, "pointerup", 300, 300);
    expect(selectedTitles()).toEqual([]);
  });

  it("a press ON a card never starts a marquee", async () => {
    board();
    await screen.findByText("first");
    placeTile("first", 0, 0);

    firePointer(tile("first").handle, "pointerdown", 5, 5);
    firePointer(window, "pointermove", 200, 200);
    expect(document.querySelector("[data-marquee-band]")).toBeNull();
    expect(selectedTitles()).toEqual([]);
    firePointer(window, "pointerup", 200, 200);
  });

  it("dragging a selected card moves EVERY selected card to the target column, order kept", async () => {
    board();
    await screen.findByText("third");

    fireEvent.click(tile("third").handle, { shiftKey: true });
    fireEvent.click(tile("first").handle, { shiftKey: true });

    const dataTransfer = transfer();
    const done = screen.getByRole("region", { name: "Done" });
    fireEvent.dragStart(tile("first").handle, { dataTransfer });
    fireEvent.dragOver(done, { dataTransfer });
    fireEvent.drop(done, { dataTransfer });

    // Board order (first is above third), not click order — and one PATCH per card.
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(2));
    expect(mockPatch).toHaveBeenNthCalledWith(1, "/cards/c1", { column: "done", position: 0 });
    expect(mockPatch).toHaveBeenNthCalledWith(2, "/cards/c3", { column: "done", position: 1 });
  });

  it("dragging a card OUTSIDE the selection moves only it and drops the selection", async () => {
    board();
    await screen.findByText("third");

    fireEvent.click(tile("first").handle, { shiftKey: true });
    fireEvent.click(tile("second").handle, { shiftKey: true });

    const dataTransfer = transfer();
    const done = screen.getByRole("region", { name: "Done" });
    fireEvent.dragStart(tile("third").handle, { dataTransfer });
    fireEvent.dragOver(done, { dataTransfer });
    fireEvent.drop(done, { dataTransfer });

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/cards/c3", { column: "done", position: 0 }),
    );
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(selectedTitles()).toEqual([]);
  });
});

describe("insertionLine", () => {
  it("draws gap 0 on the top edge of the first card", () => {
    expect(insertionLine(0, 0, 3)).toBe("top");
    expect(insertionLine(0, 1, 3)).toBeNull();
  });

  it("draws a middle gap on the bottom edge of the card above it", () => {
    expect(insertionLine(2, 1, 3)).toBe("bottom");
    expect(insertionLine(2, 2, 3)).toBeNull();
  });

  it("draws the last gap on the bottom edge of the last card", () => {
    expect(insertionLine(3, 2, 3)).toBe("bottom");
    expect(insertionLine(3, 0, 3)).toBeNull();
  });
});
