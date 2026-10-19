import {
  Circle,
  CircleCheck,
  Loader2,
  MessageCircleQuestion,
  Moon,
  OctagonAlert,
  Pause,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { cardStateTitle, type CardState, type CardStateKind } from "@/features/board/lib/board";

/**
 * Shape first, colour second: each state has its own icon, so it reads without a legend and without
 * telling amber from green. Only `working` moves — anything animated on screen means something is
 * running. Amber and red belong to the two states that ask something of you.
 */
const ICONS: Record<CardStateKind, { icon: LucideIcon; className: string }> = {
  working: { icon: Loader2, className: "animate-spin text-sky-500 dark:text-sky-400" },
  needs_me: { icon: MessageCircleQuestion, className: "text-amber-500 dark:text-amber-400" },
  blocked: { icon: OctagonAlert, className: "text-red-500 dark:text-red-400" },
  ready: { icon: CircleCheck, className: "text-emerald-500 dark:text-emerald-400" },
  done: { icon: CircleCheck, className: "text-emerald-500 dark:text-emerald-400" },
  your_turn: { icon: Circle, className: "text-muted-foreground" },
  idle: { icon: Circle, className: "text-muted-foreground/50" },
  hibernated: { icon: Moon, className: "text-muted-foreground/70" },
  paused: { icon: Pause, className: "text-muted-foreground/70" },
};

/**
 * The icon of a card's state (see `cardState`). `announce` gives it `role="status"` and an
 * accessible name — leave it off inside a link, where that name would become part of the link's.
 */
export function CardStateIcon({
  state,
  className,
  announce = false,
}: {
  state: CardState;
  /** Size (and spacing) — the colour comes from the state. */
  className?: string;
  announce?: boolean;
}) {
  const { icon: Icon, className: tone } = ICONS[state.kind];
  return (
    <span
      title={cardStateTitle(state)}
      data-state={state.kind}
      className="inline-flex shrink-0 items-center justify-center"
      {...(announce ? { role: "status", "aria-label": state.label } : {})}
    >
      <Icon aria-hidden strokeWidth={2.25} className={cn("h-3 w-3", tone, className)} />
    </span>
  );
}
