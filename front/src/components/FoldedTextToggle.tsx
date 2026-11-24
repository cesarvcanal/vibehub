import { useT } from "@/i18n";

export const FOLDED_TEXT_MIN_CHARS = 240;

export function FoldedTextToggle({ isExpanded, onToggle }: { isExpanded: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      onClick={onToggle}
      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {t(isExpanded ? "common.showLess" : "common.showMore")}
    </button>
  );
}
