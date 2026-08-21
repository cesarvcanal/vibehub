import * as React from "react";

/**
 * The browser tab is part of the UI here: people run one tab per card and find the right one by
 * reading the tab strip, so the title has to say which card, in which project.
 */

/** Matches `index.html`. Restored when a board screen unmounts. */
export const BASE_TITLE = "vibehub";

/**
 * Tab title for a board context:
 *  - project + card -> "<project> · <card>"  (the card view)
 *  - project only   -> "<project> · vibehub" (the project's board)
 *  - neither        -> BASE_TITLE            (the aggregated board)
 * Blank strings count as absent.
 *
 * The PROJECT leads. Tabs are truncated from the right, so the half that survives has to be the one
 * that tells two tabs apart — and with several cards open per project it is the project name that
 * groups them, while the card name is what you read once the tab is already narrow enough to hover.
 */
export function boardTitle(project?: string | null, card?: string | null): string {
  const p = project?.trim();
  const c = card?.trim();
  if (p && c) return `${p} · ${c}`;
  if (p) return `${p} · ${BASE_TITLE}`;
  return BASE_TITLE;
}

/**
 * Sets `document.title` while mounted and puts back whatever it was before.
 *
 * Two effects on purpose: the first captures and restores the original exactly once, the second
 * re-applies the current text. Doing both in one effect would make the "original" whatever the
 * last render set, and the title would leak into the next screen.
 */
export function useDocumentTitle(title: string): void {
  React.useEffect(() => {
    const original = document.title;
    return () => {
      document.title = original;
    };
  }, []);
  React.useEffect(() => {
    document.title = title;
  }, [title]);
}
