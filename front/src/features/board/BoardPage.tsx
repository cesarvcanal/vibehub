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
import { CardTerminalView } from "@/features/board/components/CardTerminalView";
import { KanbanBoard } from "@/features/board/components/KanbanBoard";
import { McpManager } from "@/features/board/components/McpManager";
import { NewCardDialog } from "@/features/board/components/NewCardDialog";
import { ProjectFormDialog } from "@/features/board/components/ProjectFormDialog";
import { ProjectSidebar } from "@/features/board/components/ProjectSidebar";
import { RunnerBanner } from "@/features/board/components/RunnerBanner";
import { moveProjectLocal, readLocation, sortProjects, writeLocation } from "@/features/board/lib/board";
import { cardViewHeight } from "@/features/board/lib/focusMode";
import { useIsMobile } from "@/lib/useIsMobile";
import {
  attachLeaveFocusShortcut,
  attachNewCardShortcut,
} from "@/features/board/lib/newCardShortcut";
import {
  ACCOUNTS_KEY,
  PROJECTS_KEY,
  boardApi,
  cardsKey,
  projectAccountSlug,
  projectBaseBranch,
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

  // Clicking a project selects it; clicking the selected one deselects it (the aggregated board).
  const selectProject = (id: string) => go(id === selected?.id ? null : id);
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
  // Which project a new card belongs to. Set from any row's `+`, or from the shortcut.
  const [newCardProject, setNewCardProject] = React.useState<BoardProject | null>(null);
  // The drawer, on screens where the sidebar is not part of the page.
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Any navigation closes it: on a phone the drawer covers the thing it just navigated to.
  const location = `${projectId ?? ""}:${cardId ?? ""}`;
  React.useEffect(() => setMenuOpen(false), [location]);

  const { data: accountsData } = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: boardApi.listAccounts });

  const createCardMutation = useMutation({
    mutationFn: (input: NewCard) => boardApi.createCard(input),
    onSuccess: (card) => {
      void queryClient.invalidateQueries({ queryKey: cardsKey(card.projectId) });
      // The dialog already closed itself on submit — several cards can be queued up back to back.
      // Created from inside a terminal: go straight to the new one. From the board, let it land in
      // the backlog — you are looking at the board precisely to decide what to do next.
      if (cardId) go(card.projectId, card.id);
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

  /* ------------------------------------------------------------- shortcuts */

  // Read through a ref so the listeners are bound once and never re-bound on every navigation.
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;

  React.useEffect(
    () =>
      attachNewCardShortcut(() => {
        if (selectedRef.current) setNewCardProject(selectedRef.current);
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

  const sidebar = (
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
      onNewCard={setNewCardProject}
      onDeleteProject={setDeleteTarget}
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

      {newCardProject ? (
        <NewCardDialog
          open
          onOpenChange={(next) => !next && setNewCardProject(null)}
          projectId={newCardProject.id}
          accounts={accountsData?.accounts ?? []}
          defaultAccountLabel={accountsData?.defaultLabel || t("board.defaultAccountFallback")}
          inheritedAccount={projectAccountSlug(newCardProject)}
          defaultBranch={projectBaseBranch(newCardProject)}
          onSubmit={(input) => createCardMutation.mutate(input)}
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

  /* --------------------------------------------------------- the card view */

  if (selected && cardId) {
    return (
      <div className="h-full">
        <div
          data-testid="card-layout"
          className="flex min-h-[420px] flex-col gap-3 lg:flex-row lg:items-stretch"
          style={{ height: cardViewHeight(undefined, isMobile) }}
        >
          {/* The handle is the card bar's, not the page's — see `menuButton`. The slot stays so
              React keeps reconciling the sidebar against the sidebar across the two branches. */}
          {null}
          {sidebar}
          {/* Keyed by card: switching cards tears the socket down and opens the next one cleanly. */}
          <CardTerminalView
            key={cardId}
            project={selected}
            cardId={cardId}
            onBack={() => go(selected.id)}
            onNewCard={() => setNewCardProject(selected)}
            onOpenMenu={() => setMenuOpen(true)}
          />
        </div>
        {dialogs}
      </div>
    );
  }

  /* ------------------------------------------------------------- the board */

  return (
    <div className="space-y-5">
      {isLoading ? (
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
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("board.noProjectsBody")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => setNewProjectOpen(true)}>
              <Plus /> {t("board.createFirstProject")}
            </Button>
            <RunnerBanner />
          </div>
        </div>
      ) : (
        // `lg:items-start` — the sidebar is as tall as its own content here, not as tall as the
        // board beside it.
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          {null}
          {sidebar}

          <div className="min-w-0 flex-1">
            {selected ? (
              <KanbanBoard
                project={selected}
                onOpenCard={(card) => go(selected.id, card.id)}
                onNewCard={() => setNewCardProject(selected)}
                headerExtra={headerExtra}
                headerLead={menuButton}
              />
            ) : (
              // Nothing selected: every project's cards at once. Opening one goes to ITS project.
              <AllProjectsBoard
                projects={projects}
                onOpenCard={(card) => go(card.projectId, card.id)}
                headerExtra={aggregateHeaderExtra}
                headerLead={menuButton}
              />
            )}
          </div>
        </div>
      )}

      {dialogs}
    </div>
  );
}

export default BoardPage;
