import type { CardColumn } from "@/api/types";
import type { BoardCard } from "@/features/board/api";
import { COLUMNS, sortCards } from "@/features/board/lib/board";

/**
 * Multi-selection on the board — the pure half. Selection is UI state and nothing more: a set of
 * card ids that lives in the board component and dies with it. Nothing here persists, and nothing
 * here talks to the network — the bulk move is still one ordinary PATCH per card, so every rule the
 * server ties to a column change (pausing, resuming, finishing) applies to each card exactly as if
 * it had been dragged alone.
 */

/** Shift-click: the card joins the selection, or leaves it if it is already in. */
export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** An axis-aligned rectangle in CLIENT coordinates — the marquee and the card tiles share it. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The marquee between where the pointer went down and where it is now, whichever way it went. */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** Does the marquee touch this card at all? Touching is selecting — no "mostly covered" rule. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * How far the pointer must travel before a press on empty board becomes a marquee. Under this it is
 * a CLICK on the background, which clears the selection instead.
 */
export const MARQUEE_THRESHOLD_PX = 5;

export function isMarqueeDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
  threshold: number = MARQUEE_THRESHOLD_PX,
): boolean {
  return Math.abs(a.x - b.x) >= threshold || Math.abs(a.y - b.y) >= threshold;
}

/**
 * The selected cards in BOARD ORDER — columns left to right, positions top to bottom. It is the
 * order a bulk move preserves: the cards land in the destination stacked the way the eye last saw
 * them, not in the order they happened to be clicked.
 */
export function orderByBoard(cards: BoardCard[], selected: ReadonlySet<string>): BoardCard[] {
  const columnIndex = new Map(COLUMNS.map((c, i) => [c.key, i]));
  return sortCards(cards.filter((c) => selected.has(c.id))).sort(
    (a, b) => (columnIndex.get(a.column) ?? 0) - (columnIndex.get(b.column) ?? 0),
  );
}

/** One card's PATCH in a bulk move: the same `{column, position}` a lone drag sends. */
export interface GroupDropStep {
  id: string;
  position: number;
}

/**
 * Plans a bulk drop: the PATCHes, IN ORDER, that put `movingIds` into the destination column as one
 * block at gap `gap`, keeping their relative order. PURE.
 *
 * The server (and the optimistic cache) applies each PATCH as "take the card out, splice it in at
 * `position`" — sequentially. So the positions here are computed by SIMULATING that: each card is
 * spliced in right after the last card that must precede it in the final order. Cards of the group
 * that are still sitting in the wrong place ahead of it get pulled out by their own later step, and
 * the earlier ones shift left together, which keeps the relative order true. Applying the steps in
 * the order given is part of the contract.
 *
 * `destIds` is the destination column exactly as it is on screen — including any moving cards that
 * already live there; `gap` is measured against that on-screen list, like a single drop's.
 */
export function planGroupDrop(destIds: string[], movingIds: string[], gap: number): GroupDropStep[] {
  const moving = new Set(movingIds);
  const others = destIds.filter((id) => !moving.has(id));
  // The gap counted moving cards that are about to be lifted out of the column above it.
  const liftedAbove = destIds.slice(0, Math.max(0, gap)).filter((id) => moving.has(id)).length;
  const at = Math.max(0, Math.min(gap - liftedAbove, others.length));
  const final = [...others.slice(0, at), ...movingIds, ...others.slice(at)];
  const finalIndex = new Map(final.map((id, i) => [id, i]));

  const sim = [...destIds];
  const steps: GroupDropStep[] = [];
  for (const id of movingIds) {
    const from = sim.indexOf(id);
    if (from !== -1) sim.splice(from, 1);
    // Right after the last card already required to precede it — see the doc comment.
    const mine = finalIndex.get(id) ?? 0;
    let position = 0;
    for (let i = sim.length - 1; i >= 0; i--) {
      const other = finalIndex.get(sim[i] as string);
      if (other !== undefined && other < mine) {
        position = i + 1;
        break;
      }
    }
    sim.splice(position, 0, id);
    steps.push({ id, position });
  }
  return steps;
}

/**
 * A bulk drop routed by PROJECT: positions live in each project's own space, so on the aggregated
 * board the group splits into one plan per project, each landing at the END of that project's
 * destination column (the aggregated board has no insertion line to aim with).
 */
export function planGroupDropByProject(
  allCards: BoardCard[],
  moving: BoardCard[],
  column: CardColumn,
): Array<GroupDropStep & { projectId: string }> {
  const byProject = new Map<string, BoardCard[]>();
  for (const card of moving) {
    const list = byProject.get(card.projectId);
    if (list) list.push(card);
    else byProject.set(card.projectId, [card]);
  }
  const steps: Array<GroupDropStep & { projectId: string }> = [];
  for (const [projectId, group] of byProject) {
    const destIds = sortCards(
      allCards.filter((c) => c.projectId === projectId && c.column === column),
    ).map((c) => c.id);
    for (const step of planGroupDrop(destIds, group.map((c) => c.id), destIds.length)) {
      steps.push({ ...step, projectId });
    }
  }
  return steps;
}

/**
 * The drag ghost for a bulk move: a small pill saying how many cards are travelling, instead of the
 * browser's snapshot of the one card under the pointer. Appended off-screen just long enough for
 * `setDragImage` to rasterise it. Best-effort — a browser (or jsdom) without `setDragImage` keeps
 * the default ghost and everything else still works.
 */
export function setGroupDragGhost(dataTransfer: DataTransfer | null, label: string): void {
  if (!dataTransfer || typeof dataTransfer.setDragImage !== "function") return;
  if (typeof document === "undefined") return;
  const ghost = document.createElement("div");
  ghost.textContent = label;
  ghost.style.cssText =
    "position:fixed;top:-1000px;left:-1000px;padding:6px 12px;border-radius:9999px;" +
    "background:hsl(217 91% 60%);color:#fff;font:600 12px/1.2 system-ui,sans-serif;" +
    "box-shadow:0 4px 12px rgb(0 0 0 / .35);white-space:nowrap;";
  document.body.appendChild(ghost);
  dataTransfer.setDragImage(ghost, 18, 14);
  // The next frame is after the browser took its picture.
  setTimeout(() => ghost.remove(), 0);
}
