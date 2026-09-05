import {
  cardMoveEffect, getCard, getProject, updateCard,
  type BoardColumn, type Card,
} from "../services/board/registry.js";
import { logger } from "../utils/logger.js";

/**
 * MOVING CARDS ON THE BOARD, from an agent — the tool behind `vibehub_move_cards`.
 *
 * The maestro could already do everything around a card (run its gate, deliver it, announce a
 * preview, type into it) except the one thing that CLOSES it: put it in `done`. So a board full of
 * merged work had to be tidied up by hand, card by card. This is that missing verb.
 *
 * WHY A LIST OF COLUMNS AND NOT A `card_done`: "conclude it" is not the only move worth having
 * (sending a card back to the backlog is the same gesture in reverse), and a tool per column is how
 * an MCP surface bloats. One verb, an explicit target.
 *
 * WHY ONLY `backlog` AND `done`: a column is not a label — see `cardMoveEffect` in the registry.
 * Moving INTO `paused` really pauses (killing the tmux session, or arming a PENDING pause when
 * Claude is mid-task) and moving into a LIVE column (`waiting`/`working`) really resumes, spending a
 * round trip to the runner to bring a Claude process back. Those are lifecycle acts with a cost and
 * with a protocol (see PATCH /api/cards/:id), and a BULK tool that can trigger them ten times by
 * accident is precisely the accident worth designing out. `backlog` and `done` are the two columns
 * where `cardMoveEffect` is provably `none` — the move writes the record and nothing else — and they
 * are exactly the two a maestro has business deciding on. Pausing and resuming stay a deliberate act
 * on the board (or on the session routes).
 *
 * `done` is also STICKY (the mirror rule): once the card is there, no hook status takes it out — a
 * conclusion is a human/agent decision, never something a terminal's noise undoes. That is what
 * makes this tool safe to run over ten cards at once.
 *
 * Pure decisions (which column is allowed, which ids to act on, whether the caller may touch a card)
 * are separated from the I/O below, so the rules are testable without a board on disk.
 */

/* ------------------------------------------------------------------ pure */

/**
 * The columns an AGENT may move a card into: the ones with NO session effect. Anything else is
 * refused for the whole call — a mistyped target is a mistake about the intent, not about one card.
 */
export const AGENT_MOVABLE_COLUMNS: readonly BoardColumn[] = ["backlog", "done"] as const;

/** How many cards one call may carry. Ten is the real case; this is only a sanity ceiling. */
export const MOVE_BATCH_MAX = 50;

/** A column this tool is allowed to move cards into. THROWS otherwise, saying why. PURE. */
export function assertMovableColumn(column: string): BoardColumn {
  const v = String(column ?? "").trim();
  if (!(AGENT_MOVABLE_COLUMNS as readonly string[]).includes(v)) {
    throw new Error(
      `invalid column '${column}' — this tool only moves cards to ${AGENT_MOVABLE_COLUMNS.join(" or ")}. ` +
      "'paused', 'waiting' and 'working' kill or start the card's Claude session, so they stay a " +
      "deliberate act on the board.",
    );
  }
  return v as BoardColumn;
}

/**
 * The card ids to act on: trimmed, empties dropped, DEDUPED keeping the given order (the same id
 * twice would otherwise report two contradictory outcomes for one card). THROWS on an empty list or
 * on more than {@link MOVE_BATCH_MAX}. PURE.
 */
export function normalizeCardIds(cards: readonly string[] | undefined | null): string[] {
  const seen = new Set<string>();
  for (const raw of cards ?? []) {
    const id = String(raw ?? "").trim();
    if (id) seen.add(id);
  }
  const ids = [...seen];
  if (ids.length === 0) throw new Error("no cards given — pass at least one card id");
  if (ids.length > MOVE_BATCH_MAX) {
    throw new Error(`too many cards (${ids.length}) — at most ${MOVE_BATCH_MAX} per call`);
  }
  return ids;
}

/**
 * AUTHORIZATION, agent-side: an agent acts from its OWN card, and its reach is its own PROJECT —
 * the same scope the maestro persona sets for coordinating terminals. Returns the refusal message,
 * or null when the move is allowed. No caller (the owner's own browser session on the MCP endpoint,
 * which is not a card at all) = the whole board, exactly like the UI. PURE.
 */
export function accessError(
  caller: Pick<Card, "projectId"> | undefined,
  target: Pick<Card, "projectId">,
): string | null {
  if (!caller || caller.projectId === target.projectId) return null;
  return "card belongs to another project — you can only move cards of your own project";
}

/* -------------------------------------------------------------------- I/O */

