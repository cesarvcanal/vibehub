import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderGit2,
  Moon,
  Pause,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import { cn, isNewTabClick } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  useContextMenuPoint,
  useLongPress,
  type ContextMenuItem,
} from "@/features/board/components/ContextMenu";
import { Logo } from "@/components/Logo";
import { AccountRow } from "@/components/AccountRow";
import {
  SELECTED_ROW,
  cardDot,
  cardHref,
  dotClass,
  gapToPosition,
  isBelowMidpoint,
  nextPosition,
  splitSidebarCards,
} from "@/features/board/lib/board";
import { useExpandedProjects } from "@/features/board/lib/sidebarExpanded";
import { RecentCards } from "@/features/board/components/RecentCards";
import {
  boardApi,
  cardRunnerHint,
  cardsKey,
  projectBaseBranch,
  projectRepo,
  type BoardCard,
  type BoardProject,
} from "@/features/board/api";
import { t as translate, useT } from "@/i18n";

/**
 * The ONE sidebar.
 *
 * There used to be two: a flat project list beside the board, and a different, card-shaped list
 * beside an open terminal. They are the same list. Opening a card does not change what you might
 * want to reach next, so the sidebar does not change either — it is the same component, in the same
 * place, on both views, and only the middle of the page swaps.
 *
 * Every row is one project, and it answers to TWO different clicks, because unfolding a project
 * and going to it are two different intentions. The CHEVRON unfolds its cards where they are and
 * changes nothing else — as many projects open at once as you like, and the card you have open
 * stays open, which is the whole reason it exists. The NAME navigates: that project's board fills
 * the middle. Clicking the name of the project you are already on takes you up one level — out of
 * a card to its board, and from the board to the aggregated one, which is why there is no "All
 * projects" row and no "back to board" button.
 *
 * Clicking a card opens its terminal, from ANY unfolded project rather than only the selected one:
 * moving from one agent to another is one click from anywhere in the list. Clicking the card that
 * is already open closes it and puts the board back.
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

/** Name on the row, repository in the tooltip: the repo was noise on a list you read by name. */
function projectHint(project: BoardProject): string {
  const repo = projectRepo(project);
  const branch = projectBaseBranch(project);
  const where = repo ? `${repo}${branch ? ` · ${branch}` : ""}` : translate("sidebar.noRepository");
  return `${project.name}\n${where}`;
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
  const t = useT();
  const { isExpanded, toggle } = useExpandedProjects(selectedProjectId);
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
        aria-label={t("sidebar.projects")}
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

        {/* Where you just were, above what you own. It hides itself when there is nothing to
            go back to, so a fresh install still opens on the project list. */}
        <RecentCards projects={projects} activeCardId={selectedCardId} onOpenCard={onOpenCard} />

        <div className="flex shrink-0 items-center justify-between border-b border-border/60 py-1 pl-3 pr-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("board.projects", { n: projects.length })}
          </span>
          {/* Creating a project belongs on the list of projects, not in the page header. */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label={t("sidebar.newProject")}
            title={t("sidebar.newProject")}
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
                expanded={isExpanded(project.id)}
                onToggleExpanded={() => toggle(project.id)}
                // Only the selected project can own the card that is open: opening a card selects
                // its project, so the two ids always belong together.
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
            <p className="px-3 py-3 text-xs text-muted-foreground">{t("sidebar.noProjects")}</p>
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
 * The row itself is a chevron, a name and an always-visible `+`. Nothing else: the repository moved
 * into the tooltip, and the management actions (reorder, delete) moved into the right-click menu,
 * because a row that sprouts three icon buttons on hover is a row you cannot read at a glance.
 *
 * When UNFOLDED it lists its cards, and only then does it fetch them. Unfolded is not the same as
 * selected — several projects can be open at once, and each open one polls, because a list of cards
 * with stale dots is worse than no list. The cards that are working or waiting are always listed;
 * the rest hide behind "show more"; finished ones never appear, EXCEPT the card whose terminal is
 * open, which is always listed or the one thing on screen would be the one thing you cannot see.
 */
function ProjectRow({
  project,
  index,
  first,
  last,
  selected,
  expanded,
  onToggleExpanded,
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
  /** Are this project's cards unfolded? Independent of `selected` — see the chevron. */
  expanded: boolean;
  onToggleExpanded: () => void;
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
  const t = useT();
  const queryClient = useQueryClient();
  const boardKey = cardsKey(project.id);

  const { data: cards } = useQuery({
    queryKey: boardKey,
    queryFn: () => boardApi.listCards(project.id),
    // 2s, not 5s: the dot is the one thing on screen that has to feel live. A card that just went
    // amber is a card asking for you, and three extra seconds of green reads as "still busy".
    refetchInterval: 2_000,
    // Unfolded, not selected: every open list has live dots, or the reason to keep two projects
    // open at once — watching both — would not survive the first poll.
    enabled: expanded,
  });

  const [showMore, setShowMore] = React.useState(false);
  React.useEffect(() => {
    if (!expanded) setShowMore(false);
  }, [expanded]);

  const { active, idle } = splitSidebarCards(cards ?? []);
  const openCard = activeCardId ? (cards ?? []).find((c) => c.id === activeCardId) : undefined;
  // The card you are IN always has a row, whatever column it sits in. It used to be listed only
  // when it was in neither half, so opening a card straight out of the Backlog — which is every
  // brand-new card — left the list with no row for the thing filling the screen, and the "show
  // more" fold was the only place it existed.
  const listed =
    openCard && !active.some((c) => c.id === openCard.id) ? [openCard, ...active] : active;
  const shown = new Set(listed.map((c) => c.id));
  const folded = idle.filter((c) => !shown.has(c.id));

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
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardRenameError"))),
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
      toast.success(translate("toast.cardPaused"));
      // Pausing the card you are looking at takes you up one level, exactly like clicking its row.
      if (updated.id === activeCardId) onOpenCard(updated.id);
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardPauseError"))),
  });

  const restartMutation = useMutation({
    mutationFn: (id: string) => boardApi.restartCard(id),
    onSuccess: () => toast.success(translate("toast.cardRestarting")),
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardRestartError"))),
  });

  const hibernateMutation = useMutation({
    mutationFn: (id: string) => boardApi.hibernateCard(id),
    onSuccess: (updated) => {
      mirror(updated);
      toast.success(translate("toast.cardHibernated"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardHibernateError"))),
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, column, position }: { id: string; column: BoardCard["column"]; position: number }) =>
      boardApi.patchCard(id, { column, position }),
    onSuccess: mirror,
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardMoveError"))),
  });

  function restart(card: BoardCard) {
    if (
      card.status === "working" &&
      !window.confirm(translate("confirm.restartWorking"))
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
    toast.success(translate("toast.cardFinished", { title: card.title }), {
      action: {
        label: translate("common.undo"),
        onClick: () => moveMutation.mutate({ id: card.id, ...previous }),
      },
    });
    if (card.id === activeCardId) onOpenCard(card.id);
  }

  /* --------------------------------------------------------- the row itself */

  const projectMenu: ContextMenuItem[] = [
    { key: "new-card", label: t("board.newCard"), icon: Plus, onSelect: onNewCard },
    ...(first ? [] : [{ key: "up", label: t("sidebar.moveUp"), icon: ChevronUp, onSelect: () => onStep(-1) }]),
    ...(last ? [] : [{ key: "down", label: t("sidebar.moveDown"), icon: ChevronDown, onSelect: () => onStep(1) }]),
    { key: "delete", label: t("sidebar.deleteProject"), icon: Trash2, danger: true, onSelect: onDelete },
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
        aria-label={t("sidebar.renameCard")}
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
        onHibernate={(c) => hibernateMutation.mutate(c.id)}
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
        {/* The disclosure, ahead of the folder icon and outside the name button. It is its OWN
            target, which is the whole point: unfolding a project never navigates anywhere. */}
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t("sidebar.collapseProject", { name: project.name })
              : t("sidebar.expandProject", { name: project.name })
          }
          className="ml-2 flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          title={projectHint(project)}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2 py-2.5 pl-1 pr-1 text-left active:cursor-grabbing"
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
          aria-label={t("sidebar.newCardIn", { name: project.name })}
          title={t("sidebar.newCardHint")}
          onClick={onNewCard}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {expanded ? (
        <div className="pb-1.5">
          {listed.map(renderCard)}
          {/* The revealed cards appear ABOVE the toggle, which stays anchored at the end of the
              list: expanding and collapsing are the same point of click, and nothing moves out
              from under the cursor. */}
          {showMore ? folded.map(renderCard) : null}
          {folded.length > 0 ? (
            <button
              type="button"
              aria-expanded={showMore}
              onClick={() => setShowMore((v) => !v)}
              className="w-full py-1.5 pl-9 pr-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 transition-colors hover:bg-card/60 hover:text-foreground"
            >
              {showMore ? t("sidebar.showLess") : t("sidebar.showMore", { n: folded.length })}
            </button>
          ) : null}
          {listed.length === 0 && folded.length === 0 ? (
            <p className="py-1.5 pl-9 pr-3 text-[11px] text-muted-foreground/60">{t("sidebar.noActiveCards")}</p>
          ) : null}
        </div>
      ) : null}

      <ContextMenu
        point={point}
        items={projectMenu}
        ariaLabel={t("sidebar.actionsForProject", { name: project.name })}
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
 * by comparing ids. Right-click (long-press on a touch screen) offers renaming plus the three
 * things worth doing to a live session, for ANY card in the list rather than only the open one.
 *
 * Renaming is a MENU item and not a double-click, because the first click of that double-click is
 * a real click: it opens another card, or — on the card already open — closes it, tearing the
 * terminal down before the rename box even appears. A gesture whose first half navigates cannot be
 * the way to edit a name.
 */
function SidebarCard({
  card,
  active,
  onOpen,
  onRename,
  onPause,
  onRestart,
  onHibernate,
  onFinish,
}: {
  card: BoardCard;
  active: boolean;
  onOpen: () => void;
  onRename: () => void;
  onPause: (card: BoardCard) => void;
  onRestart: (card: BoardCard) => void;
  onHibernate: (card: BoardCard) => void;
  onFinish: (card: BoardCard) => void;
}) {
  const t = useT();
  const dot = cardDot(card);
  const paused = Boolean(card.pausedAt);
  const canPause = Boolean(card.openedAt) && !paused && !card.hibernatedAt;

  const items: ContextMenuItem[] = [
    { key: "rename", label: t("card.rename"), icon: Pencil, onSelect: onRename },
    ...(canPause ? [{ key: "pause", label: t("card.pause"), icon: Pause, onSelect: () => onPause(card) }] : []),
    ...(canPause
      ? [{ key: "restart", label: t("card.restart"), icon: RotateCw, onSelect: () => onRestart(card) }]
      : []),
    // Only where there is a session to close. It does the idle sweep's job on demand: the terminal
    // goes, the card does not move.
    ...(canPause
      ? [{ key: "hibernate", label: t("card.hibernate"), icon: Moon, onSelect: () => onHibernate(card) }]
      : []),
    ...(card.column !== "done"
      ? [{ key: "finish", label: t("card.finish"), icon: Check, onSelect: () => onFinish(card) }]
      : []),
  ];
  const { point, openAt, openAtPoint, close } = useContextMenuPoint();
  const longPress = useLongPress(openAtPoint);

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
          // A long-press opened the menu over this row; the click it ends with is not a choice.
          if (longPress.swallowClick()) return;
          // A stray double-click would otherwise open and immediately close the card again.
          if (e.detail > 1) return;
          onOpen();
        }}
        onContextMenu={openAt}
        {...longPress.handlers}
        className={cn(
          // `touch-callout` off: on iOS a long press on a link raises the browser's own preview,
          // which would cover the menu that same press is here to open.
          "flex w-full items-center gap-2 py-1.5 pl-9 pr-3 text-left text-sm transition-colors [-webkit-touch-callout:none]",
          active
            ? `${SELECTED_ROW} text-foreground`
            : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
        )}
      >
        <span
          title={paused ? t("status.paused") : dot?.label}
          className="inline-flex h-2 w-2 shrink-0 items-center justify-center"
        >
          {paused ? (
            <Pause aria-hidden className="h-2.5 w-2.5 text-muted-foreground/70" />
          ) : dot ? (
            <span
              className={cn("inline-block h-2 w-2 rounded-full", dotClass(dot.tone), dot.live && "dot-live")}
            />
          ) : null}
        </span>
        <span className="truncate">{card.title}</span>
      </a>
      <ContextMenu
        point={point}
        items={items}
        ariaLabel={t("card.actionsFor", { title: card.title })}
        onClose={close}
      />
    </>
  );
}

/* ------------------------------------------------------------- drag maths */

// The maths of dropping between two rows is the same here and on the kanban, so it lives in
// `lib/board` and both read it from there. Re-exported because this is where it was first written.
export { gapToPosition, isBelowMidpoint };

