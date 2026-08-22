import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, FolderGit2, Pause, Plus, RotateCw, Trash2 } from "lucide-react";
import { cn, isNewTabClick } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  useContextMenuPoint,
  type ContextMenuItem,
} from "@/features/board/components/ContextMenu";
import { Logo } from "@/components/Logo";
import { AccountRow } from "@/components/AccountRow";
import { cardHref, nextPosition, splitSidebarCards, statusDot } from "@/features/board/lib/board";
import {
  boardApi,
  cardRunnerHint,
  cardsKey,
  projectBaseBranch,
  projectRepo,
  type BoardCard,
  type BoardProject,
} from "@/features/board/api";

/**
 * The ONE sidebar.
 *
 * There used to be two: a flat project list beside the board, and a different, card-shaped list
 * beside an open terminal. They are the same list. Opening a card does not change what you might
 * want to reach next, so the sidebar does not change either — it is the same component, in the same
 * place, on both views, and only the middle of the page swaps.
 *
 * Every row is one project. Clicking one SELECTS it: its board fills the middle and its cards
 * unfold underneath it, right here. Clicking the selected one again DESELECTS it and you get the
 * aggregated board — which is why there is no "All projects" row to hunt for. Clicking a card opens
 * its terminal; clicking the card that is already open closes it and puts the board back. Every
 * click moves exactly one level, in or out, which is why there is no "back to board" button either.
 *
 * It is also the app's only chrome: the brand sits at the TOP of the panel and the account row
 * (theme, settings, sign out) at its BOTTOM. There is no page header any more — that band of
 * height belongs to the terminal — so this column carries both, pinned to the full height of the
 * viewport, which is what keeps the bottom row visible however long the project list gets.
 *
 * Below `lg` the same component becomes a drawer: `fixed`, pushed off-screen with a transform, slid
 * in by the "Projects" button in the page. It is deliberately ONE instance rather than a desktop
 * copy and a mobile copy — the expanded project owns the poll that keeps every dot on screen fresh,
 * and two of those would be two of everything.
 */

/**
 * Selected-row accent: a hairline down the left edge and a whisper of tint. Used for the selected
 * project and for the card that is open, so "this is the one" always looks the same.
 */
export const SELECTED_ROW =
  "relative bg-primary/[0.06] before:absolute before:inset-y-1 before:left-0 before:z-10 before:w-[3px] before:rounded-r-full before:bg-primary/70 before:content-['']";

/** Name on the row, repository in the tooltip: the repo was noise on a list you read by name. */
function projectHint(project: BoardProject): string {
  const repo = projectRepo(project);
  const branch = projectBaseBranch(project);
  return `${project.name}\n${repo ? `${repo}${branch ? ` · ${branch}` : ""}` : "no repository"}`;
}

