/**
 * The deck: which cards keep a LIVE terminal in the page, and which one is on top.
 *
 * Switching cards used to mean tearing an xterm down and opening a new websocket — the pty was
 * reattached, the TUI repainted from scratch, and for a second or two you were looking at a blank
 * pane instead of the agent you just asked for. Nothing about that is necessary: the sockets are
 * cheap, the sessions are already running on the other side, and the only thing that has to change
 * when you hop between two agents is WHICH pane you can see.
 *
 * So every card you open joins the deck and stays mounted. Changing cards is a change of the active
 * entry, nothing more. The rules here are the whole policy:
 *
 *  - ORDER IS INSERTION ORDER, never recency. The deck is rendered as a list keyed by card, and
 *    reordering it would move real DOM nodes — canvases, a VNC surface — for no visible gain.
 *  - RECENCY IS A NUMBER on the entry (`usedAt`), used only to decide who leaves when the deck is
 *    full. It is a monotonic counter, not a clock: two cards opened inside the same millisecond
 *    must still be ordered.
 *  - THE ACTIVE CARD IS NEVER EVICTED. It is the one thing on screen.
 *
 * Evicting is not destructive: the tmux session lives in the runner, so a card that leaves the deck
 * simply goes back to reattaching the next time it is opened — exactly what every card did before.
 */

export interface DeckEntry {
  cardId: string;
  projectId: string;
  /** The LRU's clock. Bigger is more recent; only comparisons matter. */
  usedAt: number;
}

/**
 * How many terminals stay live at once.
 *
 * Each one holds a websocket and a WebGL context, and browsers cap the number of live contexts per
 * page (the oldest is dropped, which the terminal survives by falling back to its DOM renderer —
 * but a fallback nobody asked for is still a downgrade). Six covers "the handful of agents I am
 * actually juggling" with room to spare; a phone gets three, where the memory is tighter and the
 * card list is a drawer rather than a column you glance at.
 */
export const DECK_LIMIT_DESKTOP = 6;
export const DECK_LIMIT_MOBILE = 3;

export function deckLimit(mobile: boolean): number {
  return mobile ? DECK_LIMIT_MOBILE : DECK_LIMIT_DESKTOP;
}

/**
 * The deck after opening `entry`.
 *
 * Already in it: only its recency (and its project, if the card moved) is updated, in place, so the
 * mounted terminal is untouched. New: appended at the END, and if that pushes the deck past the
 * limit the least recently used OTHER entry leaves. Recency is a counter read off the deck, so this
 * stays a pure function — no clock, no ref, nothing to keep in sync.
 *
 * Returns the SAME array when nothing changed, so a caller storing this in state does not re-render
 * on every navigation back to a card that is already on top.
 */
export function touchDeck(
  deck: readonly DeckEntry[],
  entry: { cardId: string; projectId: string },
  limit: number,
): DeckEntry[] {
  // The clock is derived from the deck itself rather than kept outside it, which makes this a pure
  // function of its arguments: the same deck and the same card always answer the same thing, and a
  // caller may run it twice (React does, in development) without the result drifting.
  const now = deck.reduce((max, e) => Math.max(max, e.usedAt), 0);
  const usedAt = now + 1;

  const existing = deck.find((e) => e.cardId === entry.cardId);
  if (existing) {
    // Already the most recent, still in the same project: nothing to say. Returning the same array
    // is what keeps re-opening the card you are already on from re-rendering the page.
    if (existing.projectId === entry.projectId && existing.usedAt === now) return deck as DeckEntry[];
    return deck.map((e) =>
      e.cardId === entry.cardId ? { ...e, projectId: entry.projectId, usedAt } : e,
    );
  }

  const next = [...deck, { cardId: entry.cardId, projectId: entry.projectId, usedAt }];
  const max = Math.max(1, Math.trunc(limit));
  while (next.length > max) {
    // The oldest entry that is not the one we just opened. Scanned rather than sorted: the deck is
    // a handful of items, and sorting would only hide which rule is being applied.
    let victim = -1;
    for (let i = 0; i < next.length; i += 1) {
      const candidate = next[i]!;
      if (candidate.cardId === entry.cardId) continue;
      if (victim === -1 || candidate.usedAt < next[victim]!.usedAt) victim = i;
    }
    if (victim === -1) break; // only the active card is left: it stays, whatever the limit says
    next.splice(victim, 1);
  }
  return next;
}

/** The deck without `cardId` — a card that was paused, deleted, or otherwise has no session left. */
export function dropFromDeck(deck: readonly DeckEntry[], cardId: string): DeckEntry[] {
  if (!deck.some((e) => e.cardId === cardId)) return deck as DeckEntry[];
  return deck.filter((e) => e.cardId !== cardId);
}

/**
 * The deck with every entry whose project is gone removed. A deleted project takes its worktrees
 * (and its sessions) with it, so a terminal still reconnecting to one is a socket retrying into a
 * wall.
 */
export function pruneDeck(deck: readonly DeckEntry[], projectIds: readonly string[]): DeckEntry[] {
  const live = new Set(projectIds);
  if (deck.every((e) => live.has(e.projectId))) return deck as DeckEntry[];
  return deck.filter((e) => live.has(e.projectId));
}
