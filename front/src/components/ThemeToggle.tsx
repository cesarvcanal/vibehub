import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applyTheme, nextTheme, readTheme, type ThemeChoice } from "@/lib/theme";

const ICONS: Record<ThemeChoice, React.ComponentType<{ className?: string }>> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
};

const LABELS: Record<ThemeChoice, string> = {
  system: "Theme: follow system",
  dark: "Theme: dark",
  light: "Theme: light",
};

export function ThemeToggle() {
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
        <Button variant="ghost" size="icon" onClick={cycle} aria-label={LABELS[choice]}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{LABELS[choice]}</TooltipContent>
    </Tooltip>
  );
}
