import * as React from "react";
import type { CardColumn } from "@/api/types";
import { COLUMNS, type ColumnMeta } from "@/features/board/lib/board";

/**
 * Which columns the board shows on a phone.
 *
 * On a screen one column wide, five stacked columns are five screens of scrolling — and four of
 * them answer a question nobody has on a phone. What you do from a phone is give an agent its next
 * instruction: you read WAITING (someone needs you) and WORKING (someone is busy), and everything
 * else is planning work you will do at a desk. So the phone opens on those two, waiting first,
 * with the other three one tap away.
 *
 * The desktop board is untouched: `visibleColumns(false, …)` is `COLUMNS`, the same five in the
 * same order.
 */

/** Always on screen, in this order — the column that is asking for you comes first. */
export const MOBILE_COLUMNS: readonly CardColumn[] = ["waiting", "working"] as const;

/** Behind "show more", in board order. */
export const MOBILE_EXTRA_COLUMNS: readonly CardColumn[] = ["paused", "backlog", "done"] as const;

const META = new Map(COLUMNS.map((column) => [column.key, column]));

function metaOf(key: CardColumn): ColumnMeta {
  return META.get(key) ?? { key };
}

/** The columns to render, in render order. PURE. */
export function visibleColumns(isMobile: boolean, expanded: boolean): readonly ColumnMeta[] {
  if (!isMobile) return COLUMNS;
  const keys = expanded ? [...MOBILE_COLUMNS, ...MOBILE_EXTRA_COLUMNS] : MOBILE_COLUMNS;
  return keys.map(metaOf);
}

/** How many cards are behind "show more" — the number on the button. PURE. */
export function hiddenCount(groups: Record<CardColumn, unknown[]>): number {
  return MOBILE_EXTRA_COLUMNS.reduce((total, key) => total + (groups[key]?.length ?? 0), 0);
}

/**
 * Session-scoped, because it is a browsing choice and not a setting: somebody who opened the other
 * three columns to move a card keeps them open while they work, and a fresh visit starts back on
 * the two that matter. `localStorage` would make it a preference nobody remembers setting.
 */
export const SHOW_MORE_KEY = "vibehub.board.showMoreColumns";

function stored(): boolean {
  try {
    return sessionStorage.getItem(SHOW_MORE_KEY) === "1";
  } catch {
    return false;
  }
}

/** `[expanded, setExpanded]`, persisted for this tab's session. */
export function useExpandedColumns(): [boolean, (next: boolean) => void] {
  const [expanded, set] = React.useState(stored);
  const setExpanded = React.useCallback((next: boolean) => {
    set(next);
    try {
      sessionStorage.setItem(SHOW_MORE_KEY, next ? "1" : "0");
    } catch {
      /* private mode: the choice still holds for as long as the board is open */
    }
  }, []);
  return [expanded, setExpanded];
}
