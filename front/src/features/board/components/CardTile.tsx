import { Check, MoreHorizontal, Pause, RotateCw, Trash2, Users } from "lucide-react";
import { cn, isNewTabClick } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cardHref, statusDot } from "@/features/board/lib/board";
import {
  ContextMenu,
  useContextMenuPoint,
  type ContextMenuItem,
} from "@/features/board/components/ContextMenu";
import type { BoardCard } from "@/features/board/api";

/**
 * One card on the board: a status dot and a title, and nothing else it can avoid saying.
 *
 * It is a REAL link, so the operating system's habits work — Cmd/Ctrl/Shift-click and middle-click
 * open the card in another tab, hovering shows where it goes. A plain left click is intercepted and
 * handled by the router; dragging moves it between columns (a click without movement is not a drag,
 * so both live on the same element).
 *
 * The actions live in ONE `⋯` menu that appears on hover or focus, rather than as three icon
 * buttons on the face of the card: with a dozen cards on screen, a row of controls per card is what
 * turns a board into a control panel. RIGHT-CLICK is the shortcut for the three that matter while
 * an agent is running — Pause · Restart · Finish. Restart is only ever there and in an open card:
 * it acts on a live session, not on the card record.
 *
 * The card carries no line repeating its own column ("Working" under a card sitting in the Working
 * column is a word that has already been read) and no chip for a setting it merely inherited. It
 * speaks up only when something is true that neither the position nor the dot can show: a pause
 * waiting for the turn to end, or a configuration change that lands at the next restart.
 */
export function CardTile({
  card,
  onOpen,
  onDone,
  onPause,
  onRestart,
  onAccount,
  onDelete,
  onDragStart,
  onDragEnd,
  projectLabel,
}: {
  card: BoardCard;
  onOpen: (card: BoardCard) => void;
  onDone?: (card: BoardCard) => void;
  onPause?: (card: BoardCard) => void;
  /** Kills and recreates the session — same conversation, fresh brain/MCP configuration. */
  onRestart?: (card: BoardCard) => void;
  /** Opens the dialog that switches this card's Claude account. */
  onAccount?: (card: BoardCard) => void;
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

  /** The `⋯` menu: card management. Each item exists only where the board offers the handler. */
  const menuItems: ContextMenuItem[] = [
    ...(onDone && card.column !== "done"
      ? [{ key: "finish", label: "Finish (move to Done)", icon: Check, onSelect: () => onDone(card) }]
      : []),
    ...(onPause && canPause
      ? [{ key: "pause", label: "Pause (ends the session)", icon: Pause, onSelect: () => onPause(card) }]
      : []),
    ...(onAccount ? [{ key: "account", label: "Claude account…", icon: Users, onSelect: () => onAccount(card) }] : []),
    ...(onDelete
      ? [{ key: "delete", label: "Delete card", icon: Trash2, danger: true, onSelect: () => onDelete(card) }]
      : []),
  ];

  /** Right-click: the three live-session actions, in that order. Independent of the `⋯` menu. */
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
    <a
      href={cardHref(card.projectId, card.id)}
      // Named by its TITLE, not by everything printed on it: the chips and the pending-state line
      // are context for the eye, and reading them out as part of the link's name buries the title.
      aria-label={card.title}
      draggable={draggable}
      onClick={(e) => {
        if (isNewTabClick(e)) return;
        e.preventDefault();
        onOpen(card);
      }}
      onKeyDown={(e) => {
        // Enter/Space coming from INSIDE (the `⋯` menu) is not "open the card".
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
        "group flex w-full items-start gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-left transition-colors hover:border-border hover:bg-card",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
      )}
    >
      {/* No dot and no pause icon means no element at all: an empty 12px box in front of every
          backlog title is a column of nothing, indented for no reason. */}
      {paused ? (
        <span title="Paused" className="mt-1 inline-flex shrink-0 text-muted-foreground/70">
          <Pause aria-hidden className="h-3 w-3" />
        </span>
      ) : dot ? (
        <span title={dot.label} className="mt-1.5 inline-flex shrink-0">
          <span
            role="status"
            aria-label={dot.label}
            className={cn(
              "inline-block h-2.5 w-2.5 rounded-full",
              dot.tone === "ok" ? "bg-emerald-400" : "bg-amber-400",
              dot.live && "dot-live",
            )}
          />
        </span>
      ) : null}

      <div className="min-w-0 flex-1">
        <div title={card.title} className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
          {card.title}
        </div>

        {/* Only ever a line the column header and the dot cannot already tell you. */}
        {pausingWhenIdle ? (
          <div
            title="The session ends as soon as the current turn finishes — nothing is interrupted."
            className="mt-0.5 text-[11px] text-muted-foreground/80"
          >
            Pausing when idle…
          </div>
        ) : updatePending ? (
          <div
            title="The brain or the MCP set changed while it was working — it restarts once it goes idle, without interrupting."
            className="mt-0.5 text-[11px] text-muted-foreground/80"
          >
            Updating when it finishes…
          </div>
        ) : null}

        {/* The owning project, only where cards from several projects share a column. */}
        {projectLabel ? (
          <span
            title={`Project: ${projectLabel}`}
            className="mr-1 mt-1 inline-flex max-w-full items-center truncate rounded border border-primary/30 bg-primary/10 px-1 py-px text-[10px] font-medium text-primary"
          >
            {projectLabel}
          </span>
        ) : null}

        {/* The card's OWN account. An inherited one is not worth a chip on every card. */}
        {card.accountSlug ? (
          <span
            title="This card's Claude account"
            className="mt-1 inline-flex max-w-full items-center truncate rounded border border-border/60 bg-muted/40 px-1 py-px font-mono text-[10px] text-muted-foreground"
          >
            {card.accountSlug}
          </span>
        ) : null}
      </div>

      {/* Stays visible while the menu is OPEN (`aria-expanded`), or moving the mouse to it would
          dismiss the thing being used. The wrapper cuts click/keyboard/drag off from the link, so
          choosing an item never also opens the card. */}
      {menuItems.length > 0 ? (
        <span
          draggable={false}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [&:has([aria-expanded=true])]:opacity-100"
        >
          <ActionsMenu ariaLabel={`Actions for ${card.title}`} items={menuItems} />
        </span>
      ) : null}

      <ContextMenu point={point} items={contextItems} ariaLabel={`Actions for ${card.title}`} onClose={close} />
    </a>
  );
}

/** The `⋯` button and its menu. A dropdown, so it is keyboard-reachable and closes like every other. */
function ActionsMenu({ ariaLabel, items }: { ariaLabel: string; items: ContextMenuItem[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={ariaLabel}
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              key={item.key}
              onSelect={item.onSelect}
              className={cn(item.danger && "text-destructive focus:bg-destructive/10 focus:text-destructive")}
            >
              {Icon ? <Icon className="opacity-70" /> : null}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
