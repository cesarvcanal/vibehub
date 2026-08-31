import type { CardColumn, CardStatus, DeclaredState } from "@/api/types";
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

/**
 * Last time anything happened on the card's CONVERSATION, as close as the stamps we have allow:
 * the last hook report (`statusAt`), the first open, the moment it was parked or went cold
 * (`pausedAt`/`hibernatedAt` — the session died right after the last exchange, so they are the
 * best stand-in once the dot's stamp is cleared), and creation itself, so a card that was just
 * written down counts as touched NOW rather than never.
 */
export function lastActivity(card: BoardCard): number {
  return Math.max(
    card.statusAt ?? 0,
    card.openedAt ?? 0,
    card.pausedAt ?? 0,
    card.hibernatedAt ?? 0,
    card.createdAt ?? 0,
  );
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
 *
 * It RENUMBERS the destination column exactly the way the server does (take the card out, splice it
 * in at `position`, number 0..n-1), because a reorder INSIDE a column is nothing but the numbers:
 * writing the new position on one card and leaving its neighbour with the same number leaves the
 * order down to the createdAt tie-break, and the card visibly bounces back for a poll.
 */
export function moveCardLocal(
  cards: BoardCard[],
  id: string,
  column: CardColumn,
  position: number,
): BoardCard[] {
  const moved = cards.find((c) => c.id === id);
  if (!moved) return cards;
  const from = moved.column;
  // Every card is COPIED, not just the moved one: the renumbering below writes `position` in place,
  // and the array it is given is a query cache nobody is allowed to mutate.
  const next = cards.map((c) => (c.id === id ? { ...c, column, updatedAt: Date.now() } : { ...c }));
  renumberColumn(next, moved.projectId, column, id, position);
  if (from !== column) renumberColumn(next, moved.projectId, from, null, 0);
  return next;
}

/**
 * Numbers one column 0..n-1 IN PLACE (on the copies made above), optionally splicing `id` in at
 * `at` first. Mirrors `placeCard` on the server so the optimistic board and the answer agree.
 */
function renumberColumn(
  cards: BoardCard[],
  projectId: string,
  column: CardColumn,
  id: string | null,
  at: number,
): void {
  const inColumn = cards.filter((c) => c.projectId === projectId && c.column === column);
  const moved = id ? inColumn.find((c) => c.id === id) : undefined;
  const rest = sortCards(inColumn.filter((c) => c.id !== moved?.id));
  if (moved) rest.splice(Math.max(0, Math.min(Math.trunc(at), rest.length)), 0, moved);
  rest.forEach((c, i) => {
    c.position = i;
  });
}

/**
 * Turns a gap index (0..n, in the FULL list) into the `position` the server expects — the index
 * AFTER the moved item has been taken out. Dropping something back where it already is, on either
 * side of itself, answers `from`, which every caller reads as "nothing to do". PURE.
 *
 * Shared by the two lists that reorder by dragging: the projects in the sidebar and the cards in a
 * column. Both send the same kind of index, so they cannot be allowed to compute it differently.
 */
export function gapToPosition(gap: number, from: number): number {
  if (gap === from || gap === from + 1) return from;
  return gap > from ? gap - 1 : gap;
}

/** Is the pointer in the BOTTOM half of the row it is over (drop after, rather than before)? PURE. */
export function isBelowMidpoint(pointerY: number, rectTop: number, rectHeight: number): boolean {
  return pointerY >= rectTop + rectHeight / 2;
}

/**
 * The `position` a drop lands on, or `null` when the drop changes nothing.
 *
 * `from` is the card's index in the DESTINATION column, or -1 when it is arriving from another one
 * — the case where every gap is a real move and the index needs no correction, only clamping.
 */
export function dropPosition(gap: number, from: number, length: number): number | null {
  if (from < 0) return Math.max(0, Math.min(Math.trunc(gap), length));
  const at = gapToPosition(gap, from);
  return at === from ? null : at;
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
  /** Green = the agent is working; amber = it needs you; grey = the terminal went cold. */
  tone: "ok" | "warn" | "cold";
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
 * The dot on a CARD, which is the status dot plus the one thing a status cannot say: the session is
 * gone. A hibernated card kept its column and its place on the board on purpose — the only thing
 * that changed is that nothing is running behind it — so the grey dot is the whole signal, and it
 * beats the last status because that status describes a process that no longer exists.
 */
export function cardDot(
  card: Pick<BoardCard, "status" | "hibernatedAt">,
): StatusDot | null {
  if (card.hibernatedAt) return { tone: "cold", label: t("status.hibernated"), live: false };
  return statusDot(card.status);
}

/**
 * Selected-row accent: a hairline down the left edge and a whisper of tint. Used by the selected
 * project, the card that is open and the recent list, so "this is the one" always looks the same.
 */
export const SELECTED_ROW =
  "relative bg-primary/[0.06] before:absolute before:inset-y-1 before:left-0 before:z-10 before:w-[3px] before:rounded-r-full before:bg-primary/70 before:content-['']";

/** Tailwind background for a dot tone. One place, so every dot in the app is the same colour. */
export function dotClass(tone: StatusDot["tone"]): string {
  if (tone === "ok") return "bg-emerald-400";
  if (tone === "warn") return "bg-amber-400";
  return "bg-muted-foreground/50";
}

/** The declared-state chip: the agent's own word on where the work stands, colour-coded. */
export interface StateChip {
  label: string;
  className: string;
}

/** Border/bg/text classes per declared state — one place, so the chip is the same colour everywhere. */
const STATE_CHIP_CLASS: Record<DeclaredState, string> = {
  working: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  needs_me: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
};

/**
 * The chip a card shows for the agent's DECLARED state (`vibehub_report`), or null when the agent has
 * said nothing. Label is resolved in the active language; the summary rides in the tooltip. PURE
 * (given the language).
 */
export function declaredStateChip(card: Pick<BoardCard, "declaredState">): StateChip | null {
  const state = card.declaredState;
  if (!state) return null;
  return { label: t(`card.declaredState.${state}`), className: STATE_CHIP_CLASS[state] };
}

/**
 * The last conversations you were in, newest first, across EVERY project. The WHOLE history now,
 * not a five-row glance: the list is the way back to any conversation, and the component that
 * renders it gives it its own scroll. A `limit` may still be passed where a caller wants a slice.
 *
 * The question it answers is "where was I", so it only counts cards that have actually been opened
 * (`openedAt`) — a backlog card nobody has talked to is not a conversation — and it drops the ones
 * filed under `done`, which are the conversations you deliberately ended. Paused and hibernated ones
 * stay: they are exactly the thread you might want to pick back up, and their icon says so.
 *
 * Ordering is `lastActivity`, so the card whose agent just spoke rises to the top on the next poll.
 * PURE.
 */
export function recentCards(cards: BoardCard[], limit?: number): BoardCard[] {
  const started = cards.filter((c) => Boolean(c.openedAt) && c.column !== "done");
  const ordered = sortByRecency(started);
  return limit === undefined ? ordered : ordered.slice(0, Math.max(0, limit));
}

/**
 * How long a brand-new card stays in the sidebar's MAIN list before it folds away unopened. Long
 * enough to find the card you just wrote down (it lands at the very top — its recency is its
 * creation); short enough that jotted-down backlog does not crowd the live conversations out.
 */
export const FRESH_CARD_MS = 15 * 60_000;

/**
 * Split for the sidebar's card list: the MAIN list is the conversations that are alive right now,
 * ordered by recency — the last one that spoke on top — plus any card created moments ago, so a
 * card you just wrote down is at the very top instead of buried under "show more". Everything
 * abandoned goes behind the fold: hibernated (grey — the session went cold), paused, and backlog
 * that nobody has touched. Finished cards never appear.
 *
 * "Alive" is the two mirrored columns WITHOUT a hibernation stamp: hibernating keeps the column on
 * purpose, so the column alone would keep a wall of grey, dead conversations pinned to the top of
 * the list — exactly what the fold exists to absorb. The fold is ordered by recency too: the most
 * recently abandoned thread is the one you are most likely to pick back up.
 */
export function splitSidebarCards(
  cards: BoardCard[],
  now: number = Date.now(),
): { active: BoardCard[]; idle: BoardCard[] } {
  const alive = (c: BoardCard) =>
    (c.column === "working" || c.column === "waiting") && !c.hibernatedAt && !c.pausedAt;
  const fresh = (c: BoardCard) =>
    c.column === "backlog" && !c.openedAt && now - c.createdAt < FRESH_CARD_MS;
  const listed = cards.filter((c) => c.column !== "done");
  return {
    active: sortByRecency(listed.filter((c) => alive(c) || fresh(c))),
    idle: sortByRecency(listed.filter((c) => !alive(c) && !fresh(c))),
  };
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

/**
 * The href of a project (no card). Same shape as `cardHref`, so a project row is a REAL link:
 * middle-click and Cmd/Ctrl/Shift-click open it in another tab, and a plain click is intercepted.
 */
export function projectHref(projectId: string): string {
  return locationHref({ projectId, cardId: null });
}
