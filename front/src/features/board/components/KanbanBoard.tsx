import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/lib/useIsMobile";
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
  MarqueeSelect,
  useClearSelectionOnEscape,
} from "@/features/board/components/MarqueeSelect";
import {
  orderByBoard,
  planGroupDrop,
  setGroupDragGhost,
  toggleId,
} from "@/features/board/lib/selection";
import {
  columnHint,
  columnLabel,
  dropPosition,
  groupByColumn,
  isBelowMidpoint,
  moveCardLocal,
  nextPosition,
} from "@/features/board/lib/board";
import {
  MOBILE_COLUMNS,
  hiddenCount,
  useExpandedColumns,
  visibleColumns,
} from "@/features/board/lib/mobileColumns";
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
import { useAuth } from "@/providers/auth";
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
  onNewBacklogCard,
  headerExtra,
  headerLead,
}: {
  project: BoardProject;
  onOpenCard: (card: BoardCard) => void;
  /** The prominent "New card" button: jots the card down AND opens it. */
  onNewCard: () => void;
  /** The Backlog column's "+": jots a card down without leaving the board. */
  onNewBacklogCard: () => void;
  headerExtra?: React.ReactNode;
  /** Rendered FIRST in the header row — where the phone's drawer handle lives. */
  headerLead?: React.ReactNode;
}) {
  const t = useT();
  // Creating and deleting cards is the OWNER's (the routes answer 403 to a member); a member gets
  // the board of what was shared, and works inside those cards.
  const { isOwner } = useAuth();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useExpandedColumns();
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
  /**
   * Where the card being dragged would land: a column and a GAP index in it (0 = above the first
   * card, n = below the last). It is what draws the insertion line, and it is the only thing the
   * drop needs to know — the column alone could never express "third, not last".
   */
  const [dropAt, setDropAt] = React.useState<{ column: CardColumn; gap: number } | null>(null);
  /**
   * Multi-selection: the ids currently ringed. Pure UI state — it lives here, persists nowhere, and
   * exists for one purpose: dragging any selected card drags them ALL. Filled by the marquee (a
   * drag on empty board) or by shift-clicking cards; emptied by Esc, a plain click anywhere, or
   * opening a card.
   */
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);
  const replaceSelection = React.useCallback((ids: string[]) => setSelected(new Set(ids)), []);
  useClearSelectionOnEscape(selected.size > 0, clearSelection);
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

  /**
   * Hibernate: closes the terminal and leaves the card exactly where it is. What the idle sweep does
   * on its own, available on the spot for a conversation you already know you are done with today.
   */
  const hibernateMutation = useMutation({
    mutationFn: (id: string) => boardApi.hibernateCard(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success(translate("toast.cardHibernated"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardHibernateError"))),
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

  const clearDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

  /**
   * Drops the dragged card into `column` at `gap`.
   *
   * REORDERING INSIDE a column is the same gesture as moving between them — the difference is only
   * that the card is already in the destination list, so its own index has to come out of the
   * arithmetic (`dropPosition`). It used to bail out whenever the column had not changed, which is
   * exactly why dragging a card up its own column did nothing at all.
   */
  /**
   * A drag begins. On a SELECTED card it is a bulk move — the ghost becomes a pill with the head
   * count so the hand knows what it is holding. On any other card it is the ordinary single drag,
   * and it dissolves whatever selection was standing: the gesture said "this one", not "these".
   */
  function startDrag(card: BoardCard, e: React.DragEvent) {
    if (selected.has(card.id) && selected.size > 1) {
      setGroupDragGhost(e.dataTransfer, translate("board.dragCount", { n: selected.size }));
    } else if (selected.size > 0) {
      clearSelection();
    }
    setDragging(card);
  }

  function dropOn(column: CardColumn, gap: number) {
    const card = dragging;
    clearDrag();
    if (!card) return;
    // Bulk drop: every selected card lands at the gap as one block, board order preserved. Each
    // step is the SAME PATCH a lone drag sends, applied in order (awaited: the plan's positions
    // assume sequential splicing, and so do the column rules — pausing, finishing — per card).
    if (selected.has(card.id) && selected.size > 1) {
      const moving = orderByBoard(cards ?? [], selected);
      const steps = planGroupDrop(groups[column].map((c) => c.id), moving.map((c) => c.id), gap);
      void (async () => {
        for (const step of steps) {
          try {
            await moveMutation.mutateAsync({ id: step.id, column, position: step.position });
          } catch {
            break; // The toast told the story; the refetch re-syncs the board.
          }
        }
      })();
      return;
    }
    const ordered = groups[column];
    const from = ordered.findIndex((c) => c.id === card.id);
    const position = dropPosition(gap, from, ordered.length);
    if (position === null) return;
    moveMutation.mutate({ id: card.id, column, position });
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
        {headerLead}
        <span className="mr-auto text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("board.cards", { n: total })}
        </span>
        {headerExtra}
        {isOwner ? (
          <Button size="sm" className="h-9 gap-0" title={t("board.newCardHint")} onClick={onNewCard}>
            <Plus className="mr-1.5 h-4 w-4" /> {t("board.newCard")}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        // Five equal columns side by side from `xl`; two at `md`; on a phone, Waiting and Working
        // with the rest behind "show more" (see `visibleColumns`). The marquee layer owns drags
        // that START on empty board; a drag starting on a card never reaches it.
        <MarqueeSelect enabled={!isMobile} onSelect={replaceSelection} onClear={clearSelection}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          {visibleColumns(isMobile, expanded).map((column, index) => (
            <React.Fragment key={column.key}>
              <ColumnZone
                column={column.key}
                label={columnLabel(column.key)}
                hint={columnHint(column.key)}
                count={groups[column.key].length}
                // ANY drag makes every column a target now, its own included: dropping a card back
                // into the column it came from is how you reorder it.
                active={Boolean(dragging)}
                // The wash of colour is for a card CHANGING column. Inside its own column the thin
                // insertion line says everything, and tinting the whole column for a reorder is a
                // lot of screen shouting about a small move.
                highlight={Boolean(dragging) && dragging?.column !== column.key}
                // Anywhere in the column that is not a card means "at the end".
                onDragOverEmpty={() => setDropAt({ column: column.key, gap: groups[column.key].length })}
                onDrop={() =>
                  dropOn(
                    column.key,
                    dropAt?.column === column.key ? dropAt.gap : groups[column.key].length,
                  )
                }
                onDragLeave={() => setDropAt((at) => (at?.column === column.key ? null : at))}
              >
                {column.key === "backlog" && isOwner ? (
                  // Jot a card down right where it lands — no dialog trip to the top button, and it
                  // stays on the board (no jump into the card) because you are still filling the list.
                  <button
                    type="button"
                    onClick={onNewBacklogCard}
                    className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/70 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" /> {t("board.addToBacklog")}
                  </button>
                ) : null}
                {groups[column.key].map((card, cardIndex) => (
                  <CardDropSlot
                    key={card.id}
                    active={Boolean(dragging)}
                    line={
                      dropAt?.column === column.key && dragging
                        ? insertionLine(dropAt.gap, cardIndex, groups[column.key].length)
                        : null
                    }
                    onDragOver={(below) =>
                      setDropAt({ column: column.key, gap: cardIndex + (below ? 1 : 0) })
                    }
                  >
                    <CardTile
                      card={card}
                      selected={selected.has(card.id)}
                      onToggleSelect={(c) => setSelected((s) => toggleId(s, c.id))}
                      onOpen={(c) => {
                        clearSelection();
                        onOpenCard(c);
                      }}
                      onDone={finish}
                      onPause={(c) => pauseMutation.mutate(c.id)}
                      onRestart={restart}
                      onHibernate={(c) => hibernateMutation.mutate(c.id)}
                      onAccount={(c) => {
                        setAccountChoice(c.accountSlug ?? "");
                        setAccountTarget(c);
                      }}
                      onDelete={setDeleteTarget}
                      onDragStart={startDrag}
                      onDragEnd={clearDrag}
                    />
                  </CardDropSlot>
                ))}
                {groups[column.key].length === 0 ? (
                  <p className="px-1 py-2 text-center text-[11px] text-muted-foreground/60">{t("board.empty")}</p>
                ) : null}
              </ColumnZone>
              {/* Sits between the two live columns and the rest, which is where the choice is. */}
              {isMobile && index === MOBILE_COLUMNS.length - 1 ? (
                <MoreColumnsToggle
                  expanded={expanded}
                  count={hiddenCount(groups)}
                  onToggle={() => setExpanded(!expanded)}
                />
              ) : null}
            </React.Fragment>
          ))}
        </div>
        </MarqueeSelect>
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
  highlight = true,
  onDragOverEmpty,
  onDragLeave,
  onDrop,
  children,
}: {
  column: CardColumn;
  label: string;
  hint: string;
  count: number;
  active: boolean;
  /** Wash the whole column while a card hovers it. Off for a card reordering inside its own column. */
  highlight?: boolean;
  /** The pointer is over the column but not over a card — the drop lands at the END. */
  onDragOverEmpty?: () => void;
  onDragLeave?: () => void;
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
              // Only fires for the gaps BETWEEN cards and the empty space below them: the slot each
              // card sits in stops the event before it gets here.
              onDragOverEmpty?.();
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
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setOver(false);
                onDragLeave?.();
              }
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
        active && over && highlight ? "bg-primary/10 ring-2 ring-primary/40" : tone.bg,
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


/**
 * The strip one card occupies while a drag is in flight.
 *
 * It exists for one reason: to say WHERE between two cards the drop would land. Halfway down the
 * card is the seam — above it the card goes before this one, below it after — and the blue line
 * follows the pointer across that seam. Without it a column can only ever be dropped INTO, which
 * is why reordering used to be impossible: the board had no way to hear "third, not last".
 *
 * It stops the dragover event, or the column behind it would immediately answer "at the end".
 */
export function CardDropSlot({
  active,
  line,
  onDragOver,
  children,
}: {
  active: boolean;
  line: "top" | "bottom" | null;
  onDragOver: (below: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative"
      onDragOver={
        active
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              onDragOver(isBelowMidpoint(e.clientY, rect.top, rect.height));
            }
          : undefined
      }
    >
      {line ? (
        <span
          aria-hidden
          data-drop-line={line}
          className={cn(
            "pointer-events-none absolute inset-x-0 z-20 h-0.5 rounded-full bg-primary",
            // Half the 0.5rem column gap, so the line sits in the middle of the seam rather than
            // on top of one of the two cards.
            line === "top" ? "-top-1" : "-bottom-1",
          )}
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * Which edge of card `index` the insertion line is drawn on, if any. PURE.
 *
 * A gap is drawn as the BOTTOM edge of the card above it, so consecutive cards never both claim the
 * same seam; gap 0 is the only one with no card above it, and it takes the first card's top edge.
 */
export function insertionLine(gap: number, index: number, length: number): "top" | "bottom" | null {
  if (gap <= 0) return index === 0 ? "top" : null;
  if (gap >= length) return index === length - 1 ? "bottom" : null;
  return gap - 1 === index ? "bottom" : null;
}

/**
 * The phone board's "show more" — the one control that reveals Paused, Backlog and Done.
 *
 * Full width and inside the grid, so it reads as the seam between the two columns you came for and
 * the three you asked for, rather than as a header action. The count is on the button because a
 * disclosure with nothing behind it is worth knowing about BEFORE tapping it.
 */
export function MoreColumnsToggle({
  expanded,
  count,
  onToggle,
}: {
  expanded: boolean;
  count: number;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full justify-center gap-1.5 text-xs"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      {expanded ? t("board.showLess") : t("board.showMore", { n: count })}
    </Button>
  );
}
