import { describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { MarqueeSelect } from "@/features/board/components/MarqueeSelect";

/** jsdom has no PointerEvent: the coordinates are planted on the event (as in KanbanBoard.test). */
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

function placeCard(id: string, left: number, top: number, size = 20) {
  const el = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement;
  el.getBoundingClientRect = () =>
    ({ left, top, right: left + size, bottom: top + size, width: size, height: size }) as DOMRect;
}

function renderBoard(onSelect: (ids: string[]) => void, onClear = vi.fn()) {
  render(
    <MarqueeSelect enabled onSelect={onSelect} onClear={onClear}>
      <div data-testid="background">
        <div data-card-id="a">a</div>
        <div data-card-id="b">b</div>
      </div>
    </MarqueeSelect>,
  );
  placeCard("a", 0, 0);
  placeCard("b", 0, 40);
  return screen.getByTestId("background");
}

describe("MarqueeSelect", () => {
  // Every onSelect REPLACES the board's selection with a new Set, which re-renders the board and
  // every tile on it. A band sweeping across empty space touches the same cards for dozens of
  // moves in a row: only a CHANGE in what it touches is worth telling the board about.
  it("tells the board only when what the band touches changes, not on every move", () => {
    const onSelect = vi.fn();
    const background = renderBoard(onSelect);

    firePointer(background, "pointerdown", 5, 5);
    firePointer(window, "pointermove", 25, 25); // touches a
    firePointer(window, "pointermove", 26, 26); // still a
    firePointer(window, "pointermove", 27, 27); // still a
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(["a"]);

    firePointer(window, "pointermove", 25, 50); // a and b
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(["a", "b"]);
    firePointer(window, "pointerup", 25, 50);
  });

  it("each new band reports its first verdict, even if it matches the last band's", () => {
    // In between the two gestures a shift-click may have changed the selection: the new band's
    // verdict has to land again.
    const onSelect = vi.fn();
    const background = renderBoard(onSelect);

    firePointer(background, "pointerdown", 5, 5);
    firePointer(window, "pointermove", 25, 25);
    firePointer(window, "pointerup", 25, 25);
    firePointer(background, "pointerdown", 5, 5);
    firePointer(window, "pointermove", 25, 25);
    firePointer(window, "pointerup", 25, 25);

    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
