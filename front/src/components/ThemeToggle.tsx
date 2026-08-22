import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applyTheme, nextTheme, readTheme, type ThemeChoice } from "@/lib/theme";
import { useT } from "@/i18n";

const ICONS: Record<ThemeChoice, React.ComponentType<{ className?: string }>> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
};

/** Short label for the pill; the tooltip carries the full sentence. */
const NAME_KEYS: Record<ThemeChoice, string> = {
  system: "theme.system",
  dark: "theme.dark",
  light: "theme.light",
};

const LABEL_KEYS: Record<ThemeChoice, string> = {
  system: "theme.labelSystem",
  dark: "theme.labelDark",
  light: "theme.labelLight",
};

/** Cycles system -> dark -> light. Styled as a header pill so it sits in the actions group. */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useT();
  const [choice, setChoice] = React.useState<ThemeChoice>(() => readTheme());
  const Icon = ICONS[choice];

  function cycle() {
    const next = nextTheme(choice);
    applyTheme(next);
    setChoice(next);
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={cycle} aria-label={t(LABEL_KEYS[choice] as string)} className={cn("nav-pill", className)}>
          <Icon className="h-4 w-4" />
          {t(NAME_KEYS[choice] as string)}
        </button>
      </TooltipTrigger>
      <TooltipContent>{t(LABEL_KEYS[choice] as string)}</TooltipContent>
    </Tooltip>
  );
}
