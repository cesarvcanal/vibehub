import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Pause, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SELECTED_ROW } from "@/features/board/components/ProjectSidebar";
import { splitSidebarCards, statusDot } from "@/features/board/lib/board";
import { boardApi, cardsKey, type BoardCard, type BoardProject } from "@/features/board/api";

/**
 * The narrow card list beside an open terminal.
 *
 * It is what makes several agents workable at once: the cards that are working or waiting are
 * always on screen, most recently touched first, so you can see who needs you and hop straight into
 * that terminal. Everything else hides behind "show more"; finished cards never appear.
 *
 * This is also the component that keeps the board query alive while a card is open, which is why
 * the terminal view can read the card straight from the cache instead of fetching it again.
 *
 * The content is separated from its frame because the same list has to appear in two places: as the
 * permanent column on a wide screen, and inside the mobile drawer, where the column is hidden. One
 * implementation, two frames — a second copy would be the one that drifts.
 */
export function CardListSidebar({
  project,
  activeCardId,
  onBack,
  onOpenCard,
  onNewCard,
}: {
  project: BoardProject;
  activeCardId: string;
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
  onNewCard: () => void;
}) {
  return (
    <aside
      aria-label="Cards"
      className="hidden w-56 shrink-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card/30 lg:flex"
    >
      <CardListNav
        project={project}
        activeCardId={activeCardId}
        onBack={onBack}
        onOpenCard={onOpenCard}
        onNewCard={onNewCard}
      />
    </aside>
  );
}

/**
 * The list itself, with no frame of its own — rendered inside the desktop `<aside>` above and
 * inside the mobile drawer.
 */
export function CardListNav({
  project,
  activeCardId,
  onBack,
  onOpenCard,
  onNewCard,
}: {
  project: BoardProject;
  activeCardId: string;
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
  onNewCard: () => void;
}) {
  const { data: cards } = useQuery({
    queryKey: cardsKey(project.id),
    queryFn: () => boardApi.listCards(project.id),
    // 2s, not 5s: the dot is the one thing on screen that has to feel live. A card that just went
    // amber is a card asking for you, and three extra seconds of green reads as "still busy".
    refetchInterval: 2_000,
  });

  const [showMore, setShowMore] = React.useState(false);
  const { active, idle } = splitSidebarCards(cards ?? []);

  // The open card is always listed, even if it has been finished — otherwise the one terminal you
  // are actually looking at is the one card you cannot see.
  const openCard = (cards ?? []).find((c) => c.id === activeCardId);
  const listed =
    openCard && !active.some((c) => c.id === openCard.id) && !idle.some((c) => c.id === openCard.id)
      ? [openCard, ...active]
      : active;

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to board
      </button>

      <div className="flex items-center justify-between border-b border-border/60 py-1 pl-3 pr-1.5">
        <span
          title={project.name}
          className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          {project.name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="New card"
          title="New card (⌘K)"
          onClick={onNewCard}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {listed.map((card) => (
          <SidebarCard
            key={card.id}
            card={card}
            active={card.id === activeCardId}
            onOpen={() => onOpenCard(card.id)}
          />
        ))}
        {showMore
          ? idle.map((card) => (
              <SidebarCard
                key={card.id}
                card={card}
                active={card.id === activeCardId}
                onOpen={() => onOpenCard(card.id)}
              />
            ))
          : null}

        {idle.length > 0 ? (
          <button
            type="button"
            aria-expanded={showMore}
            onClick={() => setShowMore((v) => !v)}
            className="w-full px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 transition-colors hover:bg-card/60 hover:text-foreground"
          >
            {showMore ? "show less" : `show more (${idle.length})`}
          </button>
        ) : null}

        {listed.length === 0 && idle.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground/60">No active cards.</p>
        ) : null}
      </div>
    </>
  );
}

function SidebarCard({
  card,
  active,
  onOpen,
}: {
  card: BoardCard;
  active: boolean;
  onOpen: () => void;
}) {
  const dot = statusDot(card.status);
  const paused = Boolean(card.pausedAt);
  return (
    <button
      type="button"
      title={card.title}
      aria-current={active ? "true" : undefined}
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
        active
          ? `${SELECTED_ROW} text-foreground`
          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
      )}
    >
      <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center">
        {paused ? (
          <Pause aria-hidden className="h-2.5 w-2.5 text-muted-foreground/70" />
        ) : dot ? (
          <span
            aria-label={dot.label}
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              dot.tone === "ok" ? "bg-emerald-400" : "bg-amber-400",
              dot.live && "motion-safe:animate-[vh-pulse_1.6s_ease-in-out_infinite]",
            )}
          />
        ) : null}
      </span>
      <span className="truncate">{card.title}</span>
    </button>
  );
}
