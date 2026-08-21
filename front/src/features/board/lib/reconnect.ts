/**
 * Reconnect policy for the terminal and VNC sockets.
 *
 * The runner is one hop away and a dropped socket is usually a redeploy, a laptop lid, or a proxy
 * timing out an idle connection — all of which fix themselves in seconds. So: retry fast at first,
 * back off geometrically, and never give up, because the tmux session on the other side is still
 * alive and the user expects to find it there when the network comes back.
 */

/** First retry delay. Short enough that a blip is invisible. */
export const RECONNECT_BASE_MS = 400;

/** Ceiling. Beyond this, waiting longer only makes the app feel dead. */
export const RECONNECT_MAX_MS = 15_000;

/** Fraction of the delay that is randomised, so N terminals do not stampede the server together. */
export const RECONNECT_JITTER = 0.25;

/**
 * Delay before attempt `attempt` (0 = the first retry after a drop).
 *
 * Pure and deterministic unless a `random` source is supplied: `reconnectDelay(n)` is the exact
 * geometric value, and `reconnectDelay(n, Math.random)` adds up to 25% of jitter on top.
 */
export function reconnectDelay(attempt: number, random?: () => number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  // Exponent is capped before the shift so a long outage cannot overflow into Infinity.
  const steps = Math.min(n, 32);
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** steps);
  if (!random) return base;
  return Math.round(base * (1 + RECONNECT_JITTER * random()));
}

/** Connection state a socket-backed pane reports to its header. */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";