export function ProjectSidebar({
  projects,
  selectedProjectId,
  selectedCardId,
  mobileOpen,
  onCloseMobile,
  onSelectProject,
  onOpenCard,
  onReorder,
  onNewProject,
  onNewCard,
  onDeleteProject,
}: {
  projects: BoardProject[];
  selectedProjectId: string | null;
  /** The card whose terminal is open, when one is — it is highlighted and listed even if finished. */
  selectedCardId: string | null;
  /** Drawer state, for screens below `lg`. Ignored above it, where the sidebar is always visible. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
  /** Selects the project — or deselects it, when it is the one already selected. */
  onSelectProject: (id: string) => void;
  /** Opens the card — or closes it, when it is the one already open. */
  onOpenCard: (projectId: string, cardId: string) => void;
  /** Drops project `id` at `position` — the index AFTER it has been removed, as the server wants. */
  onReorder: (id: string, position: number) => void;
  onNewProject: () => void;
  onNewCard: (project: BoardProject) => void;
  onDeleteProject: (project: BoardProject) => void;
}) {
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dropAt, setDropAt] = React.useState<{ index: number; below: boolean } | null>(null);

  const clear = () => {
    setDraggingId(null);
    setDropAt(null);
  };

  function drop(index: number, below: boolean) {
    const id = draggingId;
    clear();
    if (!id) return;
    const from = projects.findIndex((p) => p.id === id);
    if (from === -1) return;
    const position = gapToPosition(below ? index + 1 : index, from);
    if (position !== from) onReorder(id, position);
  }

  function step(id: string, direction: -1 | 1) {
    const from = projects.findIndex((p) => p.id === id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= projects.length) return;
    onReorder(id, to);
  }

  return (
    <>
      {/* Only exists — and only intercepts a click — while the drawer is open, and never above
          `lg`, where the sidebar is part of the page rather than on top of it. */}
      {mobileOpen ? (
        <div
          data-testid="sidebar-backdrop"
          aria-hidden="true"
          onClick={onCloseMobile}
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
        />
      ) : null}

      <nav
        aria-label="Projects"
        className={cn(
          "panel fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] shrink-0 flex-col overflow-hidden shadow-2xl transition-transform duration-200 ease-out",
          // The gutter is `p-3`, so a full-height column is the viewport minus 1.5rem. Sticky, not
          // just tall: the account row at the bottom must stay on screen while the board scrolls.
          "lg:sticky lg:top-0 lg:z-auto lg:h-[calc(100vh-1.5rem)] lg:w-64 lg:max-w-none lg:translate-x-0 lg:shadow-none lg:transition-none",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* The brand, at the top of the panel — inside it, so it never eats into the terminal. */}
        <div className="flex shrink-0 items-center border-b border-border/60 px-3 py-2.5">
          <Logo size="side" />
        </div>

        <div className="flex shrink-0 items-center justify-between border-b border-border/60 py-1 pl-3 pr-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {projects.length} {projects.length === 1 ? "project" : "projects"}
          </span>
          {/* Creating a project belongs on the list of projects, not in the page header. */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label="New project"
            title="New project"
            onClick={onNewProject}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
          {projects.map((project, index) => {
            const selected = project.id === selectedProjectId;
            return (
              <ProjectRow
                key={project.id}
                project={project}
                index={index}
                first={index === 0}
                last={index === projects.length - 1}
                selected={selected}
                activeCardId={selected ? selectedCardId : null}
                draggingId={draggingId}
                dropLine={
                  draggingId && draggingId !== project.id && dropAt?.index === index
                    ? dropAt.below
                      ? "bottom"
                      : "top"
                    : null
                }
                onSelect={() => onSelectProject(project.id)}
                onOpenCard={(cardId) => onOpenCard(project.id, cardId)}
                onNewCard={() => onNewCard(project)}
                onDelete={() => onDeleteProject(project)}
                onStep={(direction) => step(project.id, direction)}
                onDragStart={() => setDraggingId(project.id)}
                onDragEnd={clear}
                onHover={(i, below) => setDropAt({ index: i, below })}
                onDrop={drop}
              />
            );
          })}
          {projects.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">No projects yet.</p>
          ) : null}
        </div>

        <AccountRow />
      </nav>
    </>
  );
}

/**
 * One project.
 *
 * The row itself is a folder, a name and an always-visible `+`. Nothing else: the repository moved
 * into the tooltip, and the management actions (reorder, delete) moved into the right-click menu,
 * because a row that sprouts three icon buttons on hover is a row you cannot read at a glance.
 *
 * When SELECTED it unfolds its cards, and only then does it fetch them — one poll, for the project
 * you are actually looking at. The cards that are working or waiting are always listed; the rest
 * hide behind "show more"; finished ones never appear, EXCEPT the card whose terminal is open,
 * which is always listed or the one thing on screen would be the one thing you cannot see.
 */
