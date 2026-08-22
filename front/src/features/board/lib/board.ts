import type { CardColumn, CardStatus } from "@/api/types";
import type { BoardCard, BoardProject } from "@/features/board/api";
import { t } from "@/i18n";

/**
 * The kanban's pure logic — grouping, ordering, the status dot and the deep link. No React, no
 * network: given the same board, these always answer the same thing, which is why they carry the
 * rules the UI must not get wrong.
 *
 * The mirrored columns (`waiting`, `working`) are written by the SERVER from what the Claude hooks
 * report inside the runner. `backlog`, `paused` and `done` only ever move because a human moved
 * them, and finishing a card is always manual. Nothing here ever infers a column from a status:
 * the front-end renders the board the server describes.
 */

export interface ColumnMeta {
  key: CardColumn;
}

/**
 * The five columns in reading order: Backlog · Paused · Waiting · Working · Done.
 *
 * The order is a life cycle read left to right — not yet started, parked, then the two live
 * columns, then finished. "Paused" sits next to "Backlog" because a parked card is work that has
 * not resumed yet; "Waiting" sits left of "Working" because the cards that need a human are the
 * ones you should see first.
 */
export const COLUMNS: readonly ColumnMeta[] = [
  { key: "backlog" },
  { key: "paused" },
  { key: "waiting" },
  { key: "working" },
  { key: "done" },
] as const;

/**
 * The column's heading, in the active language. Resolved at RENDER time rather than baked into the
 * array above, so switching the language in Settings relabels the board where it stands instead of
 * waiting for a reload.
 */
export function columnLabel(key: CardColumn): string {
  return t(`column.${key}`);
}

/** One line explaining who moves cards into this column. Shown as the column's title tooltip. */
export function columnHint(key: CardColumn): string {
  return t(`column.${key}.hint`);
}

