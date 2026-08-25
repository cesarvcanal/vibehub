import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Code2, Loader2, Menu, Plus } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccountsManager } from "@/features/board/components/AccountsManager";
import { AllProjectsBoard } from "@/features/board/components/AllProjectsBoard";
import { BrainManager } from "@/features/board/components/BrainManager";
import { KanbanBoard } from "@/features/board/components/KanbanBoard";
import { McpManager } from "@/features/board/components/McpManager";
import { NewCardDialog } from "@/features/board/components/NewCardDialog";
import { ProjectFormDialog } from "@/features/board/components/ProjectFormDialog";
import { ProjectSidebar } from "@/features/board/components/ProjectSidebar";
import { RunnerBanner } from "@/features/board/components/RunnerBanner";
import { TerminalDeck } from "@/features/board/components/TerminalDeck";
import { moveProjectLocal, readLocation, sortProjects, writeLocation } from "@/features/board/lib/board";
import { deckLimit, dropFromDeck, pruneDeck, touchDeck, type DeckEntry } from "@/features/board/lib/deck";
import { cardViewHeight } from "@/features/board/lib/focusMode";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/lib/useIsMobile";
import {
  attachLeaveFocusShortcut,
  attachNewCardShortcut,
} from "@/features/board/lib/newCardShortcut";
import {
  ACCOUNTS_KEY,
  PROJECTS_KEY,
  boardApi,
  cardKey,
  cardsKey,
  type BoardCard,
  type BoardProject,
} from "@/features/board/api";
import type { NewCard } from "@/api/types";
import { t as translate, useT } from "@/i18n";

/**
 * The board.
 *
 * ONE frame, two middles. The sidebar IS the page's chrome — brand at its top, account row at its
 * bottom, everything else in between — and the column beside it runs from the very top of the
 * viewport to the bottom. Opening a card does not take the screen over, it swaps the kanban for
 * that card's terminal and leaves everything else exactly where it was. Nothing moves under the
 * cursor, and the list you use to reach the next agent is still there while you read this one.
 *
 * Where you are lives in the URL (`?project=…&card=…`), never in component state, so a refresh, a
 * second tab and a pasted link all land in the same place, including inside a terminal. NO project
 * is a destination too: it is the aggregated board across everything.
 *
 * ## One layout, and the deck inside it
 *
 * The page renders ONE element tree in both states. The board and the card view are not two screens
 * that replace each other; they are the same frame with a different middle. That is what lets the
 * TERMINAL DECK — every card you have opened, still mounted, still connected — sit at a fixed spot
 * in that tree and survive every navigation: React reconciles by position, so a deck that moved
 * between two branches would be a deck that unmounts, and unmounting is exactly the cost this is
 * here to remove. Switching cards is now a change of which pane is visible; going back to the board
 * parks the deck off screen with its sockets intact.
 */
