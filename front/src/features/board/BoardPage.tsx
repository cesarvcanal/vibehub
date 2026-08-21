import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Code2, Loader2, Plus } from "lucide-react";
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
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AccountsManager } from "@/features/board/components/AccountsManager";
import { AllProjectsBoard } from "@/features/board/components/AllProjectsBoard";
import { BrainManager } from "@/features/board/components/BrainManager";
import { CardListNav, CardListSidebar } from "@/features/board/components/CardListSidebar";
import { CardTerminalView } from "@/features/board/components/CardTerminalView";
import { KanbanBoard } from "@/features/board/components/KanbanBoard";
import { McpManager } from "@/features/board/components/McpManager";
import { NewCardDialog } from "@/features/board/components/NewCardDialog";
import { ProjectFormDialog } from "@/features/board/components/ProjectFormDialog";
import { ProjectSidebar } from "@/features/board/components/ProjectSidebar";
import { RunnerBanner } from "@/features/board/components/RunnerBanner";
import {
  isAllProjects,
  moveProjectLocal,
  readLocation,
  sortProjects,
  writeLocation,
} from "@/features/board/lib/board";
import { FOCUS_CHROME_PX, focusHeight } from "@/features/board/lib/focusMode";
import {
  attachLeaveFocusShortcut,
  attachNewCardShortcut,
} from "@/features/board/lib/newCardShortcut";
import { boardTitle, useDocumentTitle } from "@/features/board/lib/documentTitle";
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

/**
 * The board.
 *
 * Two views, one screen: the kanban of the selected project, and — when a card is open — that
 * card's terminal filling the window with a narrow card list beside it. Which one you get is read
 * from the URL (`?project=…&card=…`), never from component state, so a refresh, a second tab and a
 * pasted link all land in exactly the same place, including inside a terminal.
 */
