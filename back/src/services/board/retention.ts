import * as registry from "./registry.js";
import type { Card } from "./registry.js";
import { purgeCard } from "./purge.js";
import { logger } from "../../utils/logger.js";

/**
 * THE DONE-CARD RETENTION — a card does not live in `done` forever.
 *
 * The problem it closes: `done` is the column nobody cleans. Cards pile up there by the dozen,
 * each one still holding, in the runner, a worktree, a `card/<slug>` branch, a Claude Code
 * transcript, a browser profile and a GitHub token, plus its conversation under the data dir. The
 * board becomes unreadable and the disk grows for work that was finished half a year ago.
 *
 * So after {@link DONE_RETENTION_DAYS} of TOTAL SILENCE in `done` the card is PURGED — the same
 * purge as the delete button (services/board/purge.ts), not a hide: processes killed, card off the
 * board, bytes erased on both sides.
 *
 * What makes this safe enough to run unattended:
 *  - **Only `done`.** Every other column is invisible to the sweep, however old the card is.
 *    `done` is the one column a card only reaches because a person put it there.
 *  - **Silence, not just the move.** The clock is the card's LAST SIGN OF LIFE
 *    ({@link lastActivityAt}) — the move to done, a rename, a status the hooks reported, a human
 *    typing in the terminal. Touch a finished card and it gets another six months.
 *  - **Six months.** Long enough that anything still wanted has been looked at; the same number
 *    the uploads sweep already uses (`UPLOAD_RETENTION_DAYS`).
 *  - **A cap per pass** ({@link DONE_SWEEP_MAX}), oldest first, and what was left over is LOGGED:
 *    the first run on an old install trims the worst offenders over a few days instead of being a
 *    silent mass deletion.
 *  - **An off switch:** retention `0` disables the sweep entirely.
 */

/** How long a card may sit in `done`, untouched, before it is purged. */
export const DONE_RETENTION_DAYS = 180;

/** Ceiling on one pass — a backlog of finished cards is collected over a few days, not at once. */
export const DONE_SWEEP_MAX = 20;

const DAY_MS = 24 * 60 * 60_000;

/** The stamps that prove somebody still cares about a card. */
type ActivityStamps = Pick<Card, "doneAt" | "updatedAt" | "statusAt" | "humanActiveAt">;

/**
 * The card's LAST SIGN OF LIFE (epoch ms): the newest of the stamps anything writes on it. A card
 * finished before `doneAt` existed falls back to `updatedAt`, which is what the move to `done`
 * wrote back then. PURE.
 */
export function lastActivityAt(card: ActivityStamps): number {
  return Math.max(card.doneAt ?? 0, card.updatedAt ?? 0, card.statusAt ?? 0, card.humanActiveAt ?? 0);
}

/**
 * The cards the sweep is allowed to delete: in `done`, and silent for at least `retentionDays`.
 * OLDEST FIRST, so a capped pass always takes the worst offenders. `retentionDays <= 0` is the off
 * switch and returns nothing. PURE — the whole safety of the feature is in here, which is why it
 * does no I/O and is tested directly.
 */
export function expiredDoneCards(
  cards: readonly Card[],
  opts: { now?: number; retentionDays?: number } = {},
): Card[] {
  const retentionDays = opts.retentionDays ?? DONE_RETENTION_DAYS;
  if (!(retentionDays > 0)) return [];
  const now = opts.now ?? Date.now();
  const cutoff = now - retentionDays * DAY_MS;
  return cards
    .filter((card) => card.column === "done" && lastActivityAt(card) <= cutoff)
    .sort((a, b) => lastActivityAt(a) - lastActivityAt(b));
}

/** What one retention pass did. */
export interface DoneRetentionSummary {
  /** Cards that were past the retention this pass (before the cap). */
  expired: number;
  /** Cards actually purged. */
  purged: number;
  /** Of those, how many left something behind (runner down) — the orphan sweep collects it. */
  incomplete: number;
  /** Expired cards the cap left for the next pass. */
  truncated: number;
}

/**
 * ONE RETENTION PASS. Reads the board, purges the cards that have been done for too long, and
 * reports what it did. Never throws: a board that cannot be read, or a runner that is down, costs
 * at most one pass (the next one is a day away).
 *
 * Sequential on purpose, like `purgeRemovedCards`: each purge is a handful of docker execs and
 * twenty of them must not hit the runner at the same time.
 */
export async function sweepDoneCards(
  opts: { now?: number; retentionDays?: number; max?: number } = {},
): Promise<DoneRetentionSummary> {
  const summary: DoneRetentionSummary = { expired: 0, purged: 0, incomplete: 0, truncated: 0 };
  const max = opts.max ?? DONE_SWEEP_MAX;
  let expired: Card[];
  try {
    expired = expiredDoneCards(await registry.listAllCards(), opts);
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "done-card retention skipped — the board could not be read");
    return summary;
  }
  summary.expired = expired.length;
  summary.truncated = Math.max(0, expired.length - max);
  if (expired.length === 0) return summary;

  for (const card of expired.slice(0, max)) {
    try {
      const report = await purgeCard(card.id, "retention");
      if (!report) continue; // already gone (a delete that raced this pass)
      summary.purged += 1;
      if (report.incomplete.length > 0) summary.incomplete += 1;
    } catch (err) {
      // purgeCard is written never to throw; if it ever does, the rest of the pass still runs.
      logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "a done card could not be purged");
    }
  }

  logger.info(
    {
      audit: true,
      action: "card.retention_sweep",
      retentionDays: opts.retentionDays ?? DONE_RETENTION_DAYS,
      ...summary,
    },
    "done cards past the retention were purged (board, conversation, worktree and branch)",
  );
  return summary;
}