/** Cards ordered inside a column: by position, then creation, then id. Stable across refetches. */
export function sortCards(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort(
    (a, b) => positionOf(a) - positionOf(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

function positionOf(card: BoardCard): number {
  return Number.isFinite(card.position) ? (card.position as number) : Number.POSITIVE_INFINITY;
}

/** Last time anything happened on a card that has been started. */
export function lastActivity(card: BoardCard): number {
  return Math.max(card.statusAt ?? 0, card.openedAt ?? 0);
}

/** Most recently touched first, with a stable tie-break so idle cards never shuffle on a poll. */
export function sortByRecency(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort(
    (a, b) => lastActivity(b) - lastActivity(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

/** Cards grouped by column, each group already ordered. An unknown column is dropped. */
export function groupByColumn(cards: BoardCard[]): Record<CardColumn, BoardCard[]> {
  const out: Record<CardColumn, BoardCard[]> = {
    backlog: [],
    waiting: [],
    working: [],
    paused: [],
    done: [],
  };
  for (const card of sortCards(cards)) {
    if (card.column in out) out[card.column].push(card);
  }
  return out;
}

/** Free position at the END of a column — dropping a card into a column puts it last. */
export function nextPosition(cards: BoardCard[], column: CardColumn): number {
  const inColumn = cards.filter((c) => c.column === column);
  if (inColumn.length === 0) return 0;
  return Math.max(...inColumn.map((c) => c.position ?? 0)) + 1;
}

/**
 * Applies a move locally so the card does not snap back while the PATCH is in flight. The refetch
 * that follows re-synchronises with the server, which stays the authority on the final position.
 */
export function moveCardLocal(
  cards: BoardCard[],
  id: string,
  column: CardColumn,
  position: number,
): BoardCard[] {
  return cards.map((c) => (c.id === id ? { ...c, column, position, updatedAt: Date.now() } : c));
}

/**
 * Sidebar order of the projects: by `position`, falling back to creation for a project written
 * before the field existed. The single source of order — the board and the terminal view share it.
 */
export function sortProjects(projects: BoardProject[]): BoardProject[] {
  return [...projects].sort((a, b) => {
    const ap = Number.isFinite(a.position) ? (a.position as number) : Number.POSITIVE_INFINITY;
    const bp = Number.isFinite(b.position) ? (b.position as number) : Number.POSITIVE_INFINITY;
    return ap - bp || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  });
}

/**
 * Moves a project to `toIndex` and renumbers 0..n-1, so the optimistic list matches what the
 * server will send back. Does not mutate the input (it is a query cache).
 */
export function moveProjectLocal(projects: BoardProject[], id: string, toIndex: number): BoardProject[] {
  const ordered = sortProjects(projects);
  const from = ordered.findIndex((p) => p.id === id);
  if (from === -1) return projects;
  const [moved] = ordered.splice(from, 1);
  if (!moved) return projects;
  const at = Math.max(0, Math.min(Math.trunc(toIndex), ordered.length));
  ordered.splice(at, 0, moved);
  return ordered.map((p, i) => ({ ...p, position: i }));
}

export interface StatusDot {
  /** Green = the agent is working; amber = it needs you. */
  tone: "ok" | "warn";
  label: string;
  /** Pulses — reserved for "something is happening right now". */
  live: boolean;
}

/**
 * The dot on a card. No status at all means NO dot: the runner has not reported anything, and
 * inventing a state the agent never claimed is worse than showing nothing.
 */
export function statusDot(status: CardStatus | null | undefined): StatusDot | null {
  if (status === "working") return { tone: "ok", label: t("status.working"), live: true };
  if (status === "waiting") return { tone: "warn", label: t("status.waitingForYou"), live: false };
  return null;
}

/**
 * Which of the two live columns a card in the sidebar is sorted under. `waiting` first: it is the
 * column that is asking something of you.
 */
const ACTIVE_RANK: Record<"waiting" | "working", number> = { waiting: 0, working: 1 };

/**
 * Split for the narrow card list beside an open terminal: ACTIVE cards (the mirrored columns, the
 * ones with a dot) are always visible; the rest hide behind "show more" — paused first, then
 * backlog. Finished cards never appear.
 *
 * The active ones group by STATUS before recency: every `waiting` card sits above every `working`
 * card, and only inside a group does the most recently touched win. Sorting by recency alone let a
 * card that had just gone green jump ahead of an older amber one — pushing the card that is blocked
 * on you down the list exactly when it started needing you. Grouping comes first, not alongside.
 */
export function splitSidebarCards(cards: BoardCard[]): { active: BoardCard[]; idle: BoardCard[] } {
  const rank: Record<CardColumn, number> = { working: 0, waiting: 1, paused: 2, backlog: 3, done: 99 };
  const active = cards
    .filter((c): c is BoardCard & { column: "waiting" | "working" } =>
      c.column === "working" || c.column === "waiting",
    )
    .sort(
      (a, b) =>
        ACTIVE_RANK[a.column] - ACTIVE_RANK[b.column] ||
        lastActivity(b) - lastActivity(a) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
  const idle = cards
    .filter((c) => c.column === "paused" || c.column === "backlog")
    .sort(
      (a, b) =>
        rank[a.column] - rank[b.column] ||
        positionOf(a) - positionOf(b) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
  return { active, idle };
}

/* ------------------------------------------------------------- deep links */

/**
 * Where the board is pointing.
 *
 * NO project is a destination, not an accident: it is the aggregated board across every project.
 * That is what makes the sidebar's second click meaningful — clicking the selected project again
 * deselects it and you are looking at every agent at once, which is the question you actually have
 * ("who needs me"), not "which of my projects has someone who needs me".
 */
export interface BoardLocation {
  projectId: string | null;
  cardId: string | null;
}

export const PROJECT_PARAM = "project";
export const CARD_PARAM = "card";

/**
 * Reads the location out of the URL's query string. It lives in the URL — not in component state —
 * so a refresh, a second tab or a pasted link all land in exactly the same place, including inside
 * a card's terminal.
 */
export function readLocation(params: URLSearchParams): BoardLocation {
  const projectId = params.get(PROJECT_PARAM)?.trim() || null;
  const cardId = params.get(CARD_PARAM)?.trim() || null;
  // A card without a project is not addressable: the terminal view needs both.
  if (!projectId) return { projectId: null, cardId: null };
  return { projectId, cardId };
}

/** The query string for a location. Empty values are dropped rather than written as blanks. */
export function writeLocation(location: BoardLocation): URLSearchParams {
  const params = new URLSearchParams();
  if (location.projectId) params.set(PROJECT_PARAM, location.projectId);
  if (location.projectId && location.cardId) params.set(CARD_PARAM, location.cardId);
  return params;
}

/** True when the two locations point at the same thing — used to avoid pointless history entries. */
export function sameLocation(a: BoardLocation, b: BoardLocation): boolean {
  return a.projectId === b.projectId && a.cardId === b.cardId;
}

/**
 * The href of a location, relative to the current path.
 *
 * Every card on the board and every card row in the sidebar is a REAL link built from this, so the
 * browser's own habits keep working: middle-click and Cmd/Ctrl/Shift-click open the card in another
 * tab, hovering shows where it goes, and "copy link address" produces something that can be pasted.
 * A plain left click is still intercepted (see `isNewTabClick`) and handled by the router.
 */
export function locationHref(location: BoardLocation): string {
  const query = writeLocation(location).toString();
  return query ? `?${query}` : "?";
}

/** Shorthand for the two ids a card link always carries. */
export function cardHref(projectId: string, cardId: string): string {
  return locationHref({ projectId, cardId });
}
