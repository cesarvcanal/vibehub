/**
 * Where a right-click menu is allowed to sit.
 *
 * The panel is anchored at the POINT of the click rather than at a trigger element, which is what
 * lets a card have a menu without carrying a visible "⋯" button. The cost of that freedom is that
 * nothing stops the panel from hanging off the screen, so the position is clamped here — pure, so
 * the edge cases are a test instead of a thing you discover by right-clicking the last card in the
 * rightmost column.
 */

export interface ContextMenuPoint {
  x: number;
  y: number;
}

/** Panel width (`w-56`) and the breathing room kept against every viewport edge. */
export const MENU_WIDTH = 224;
export const MENU_MARGIN = 8;

/**
 * Clamps the anchor so the panel stays fully on screen.
 *
 * Horizontally the panel is placed to the RIGHT of the click and pushed left only when it would
 * overflow. Vertically it hangs DOWN from the click, so it is flipped to hang upwards when there is
 * not enough room below — a menu that hides its own items under the fold is worse than one that
 * opens in the other direction.
 *
 * A viewport narrower or shorter than the panel is not an error: the margin wins and the panel is
 * pinned at the top-left, which is the only honest answer.
 */
export function clampMenuPoint(
  point: ContextMenuPoint,
  viewport: { width: number; height: number },
  menu: { width?: number; height: number },
): { left: number; top: number } {
  const width = menu.width ?? MENU_WIDTH;
  const left = clamp(point.x, MENU_MARGIN, viewport.width - width - MENU_MARGIN);

  // Flip upwards rather than squash: the click point becomes the BOTTOM edge of the panel.
  const overflowsBelow = point.y + menu.height + MENU_MARGIN > viewport.height;
  const flipped = overflowsBelow && point.y - menu.height >= MENU_MARGIN;
  const desiredTop = flipped ? point.y - menu.height : point.y;
  const top = clamp(desiredTop, MENU_MARGIN, viewport.height - menu.height - MENU_MARGIN);

  return { left, top };
}

function clamp(value: number, min: number, max: number): number {
  // `max` below `min` means the panel does not fit at all — the margin is the last thing to give.
  return Math.max(min, Math.min(value, Math.max(min, max)));
}