export function BoardPage() {
  const t = useT();
  // Only used for the card view's height unit: `dvh` on a phone, `vh` everywhere else.
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const { projectId, cardId } = readLocation(searchParams);

  const { data: projectList, isLoading } = useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: boardApi.listProjects,
  });
  const projects = React.useMemo(() => sortProjects(projectList ?? []), [projectList]);

  const selected = projects.find((p) => p.id === projectId) ?? null;

  const go = React.useCallback(
    (nextProjectId: string | null, nextCardId: string | null = null) => {
      setSearchParams(writeLocation({ projectId: nextProjectId, cardId: nextCardId }), {
        replace: false,
      });
    },
    [setSearchParams],
  );

  /**
   * The project's NAME navigates — unfolding its cards is the chevron's job now, and no longer
   * costs you the terminal you had open.
   *
   * Clicking the project you are ALREADY on goes up exactly one level: out of a card to that
   * project's board, and from that board to the aggregated one. It used to jump straight to the
   * aggregated board from inside a card, which threw away two levels for one click.
   */
  const selectProject = (id: string) => {
    if (id !== selected?.id) return go(id);
    return go(cardId ? id : null);
  };
  // Clicking a card opens it; clicking the one already open closes it (back to that project's board).
  const openCard = (nextProjectId: string, nextCardId: string) =>
    go(nextProjectId, projectId === nextProjectId && cardId === nextCardId ? null : nextCardId);

  /**
   * Keep the URL honest. A project id that no longer exists — deleted, or a stale bookmark — falls
   * back to the AGGREGATED board rather than to some arbitrary first project: showing someone
   * else's board because the one they asked for is gone is a lie, and "everything" is the honest
   * answer. Nothing happens while the list is still loading: that is not "missing", it is "not
   * known yet".
   */
  React.useEffect(() => {
    if (!projectList) return;
    if (!projectId) return;
    if (projects.some((p) => p.id === projectId)) return;
    go(null);
  }, [projectList, projects, projectId, go]);

  /* --------------------------------------------------------------- dialogs */

  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<BoardProject | null>(null);
  // A new-card request in flight. `project` is null when it came from a no-project context (the
  // homepage / a global "+"): the dialog asks which. `open` = jump into the card once it is created
  // — true for the prominent "New card" buttons, false for the Backlog column's "+", which is for
  // jotting down work without leaving the board.
  const [newCard, setNewCard] = React.useState<{ project: BoardProject | null; open: boolean } | null>(null);
  const askCard = (project: BoardProject | null, open: boolean) => setNewCard({ project, open });
  // The drawer, on screens where the sidebar is not part of the page.
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Any navigation closes it: on a phone the drawer covers the thing it just navigated to.
  const location = `${projectId ?? ""}:${cardId ?? ""}`;
  React.useEffect(() => setMenuOpen(false), [location]);

  const { data: accountsData } = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: boardApi.listAccounts });

  const createCardMutation = useMutation({
    mutationFn: ({ input }: { input: NewCard; open: boolean }) => boardApi.createCard(input),
    onSuccess: (card, { open }) => {
      // WRITE IT INTO THE CACHE FIRST. Invalidating alone means the card only shows up after a
      // round trip, and in that gap the sidebar has no row for the card the user just named — you
      // click where it should be, nothing is there, and if you land in it anyway the terminal opens
      // against a workspace nobody has admitted exists yet. Insert it, then let the poll confirm.
      queryClient.setQueryData<BoardCard[]>(cardsKey(card.projectId), (previous) =>
        previous ? (previous.some((c) => c.id === card.id) ? previous : [...previous, card]) : previous,
      );
      queryClient.setQueryData(cardKey(card.id), card);
      void queryClient.invalidateQueries({ queryKey: cardsKey(card.projectId) });
      // The dialog already closed itself on submit — several cards can be queued up back to back.
      // Whether to jump into the new card is the CALLER's choice (see `newCard.open`): the prominent
      // "New card" buttons open it; the Backlog column's "+" leaves it on the board.
      if (open) go(card.projectId, card.id);
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardCreateError"))),
  });

  const deleteProjectMutation = useMutation({
    mutationFn: (id: string) => boardApi.deleteProject(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      if (projectId === id) go(null);
      toast.success(translate("toast.projectDeleted"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.projectDeleteError"))),
    onSettled: () => setDeleteTarget(null),
  });

  const reorderMutation = useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) =>
      boardApi.reorderProject(id, position),
    onMutate: async ({ id, position }) => {
      await queryClient.cancelQueries({ queryKey: PROJECTS_KEY });
      const previous = queryClient.getQueryData<BoardProject[]>(PROJECTS_KEY);
      if (previous) queryClient.setQueryData(PROJECTS_KEY, moveProjectLocal(previous, id, position));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(PROJECTS_KEY, context.previous);
      toast.error(apiErrorMessage(error, translate("toast.projectReorderError")));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  });

  /* ------------------------------------------------------------------ deck */

  /**
   * The cards whose terminals stay alive. Every card you open joins; the limit decides who leaves.
   *
   * This is the ONE piece of screen state the URL does not own, and deliberately so: the URL says
   * which card you are looking at, this says which ones are still warm behind it. A refresh is
   * allowed to forget the deck — the sessions are in the runner, not here.
   */
  const [deck, setDeck] = React.useState<DeckEntry[]>([]);
  const limit = deckLimit(isMobile);
  const projectExists = Boolean(selected);

  React.useEffect(() => {
    if (!cardId || !projectId || !projectExists) return;
    setDeck((prev) => touchDeck(prev, { cardId, projectId }, limit));
  }, [cardId, projectId, projectExists, limit]);

  // A deleted project takes its worktrees and its sessions with it; nothing of it stays connected.
  React.useEffect(() => {
    if (!projectList) return;
    const ids = projects.map((p) => p.id);
    setDeck((prev) => pruneDeck(prev, ids));
  }, [projectList, projects]);

  const closePane = React.useCallback((id: string) => {
    setDeck((prev) => dropFromDeck(prev, id));
  }, []);

  /* ------------------------------------------------------------- shortcuts */

  // Read through a ref so the listeners are bound once and never re-bound on every navigation.
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;

  React.useEffect(
    () =>
      attachNewCardShortcut(() => {
        askCard(selectedRef.current, true);
      }),
    [],
  );

  const cardOpen = Boolean(selected && cardId);
  React.useEffect(() => {
    if (!cardOpen) return;
    return attachLeaveFocusShortcut(() => go(selectedRef.current?.id ?? null));
  }, [cardOpen, go]);

  /* ------------------------------------------------------------- the parts */

  /** The install-wide managers, then the runner chip — which sits next to the New card button. */
  const headerExtra = (
    <>
      <AccountsManager />
      <McpManager />
      <BrainManager />
      <RunnerBanner />
    </>
  );

  /** The same managers minus the runner: the aggregated board has no single runner to report on. */
  const aggregateHeaderExtra = (
    <>
      <AccountsManager />
      <McpManager />
      <BrainManager />
    </>
  );

  // `inline` swaps the drawer for an in-flow panel: on a phone with nothing open, the project/card
  // list IS the page rather than a menu behind a handle (see `showInlineMenu` below). Same instance
  // wherever it renders, so only one poll is ever alive.
  const sidebar = (inline = false) => (
    <ProjectSidebar
      projects={projects}
      selectedProjectId={selected?.id ?? null}
      selectedCardId={selected ? cardId : null}
      mobileOpen={menuOpen}
      onCloseMobile={() => setMenuOpen(false)}
      onSelectProject={selectProject}
      onOpenCard={openCard}
      onReorder={(id, position) => reorderMutation.mutate({ id, position })}
      onNewProject={() => setNewProjectOpen(true)}
      onNewCard={(project) => askCard(project, false)}
      onNewGlobalCard={() => askCard(null, true)}
      onDeleteProject={setDeleteTarget}
      onShowAllProjects={() => go(null)}
      inline={inline}
    />
  );

  /**
   * The drawer's handle, below `lg`.
   *
   * It used to be a labelled row of its own above everything, and on a phone that row was a whole
   * line of height spent on a button — with a second handle already sitting in the card bar doing
   * the same job. So it moved INTO the board's header row, beside the card count, as an icon: one
   * handle per screen, no line of its own, and the card view has its own in the bar.
   */
  const menuButton = (
    <button
      type="button"
      onClick={() => setMenuOpen(true)}
      aria-label={t("board.openMenu")}
      title={t("board.projectsButton")}
      className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
    >
      <Menu className="h-4 w-4" />
    </button>
  );

  const dialogs = (
    <>
      <ProjectFormDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        onCreated={(project) => go(project.id)}
      />

      {newCard ? (
        <NewCardDialog
          open
          onOpenChange={(next) => !next && setNewCard(null)}
          projects={projects}
          initialProjectId={newCard.project?.id ?? null}
          accounts={accountsData?.accounts ?? []}
          defaultAccountLabel={accountsData?.defaultLabel || t("board.defaultAccountFallback")}
          onSubmit={(input) => createCardMutation.mutate({ input, open: newCard.open })}
        />
      ) : null}

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("board.deleteProject.title", { name: deleteTarget?.name })}</DialogTitle>
            <DialogDescription>
              {t("board.deleteProject.body")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteProjectMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteProjectMutation.isPending}
              onClick={() => deleteTarget && deleteProjectMutation.mutate(deleteTarget.id)}
            >
              {deleteProjectMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              {t("board.deleteProject.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  /* -------------------------------------------------------- board and card */

  /**
   * The board's middle. Not rendered while a card is open — the deck is standing in that slot — so
   * the kanban stops polling and gets out of the way, exactly as it did when these were two screens.
   */
  const boardMiddle = isLoading ? (
    <div className="flex justify-center py-12">
      <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
    </div>
  ) : projects.length === 0 ? (
    <div className="panel flex flex-col items-center gap-3 py-12 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
        <Code2 className="h-5 w-5" />
      </div>
      <div>
        <p className="font-medium">{t("board.noProjects")}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("board.noProjectsBody")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => setNewProjectOpen(true)}>
          <Plus /> {t("board.createFirstProject")}
        </Button>
        <RunnerBanner />
      </div>
    </div>
  ) : selected ? (
    <KanbanBoard
      project={selected}
      onOpenCard={(card) => go(selected.id, card.id)}
      onNewCard={() => askCard(selected, true)}
      onNewBacklogCard={() => askCard(selected, false)}
      headerExtra={headerExtra}
      headerLead={menuButton}
    />
  ) : (
    // Nothing selected: every project's cards at once. Opening one goes to ITS project.
    <AllProjectsBoard
      projects={projects}
      onOpenCard={(card) => go(card.projectId, card.id)}
      onNewCard={() => askCard(null, true)}
      headerExtra={aggregateHeaderExtra}
      headerLead={menuButton}
    />
  );

  /**
   * The phone homepage shows the MENU, not the kanban.
   *
   * On a narrow screen with nothing open, the aggregated board is five columns squeezed into one —
   * not what you reach for on a phone, where the question is "which project / which card". So the
   * sidebar becomes the main view, in-flow instead of a drawer, and the board middle stands aside.
   * Above `lg`, and whenever a project or card is open, nothing changes: the sidebar is the drawer
   * it always was and the board fills the column beside it.
   */
  const showInlineMenu = isMobile && !cardOpen && !selected && projects.length > 0;

  return (
    <div className={cardOpen ? "h-full" : "space-y-5"}>
      {/* THE frame. Same element, same children, in both states — see the note at the top: the deck
          below only stays connected because it never changes its place in this tree. With a card
          open the row is exactly one viewport tall; on the board it is as tall as its content. */}
      <div
        data-testid={cardOpen ? "card-layout" : "board-layout"}
        className={cn(
          "flex min-w-0 flex-col gap-3 lg:flex-row",
          cardOpen ? "min-h-[420px] lg:items-stretch" : "lg:items-start",
        )}
        style={cardOpen ? { height: cardViewHeight(undefined, isMobile) } : undefined}
      >
        {/* No projects at all: there is nothing to list, and the invitation below is the whole page.
            When the phone menu IS the page, the sidebar moves into the middle slot instead — one
            instance, never both, so the poll stays single. */}
        {projects.length > 0 && !showInlineMenu ? sidebar() : null}
        {cardOpen ? null : (
          <div className="min-w-0 flex-1">{showInlineMenu ? sidebar(true) : boardMiddle}</div>
        )}
        <TerminalDeck
          entries={deck}
          activeCardId={cardOpen ? cardId : null}
          projects={projects}
          onBack={(id) => go(id)}
          onNewCard={(project) => askCard(project, true)}
          onOpenMenu={() => setMenuOpen(true)}
          onClose={closePane}
        />
      </div>

      {dialogs}
    </div>
  );
}

export default BoardPage;
