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
import { Label } from "@/components/ui/label";
import { CardTile } from "@/features/board/components/CardTile";
import {
  COLUMNS,
  columnHint,
  columnLabel,
  groupByColumn,
  moveCardLocal,
  nextPosition,
} from "@/features/board/lib/board";
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
import { t as translate, useT } from "@/i18n";

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
 * Deleting keeps its dialog — uncommitted work in the worktree does not come back.
 *
 * The header says how many cards there are and nothing else. The project's NAME is not repeated
 * here: the sidebar beside it is showing which project is selected, in the same eyeful.
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
  const t = useT();
  const queryClient = useQueryClient();
  const boardKey = cardsKey(project.id);
  useDocumentTitle(boardTitle(project.name));

  const { data: cards, isLoading } = useQuery({
    queryKey: boardKey,
    queryFn: () => boardApi.listCards(project.id),
    // 2s, not 5s: the dot is the one thing on screen that has to feel live. A card that just went
    // amber is a card asking for you, and three extra seconds of green reads as "still busy".
    refetchInterval: 2_000,
  });

  const [dragging, setDragging] = React.useState<BoardCard | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<BoardCard | null>(null);
  // Switching a card's Claude account: the target card, plus the choice ("" = inherit).
  const [accountTarget, setAccountTarget] = React.useState<BoardCard | null>(null);
  const [accountChoice, setAccountChoice] = React.useState("");

  const { data: accountsData } = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: boardApi.listAccounts,
    enabled: Boolean(accountTarget),
  });

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
      toast.error(apiErrorMessage(error, translate("toast.cardMoveError")));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: boardKey }),
  });

  const pauseMutation = useMutation({
    mutationFn: (id: string) => boardApi.pauseCard(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success(translate("toast.cardPaused"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardPauseError"))),
  });

  /**
   * Restart: kills and recreates the session, same conversation. It is how a card picks up a new
   * brain or a new MCP without waiting to go idle, and — before this — the board had no way to ask
   * for it at all; you had to open the card first.
   */
  const restartMutation = useMutation({
    mutationFn: (id: string) => boardApi.restartCard(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success(translate("toast.cardRestarting"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardRestartError"))),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => boardApi.deleteCard(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success(translate("toast.cardDeleted"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardDeleteError"))),
  });

  /**
   * Switching the account PATCHes `accountSlug` ("" from the form becomes null = inherit). The
   * server kills the tmux session when the value actually changes; the next open recreates it with
   * the new profile's `CLAUDE_CONFIG_DIR`.
   */
  const accountMutation = useMutation({
    mutationFn: ({ id, accountSlug }: { id: string; accountSlug: string | null }) =>
      boardApi.patchCard(id, { accountSlug }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
      setAccountTarget(null);
      toast.success(translate("toast.cardAccountSwitched"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardAccountSwitchError"))),
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
    toast.success(translate("toast.cardFinished", { title: card.title }), {
      action: {
        label: translate("common.undo"),
        onClick: () => moveMutation.mutate({ id: card.id, ...previous }),
      },
    });
  }

  /** Restarting a card mid-turn throws away what it is in the middle of. Ask first. */
  function restart(card: BoardCard) {
    if (
      card.status === "working" &&
      !window.confirm(translate("confirm.restartWorking"))
    ) {
      return;
    }
    restartMutation.mutate(card.id);
  }

  const inheritedSlug = projectAccountSlug(project);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("board.cards", { n: total })}
        </span>
        {headerExtra}
        <Button size="sm" className="h-9 gap-0" title={t("board.newCardHint")} onClick={onNewCard}>
          <Plus className="mr-1.5 h-4 w-4" /> {t("board.newCard")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        // Five equal columns side by side from `xl`; two at `md`; one on a phone.
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          {COLUMNS.map((column) => (
            <ColumnZone
              key={column.key}
              column={column.key}
              label={columnLabel(column.key)}
              hint={columnHint(column.key)}
              count={groups[column.key].length}
              active={Boolean(dragging) && dragging?.column !== column.key}
              onDrop={() => dropOn(column.key)}
            >
              {groups[column.key].map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  onOpen={onOpenCard}
                  onDone={finish}
                  onPause={(c) => pauseMutation.mutate(c.id)}
                  onRestart={restart}
                  onAccount={(c) => {
                    setAccountChoice(c.accountSlug ?? "");
                    setAccountTarget(c);
                  }}
                  onDelete={setDeleteTarget}
                  onDragStart={setDragging}
                  onDragEnd={() => setDragging(null)}
                />
              ))}
              {groups[column.key].length === 0 ? (
                <p className="px-1 py-2 text-center text-[11px] text-muted-foreground/60">{t("board.empty")}</p>
              ) : null}
            </ColumnZone>
          ))}
        </div>
      )}

      {/* The card's Claude account. A dialog rather than a submenu: switching it ends the session
          that is running, which is not something to do by brushing past a menu item. */}
      <Dialog open={Boolean(accountTarget)} onOpenChange={(next) => !next && setAccountTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("kanban.accountDialog.title", { title: accountTarget?.title })}</DialogTitle>
            <DialogDescription>
              {t("kanban.accountDialog.body")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="card-account">{t("kanban.accountDialog.label")}</Label>
            <select
              id="card-account"
              value={accountChoice}
              onChange={(e) => setAccountChoice(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">
                {inheritedSlug
                  ? t("kanban.accountDialog.inherit", { slug: inheritedSlug })
                  : t("kanban.accountDialog.default", {
                      label: accountsData?.defaultLabel || t("kanban.accountDialog.runnerAccount"),
                    })}
              </option>
              {(accountsData?.accounts ?? []).map((account) => (
                <option key={account.slug} value={account.slug}>
                  {accountLabel(account)} ({account.slug})
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setAccountTarget(null)}
              disabled={accountMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={accountMutation.isPending || accountChoice === (accountTarget?.accountSlug ?? "")}
              onClick={() => {
                if (accountTarget) {
                  accountMutation.mutate({ id: accountTarget.id, accountSlug: accountChoice || null });
                }
              }}
            >
              {accountMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              {t("kanban.accountDialog.switch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("kanban.deleteCard.title", { title: deleteTarget?.title })}</DialogTitle>
            <DialogDescription>
              {t("kanban.deleteCard.body")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
              {t("common.cancel")}
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
              {t("common.delete")}
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

/**
 * A column: a header plus a drop zone that lights up when a card from elsewhere hovers it.
 *
 * It grows to the useful height of the viewport once the columns sit side by side, so an EMPTY
 * column is still a target you can hit — a 40px strip is not somewhere anyone can drop a card. The
 * column itself never scrolls: the page does, so a long Backlog pushes the page down instead of
 * hiding its own cards behind an inner scrollbar nobody notices.
 */
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
        "flex min-h-40 min-w-0 flex-col gap-2 rounded-xl border p-2 backdrop-blur-sm transition-colors md:min-h-[calc(100vh-19rem)]",
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
