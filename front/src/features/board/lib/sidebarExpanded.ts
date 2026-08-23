import * as React from "react";

/**
 * Which projects have their cards unfolded in the sidebar.
 *
 * EXPANDING IS NOT NAVIGATING. They used to be the same act — the sidebar unfolded whichever
 * project was selected, and selecting one closed the card you had open — so glancing at another
 * project's cards cost you the terminal you were working in. They are now two different things
 * with two different targets: the chevron unfolds, the name navigates.
 *
 * Several projects can be unfolded at once, which is the whole point: the project you are working
 * in stays open while you look at someone else's. Kept in `localStorage` rather than for the
 * session, because it is how somebody arranges their workspace — reopening the same three projects
 * every morning is exactly the kind of chore a board should not ask for.
 */

export const EXPANDED_KEY = "vibehub.sidebar.expandedProjects";

/** The stored ids, or none at all when storage is unavailable or holds something else. */
export function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** Best-effort write: a browser that refuses storage still gets the expansion, just not tomorrow. */
export function writeExpanded(ids: string[]): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(ids));
  } catch {
    /* private mode: the choice holds for as long as the tab is open */
  }
}

/** Adds or removes one id. PURE. */
export function toggleExpanded(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];
}

/**
 * Adds the SELECTED project to the set. Selecting a project is asking to see it, so its cards
 * unfold with it — and every project that was already unfolded stays that way. PURE.
 */
export function withSelected(ids: string[], selectedId: string | null): string[] {
  if (!selectedId || ids.includes(selectedId)) return ids;
  return [...ids, selectedId];
}

/** `isExpanded(id)` and `toggle(id)`, persisted, with the selected project always unfolded. */
export function useExpandedProjects(selectedProjectId: string | null): {
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
} {
  const [ids, setIds] = React.useState<string[]>(() => withSelected(readExpanded(), selectedProjectId));

  // Selecting a project unfolds it. Written straight through, so the next visit opens on the same
  // arrangement rather than on whatever was stored before this one.
  React.useEffect(() => {
    setIds((current) => {
      const next = withSelected(current, selectedProjectId);
      if (next !== current) writeExpanded(next);
      return next;
    });
  }, [selectedProjectId]);

  const toggle = React.useCallback((id: string) => {
    setIds((current) => {
      const next = toggleExpanded(current, id);
      writeExpanded(next);
      return next;
    });
  }, []);

  const isExpanded = React.useCallback((id: string) => ids.includes(id), [ids]);
  return { isExpanded, toggle };
}
