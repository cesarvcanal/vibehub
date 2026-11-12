/**
 * SUBAGENTS IN THE NATIVE CHAT — who did what.
 *
 * An Agent/Task fires a subagent, and the driver tags what it does with `parentToolUseId` (the row
 * stores it as `parent`). The thread is split: the main one goes on as always (it is the one
 * `groupSdkRows` folds), and what belongs to each subagent goes under the card of the call that fired
 * it. PURE.
 */

import type { SdkRow } from "@/features/board/lib/sdkChat";

/** The tools that fire a subagent: `Agent` (current name in Claude Code) and `Task` (the old one). */
export function isAgentTool(name: string): boolean {
  return name === "Agent" || name === "Task";
}

export interface SubagentSplit {
  /** The main thread: everything that does not belong to a subagent whose parent is on screen. */
  main: SdkRow[];
  /** Each subagent's rows, by the id of the call that fired it, in the order they arrived. */
  children: ReadonlyMap<string, readonly SdkRow[]>;
}

const NO_CHILDREN: ReadonlyMap<string, readonly SdkRow[]> = new Map();

/**
 * Splits the rows between the main thread and the subagents. A child whose parent is NOT on screen
 * (the replay has a window and may have cut the call) stays in the main thread: hiding it would erase
 * work that happened. With no subagent at all, returns the SAME array — the screen's memo does not
 * redraw the conversation because of this. PURE.
 */
export function splitSubagentRows(
  rows: SdkRow[],
  previous?: ReadonlyMap<string, readonly SdkRow[]>,
): SubagentSplit {
  const toolIds = new Set<string>();
  let anyChild = false;
  for (const row of rows) {
    if (row.kind === "tool") toolIds.add(row.id);
    if (parentOf(row) !== undefined) anyChild = true;
  }
  if (!anyChild) return { main: rows, children: NO_CHILDREN };
  const main: SdkRow[] = [];
  const children = new Map<string, SdkRow[]>();
  for (const row of rows) {
    const parent = parentOf(row);
    if (parent === undefined || !toolIds.has(parent)) {
      main.push(row);
      continue;
    }
    const list = children.get(parent);
    if (list) list.push(row);
    else children.set(parent, [row]);
  }
  return { main, children: previous && sameChildren(previous, children) ? previous : children };
}

/** The two maps have the same rows, by the same references (the reducer preserves the untouched ones). PURE. */
function sameChildren(a: ReadonlyMap<string, readonly SdkRow[]>, b: ReadonlyMap<string, readonly SdkRow[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [parent, list] of b) {
    const other = a.get(parent);
    if (!other || other.length !== list.length || other.some((row, i) => row !== list[i])) return false;
  }
  return true;
}

/** The id of the main thread's most recent TodoWrite — the only one the screen shows open. PURE. */
export function latestTodoRowId(rows: readonly SdkRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as SdkRow;
    if (row.kind === "tool" && row.name === "TodoWrite" && row.parent === undefined) return row.id;
  }
  return null;
}

function parentOf(row: SdkRow): string | undefined {
  return (row.kind === "tool" || row.kind === "assistant") && row.parent ? row.parent : undefined;
}