/** What happened to ONE card. `ok:false` carries `error` and nothing was written for that card. */
export interface CardMoveOutcome {
  cardId: string;
  ok: boolean;
  title?: string;
  project?: string;
  /** The column the card came from (present whenever the card was found). */
  was?: BoardColumn;
  /** Where it is now. */
  column?: BoardColumn;
  /** false = it was already in the target column, so nothing was written (the call is idempotent). */
  changed?: boolean;
  error?: string;
}

export interface MoveCardsResult {
  column: BoardColumn;
  /** Cards that actually changed column. */
  moved: number;
  /** Cards that were already there. */
  unchanged: number;
  failed: number;
  results: CardMoveOutcome[];
}

export interface MoveCardsOptions {
  /** The CALLER's own card id ($VIBEHUB_CARD_ID). Scopes the move to that card's project. */
  from?: string;
  /** true = the caller is a card and must identify itself (a browser/owner caller need not). */
  requireFrom?: boolean;
  /** Who is doing it, for the audit log. */
  by?: string;
}

/**
 * Moves every card in `cards` to `column`, ONE BY ONE and independently: a card that does not exist,
 * or that belongs to another project, fails on its own line and the rest still move. The batch as a
 * whole only aborts on something that would make every card fail the same way — an unusable target
 * column, an empty list, or a caller that cannot be identified.
 *
 * Sequential on purpose: `updateCard` renumbers the positions of both columns, and running the moves
 * in parallel would only interleave those renumberings for no gain (the store serializes writes
 * anyway).
 */
export async function moveCards(
  cards: readonly string[] | undefined | null,
  column: string,
  opts: MoveCardsOptions = {},
): Promise<MoveCardsResult> {
  const target = assertMovableColumn(column);
  const ids = normalizeCardIds(cards);

  // The caller's identity is resolved ONCE, before any write: if `from` names nothing, every card
  // would be refused for the same reason, and reporting that ten times helps nobody.
  const fromId = String(opts.from ?? "").trim();
  if (!fromId && opts.requireFrom) {
    throw new Error("pass `from` — your own card id (the $VIBEHUB_CARD_ID of this terminal)");
  }
  let caller: Card | undefined;
  if (fromId) {
    caller = await getCard(fromId);
    if (!caller) throw new Error(`caller card not found: '${fromId}' — pass your own $VIBEHUB_CARD_ID in \`from\``);
  }

  const projectNames = new Map<string, string>();
  const results: CardMoveOutcome[] = [];

  for (const cardId of ids) {
    try {
      const live = await getCard(cardId);
      if (!live) {
        results.push({ cardId, ok: false, error: "card not found" });
        continue;
      }
      // SNAPSHOT: `getCard` hands back the live cached record and `updateCard` mutates that very
      // object, so a "before" that is not copied is really the "after" (the same trap PATCH
      // /api/cards/:id documents) — both the effect check and `was` would then read the new column.
      const before: Card = { ...live };

      const refusal = accessError(caller, before);
      if (refusal) {
        results.push({ cardId, ok: false, title: before.title, was: before.column, error: refusal });
        continue;
      }

      if (!projectNames.has(before.projectId)) {
        projectNames.set(before.projectId, (await getProject(before.projectId))?.name ?? "");
      }
      const project = projectNames.get(before.projectId) || undefined;

      // BELT on the whitelist: the registry decides what a move does to the runner, so we ask it
      // rather than trusting the list above to stay right. Anything that would pause or resume a
      // session is refused here instead of being half-applied — this tool never touches a session.
      const effect = cardMoveEffect(before, { column: target });
      if (effect !== "none") {
        results.push({
          cardId, ok: false, title: before.title, project, was: before.column,
          error: `moving this card to '${target}' would ${effect} its session — use the board (or the session routes) for that`,
        });
        continue;
      }

      if (before.column === target) {
        // Already there: report it as a success that changed nothing, so re-running a batch after a
        // partial failure is harmless.
        results.push({ cardId, ok: true, title: before.title, project, was: before.column, column: target, changed: false });
        continue;
      }

      const card = await updateCard(cardId, { column: target });
      logger.info(
        { audit: true, action: "card.move", card: card.worktreeSlug, from: before.column, to: target, by: opts.by },
        "card moved between columns by an agent",
      );
      results.push({ cardId, ok: true, title: card.title, project, was: before.column, column: card.column, changed: true });
    } catch (err) {
      // One card's failure never takes the batch down — that is the whole point of the list form.
      results.push({ cardId, ok: false, error: (err as Error).message });
    }
  }

  return {
    column: target,
    moved: results.filter((r) => r.ok && r.changed).length,
    unchanged: results.filter((r) => r.ok && !r.changed).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
