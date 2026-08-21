import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
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
import { CardTile } from "@/features/board/components/CardTile";
import { COLUMNS, groupByColumn, moveCardLocal, nextPosition } from "@/features/board/lib/board";
import { boardTitle, useDocumentTitle } from "@/features/board/lib/documentTitle";
import {
  ACCOUNTS_KEY,
  accountLabel,
  boardApi,
  cardsKey,
  projectAccountSlug,
  type BoardCard,
  type BoardProject,
} from "@/features/board/api";
import type { CardColumn } from "@/api/types";

/**
 * The board of one project.
 *
 * It POLLS, because two of the five columns are written by the runner: the Claude hooks report
 * `working`/`waiting` to the server, which moves the card. Nothing here ever infers a column from a
 * status — the front-end renders what the server says, so a card that moves on its own is the
 * server having moved it, and dragging is just a PATCH.
 *
 * Moving to Done is always a manual act. It gets an undo toast rather than a confirmation dialog:
 * finishing a card is cheap to reverse, and a modal for it would be noise fifty times a day.
 */
export function KanbanBoard({
  project,
  onOpenCard,
  onNewCard,
  headerExtra,
}: {
  project: BoardProject;
  onOpenCard: (card: BoardCard) => void;
  onNewCard: () => void;
  headerExtra?: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const boardKey = cardsKey(project.id);
  useDocumentTitle(boardTitle(project.name));

  const { data: cards, isLoading } = useQuery({
    queryKey: boardKey,
    queryFn: () => boardApi.listCards(project.id),
    refetchInterval: 5_000,
  });

  const { data: accountsData } = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: boardApi.listAccounts });
  const inheritedAccount = React.useMemo(() => {
    const slug = projectAccountSlug(project);
    if (!slug) return undefined;
    const account = accountsData?.accounts.find((a) => a.slug === slug);
    return account ? accountLabel(account) : slug;
  }, [project, accountsData]);

  const [dragging, setDragging] = React.useState<BoardCard | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<BoardCard | null>(null);

  const moveMutation = useMutation({
    mutationFn: ({ id, column, position }: { id: string; column: CardColumn; position: number }) =>
      boardApi.patchCard(id, { column, position }),
    // Optimistic: without it the card snaps back to its old column on the next poll, which reads as
    // the app fighting the user.
    onMutate: async ({ id, column, position }) => {
      await queryClient.cancelQueries({ queryKey: boardKey });
      const previous = queryClient.getQueryData<BoardCard[]>(boardKey);
      if (previous) queryClient.setQueryData(boardKey, moveCardLocal(previous, id, column, position));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(boardKey, context.previous);
      toast.error(apiErrorMessage(error, "Could not move the card"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: boardKey }),
  });

  const pauseMutation = useMutation({
    mutationFn: (id: string) => boardApi.pauseCard(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success("Paused — reopening the card resumes the same conversation.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not pause the card")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => boardApi.deleteCard(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success("Card deleted.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not delete the card")),
  });

  const groups = groupByColumn(cards ?? []);
  const total = (cards ?? []).length;

  function dropOn(column: CardColumn) {
    const card = dragging;
    setDragging(null);
    if (!card || card.column === column) return;
    moveMutation.mutate({ id: card.id, column, position: nextPosition(cards ?? [], column) });
  }

  function finish(card: BoardCard) {
    const previous = { column: card.column, position: card.position ?? 0 };
    moveMutation.mutate({ id: card.id, column: "done", position: nextPosition(cards ?? [], "done") });
    toast.success(`“${card.title}” finished.`, {
      action: { label: "Undo", onClick: () => moveMutation.mutate({ id: card.id, ...previous }) },
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">{project.name}</h1>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {total} {total === 1 ? "card" : "cards"}
          </p>
        </div>
        {headerExtra}
        <Button size="sm" className="h-8" onClick={onNewCard}>
          <Plus /> New card
          <span className="kbd ml-1">⌘K</span>
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          {COLUMNS.map((column) => (
            <ColumnZone
              key={column.key}
              column={column.key}
              label={column.label}
              hint={column.hint}
              count={groups[column.key].length}
              active={Boolean(dragging) && dragging?.column !== column.key}
              onDrop={() => dropOn(column.key)}
            >
              {groups[column.key].map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  accountLabel={card.accountSlug ?? inheritedAccount}
                  onOpen={onOpenCard}
                  onDone={finish}
                  onPause={(c) => pauseMutation.mutate(c.id)}
                  onDelete={setDeleteTarget}
                  onDragStart={setDragging}
                  onDragEnd={() => setDragging(null)}
                />
              ))}
              {groups[column.key].length === 0 ? (
                <p className="px-1 py-2 text-center text-[11px] text-muted-foreground/60">empty</p>
              ) : null}
            </ColumnZone>
          ))}
        </div>
      )}

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{deleteTarget?.title}”?</DialogTitle>
            <DialogDescription>
              The session is killed and the worktree is dropped. The branch and any commits stay in
              the repository — only uncommitted work in the worktree is lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              {deleteMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Background tint per column. It is a BACKGROUND, not a traffic light: the tints are barely there,
 * enough to tell the columns apart at a glance without shouting. `bg` is kept separate from the
 * border because the drag-over highlight replaces it, and two competing `bg-` classes would win in
 * whichever order Tailwind emitted them.
 */
const COLUMN_TONE: Record<CardColumn, { border: string; bg: string; title: string }> = {
  backlog: { border: "border-border/70", bg: "bg-muted/20", title: "text-muted-foreground" },
  waiting: { border: "border-amber-500/25", bg: "bg-amber-500/[0.06]", title: "text-amber-400/90" },
  working: { border: "border-emerald-500/20", bg: "bg-emerald-500/[0.06]", title: "text-emerald-400/90" },
  paused: { border: "border-sky-500/20", bg: "bg-sky-500/[0.05]", title: "text-sky-400/80" },
  done: { border: "border-border/50", bg: "bg-card/30", title: "text-muted-foreground/60" },
};

/** A column: a header plus a drop zone that lights up when a card from elsewhere hovers it. */
export function ColumnZone({
  column,
  label,
  hint,
  count,
  active,
  onDrop,
  children,
}: {
  column: CardColumn;
  label: string;
  hint: string;
  count: number;
  active: boolean;
  onDrop: () => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = React.useState(false);
  const tone = COLUMN_TONE[column];
  return (
    <section
      aria-label={label}
      data-column={column}
      onDragOver={
        active
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          : undefined
      }
      onDragEnter={
        active
          ? (e) => {
              e.preventDefault();
              setOver(true);
            }
          : undefined
      }
      onDragLeave={
        active
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
            }
          : undefined
      }
      onDrop={
        active
          ? (e) => {
              e.preventDefault();
              setOver(false);
              onDrop();
            }
          : undefined
      }
      className={cn(
        "flex min-h-40 min-w-0 flex-col gap-2 overflow-y-auto rounded-xl border p-2 backdrop-blur-sm transition-colors",
        tone.border,
        active && over ? "bg-primary/10 ring-2 ring-primary/40" : tone.bg,
      )}
    >
      <header className="flex items-center justify-between px-1 pt-0.5" title={hint}>
        <h2 className={cn("text-[11px] font-semibold uppercase tracking-wider", tone.title)}>{label}</h2>
        <span className="text-[10px] text-muted-foreground/70">{count}</span>
      </header>
      {children}
    </section>
  );
}
