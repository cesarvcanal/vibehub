import * as React from "react";
import { filterBranches, rankBranches } from "@/features/board/lib/branches";
import type { BranchPickerProps } from "@/features/board/types/branches";

/**
 * State of the branch combobox: open, search, the keyboard's active row and the filtered list. The
 * active row is kept by NAME, not by position: the list refreshes while it is open, and Enter has to
 * pick the branch that was marked, not the one that fell into the same position.
 */
export function useBranchPicker({
  listId,
  value,
  onSelect,
  branches,
  defaultBranch,
  onOpen,
  noChoiceLabel,
}: Pick<BranchPickerProps, "value" | "onSelect" | "branches" | "defaultBranch" | "onOpen" | "noChoiceLabel"> & {
  listId: string;
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [activeName, setActiveName] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const ranked = React.useMemo(() => rankBranches(branches, defaultBranch), [branches, defaultBranch]);
  const featured = filterBranches(ranked.featured, search);
  const others = filterBranches(ranked.others, search);
  const hasNoChoiceRow = noChoiceLabel !== undefined && search.trim() === "";
  const navigableValues = [
    ...(hasNoChoiceRow ? [""] : []),
    ...featured.map((b) => b.name),
    ...others.map((b) => b.name),
  ];
  const activeValue = activeName !== null && navigableValues.includes(activeName) ? activeName : navigableValues[0];

  React.useEffect(() => {
    if (!isOpen) return;
    containerRef.current?.querySelector("[data-active]")?.scrollIntoView?.({ block: "nearest" });
  }, [isOpen, activeValue]);

  const open = () => {
    setActiveName(value);
    setIsOpen(true);
    onOpen();
  };

  const close = () => {
    setIsOpen(false);
    setSearch("");
  };

  const select = (branch: string) => {
    onSelect(branch);
    close();
  };

  const changeSearch = (text: string) => {
    setSearch(text);
    setActiveName(null);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (activeValue === undefined) return;
      const total = navigableValues.length;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveName(navigableValues[(navigableValues.indexOf(activeValue) + step + total) % total] ?? null);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeValue !== undefined) select(activeValue);
    }
  };

  const closeOnEscape = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && isOpen) close();
  };

  // Clicking the dialog's scrollbar (or an empty spot in it) moves the focus to the dialog itself,
  // which is an ancestor of the picker: that is scrolling to see the list, not leaving it.
  const closeOnBlur = (event: React.FocusEvent) => {
    const target = event.relatedTarget;
    const container = containerRef.current;
    if (!container || !(target instanceof Node)) return close();
    if (container.contains(target) || target.contains(container)) return;
    close();
  };

  const selected = ranked.featured.find((b) => b.name === value)
    ?? ranked.others.find((b) => b.name === value);

  return {
    containerRef,
    isOpen,
    search,
    featured,
    others,
    hasNoChoiceRow,
    activeValue,
    activeOptionId: activeValue === undefined ? undefined : optionId(listId, activeValue),
    selected,
    open,
    close,
    select,
    changeSearch,
    onSearchKeyDown,
    closeOnEscape,
    closeOnBlur,
  };
}

/** Stable id of an option, for the search's `aria-activedescendant`. A branch name has no spaces. */
export function optionId(listId: string, branch: string): string {
  return `${listId}-option-${branch || "no-choice"}`;
}

/**
 * Radix's Dialog listens for Esc on the document (capture phase) and would close the whole form.
 * With the picker open, Esc is the picker's: it closes only the list.
 */
export function keepDialogOpenOnPickerEscape(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest("[data-branch-picker-open]")) event.preventDefault();
}
