import { Check, ChevronDown, GitBranch, RefreshCw, Search } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { optionId, useBranchPicker } from "@/features/board/lib/useBranchPicker";
import type { BranchHighlight, BranchPickerProps, RankedBranch } from "@/features/board/types/branches";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

const HIGHLIGHT_TONE: Record<BranchHighlight, BadgeTone> = {
  default: "info",
  production: "critical",
  main: "ok",
  development: "warn",
};

// The name truncates with an ellipsis at the dialog's width; the tooltip gives the whole name back on hover.
function BranchName({ name }: { name: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(32rem,90vw)] break-all font-mono">{name}</TooltipContent>
    </Tooltip>
  );
}

export default function BranchPicker({
  id,
  value,
  onSelect,
  branches,
  defaultBranch,
  refreshing,
  refreshFailed,
  truncated,
  onOpen,
  onRefresh,
  noChoiceLabel,
}: BranchPickerProps) {
  const t = useT();
  const listId = `${id}-list`;
  const picker = useBranchPicker({ listId, value, onSelect, branches, defaultBranch, onOpen, noChoiceLabel });

  const row = (branch: RankedBranch) => (
    <li
      key={branch.name}
      id={optionId(listId, branch.name)}
      role="option"
      aria-selected={branch.name === value}
      data-active={branch.name === picker.activeValue || undefined}
      onClick={() => picker.select(branch.name)}
      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm data-[active]:bg-accent"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <BranchName name={branch.name} />
      {branch.highlight ? (
        <Badge tone={HIGHLIGHT_TONE[branch.highlight]} className="px-1.5 py-0 text-[10px]">
          {t(`branchPicker.badge.${branch.highlight}`)}
        </Badge>
      ) : null}
      {branch.name === value ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
    </li>
  );

  const nothingFound = picker.featured.length === 0 && picker.others.length === 0;

  return (
    <div
      ref={picker.containerRef}
      data-branch-picker-open={picker.isOpen || undefined}
      onKeyDown={picker.closeOnEscape}
      onBlur={picker.closeOnBlur}
      // Without containing the width, the longest branch name (unbreakable text) becomes the minimum
      // width of the Dialog's grid column, which overflows sideways and gets a horizontal scroll.
      className="space-y-1.5 [contain:inline-size]"
    >
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={picker.isOpen}
        aria-controls={listId}
        onClick={picker.isOpen ? picker.close : picker.open}
        onKeyDown={(e) => {
          if (picker.isOpen || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
          e.preventDefault();
          picker.open();
        }}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background/60 px-3 text-left text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          picker.isOpen && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        )}
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {picker.selected ? (
          <>
            <BranchName name={picker.selected.name} />
            {picker.selected.highlight ? (
              <Badge tone={HIGHLIGHT_TONE[picker.selected.highlight]} className="px-1.5 py-0 text-[10px]">
                {t(`branchPicker.badge.${picker.selected.highlight}`)}
              </Badge>
            ) : null}
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {value || noChoiceLabel || t("branchPicker.placeholder")}
          </span>
        )}
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", picker.isOpen && "rotate-180")} />
      </button>

      {picker.isOpen ? (
        <div
          onPointerDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
          className="overflow-hidden rounded-md border border-border/60 bg-popover shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              type="search"
              autoComplete="off"
              role="searchbox"
              aria-label={t("branchPicker.search")}
              aria-controls={listId}
              aria-activedescendant={picker.activeOptionId}
              placeholder={t("branchPicker.search")}
              value={picker.search}
              onChange={(e) => picker.changeSearch(e.target.value)}
              onKeyDown={picker.onSearchKeyDown}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={onRefresh}
              aria-busy={refreshing}
              aria-label={t("branchPicker.refresh")}
              title={t("branchPicker.refresh")}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </button>
          </div>

          <ul id={listId} role="listbox" aria-label={t("branchPicker.search")} className="max-h-64 overflow-y-auto p-1">
            {picker.hasNoChoiceRow ? (
              <li
                id={optionId(listId, "")}
                role="option"
                aria-selected={value === ""}
                data-active={picker.activeValue === "" || undefined}
                onClick={() => picker.select("")}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground data-[active]:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">{noChoiceLabel}</span>
                {value === "" ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
              </li>
            ) : null}

            {picker.featured.length ? (
              <>
                <li role="presentation" className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("branchPicker.featured")}
                </li>
                {picker.featured.map(row)}
              </>
            ) : null}

            {picker.others.length ? (
              <>
                <li role="presentation" className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("branchPicker.others", { n: picker.others.length })}
                </li>
                {picker.others.map(row)}
              </>
            ) : null}

            {nothingFound ? (
              <li role="presentation" className="px-2 py-3 text-center text-xs text-muted-foreground">
                {t("branchPicker.empty")}
              </li>
            ) : null}
          </ul>

          <div className="space-y-0.5 border-t border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>
                {truncated ? t("branchPicker.truncated", { n: branches.length }) : t("branchPicker.total", { n: branches.length })}
              </span>
              {refreshing ? <span>{t("branchPicker.refreshing")}</span> : null}
            </div>
            {refreshFailed && !refreshing ? (
              <p role="alert" className="text-amber-600 dark:text-amber-400">
                {t("branchPicker.refreshFailed")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
