import { Check, Pause, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { statusDot } from "@/features/board/lib/board";
import type { BoardCard } from "@/features/board/api";

const DOT_TONE: Record<"ok" | "warn", string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
};

const DOT_TEXT: Record<"ok" | "warn", string> = {
  ok: "text-emerald-400/90",
  warn: "text-amber-400/90",
};

/**
 * One card on the board: a status dot, the title, and the chips that say which account and model it
 * runs under. Clicking the body opens its terminal; dragging moves it between columns (a click
 * without movement is not a drag, so the two live on the same element).
 *
 * The actions are inline rather than behind a menu — with a dozen cards on screen, "pause this one"
 * should be one click, not two. They stay invisible until the card is hovered or focused so the
 * board reads as a list of titles, and each one stops the click from bubbling up into "open".
 */
export function CardTile({
  card,
  accountLabel,
  onOpen,
  onDone,
  onPause,
  onDelete,
  onDragStart,
  onDragEnd,
  projectLabel,
}: {
  card: BoardCard;
  /** Effective account name, already resolved (the card's own, or the project's, or the default). */
  accountLabel?: string;
  onOpen: (card: BoardCard) => void;
  onDone?: (card: BoardCard) => void;
  onPause?: (card: BoardCard) => void;
  onDelete?: (card: BoardCard) => void;
  onDragStart?: (card: BoardCard) => void;
  onDragEnd?: () => void;
  /** Owning project's name — only shown where cards from several projects are mixed. */
  projectLabel?: string;
}) {
  const dot = statusDot(card.status);
  const paused = Boolean(card.pausedAt);
  /**
   * Moved to Paused while the agent was still working: the runner ends the session once the
   * current turn finishes, so the card is on its way there rather than already parked.
   */
  const pausingWhenIdle = !paused && card.column === "paused" && Boolean(card.openedAt);
  const canPause = Boolean(card.openedAt) && !paused;
  const draggable = Boolean(onDragStart);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      aria-label={card.title}
      onClick={() => onOpen(card)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(card);
        }
      }}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", card.id);
              onDragStart?.(card);
            }
          : undefined
      }
      onDragEnd={draggable ? () => onDragEnd?.() : undefined}
      className={cn(
        "group flex w-full items-start gap-2 rounded-lg border border-border/60 bg-card/60 px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-card",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
      )}
    >
      <span className="mt-1 inline-flex h-3 w-3 shrink-0 items-center justify-center">
        {paused ? (
          <Pause aria-hidden className="h-3 w-3 text-muted-foreground/70" />
        ) : dot ? (
          <span
            title={dot.label}
            aria-label={dot.label}
            role="status"
            className={cn(
              "inline-block h-2.5 w-2.5 rounded-full",
              DOT_TONE[dot.tone],
              dot.live && "motion-safe:animate-[vh-pulse_1.6s_ease-in-out_infinite]",
            )}
          />
        ) : null}
      </span>

      <div className="min-w-0 flex-1">
        <div title={card.title} className="line-clamp-2 text-sm font-medium leading-snug">
          {card.title}
        </div>

        {/* Only say something the dot does not already say. */}
        {pausingWhenIdle ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground/80">Pausing when idle…</div>
        ) : !paused && dot ? (
          <div className={cn("mt-0.5 text-[11px]", DOT_TEXT[dot.tone])}>{dot.label}</div>
        ) : null}

        <div className="mt-1 flex flex-wrap gap-1">
          {projectLabel ? <Badge tone="info">{projectLabel}</Badge> : null}
          {accountLabel ? (
            <Badge tone="muted" className="font-mono">
              {accountLabel}
            </Badge>
          ) : null}
          {card.model ? (
            <Badge tone="muted" className="font-mono">
              {modelLabel(card.model)}
            </Badge>
          ) : null}
        </div>
      </div>

      {/* Inline actions. Hidden until hover/focus so the column reads as a list of titles. */}
      <div
        className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        draggable={false}
        onDragStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {onPause && canPause ? (
          <TileAction
            label={`Pause ${card.title}`}
            hint="Ends the session in the runner. Reopening resumes the same conversation."
            onClick={() => onPause(card)}
          >
            <Pause className="h-3.5 w-3.5" />
          </TileAction>
        ) : null}
        {onDone && card.column !== "done" ? (
          <TileAction label={`Finish ${card.title}`} hint="Move to Done" onClick={() => onDone(card)}>
            <Check className="h-3.5 w-3.5" />
          </TileAction>
        ) : null}
        {onDelete ? (
          <TileAction
            label={`Delete ${card.title}`}
            hint="Deletes the card and drops its worktree"
            danger
            onClick={() => onDelete(card)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </TileAction>
        ) : null}
      </div>
    </div>
  );
}

function TileAction({
  label,
  hint,
  danger,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(
            "grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            danger && "hover:text-destructive",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/** Short label for a model id, so the chip stays a chip. */
export function modelLabel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d+(-\d+)?$/, "");
}