export function BoardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const { projectId, cardId } = readLocation(searchParams);

  const { data: projectList, isLoading } = useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: boardApi.listProjects,
  });
  const projects = React.useMemo(() => sortProjects(projectList ?? []), [projectList]);

  const selected = projects.find((p) => p.id === projectId) ?? null;
  // An explicit choice, not the absence of one: the aggregated board across every project.
  const allProjects = isAllProjects(projectId);

  const go = React.useCallback(
    (nextProjectId: string | null, nextCardId: string | null = null) => {
      setSearchParams(writeLocation({ projectId: nextProjectId, cardId: nextCardId }), {
        replace: false,
      });
    },
    [setSearchParams],
  );

  /**
   * Keep the URL honest. A link to a project that has since been deleted (or a stale bookmark)
   * falls back to the first project rather than showing an empty screen with no way out. Nothing
   * happens while the list is still loading — that is not "missing", it is "not known yet".
   */
  React.useEffect(() => {
    if (!projectList) return;
    // "All projects" is a destination, not a missing project — never reconcile it away.
    if (isAllProjects(projectId)) return;
    if (projectId && projects.some((p) => p.id === projectId)) return;
    const fallback = projects[0]?.id ?? null;
    if (fallback !== projectId) go(fallback);
  }, [projectList, projects, projectId, go]);

  /* --------------------------------------------------------------- dialogs */

  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const [newCardOpen, setNewCardOpen] = React.useState(false);
  // The navigation drawer, for screens where the card list column is hidden.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<BoardProject | null>(null);

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
    onError: (error) => toast.error(apiErrorMessage(error, "Could not create the card")),
  });

  const deleteProjectMutation = useMutation({
    mutationFn: (id: string) => boardApi.deleteProject(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      // The URL may still be pointing at what was just deleted; the reconciling effect above will
      // move it on, but clearing it here avoids a flash of an empty board.
      if (projectId === id) go(null);
      toast.success("Project deleted.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not delete the project")),
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
      toast.error(apiErrorMessage(error, "Could not reorder the projects"));
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
        if (selectedRef.current) setNewCardOpen(true);
      }),
    [],
  );

  const inFocus = Boolean(selected && cardId);
  React.useEffect(() => {
    if (!inFocus) return;
    return attachLeaveFocusShortcut(() => go(selectedRef.current?.id ?? null));
  }, [inFocus, go]);

  useDocumentTitle(boardTitle(inFocus ? null : selected?.name));

  /** The install-wide managers. Same set on either board — they are not about one project. */
  const headerExtra = (
    <>
      <RunnerBanner />
      <AccountsManager />
      <BrainManager />
      <McpManager />
    </>
  );

  const newCardDialog = selected ? (
    <NewCardDialog
      open={newCardOpen}
      onOpenChange={setNewCardOpen}
      projectId={selected.id}
      accounts={accountsData?.accounts ?? []}
      defaultAccountLabel={accountsData?.defaultLabel || "the runner default"}
      inheritedAccount={projectAccountSlug(selected)}
      defaultBranch={projectBaseBranch(selected)}
      onSubmit={(input) => createCardMutation.mutate(input)}
    />
  ) : null;

  /* ------------------------------------------------------------ focus mode */

  if (selected && cardId) {
    return (
      <div
        data-testid="focus-layout"
        className="flex min-h-[420px] items-stretch gap-2 px-1.5 py-1.5"
        style={{ height: focusHeight(FOCUS_CHROME_PX) }}
      >
        <CardListSidebar
          project={selected}
          activeCardId={cardId}
          onBack={() => go(selected.id)}
          onOpenCard={(id) => go(selected.id, id)}
          onNewCard={() => setNewCardOpen(true)}
        />

        {/* Same list, as a drawer, on the screens where the column above is hidden. Every action
            closes it: on a phone the drawer covers the terminal you just asked to see. */}
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="w-72 lg:hidden">
            <SheetTitle className="sr-only">Cards</SheetTitle>
            <CardListNav
              project={selected}
              activeCardId={cardId}
              onBack={() => {
                setMenuOpen(false);
                go(selected.id);
              }}
              onOpenCard={(id) => {
                setMenuOpen(false);
                go(selected.id, id);
              }}
              onNewCard={() => {
                setMenuOpen(false);
                setNewCardOpen(true);
              }}
            />
          </SheetContent>
        </Sheet>

        {/* Keyed by card: switching cards tears the socket down and opens the next one cleanly. */}
        <CardTerminalView
          key={cardId}
          project={selected}
          cardId={cardId}
          onBack={() => go(selected.id)}
          onNewCard={() => setNewCardOpen(true)}
          onOpenMenu={() => setMenuOpen(true)}
        />
        {newCardDialog}
      </div>
    );
  }

  /* ----------------------------------------------------------------- board */

  return (
    <div className="flex min-h-0 flex-col gap-4 px-4 py-4">
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : projects.length === 0 ? (
        <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-lg border border-border/80 bg-card/70 p-10 text-center backdrop-blur-sm">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
            <Code2 className="h-5 w-5" />
          </div>
          <div>
            <p className="font-medium">No projects yet</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Point a project at a repository and every card becomes a Claude terminal in its own
              worktree.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => setNewProjectOpen(true)}>
              <Plus /> Create the first project
            </Button>
            <RunnerBanner />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-4 lg:flex-row lg:items-stretch">
          <ProjectSidebar
            projects={projects}
            selectedId={selected?.id ?? null}
            onSelect={(id) => go(id)}
            onReorder={(id, position) => reorderMutation.mutate({ id, position })}
            onNewProject={() => setNewProjectOpen(true)}
            onDeleteProject={setDeleteTarget}
          />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selected && !allProjects ? (
              <KanbanBoard
                project={selected}
                onOpenCard={(card) => go(selected.id, card.id)}
                onNewCard={() => setNewCardOpen(true)}
                headerExtra={headerExtra}
              />
            ) : (
              // No project selected is not a dead end: show every project's cards on one board.
              <AllProjectsBoard
                projects={projects}
                onOpenCard={(card) => go(card.projectId, card.id)}
                headerExtra={headerExtra}
              />
            )}
          </div>
        </div>
      )}

      <ProjectFormDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        onCreated={(project) => go(project.id)}
      />

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{deleteTarget?.name}”?</DialogTitle>
            <DialogDescription>
              Every card in this project goes with it: their sessions are killed and their worktrees
              are dropped. Branches and commits stay in the repository.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteProjectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteProjectMutation.isPending}
              onClick={() => deleteTarget && deleteProjectMutation.mutate(deleteTarget.id)}
            >
              {deleteProjectMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {newCardDialog}
    </div>
  );
}

export default BoardPage;
