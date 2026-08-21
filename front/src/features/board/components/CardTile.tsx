import { Check, Pause, RotateCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { statusDot } from "@/features/board/lib/board";
import {
  ContextMenu,
  useContextMenuPoint,
  type ContextMenuItem,
} from "@/features/board/components/ContextMenu";
import type { BoardCard } from "@/features/board/api";

const DOT_TONE: Record<"ok" | "warn", string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
};

/**
 * One card on the board: a status dot, the title, and the chips that say which account and model it
 * runs under. Clicking the body opens its terminal; dragging moves it between columns (a click
 * without movement is not a drag, so the two live on the same element).
 *
 * The actions are inline rather than behind a menu — with a dozen cards on screen, "pause this one"
 * should be one click, not two. They stay invisible until the card is hovered or focused so the
 * board reads as a list of titles, and each one stops the click from bubbling up into "open".
 *
 * RIGHT-CLICK opens the same three session actions the open card's bar has — Pause · Restart ·
 * Finish, in that order. Restart lives only here and in an open card: it is an action on a live
 * session, not on the card record, which is why it is not one of the always-on inline icons.
 *
 * The card says as little as it can. It carries no line repeating its own column ("Working" under a
 * card sitting in the Working column is a word that has already been read), and speaks up only when
 * something is true that the position and the dot cannot show: a pause that is waiting for the turn
 * to end, or a configuration change that will land at the next restart.
 */
export function CardTile({
  card,
  accountLabel,
  onOpen,
  onDone,
  onPause,
  onRestart,
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
  /** Kills and recreates the session — same conversation, fresh brain/MCP configuration. */
  onRestart?: (card: BoardCard) => void;
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
  /**
   * The brain or the MCP set changed while this card was mid-turn. Claude reads either one only at
   * start-up, so the server flagged the card instead of interrupting it — it restarts itself the
   * moment the turn ends. Not shown when a pending pause already owns the line: the pause wins on
   * the server, so its text is the one that is true.
   */
  const updatePending = !paused && !pausingWhenIdle && Boolean(card.restartPendingAt);
  const canPause = Boolean(card.openedAt) && !paused;
  // Same precondition: there is only a session to restart once the card has been opened.
  const canRestart = canPause;
  const draggable = Boolean(onDragStart);

  const contextItems: ContextMenuItem[] = [
    ...(onPause && canPause
      ? [{ key: "pause", label: "Pause", icon: Pause, onSelect: () => onPause(card) }]
      : []),
    ...(onRestart && canRestart
      ? [{ key: "restart", label: "Restart", icon: RotateCw, onSelect: () => onRestart(card) }]
      : []),
    ...(onDone && card.column !== "done"
      ? [{ key: "finish", label: "Finish", icon: Check, onSelect: () => onDone(card) }]
      : []),
  ];
  const { point, openAt, close } = useContextMenuPoint();

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
      onContextMenu={contextItems.length > 0 ? openAt : undefined}
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

        {/* Only ever a line the column header and the dot cannot already tell you. */}
        {pausingWhenIdle ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground/80">Pausing when idle…</div>
        ) : updatePending ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground/80">Updating when it finishes…</div>
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

      <ContextMenu point={point} items={contextItems} ariaLabel={`Actions for ${card.title}`} onClose={close} />
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
