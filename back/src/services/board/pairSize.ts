/**
 * PAIRING ON ONE TERMINAL — two browsers opening the SAME card attach to the SAME tmux session, so
 * both people watch the same Claude live and both can type. The problem is size: every browser has
 * its own viewport and tmux (default `window-size latest`) resizes the window to whatever the client
 * that acted LAST wants. The other browser then paints garbage — the dotted filler tmux draws over
 * the area the window no longer owns.
 *
 * The cure is a CANONICAL DIMENSION per card: while there are 2+ clients, every one of them renders
 * the SAME cols x rows. With everybody the same size no client is ever bigger than the window, tmux
 * never draws the dotted area, and both see exactly the same content. The FIRST client sets the
 * dimension (its own initial fit); while 2+ are connected it is frozen; alone again, a client may
 * re-fit; empty, the dimension is dropped and the next "first client" defines it anew.
 *
 * This module is the in-memory registry (per card) plus the PURE decisions. Execution — the
 * websocket attach, the tmux command, the control frame sent to the browser — belongs to the route;
 * nothing here does I/O.
 */

export interface Dim {
  cols: number;
  rows: number;
}

/** Acceptable terminal range, the same one the terminal route parses: integers from 10 to 500. */
const MIN_DIM = 10;
const MAX_DIM = 500;

function isDim(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_DIM && n <= MAX_DIM;
}

/** cols/rows → a valid Dim, or null (out of 10..500, not an integer, missing). PURE. */
export function clampDim(cols: unknown, rows: unknown): Dim | null {
  return isDim(cols) && isDim(rows) ? { cols, rows } : null;
}

/**
 * The canonical dimension in force after a fit, given how many clients the card has and the current
 * dimension:
 *  - 2+ clients ⇒ FROZEN at the current one (a new client's fit must not resize everybody else);
 *  - 0..1 client ⇒ the fit (when valid) redefines it; an invalid fit keeps the current one.
 * `clientCount` includes the client that is acting. PURE.
 */
export function resolveCanonicalDim(clientCount: number, current: Dim | null, fit: Dim | null): Dim | null {
  if (clientCount >= 2) return current;
  return fit ?? current;
}

/**
 * Server→client control frame announcing the card's imposed dimension. `locked=true` means 2+
 * clients (render at THIS size, do not fit); `locked=false` means one is left and it may re-fit.
 * JSON text under the reserved `__ctl` envelope, which is how the front-end tells control frames
 * apart from terminal output. PURE.
 */
export function dimControlFrame(cols: number, rows: number, locked: boolean): string {
  return JSON.stringify({ __ctl: "dim", cols, rows, locked });
}

/**
 * tmux command (argv of a `docker exec`) that PINS the session window to a canonical dimension,
 * immune to client sizes: `window-size manual` + `resize-window`. This is the belt of the pairing
 * fix — with a manual window, a newly joined client cannot resize anybody else's. PURE.
 */
export function tmuxWindowFixArgs(containerName: string, session: string, dim: Dim): string[] {
  return [
    "docker", "exec", containerName,
    "tmux", "set-option", "-t", session, "window-size", "manual", ";",
    "resize-window", "-t", session, "-x", String(dim.cols), "-y", String(dim.rows),
  ];
}

/**
 * tmux command that hands the window back to client-follow mode (`window-size latest`) — used when
 * a single client is left: unfrozen, the window tracks that one browser's fit again. PURE.
 */
export function tmuxWindowFollowArgs(containerName: string, session: string): string[] {
  return ["docker", "exec", containerName, "tmux", "set-option", "-t", session, "window-size", "latest"];
}

/** One browser attached to a card: the backend tells it (imposed size / unfrozen) via this callback. */
export interface PairMember {
  notify(dim: Dim, locked: boolean): void;
}

interface CardEntry {
  dim: Dim | null;
  members: Set<PairMember>;
}

/** In-memory registry: card → { canonical dimension, attached clients }. Lives in the API process. */
const cards = new Map<string, CardEntry>();

export interface JoinResult {
  /** The card's canonical dimension (null = not defined yet — no valid initial fit). */
  dim: Dim | null;
  /** true = there are 2+ clients now (the dimension is frozen). */
  locked: boolean;
}

/**
 * A browser joins the card. The FIRST one sets the dimension (its fit); the others inherit whatever
 * is in force (their fit is ignored). Going from 1 to 2 clients, the ones already there are told it
 * is frozen now. Returns the dimension to apply for this client and whether it is frozen.
 */
export function joinCard(cardKey: string, member: PairMember, fit: Dim | null): JoinResult {
  let entry = cards.get(cardKey);
  if (!entry) {
    entry = { dim: null, members: new Set() };
    cards.set(cardKey, entry);
  }
  entry.members.add(member);
  const count = entry.members.size;
  entry.dim = resolveCanonicalDim(count, entry.dim, fit);
  const locked = count >= 2;
  if (locked && entry.dim) {
    // 1→2 (or more): whoever was already there was rendering free — tell them to freeze.
    for (const m of entry.members) if (m !== member) m.notify(entry.dim, true);
  }
  return { dim: entry.dim, locked };
}

/**
 * A client sent a new fit. With 2+ clients the dimension stays frozen (the canonical one is returned
 * and the fit ignored); alone, the fit redefines it. Returns what to apply to the pty and whether it
 * is frozen.
 */
export function resizeCard(cardKey: string, fit: Dim | null): JoinResult {
  const entry = cards.get(cardKey);
  if (!entry) return { dim: fit, locked: false };
  const count = entry.members.size;
  entry.dim = resolveCanonicalDim(count, entry.dim, fit);
  return { dim: entry.dim, locked: count >= 2 };
}

export interface LeaveResult {
  /** How many clients are left on the card. */
  remaining: number;
  /** true = this departure took the card from 2 to 1 (unfrozen; the survivor was notified). */
  unlocked: boolean;
}

/**
 * A browser left the card. Empty ⇒ the canonical dimension is dropped (the next first client sets a
 * new one). Exactly 1 left (was a pair, now solo) ⇒ unfreeze and TELL the survivor it may re-fit.
 */
export function leaveCard(cardKey: string, member: PairMember): LeaveResult {
  const entry = cards.get(cardKey);
  if (!entry) return { remaining: 0, unlocked: false };
  entry.members.delete(member);
  const remaining = entry.members.size;
  if (remaining === 0) {
    cards.delete(cardKey);
    return { remaining: 0, unlocked: false };
  }
  if (remaining === 1 && entry.dim) {
    for (const m of entry.members) m.notify(entry.dim, false);
    return { remaining: 1, unlocked: true };
  }
  return { remaining, unlocked: false };
}

/** The card's current canonical dimension (null = not defined). Pure read of the registry. */
export function cardDim(cardKey: string): Dim | null {
  return cards.get(cardKey)?.dim ?? null;
}

/** How many clients are attached to the card. Pure read of the registry. */
export function cardClientCount(cardKey: string): number {
  return cards.get(cardKey)?.members.size ?? 0;
}

/** Clears the registry (tests). */
export function resetPairSizes(): void {
  cards.clear();
}
