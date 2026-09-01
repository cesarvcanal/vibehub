import * as React from "react";
import {
  isMarqueeDrag,
  rectFromPoints,
  rectsIntersect,
  type Rect,
} from "@/features/board/lib/selection";

/**
 * The rubber-band selection layer around a board.
 *
 * The gesture is decided by WHERE the press lands, which is what keeps it out of the card drag's
 * way: a press on a card (`[data-card-id]`), a button, a link or a form control is none of this
 * component's business and starts the behaviour those elements already have — dragging a card still
 * moves it. Only a press on the board's EMPTY space (column background, gaps) is claimed, and even
 * then nothing draws until the pointer has actually travelled (`isMarqueeDrag`): a press-and-release
 * on the background is a click, and a click on nothing clears the selection.
 *
 * While the band is out, every card it touches is selected — recomputed on each move from the live
 * `[data-card-id]` rectangles, so scrolling mid-drag stays honest. Coordinates are CLIENT
 * coordinates throughout and the band itself is `position: fixed`, which is what makes the maths
 * immune to whatever scrolling container the board happens to sit in.
 *
 * Mouse only, by design: on a touch screen a drag on empty space is how the page scrolls.
 */
export function MarqueeSelect({
  enabled,
  onSelect,
  onClear,
  children,
}: {
  enabled: boolean;
  /** The marquee's verdict: the ids it currently touches. REPLACES the selection. */
  onSelect: (ids: string[]) => void;
  /** A plain click on the board's empty space — nothing was dragged over. */
  onClear: () => void;
  children: React.ReactNode;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const origin = React.useRef<{ x: number; y: number } | null>(null);
  const [band, setBand] = React.useState<Rect | null>(null);
  const bandRef = React.useRef<Rect | null>(null);

  // The handlers live on `window` for the life of one gesture: the pointer routinely leaves the
  // board mid-drag, and losing the pointerup there would leave a band stuck on screen.
  React.useEffect(() => {
    if (!enabled) return;

    const move = (e: PointerEvent) => {
      const start = origin.current;
      if (!start) return;
      const point = { x: e.clientX, y: e.clientY };
      if (!bandRef.current && !isMarqueeDrag(start, point)) return;
      const rect = rectFromPoints(start, point);
      bandRef.current = rect;
      setBand(rect);
      onSelect(cardsTouching(containerRef.current, rect));
    };

    const up = () => {
      if (!origin.current) return;
      const dragged = Boolean(bandRef.current);
      origin.current = null;
      bandRef.current = null;
      setBand(null);
      if (!dragged) onClear();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [enabled, onSelect, onClear]);

  return (
    <div
      ref={containerRef}
      data-marquee-root
      // Without this the drag also sweeps a text selection across every card title it crosses.
      className={band ? "select-none" : undefined}
      onPointerDown={
        enabled
          ? (e) => {
              if (e.button !== 0 || e.pointerType === "touch") return;
              if (isInteractive(e.target)) return;
              origin.current = { x: e.clientX, y: e.clientY };
            }
          : undefined
      }
    >
      {children}
      {band ? (
        <div
          aria-hidden
          data-marquee-band
          className="pointer-events-none fixed z-50 rounded-sm border border-primary/70 bg-primary/10"
          style={{
            left: band.left,
            top: band.top,
            width: band.right - band.left,
            height: band.bottom - band.top,
          }}
        />
      ) : null}
    </div>
  );
}

/** A press here belongs to something else — a card (drag/click), a control, a menu. */
function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("[data-card-id], a, button, input, select, textarea, [role='menu']"));
}

/** Every card in the container whose tile the band touches, by its live rectangle. */
function cardsTouching(container: HTMLElement | null, band: Rect): string[] {
  if (!container) return [];
  const ids: string[] = [];
  for (const el of container.querySelectorAll<HTMLElement>("[data-card-id]")) {
    const r = el.getBoundingClientRect();
    if (rectsIntersect(band, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })) {
      const id = el.getAttribute("data-card-id");
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * Esc clears the selection — unless something that eats keystrokes has the focus, where Esc already
 * means "close this" or "leave the field".
 */
export function useClearSelectionOnEscape(enabled: boolean, onClear: () => void): void {
  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [role='dialog'], [role='menu']")
      ) {
        return;
      }
      onClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, onClear]);
}
