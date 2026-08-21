/**
 * PURE derivation of the display number, ports and user-data-dir for a card's live browser.
 *
 * It lives apart from browser.ts so the card-open path (which builds the tmux environment and needs
 * the CDP port to hand to the Playwright MCP) can import it WITHOUT pulling in browser.ts — that
 * would be a module cycle. Nothing here does I/O.
 */

/** Slot space per card — keeps display/ports in ranges that never cross each other. */
export const SLOT_SPACE = 900;

/** First X display number handed out (:100 … :999). */
export const DISPLAY_BASE = 100;
/** First RFB port handed out (5900 … 6799). */
export const VNC_PORT_BASE = 5900;
/** First DevTools/CDP port handed out (9222 … 10121). */
export const CDP_PORT_BASE = 9222;

/**
 * Where each card's Chromium profile lives. It sits under /work, the runner's persistent bind
 * mount, so a browser profile survives a container restart.
 */
export const BROWSER_DATA_DIR = "/work/.browser";

export interface CardBrowserPorts {
  /** X display number for this card (:100 … :999). */
  display: number;
  /** RFB port of x11vnc inside the container (bound to 127.0.0.1 only). */
  vncPort: number;
  /** Chromium DevTools/CDP port (127.0.0.1 only) — what the Playwright MCP connects to. */
  cdpPort: number;
  /** Dedicated Chromium user-data-dir so two cards never share a browser profile. */
  userDataDir: string;
}

/**
 * Deterministic slot for a card (0..SLOT_SPACE-1). Normal path: the leading hex of the id (card ids
 * are uuids, so pure hex). It is TOTAL — it never throws: an unusual id (non-hex) falls back to a
 * deterministic hash of the whole id, so deriving ports can NEVER be the thing that breaks opening
 * a card. Two cards colliding is unlikely (1/900) and harmless-ish: they would share a display.
 */
export function cardBrowserSlot(cardId: string): number {
  const hex = cardId.replace(/-/g, "").slice(0, 6);
  if (hex.length > 0 && /^[0-9a-fA-F]+$/.test(hex)) return Number.parseInt(hex, 16) % SLOT_SPACE;
  let h = 0;
  for (let i = 0; i < cardId.length; i++) h = (h * 31 + cardId.charCodeAt(i)) % SLOT_SPACE;
  return h;
}

/** Display/ports/user-data-dir of a card — all derived from its slot. PURE. */
export function cardBrowserPorts(cardId: string): CardBrowserPorts {
  const slot = cardBrowserSlot(cardId);
  return {
    display: DISPLAY_BASE + slot,
    vncPort: VNC_PORT_BASE + slot,
    cdpPort: CDP_PORT_BASE + slot,
    // Only [0-9a-f] survives the slice, so this path can never carry a shell metacharacter.
    userDataDir: `${BROWSER_DATA_DIR}/card-${cardId.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8)}`,
  };
}

/** CDP endpoint (container loopback) of a card's browser — what the Playwright MCP consumes. PURE. */
export function cardCdpEndpoint(cardId: string): string {
  return `http://127.0.0.1:${cardBrowserPorts(cardId).cdpPort}`;
}
