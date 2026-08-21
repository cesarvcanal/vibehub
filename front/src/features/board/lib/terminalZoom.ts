/**
 * Terminal zoom and clipboard, kept out of the component so they are testable in jsdom (a real
 * xterm does not open there).
 *
 * Both exist because of things people actually hit:
 *  - **Zoom.** A terminal is where you read for hours. 13px on a 4K panel and 13px on a laptop are
 *    not the same thing, and the size you like is a per-person, per-screen decision — so it is a
 *    control, and it persists.
 *  - **Clipboard.** `navigator.clipboard` only exists in a secure context (https or localhost). A
 *    self-hosted install reached over plain http on a LAN — which is a normal way to run this —
 *    silently refuses every copy: the selection highlights, and nothing lands on the clipboard.
 */

export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 20;
export const TERMINAL_FONT_STEP = 1;
export const TERMINAL_FONT_DEFAULT = 13;
/** One key for the whole app: the size you chose is about your eyes, not about a given card. */
export const TERMINAL_FONT_SIZE_KEY = "vibehub.terminalFontSize";

/** Clamps `size` into [min, max] and rounds it. An invalid value falls back to the minimum. */
export function clampFontSize(size: number, min = TERMINAL_FONT_MIN, max = TERMINAL_FONT_MAX): number {
  if (!Number.isFinite(size)) return min;
  return Math.min(max, Math.max(min, Math.round(size)));
}

/** The next size from the current one: one step in (+1) or out (−1), already clamped. */
export function nextFontSize(current: number, direction: 1 | -1, step = TERMINAL_FONT_STEP): number {
  return clampFontSize(current + step * direction);
}

export type ZoomAction = "in" | "out" | "reset";

/**
 * Cmd/Ctrl `+`/`=` zooms in, Cmd/Ctrl `-`/`_` zooms out, Cmd/Ctrl `0` resets. No Alt, keydown only.
 * Returns the action so the caller can preventDefault — otherwise the browser zooms the whole page
 * and the terminal geometry goes with it. PURE.
 */
export function zoomActionFromKey(e: KeyboardEvent): ZoomAction | null {
  if (e.type !== "keydown") return null;
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const k = e.key;
  if (k === "+" || k === "=") return "in";
  if (k === "-" || k === "_") return "out";
  if (k === "0") return "reset";
  return null;
}

/** Applies a zoom action to a size. PURE. */
export function applyZoom(current: number, action: ZoomAction): number {
  if (action === "reset") return TERMINAL_FONT_DEFAULT;
  return nextFontSize(current, action === "in" ? 1 : -1);
}

/** Reads the stored size (clamped). Missing, invalid or no storage → `fallback`. */
export function readTerminalFontSize(fallback: number = TERMINAL_FONT_DEFAULT): number {
  try {
    const raw = localStorage.getItem(TERMINAL_FONT_SIZE_KEY);
    if (raw === null) return clampFontSize(fallback);
    const n = Number(raw);
    return Number.isFinite(n) ? clampFontSize(n) : clampFontSize(fallback);
  } catch {
    return clampFontSize(fallback);
  }
}

/** Stores the size (clamped). Silent when storage is unavailable — the zoom just does not persist. */
export function writeTerminalFontSize(size: number): void {
  try {
    localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(clampFontSize(size)));
  } catch {
    /* private mode, quota, storage blocked */
  }
}

/**
 * Legacy fallback for when the Clipboard API fails or is not there at all: an off-screen textarea
 * plus `execCommand('copy')`. It does not need a secure context or a permission, and it tolerates
 * gesture timing better. Only reached when the modern API has already failed.
 */
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

/**
 * `navigator.clipboard.writeText` with the legacy fallback behind it.
 *
 * If BOTH fail, a `console.warn` carrying both reasons is the only visible output — silence here
 * was the actual bug: people saw the selection happen, pasted, and got nothing, with no way to tell
 * whether it was a permission, an insecure context, or something else.
 */
export function writeClipboard(
  text: string,
  write?: (t: string) => Promise<void>,
  fallback: (t: string) => boolean = legacyCopy,
): void {
  const w = write ?? ((t: string) => navigator.clipboard.writeText(t));
  const tryFallback = (apiReason: unknown) => {
    try {
      if (!fallback(text)) {
        console.warn(
          "[clipboard] the Clipboard API refused and execCommand('copy') copied nothing — nothing reached the clipboard.",
          { apiReason },
        );
      }
    } catch (fallbackReason) {
      console.warn(
        "[clipboard] both the Clipboard API and execCommand('copy') failed — nothing reached the clipboard.",
        { apiReason, fallbackReason },
      );
    }
  };
  try {
    void Promise.resolve(w(text)).catch(tryFallback);
  } catch (apiReason) {
    tryFallback(apiReason);
  }
}
