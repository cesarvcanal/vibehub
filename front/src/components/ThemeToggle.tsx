import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applyTheme, nextTheme, readTheme, type ThemeChoice } from "@/lib/theme";

const ICONS: Record<ThemeChoice, React.ComponentType<{ className?: string }>> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
};

/** Short label for the pill; the tooltip carries the full sentence. */
const NAMES: Record<ThemeChoice, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

const LABELS: Record<ThemeChoice, string> = {
  system: "Theme: follow system",
  dark: "Theme: dark",
  light: "Theme: light",
};

/** Cycles system -> dark -> light. Styled as a header pill so it sits in the actions group. */
export function ThemeToggle({ className }: { className?: string }) {
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
        <button type="button" onClick={cycle} aria-label={LABELS[choice]} className={cn("nav-pill", className)}>
          <Icon className="h-4 w-4" />
          {NAMES[choice]}
        </button>
      </TooltipTrigger>
      <TooltipContent>{LABELS[choice]}</TooltipContent>
    </Tooltip>
  );
}
