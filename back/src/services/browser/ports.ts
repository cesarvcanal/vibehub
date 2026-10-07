/**
 * Display number, ports and user-data-dir for a card's live browser.
 *
 * It lives apart from browser.ts so the card-open path (which builds the tmux environment and needs
 * the CDP port to hand to the Playwright MCP) can import it WITHOUT pulling in browser.ts — that
 * would be a module cycle. Nothing here does I/O.
 *
 * THE SLOT IS ALLOCATED, NOT DERIVED. Deriving it from the id alone (`hex6 % 900`) collides about
 * one time in five on a board with twenty cards, and a collision is not "harmless-ish": the two
 * cards share display, VNC and CDP port, so card B's agent drives card A's logged-in Chromium,
 * opening B's browser finds A's already up, and deleting B kills A's. So the registry hands each
 * card the first FREE slot when the card is created (and to cards older than that on load), stores
 * it on the card, and reports it here ({@link rememberBrowserSlot}); every reader below asks this
 * table first. The table only grows: a card that has just left the board (a project purge stops its
 * browser after `removeProject`) must still resolve to the slot its browser runs on.
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
 * The HASHED slot of a card (0..SLOT_SPACE-1) — its PREFERRED slot, not a guaranteed one: two ids
 * can hash to the same slot, which is why {@link allocateBrowserSlot} only takes it when it is free.
 * Every card created before slots were allocated has its browser running here, which is why it
 * stays the first choice. Normal path: the leading hex of the id (card ids are uuids, so pure hex).
 * It is TOTAL — it never throws: an unusual id (non-hex) falls back to a deterministic hash of the
 * whole id, so deriving ports can NEVER be the thing that breaks opening a card.
 */
export function cardBrowserSlot(cardId: string): number {
  const hex = cardId.replace(/-/g, "").slice(0, 6);
  if (hex.length > 0 && /^[0-9a-fA-F]+$/.test(hex)) return Number.parseInt(hex, 16) % SLOT_SPACE;
  let h = 0;
  for (let i = 0; i < cardId.length; i++) h = (h * 31 + cardId.charCodeAt(i)) % SLOT_SPACE;
  return h;
}

/** Slots the registry allocated, by card id. See the header: it only grows. */
const allocatedSlots = new Map<string, number>();

/** Records the slot the registry allocated to a card — the one every reader below will use. */
export function rememberBrowserSlot(cardId: string, slot: number): void {
  allocatedSlots.set(cardId, slot);
}

/**
 * Is `port` the VNC or CDP of a slot a browser is allocated to (a card's, or a deleted card's
 * held one)? THAT is vibehub's browser plumbing — remote control of a logged-in browser, never a
 * preview. The rest of the 5900–6799 / 9222–10121 span is ordinary ports: dev servers live there by
 * default (Storybook 6006, the Node inspector 9229), and blocking the whole span shut them out.
 */
export function isBrowserSlotPort(port: number): boolean {
  for (const slot of allocatedSlots.values()) {
    if (port === VNC_PORT_BASE + slot || port === CDP_PORT_BASE + slot) return true;
  }
  return false;
}

/**
 * Picks a slot for a card nobody else holds: its hashed slot when that one is free (a browser
 * already running there keeps its display), otherwise the lowest free one. Only when all
 * SLOT_SPACE slots are taken does it settle for the hashed slot anyway — sharing a display is
 * the old behaviour, and opening a card must never fail over a browser. PURE.
 */
export function allocateBrowserSlot(cardId: string, taken: ReadonlySet<number>): number {
  const preferred = cardBrowserSlot(cardId);
  if (!taken.has(preferred)) return preferred;
  for (let slot = 0; slot < SLOT_SPACE; slot++) if (!taken.has(slot)) return slot;
  return preferred;
}

/**
 * Display/ports/user-data-dir of a card — all derived from its slot: the allocated one, or the
 * hashed one for a card the registry has not reported (it always does before a card can be opened).
 */
export function cardBrowserPorts(cardId: string): CardBrowserPorts {
  const slot = allocatedSlots.get(cardId) ?? cardBrowserSlot(cardId);
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
