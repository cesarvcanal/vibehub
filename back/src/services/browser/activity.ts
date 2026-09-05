/**
 * WHO IS IN THE CARD'S BROWSER — the little bit of state that stops the card bar from being blind
 * while the agent clicks around in the card's Chromium, and that decides whose hands are on it.
 *
 * Three readings, all cheap enough to poll:
 *   - `live`: the card's Chromium is up. Set when the browser is started, cleared when it is torn
 *     down — no `docker exec`, no probing, just what this process already knows because it is the
 *     only thing that starts and stops those browsers.
 *   - `busy`: something clicked, typed or moved a pointer inside that browser in the last few
 *     seconds. It rides the CDP observer the Cofre capture ALREADY keeps attached to the page
 *     (see services/credentials), so watching costs one throttled message per burst of activity and
 *     not a single extra connection.
 *   - `control`: WHO may drive. The default is the AGENT, and while the agent holds it the person's
 *     panel is a spectator seat — noVNC view-only, their mouse and keys never reach the page. That
 *     is the whole point: two pointers fighting over one Chromium ("sair clicando juntos") is worse
 *     than not touching it, so taking the wheel is now an explicit, visible act.
 *
 * `busy` deliberately does not try to tell the agent apart from a person driving over noVNC: in the
 * page both arrive as ordinary trusted input, and separating them would mean correlating VNC input
 * frames by timestamp — fragile, for a distinction nobody needs. The person clicking already knows
 * they are clicking; the point of the signal is the OTHER case.
 *
 * In memory on purpose: a browser does not survive a restart of this process either.
 */

/** How long after the last input in the page the browser still reads as "busy". */
export const BUSY_WINDOW_MS = 4_000;

interface Entry {
  liveSince: number;
  busyAt: number;
}

const entries = new Map<string, Entry>();
/** cardId → the person currently holding the wheel. Absent = the agent drives (the default). */
const control = new Map<string, string>();

/** Who may drive the card's browser. */
export type BrowserControlHolder = "agent" | "human";

export interface CardBrowserActivity {
  /** The card's Chromium is up in the runner. */
  live: boolean;
  /** When it came up (epoch ms), or null when it is down. */
  liveSince: number | null;
  /** Input landed in the page within BUSY_WINDOW_MS — someone is working in there. */
  busy: boolean;
  /** "agent" (the default) or "human" while a person has taken the wheel. */
  control: BrowserControlHolder;
  /** Which person holds it, so a second viewer sees a name instead of a locked button. */
  controlBy: string | null;
}

/** The card's browser came up. Idempotent: a restart of an already-live browser keeps its start. */
export function markBrowserLive(cardId: string, at: number = Date.now()): void {
  if (entries.has(cardId)) return;
  entries.set(cardId, { liveSince: at, busyAt: 0 });
}

/** The card's browser is gone — and with it any hold on it, so nothing stays locked to a ghost. */
export function markBrowserDown(cardId: string): void {
  entries.delete(cardId);
  control.delete(cardId);
}

/**
 * Input was observed in the card's page. Ignored when the browser is not live — a late report from
 * a listener being torn down must never resurrect a browser that is already dead.
 */
export function markBrowserBusy(cardId: string, at: number = Date.now()): void {
  const entry = entries.get(cardId);
  if (entry) entry.busyAt = at;
}

/**
 * A person takes the wheel: from here their noVNC input reaches the page and the agent is expected
 * to keep its hands off (see `agentMayDriveBrowser`). A second person taking it simply takes it —
 * a card is worked by a couple of people who can talk to each other, and a lock that needs an
 * administrator to break is a worse problem than the one it solves.
 */
export function takeBrowserControl(cardId: string, by: string): void {
  control.set(cardId, by);
}

/**
 * Back to spectator. `by` releases only their OWN hold, so closing a stale pane cannot yank the
 * wheel from whoever took it afterwards; omit it to release unconditionally.
 */
export function releaseBrowserControl(cardId: string, by?: string): void {
  if (by !== undefined && control.get(cardId) !== by) return;
  control.delete(cardId);
}

/**
 * THE HOOK the agent side asks before driving. Today only `credential_fill` consults it (the
 * `navegador` MCP talks to Chromium's CDP port directly, with vibehub nowhere in that path, so it
 * cannot be gated from here — gating it needs either a check inside the vibehub MCP tools or a
 * proxy in front of the CDP port). It is a real answer, not a placeholder: whatever gets wired next
 * asks this one function.
 */
export function agentMayDriveBrowser(cardId: string): boolean {
  return !control.has(cardId);
}

/** What the card bar and the pane read. PURE (given `now`). */
export function cardBrowserActivity(cardId: string, now: number = Date.now()): CardBrowserActivity {
  const holder = control.get(cardId) ?? null;
  const entry = entries.get(cardId);
  return {
    live: Boolean(entry),
    liveSince: entry ? entry.liveSince : null,
    busy: Boolean(entry && entry.busyAt > 0 && now - entry.busyAt < BUSY_WINDOW_MS),
    control: holder ? "human" : "agent",
    controlBy: holder,
  };
}

export function resetBrowserActivityForTesting(): void {
  entries.clear();
  control.clear();
}
