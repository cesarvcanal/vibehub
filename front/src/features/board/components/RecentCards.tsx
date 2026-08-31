import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Pause } from "lucide-react";
import { cn, isNewTabClick } from "@/lib/utils";
import { SELECTED_ROW, cardDot, cardHref, dotClass, recentCards } from "@/features/board/lib/board";
import { ALL_CARDS_KEY, boardApi, type BoardCard, type BoardProject } from "@/features/board/api";
import { useT } from "@/i18n";

/**
 * The last conversations you were in — the top of the sidebar, above the projects.
 *
 * The projects list answers "what am I working on"; this answers "where was I two minutes ago", and
 * they are not the same question. With one terminal per card spread over several repositories, going
 * back to the thread you just left meant remembering which project owned it, selecting that project,
 * and finding the card — three steps to reach something you had open a moment ago. So EVERY
 * conversation sits here, ACROSS projects, newest first, with the project's name under each title,
 * and they stay on screen while a terminal is open: from inside one conversation the next one is one
 * click. The list scrolls inside its own bounded box rather than pushing the projects off screen —
 * the last handful is what you reach for, the rest is one wheel-turn away.
 *
 * It reads `GET /api/cards` — one request for every card in the install, rather than one poll per
 * project — on a slower interval than the board itself. This list is a way back, not a monitor: the
 * dot on it is a courtesy, and the board is where you watch things happen.
 *
 * Empty means GONE, not an empty box: a fresh install has no conversations to go back to, and a
 * heading over nothing is a heading you learn to ignore.
 */
export function RecentCards({
  projects,
  activeCardId,
  onOpenCard,
}: {
  projects: BoardProject[];
  /** The card whose terminal is open, when one is — it is highlighted, exactly like in the list below. */
  activeCardId: string | null;
  onOpenCard: (projectId: string, cardId: string) => void;
}) {
  const t = useT();

  const { data: cards } = useQuery({
    queryKey: ALL_CARDS_KEY,
    queryFn: boardApi.listAllCards,
    // 6s, not the board's 2s: nothing here is being watched, and this poll runs on every screen,
    // including inside a terminal, where the terminal's own socket is what has to stay smooth.
    refetchInterval: 6_000,
  });

  const projectName = React.useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );

  // A card whose project has been deleted is not a place you can go back to: the board reads its
  // location from a project id that no longer resolves.
  const recent = React.useMemo(
    () => recentCards(cards ?? []).filter((c) => projectName.has(c.projectId)),
    [cards, projectName],
  );

  if (recent.length === 0) return null;

  return (
    <div data-testid="recent-cards" className="shrink-0 border-b border-border/60">
      <div className="px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("sidebar.recent")}
        </span>
      </div>
      {/* Bounded and scrollable: the full history lives here, and the box must not squeeze the
          project list below it out of the panel. `overscroll-contain` keeps a wheel that reaches
          the end from scrolling the page behind it. */}
      <div data-testid="recent-cards-list" className="max-h-[40dvh] overflow-y-auto overscroll-contain pb-1.5">
        {recent.map((card) => (
          <RecentRow
            key={card.id}
            card={card}
            project={projectName.get(card.projectId) ?? ""}
            active={card.id === activeCardId}
            onOpen={() => onOpenCard(card.projectId, card.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One conversation: the dot, the title, and the project it belongs to underneath.
 *
 * The project line is the whole reason this list works — without it the five rows are five titles
 * with no idea where they live, and picking the right one becomes a guess. A real link, like every
 * other card row, so Cmd/Ctrl-click and "copy link" behave.
 */
function RecentRow({
  card,
  project,
  active,
  onOpen,
}: {
  card: BoardCard;
  project: string;
  active: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const dot = cardDot(card);
  const paused = Boolean(card.pausedAt);

  return (
    <a
      href={cardHref(card.projectId, card.id)}
      title={`${card.title}\n${project}`}
      aria-current={active ? "true" : undefined}
      onClick={(e) => {
        if (isNewTabClick(e)) return;
        e.preventDefault();
        onOpen();
      }}
      className={cn(
        "flex w-full items-start gap-2 py-1 pl-3 pr-3 text-left transition-colors",
        active
          ? `${SELECTED_ROW} text-foreground`
          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
      )}
    >
      <span
        title={paused ? t("status.paused") : dot?.label}
        className="mt-1.5 inline-flex h-2 w-2 shrink-0 items-center justify-center"
      >
        {paused ? (
          <Pause aria-hidden className="h-2.5 w-2.5 text-muted-foreground/70" />
        ) : dot ? (
          // No `role`/`aria-label` here: this span sits INSIDE the link, and an accessible name on
          // it becomes part of the link's own name. The title carries the meaning for the mouse.
          <span
            data-tone={dot.tone}
            className={cn("inline-block h-2 w-2 rounded-full", dotClass(dot.tone), dot.live && "dot-live")}
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-snug">{card.title}</span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground/70">{project}</span>
      </span>
    </a>
  );
}
