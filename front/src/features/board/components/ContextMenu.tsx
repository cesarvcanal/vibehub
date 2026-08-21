import * as React from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MENU_WIDTH,
  clampMenuPoint,
  type ContextMenuPoint,
} from "@/features/board/lib/contextMenu";

/**
 * A menu anchored at the point of a right-click.
 *
 * The board's cards already carry their common actions as inline icons, but the ones that matter
 * while an agent is running — pause it, restart it, call it done — should not require finding a
 * 24px target on hover. Right-click is the gesture everyone already has for "what can I do with
 * this", and anchoring at the click means a card needs no visible trigger at all.
 *
 * It closes on anything that could move the anchor out from under it: a click elsewhere, Escape,
 * a scroll, a resize. A fixed panel positioned against a point that has since moved is worse than
 * no panel, so the cheap answer — close — is the right one.
 *
 * It renders through a PORTAL onto `document.body`, which is not a detail: the columns of the board
 * carry `backdrop-blur`, and a filtered element becomes the containing block for its `position:
 * fixed` descendants. Left inside the card, the panel would be positioned against the column
 * instead of the viewport — the clamped coordinates would be measured from the wrong origin and the
 * menu would open somewhere near, but not at, the click.
 */

export interface ContextMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  icon?: LucideIcon;
  /** Explains the action, including why it is unavailable. */
  hint?: string;
  danger?: boolean;
}

export type { ContextMenuPoint };

/** The open point plus the handler that turns a browser `contextmenu` event into this panel. */
export function useContextMenuPoint() {
  const [point, setPoint] = React.useState<ContextMenuPoint | null>(null);
  const openAt = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setPoint({ x: event.clientX, y: event.clientY });
  }, []);
  const close = React.useCallback(() => setPoint(null), []);
  return { point, openAt, close };
}

/** Row height + padding, used to guess the panel's height before it is measured. */
const ROW_HEIGHT = 30;
const PANEL_PADDING = 8;

export function ContextMenu({
  point,
  items,
  ariaLabel,
  onClose,
}: {
  point: ContextMenuPoint | null;
  items: ContextMenuItem[];
  ariaLabel: string;
  onClose: () => void;
}) {
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!point) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKey);
    // Capture phase: a scroll inside a column never bubbles to the document otherwise.
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [point, onClose]);

  // No actions = no panel, and the browser's own menu is left to appear. Suppressing the native
  // menu to then show an empty box would be strictly worse than doing nothing.
  if (!point || items.length === 0) return null;

  const { left, top } = clampMenuPoint(
    point,
    { width: window.innerWidth, height: window.innerHeight },
    { width: MENU_WIDTH, height: items.length * ROW_HEIGHT + PANEL_PADDING },
  );

  const panel = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      style={{ left, top }}
      // React portals keep the REACT tree intact even though the DOM node moved, so an event still
      // bubbles to the card that rendered the menu — without stopping it, choosing an item would
      // also "open" the card underneath.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="fixed z-50 flex w-56 max-w-[calc(100vw-1rem)] flex-col rounded-lg border border-border bg-popover p-1 shadow-2xl"
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            title={item.hint}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
              item.danger
                ? "text-destructive hover:bg-destructive/10"
                : "text-foreground hover:bg-accent focus:bg-accent",
            )}
          >
            {Icon ? <Icon className="h-4 w-4 shrink-0 opacity-70" /> : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  return createPortal(panel, document.body);
}