function ProjectRow({
  project,
  index,
  first,
  last,
  selected,
  activeCardId,
  draggingId,
  dropLine,
  onSelect,
  onOpenCard,
  onNewCard,
  onDelete,
  onStep,
  onDragStart,
  onDragEnd,
  onHover,
  onDrop,
}: {
  project: BoardProject;
  index: number;
  first: boolean;
  last: boolean;
  selected: boolean;
  activeCardId: string | null;
  draggingId: string | null;
  dropLine: "top" | "bottom" | null;
  onSelect: () => void;
  onOpenCard: (cardId: string) => void;
  onNewCard: () => void;
  onDelete: () => void;
  onStep: (direction: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onHover: (index: number, below: boolean) => void;
  onDrop: (index: number, below: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const boardKey = cardsKey(project.id);

  const { data: cards } = useQuery({
    queryKey: boardKey,
    queryFn: () => boardApi.listCards(project.id),
    // 2s, not 5s: the dot is the one thing on screen that has to feel live. A card that just went
    // amber is a card asking for you, and three extra seconds of green reads as "still busy".
    refetchInterval: 2_000,
    enabled: selected,
  });

  const [showMore, setShowMore] = React.useState(false);
  React.useEffect(() => {
    if (!selected) setShowMore(false);
  }, [selected]);

  const { active, idle } = splitSidebarCards(cards ?? []);
  const openCard = activeCardId ? (cards ?? []).find((c) => c.id === activeCardId) : undefined;
  const listed =
    openCard && !active.some((c) => c.id === openCard.id) && !idle.some((c) => c.id === openCard.id)
      ? [openCard, ...active]
      : active;

  /** Writes one card back into this project's cache, then lets the poll re-synchronise. */
  const mirror = React.useCallback(
    (updated: BoardCard) => {
      queryClient.setQueryData<BoardCard[]>(boardKey, (previous) =>
        previous ? previous.map((c) => (c.id === updated.id ? updated : c)) : previous,
      );
      void queryClient.invalidateQueries({ queryKey: boardKey });
    },
    [queryClient, boardKey],
  );

  /* ------------------------------------------------------------- renaming */

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => boardApi.patchCard(id, { title }),
    onSuccess: mirror,
    onError: (error) => toast.error(apiErrorMessage(error, "Could not rename the card")),
  });

  function saveRename(card: BoardCard) {
    const title = draft.trim();
    setEditingId(null);
    if (!title || title === card.title) return;
    renameMutation.mutate({ id: card.id, title });
  }

  /* ----------------------------------------------------- session actions */

  const pauseMutation = useMutation({
    mutationFn: (id: string) => boardApi.pauseCard(id),
    onSuccess: (updated) => {
      mirror(updated);
      toast.success("Paused — reopening the card resumes the same conversation.");
      // Pausing the card you are looking at takes you up one level, exactly like clicking its row.
      if (updated.id === activeCardId) onOpenCard(updated.id);
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not pause the card")),
  });

  const restartMutation = useMutation({
    mutationFn: (id: string) => boardApi.restartCard(id),
    onSuccess: () => toast.success("Restarting the terminal… the conversation resumes on the next open."),
    onError: (error) => toast.error(apiErrorMessage(error, "Could not restart the card")),
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, column, position }: { id: string; column: BoardCard["column"]; position: number }) =>
      boardApi.patchCard(id, { column, position }),
    onSuccess: mirror,
    onError: (error) => toast.error(apiErrorMessage(error, "Could not move the card")),
  });

  function restart(card: BoardCard) {
    if (
      card.status === "working" &&
      !window.confirm("Claude is working — restarting will interrupt it. Continue?")
    ) {
      return;
    }
    restartMutation.mutate(card.id);
  }

  function finish(card: BoardCard) {
    const previous = { column: card.column, position: card.position ?? 0 };
    moveMutation.mutate({
      id: card.id,
      column: "done",
      position: nextPosition(cards ?? [], "done"),
    });
    toast.success(`“${card.title}” finished — stopped following the terminal.`, {
      action: { label: "Undo", onClick: () => moveMutation.mutate({ id: card.id, ...previous }) },
    });
    if (card.id === activeCardId) onOpenCard(card.id);
  }

  /* --------------------------------------------------------- the row itself */

  const projectMenu: ContextMenuItem[] = [
    { key: "new-card", label: "New card", icon: Plus, onSelect: onNewCard },
    ...(first ? [] : [{ key: "up", label: "Move up", icon: ChevronUp, onSelect: () => onStep(-1) }]),
    ...(last ? [] : [{ key: "down", label: "Move down", icon: ChevronDown, onSelect: () => onStep(1) }]),
    { key: "delete", label: "Delete project…", icon: Trash2, danger: true, onSelect: onDelete },
  ];
  const { point, openAt, close } = useContextMenuPoint();

  const dropActive = Boolean(draggingId) && draggingId !== project.id;
  const below = (e: React.DragEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return isBelowMidpoint(e.clientY, rect.top, rect.height);
  };

  const renderCard = (card: BoardCard) =>
    editingId === card.id ? (
      <input
        key={card.id}
        aria-label="Rename card"
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") saveRename(card);
          else if (e.key === "Escape") setEditingId(null);
        }}
        onBlur={() => saveRename(card)}
        className="mx-3 my-1 h-7 w-[calc(100%-1.5rem)] rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    ) : (
      <SidebarCard
        key={card.id}
        card={card}
        active={card.id === activeCardId}
        onOpen={() => onOpenCard(card.id)}
        onRename={() => {
          setDraft(card.title);
          setEditingId(card.id);
        }}
        onPause={(c) => pauseMutation.mutate(c.id)}
        onRestart={restart}
        onFinish={finish}
      />
    );

  return (
    <div
      data-project-row={project.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", project.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={
        dropActive
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              onHover(index, below(e));
            }
          : undefined
      }
      onDrop={
        dropActive
          ? (e) => {
              e.preventDefault();
              onDrop(index, below(e));
            }
          : undefined
      }
      className={cn(
        "relative transition-colors",
        draggingId === project.id && "opacity-40",
        selected ? SELECTED_ROW : "hover:bg-card/60",
      )}
    >
      {dropLine ? (
        <span
          aria-hidden
          data-drop-line={dropLine}
          className={cn(
            "pointer-events-none absolute inset-x-2 z-20 h-0.5 rounded-full bg-primary",
            dropLine === "top" ? "top-0" : "bottom-0",
          )}
        />
      ) : null}

      {/* Right-click anywhere on the row line, not only on the name. The card rows below have a
          menu of their own and stop the event, so the two never collide. */}
      <div className="flex items-center gap-0.5" onContextMenu={openAt}>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          title={projectHint(project)}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2.5 py-2.5 pl-3 pr-1 text-left active:cursor-grabbing"
        >
          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              selected ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {project.name}
          </span>
        </button>
        {/* Always visible, on every row: writing down the next task is the most frequent thing
            anyone does here, and it should not require selecting the project first. */}
        <Button
          variant="ghost"
          size="icon"
          className="mr-1.5 h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`New card in ${project.name}`}
          title="New card (⌘K on the selected project)"
          onClick={onNewCard}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {selected ? (
        <div className="pb-1.5">
          {listed.map(renderCard)}
          {/* The revealed cards appear ABOVE the toggle, which stays anchored at the end of the
              list: expanding and collapsing are the same point of click, and nothing moves out
              from under the cursor. */}
          {showMore ? idle.map(renderCard) : null}
          {idle.length > 0 ? (
            <button
              type="button"
              aria-expanded={showMore}
              onClick={() => setShowMore((v) => !v)}
              className="w-full py-1.5 pl-9 pr-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 transition-colors hover:bg-card/60 hover:text-foreground"
            >
              {showMore ? "show less" : `show more (${idle.length})`}
            </button>
          ) : null}
          {listed.length === 0 && idle.length === 0 ? (
            <p className="py-1.5 pl-9 pr-3 text-[11px] text-muted-foreground/60">No active cards</p>
          ) : null}
        </div>
      ) : null}

      <ContextMenu
        point={point}
        items={projectMenu}
        ariaLabel={`Actions for ${project.name}`}
        onClose={close}
      />
    </div>
  );
}

