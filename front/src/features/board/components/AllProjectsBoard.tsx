import * as React from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/lib/useIsMobile";
import { CardTile } from "@/features/board/components/CardTile";
import { ColumnZone, MoreColumnsToggle } from "@/features/board/components/KanbanBoard";
import {
  MarqueeSelect,
  useClearSelectionOnEscape,
} from "@/features/board/components/MarqueeSelect";
import {
  orderByBoard,
  planGroupDropByProject,
  setGroupDragGhost,
  toggleId,
} from "@/features/board/lib/selection";
import {
  columnHint,
  columnLabel,
  groupByColumn,
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
import { boardApi, cardsKey, type BoardCard, type BoardProject } from "@/features/board/api";
import type { CardColumn } from "@/api/types";
import { t as translate, useT } from "@/i18n";

/**
 * Every project's cards on one board.
 *
 * With one terminal per card and a handful of repositories, the question you actually have is
 * "which agent needs me", not "which of my projects has an agent that needs me" — and answering it
 * by clicking through projects one at a time is how a waiting card goes unnoticed. So the five
 * columns are the same five columns, filled from all projects at once, and each card carries its
 * project's name as a chip.
 *
 * It reuses the SAME per-project query keys the single-project board uses (`useQueries`, one per
 * project, same 2s poll), so both views read one cache: nothing double-fetches, and a card moved
 * here is already moved when you open that project.
 *
 * Dragging works across columns and routes by `card.projectId`: positions are per-project, so both
 * the PATCH and the optimistic update land in the owning project's cache.
 *
 * The cards here are OPEN-ONLY: no `⋯` menu, no right-click actions. This view answers one question
 * — who needs me — and acting on a card is done where its context is, which is its own project's
 * board or its terminal. For the same reason there is no runner chip (there is no single runner to
 * report on) and no New card button (there is no project for it to belong to).
 */
export function AllProjectsBoard({
  projects,
  onOpenCard,
  onNewCard,
  headerExtra,
  headerLead,
}: {
  projects: BoardProject[];
  onOpenCard: (card: BoardCard) => void;
  /** New card from the aggregated board — no project is implied, so the dialog asks which. */
  /** Absent = this person may not create cards (a member): the button is not drawn. */
  onNewCard?: () => void;
  headerExtra?: React.ReactNode;
  /** Rendered FIRST in the header row — where the phone's drawer handle lives. */
  headerLead?: React.ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useExpandedColumns();
  // The aggregated board is not one project, so the tab is just the app.
  useDocumentTitle(boardTitle());

  const results = useQueries({
    queries: projects.map((project) => ({
      queryKey: cardsKey(project.id),
      queryFn: () => boardApi.listCards(project.id),
      refetchInterval: 2_000,
    })),
  });

  const isLoading = results.some((r) => r.isLoading);
  const cards = React.useMemo(() => results.flatMap((r) => r.data ?? []), [results]);

  const projectName = React.useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );

  // Positions live in the owning project's space, so a move has to be measured against that
  // project's cards only — never against the mixed list on screen.
  const byProject = React.useMemo(() => {
    const map = new Map<string, BoardCard[]>();
    for (const card of cards) {
      const list = map.get(card.projectId);
      if (list) list.push(card);
      else map.set(card.projectId, [card]);
    }
    return map;
  }, [cards]);

  const [dragging, setDragging] = React.useState<BoardCard | null>(null);
  /** Multi-selection, exactly as on the single-project board. See `KanbanBoard`. */
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);
  const replaceSelection = React.useCallback((ids: string[]) => setSelected(new Set(ids)), []);
  useClearSelectionOnEscape(selected.size > 0, clearSelection);

  const moveMutation = useMutation({
    mutationFn: ({ id, column, position }: MoveVars) => boardApi.patchCard(id, { column, position }),
    onMutate: async ({ id, projectId, column, position }) => {
      const key = cardsKey(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<BoardCard[]>(key);
      if (previous) queryClient.setQueryData(key, moveCardLocal(previous, id, column, position));
      return { previous, key };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(context.key, context.previous);
      toast.error(apiErrorMessage(error, translate("toast.cardMoveError")));
    },
    onSettled: (_data, _error, vars) =>
      queryClient.invalidateQueries({ queryKey: cardsKey(vars.projectId) }),
  });

  /** See `KanbanBoard.startDrag`: selected card = bulk drag with the head-count ghost. */
  function startDrag(card: BoardCard, e: React.DragEvent) {
    if (selected.has(card.id) && selected.size > 1) {
      setGroupDragGhost(e.dataTransfer, translate("board.dragCount", { n: selected.size }));
    } else if (selected.size > 0) {
      clearSelection();
    }
    setDragging(card);
  }

  function dropOn(column: CardColumn) {
    const card = dragging;
    setDragging(null);
    if (!card) return;
    // Bulk drop: the group splits by PROJECT (positions are per-project) and each part lands at the
    // end of its own destination column, board order kept. One ordinary PATCH per card, in order.
    if (selected.has(card.id) && selected.size > 1) {
      const moving = orderByBoard(cards, selected).filter((c) => c.column !== column);
      const steps = planGroupDropByProject(cards, moving, column);
      void (async () => {
        for (const step of steps) {
          try {
            await moveMutation.mutateAsync({
              id: step.id,
              projectId: step.projectId,
              column,
              position: step.position,
            });
          } catch {
            break;
          }
        }
      })();
      return;
    }
    if (card.column === column) return;
    const siblings = byProject.get(card.projectId) ?? [];
    moveMutation.mutate({
      id: card.id,
      projectId: card.projectId,
      column,
      position: nextPosition(siblings, column),
    });
  }

  const groups = groupByColumn(cards);
  // A bulk drag can hold cards from several columns, so EVERY column is a target for it — the
  // dragged card's own included: the rest of the group still has somewhere to go.
  const bulkDragging = Boolean(dragging && selected.has(dragging.id) && selected.size > 1);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {headerLead}
        <span className="mr-auto text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("board.cards", { n: cards.length })} · {t("board.projects", { n: projects.length })}
        </span>
        {headerExtra}
        {onNewCard ? (
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
        <MarqueeSelect enabled={!isMobile} onSelect={replaceSelection} onClear={clearSelection}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          {visibleColumns(isMobile, expanded).map((column, index) => (
            <React.Fragment key={column.key}>
              <ColumnZone
                column={column.key}
                label={columnLabel(column.key)}
                hint={columnHint(column.key)}
                count={groups[column.key].length}
                active={Boolean(dragging) && (bulkDragging || dragging?.column !== column.key)}
                onDrop={() => dropOn(column.key)}
              >
                {groups[column.key].map((card) => (
                  <CardTile
                    key={card.id}
                    card={card}
                    projectLabel={projectName.get(card.projectId)}
                    selected={selected.has(card.id)}
                    onToggleSelect={(c) => setSelected((s) => toggleId(s, c.id))}
                    onOpen={(c) => {
                      clearSelection();
                      onOpenCard(c);
                    }}
                    onDragStart={startDrag}
                    onDragEnd={() => setDragging(null)}
                  />
                ))}
                {groups[column.key].length === 0 ? (
                  <p className="px-1 py-2 text-center text-[11px] text-muted-foreground/60">{t("board.empty")}</p>
                ) : null}
              </ColumnZone>
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
    </div>
  );
}

interface MoveVars {
  id: string;
  projectId: string;
  column: CardColumn;
  position: number;
}
