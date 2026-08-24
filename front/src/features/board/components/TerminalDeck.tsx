import * as React from "react";
import { cn } from "@/lib/utils";
import { CardTerminalView } from "@/features/board/components/CardTerminalView";
import type { DeckEntry } from "@/features/board/lib/deck";
import type { BoardProject } from "@/features/board/api";

/**
 * Every terminal you have opened, all alive, one of them on top.
 *
 * ## Why this exists
 *
 * Hopping between agents is the whole job of this board, and it used to cost a full teardown: a new
 * xterm, a new websocket, a fresh attach and a repaint of the TUI. That is a second of blank pane
 * every time you look at another card — enough to break the flow the board exists to support.
 *
 * Here the panes are STACKED instead. All of them are mounted, all of them keep their socket, and
 * switching cards flips which one is visible. Nothing reconnects, nothing repaints, and the
 * scrollback you were reading is where you left it.
 *
 * ## The two things that make it work
 *
 * 1. **Hidden must not mean zero-sized.** `display: none` would collapse the pane's box, the fit
 *    addon would measure nothing, and the pty would be resized to a sliver — the agent's TUI would
 *    redraw itself into a corner while you are not even looking. So the panes are absolutely
 *    positioned over ONE box and hidden with `visibility`, which keeps the layout box intact: every
 *    terminal in the deck is exactly the size of the visible one, and switching costs no resize at
 *    all.
 * 2. **Leaving the deck on screen must not disturb the board.** When no card is open the deck is
 *    parked: taken out of the flow (`position: fixed`, off the z-order, not hit-testable) at the
 *    size it had while it was visible — measured on every visible commit, so the parked box is the
 *    real one rather than a guess. The terminals keep their geometry, the board lays out as if the
 *    deck were not there, and coming back is a change of two style properties.
 *
 * The deck sits at a FIXED position in the page's element tree — the same child of the same parent
 * whether a card is open or not. That is not cosmetic: React reconciles by position, and moving
 * this node between two branches would unmount every terminal in it, which is the exact thing the
 * component exists to prevent.
 */
/** A box the size of the window — the parked size before anything has been measured. */
function viewportBox(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1024, height: 768 };
  return { width: window.innerWidth || 1024, height: window.innerHeight || 768 };
}

export function TerminalDeck({
  entries,
  activeCardId,
  projects,
  onBack,
  onNewCard,
  onOpenMenu,
  onClose,
}: {
  entries: readonly DeckEntry[];
  /** The card on top, or null when the board is showing and the whole deck is parked. */
  activeCardId: string | null;
  projects: readonly BoardProject[];
  onBack: (projectId: string) => void;
  onNewCard: (project: BoardProject) => void;
  onOpenMenu: () => void;
  /** A card whose session is gone (paused): drop it from the deck instead of reconnecting to it. */
  onClose: (cardId: string) => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  // The box to park at. Written on every commit where the deck is visible — never read from state,
  // because the render that PARKS it must already know the size the previous one measured.
  const sizeRef = React.useRef<{ width: number; height: number } | null>(null);
  const visible = activeCardId !== null;

  React.useLayoutEffect(() => {
    if (!visible) return;
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) sizeRef.current = { width: box.width, height: box.height };
  });

  // Parked ALWAYS when nothing is on top — a deck left in the flow would sit in the board's layout
  // and be visible over it. The measured box is the right one; the viewport is the fallback for the
  // case where there is nothing to measure yet, and it is deliberately not zero: a zero-sized box
  // would resize every pty in the deck down to a sliver.
  const parked = !visible ? (sizeRef.current ?? viewportBox()) : null;

  // Nothing has ever been opened: render nothing at all rather than an invisible box.
  if (entries.length === 0 && !visible) return <div ref={ref} hidden data-testid="terminal-deck" />;

  return (
    <div
      ref={ref}
      data-testid="terminal-deck"
      data-parked={parked ? "true" : undefined}
      className="relative min-h-0 min-w-0 flex-1"
      style={
        parked
          ? {
              position: "fixed",
              left: 0,
              top: 0,
              width: parked.width,
              height: parked.height,
              // `visibility`, not `display`: the box (and every terminal's geometry inside it) has
              // to survive being off screen. See note 1 above.
              visibility: "hidden",
              pointerEvents: "none",
              zIndex: -1,
            }
          : undefined
      }
    >
      {entries.map((entry) => {
        const project = projects.find((p) => p.id === entry.projectId);
        if (!project) return null;
        const active = entry.cardId === activeCardId;
        return (
          <Pane key={entry.cardId} cardId={entry.cardId} active={active}>
            <CardTerminalView
              project={project}
              cardId={entry.cardId}
              active={active}
              onBack={() => onBack(project.id)}
              onNewCard={() => onNewCard(project)}
              onOpenMenu={onOpenMenu}
              onClose={() => onClose(entry.cardId)}
            />
          </Pane>
        );
      })}
    </div>
  );
}

/**
 * One card's slot in the stack: same box as every other, visible only when it is the active one.
 *
 * A hidden pane must not be REACHABLE — and that is about the keyboard, not about looks. The pane
 * you just left still contains a focused xterm, and a terminal that keeps the focus while another
 * card is on screen means your next keystrokes go to the wrong agent. `inert` is what says so
 * properly (it drops the focus, takes the subtree out of the tab order and hides it from assistive
 * tech); the explicit blur is for the browsers that do not implement it yet, where losing a
 * sentence into an invisible session would be the alternative.
 *
 * It is set imperatively because React 18 does not pass `inert` through as a property, and the
 * value has to be an attribute for the browser to act on it at all.
 */
function Pane({
  cardId,
  active,
  children,
}: {
  cardId: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (active) {
      el.removeAttribute("inert");
      return;
    }
    el.setAttribute("inert", "");
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && el.contains(focused)) focused.blur();
  }, [active]);

  return (
    <div
      ref={ref}
      data-card-pane={cardId}
      data-active={active ? "true" : "false"}
      aria-hidden={!active || undefined}
      className={cn(
        "absolute inset-0 flex min-h-0 min-w-0 flex-col",
        !active && "invisible pointer-events-none",
      )}
    >
      {children}
    </div>
  );
}

export default TerminalDeck;
