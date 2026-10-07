/**
 * Reconnect policy for the panel's sockets (the terminal, VNC and both chats).
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

/**
 * How long a freshly opened socket must stay up before it counts as healthy and the backoff resets.
 *
 * The handshake is not health: a server that accepts the websocket and only then finds it cannot
 * serve it (a setting off, the card deleted, a failed install) sends an error and closes — and a
 * redeploy racing the proxy does the same without the error. Resetting on the bare `open` turns
 * either into a reconnect at the base interval forever.
 */
export const STABLE_CONNECTION_MS = 3_000;

/**
 * The retry bookkeeping of one socket-backed pane: how many retries since the last HEALTHY
 * connection, and therefore how long to wait before the next one.
 */
export interface ReconnectBackoff {
  /** Retries since the last healthy connection (0 = none: the next dial is a first connect). */
  readonly attempt: number;
  /** The delay before the next retry — and that retry is counted. */
  next(): number;
  /** The socket opened: it resets the backoff only after holding for `STABLE_CONNECTION_MS`. */
  opened(): void;
  /** A proof of health that needs no clock (the server's own "ready"): reset now. */
  healthy(): void;
  /** The socket closed: a connection that never proved itself leaves the backoff where it was. */
  closed(): void;
  /** The pane is going away: no timer outlives it. */
  dispose(): void;
}

export function createReconnectBackoff(
  random?: () => number,
  stableMs: number = STABLE_CONNECTION_MS,
): ReconnectBackoff {
  let attempt = 0;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelStable = (): void => {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
  };
  return {
    get attempt() {
      return attempt;
    },
    next() {
      const delay = reconnectDelay(attempt, random);
      attempt += 1;
      return delay;
    },
    opened() {
      cancelStable();
      stableTimer = setTimeout(() => {
        stableTimer = null;
        attempt = 0;
      }, stableMs);
    },
    healthy() {
      cancelStable();
      attempt = 0;
    },
    closed: cancelStable,
    dispose: cancelStable,
  };
}

/** Connection state a socket-backed pane reports to its header. */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";
