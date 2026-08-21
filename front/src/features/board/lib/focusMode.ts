/**
 * Focus mode geometry — the numbers the terminal view and the terminal itself agree on.
 *
 * A terminal is the one widget that cannot be "roughly" sized: half a row short and the agent's
 * last line is invisible, half a row long and the pane scrolls forever. So the height is computed,
 * not guessed, and everything that eats vertical space is named here rather than being sprinkled
 * across class names.
 */

/** The app shell's sticky header (`h-11` in AppLayout). */
export const HEADER_PX = 44;

/** Vertical padding the focus layout puts around itself, top and bottom. */
export const FOCUS_PAD_PX = 6;

/** Total chrome above and below the focus view. */
export const FOCUS_CHROME_PX = HEADER_PX + FOCUS_PAD_PX * 2;

/** CSS height for the focus view: the viewport minus everything that is not the view. */
export function focusHeight(chrome: number = FOCUS_CHROME_PX): string {
  return `calc(100vh - ${Math.max(0, Math.round(chrome))}px)`;
}

/**
 * Terminal geometry the runner accepts (it validates the same range, so anything outside is a
 * frame the server would reject).
 */
export const TERM_MIN = 10;
export const TERM_MAX = 500;

/** True when `n` is a size the resize frame may carry. */
export function isValidTermSize(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= TERM_MIN && n <= TERM_MAX;
}

/** Nearest size the runner will accept. Non-finite input falls back to the minimum. */
export function clampTermSize(n: number): number {
  if (!Number.isFinite(n)) return TERM_MIN;
  return Math.min(TERM_MAX, Math.max(TERM_MIN, Math.trunc(n)));
}

export interface ResizeFrame {
  type: "resize";
  cols: number;
  rows: number;
}

/**
 * The frame sent up the websocket after a fit. Returns null when the measurement is nonsense
 * (a detached or zero-sized element measures as 0) — sending that would resize the agent's pty to
 * something unusable, so we simply do not send it and wait for the next observation.
 */
export function resizeFrame(cols: number, rows: number): ResizeFrame | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (cols < 1 || rows < 1) return null;
  return { type: "resize", cols: clampTermSize(cols), rows: clampTermSize(rows) };
}

/**
 * Columns and rows that fit a box, given one cell's size.
 *
 * The FitAddon does this against the element it is mounted on, which is exactly why that element
 * must be CLEAN: padding or a border on the holder is counted as usable space and the last row ends
 * up clipped. This function is the same arithmetic, used as a fallback when the addon measures
 * nothing, and it takes the box AFTER the chrome has been subtracted.
 */
export function fitDimensions(
  box: { width: number; height: number },
  cell: { width: number; height: number },
): { cols: number; rows: number } | null {
  if (!(cell.width > 0) || !(cell.height > 0)) return null;
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return {
    cols: clampTermSize(Math.floor(box.width / cell.width)),
    rows: clampTermSize(Math.floor(box.height / cell.height)),
  };
}