/**
 * One card in the list: a dot and a title.
 *
 * A real link, so the browser's habits work (Cmd/Ctrl/Shift-click, middle-click, "copy link"). A
 * plain click opens it — or closes it, when it is the card already open, which the parent decides
 * by comparing ids. Double-click renames it in place; right-click offers the three things worth
 * doing to a live session, for ANY card in the list rather than only the open one.
 */
function SidebarCard({
  card,
  active,
  onOpen,
  onRename,
  onPause,
  onRestart,
  onFinish,
}: {
  card: BoardCard;
  active: boolean;
  onOpen: () => void;
  onRename: () => void;
  onPause: (card: BoardCard) => void;
  onRestart: (card: BoardCard) => void;
  onFinish: (card: BoardCard) => void;
}) {
  const dot = statusDot(card.status);
  const paused = Boolean(card.pausedAt);
  const canPause = Boolean(card.openedAt) && !paused;

  const items: ContextMenuItem[] = [
    ...(canPause ? [{ key: "pause", label: "Pause", icon: Pause, onSelect: () => onPause(card) }] : []),
    ...(canPause ? [{ key: "restart", label: "Restart", icon: RotateCw, onSelect: () => onRestart(card) }] : []),
    ...(card.column !== "done"
      ? [{ key: "finish", label: "Finish", icon: Check, onSelect: () => onFinish(card) }]
      : []),
  ];
  const { point, openAt, close } = useContextMenuPoint();

  return (
    <>
      <a
        href={cardHref(card.projectId, card.id)}
        // Name first, then where it lives in the runner — the worktree, the base branch and the
        // tmux session used to be a footer line under the terminal, which is height this app does
        // not have to spare for something you look at once a day.
        title={`${card.title}\n${cardRunnerHint(card)}`}
        aria-current={active ? "true" : undefined}
        onClick={(e) => {
          if (isNewTabClick(e)) return;
          e.preventDefault();
          // The first click of a double-click also lands here; renaming owns the second one.
          if (e.detail > 1) return;
          onOpen();
        }}
        onDoubleClick={onRename}
        onContextMenu={items.length > 0 ? openAt : undefined}
        className={cn(
          "flex w-full items-center gap-2 py-1.5 pl-9 pr-3 text-left text-sm transition-colors",
          active
            ? `${SELECTED_ROW} text-foreground`
            : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
        )}
      >
        <span
          title={paused ? "Paused" : dot?.label}
          className="inline-flex h-2 w-2 shrink-0 items-center justify-center"
        >
          {paused ? (
            <Pause aria-hidden className="h-2.5 w-2.5 text-muted-foreground/70" />
          ) : dot ? (
            <span
              className={cn(
                "inline-block h-2 w-2 rounded-full",
                dot.tone === "ok" ? "bg-emerald-400" : "bg-amber-400",
                dot.live && "dot-live",
              )}
            />
          ) : null}
        </span>
        <span className="truncate">{card.title}</span>
      </a>
      <ContextMenu point={point} items={items} ariaLabel={`Actions for ${card.title}`} onClose={close} />
    </>
  );
}

/* ------------------------------------------------------------- drag maths */

/** Is the pointer in the BOTTOM half of the row it is over (drop after, rather than before)? PURE. */
export function isBelowMidpoint(pointerY: number, rectTop: number, rectHeight: number): boolean {
  return pointerY >= rectTop + rectHeight / 2;
}

/**
 * Turns a gap index (0..n, in the FULL list) into the `position` the server expects — the index
 * after the moved item has been taken out. Dropping a row back where it already is, on either side
 * of itself, is a no-op.
 */
export function gapToPosition(gap: number, from: number): number {
  if (gap === from || gap === from + 1) return from;
  return gap > from ? gap - 1 : gap;
}

