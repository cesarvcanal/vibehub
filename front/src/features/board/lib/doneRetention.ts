import type { BoardCard } from "@/features/board/api";

/**
 * THE COUNTDOWN ON A DONE CARD — the client half of the done-card retention.
 *
 * The server purges a card that sat untouched in `done` for `doneRetentionDays` (served by
 * `GET /api/features`; the rule is back/src/services/board/retention.ts). The card prints how long
 * it has left, so the deadline it shows MUST be the one the server acts on: the same stamps make
 * up the card's last sign of life (`doneAt`, `updatedAt`, `statusAt`, `humanActiveAt` — NOT
 * `lastActivity` from ./board, which counts opens and pauses the server ignores), the same
 * `done`-only rule and the same `0 = off` switch. Anything unknown prints NOTHING: no countdown
 * beats a wrong one.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type RetentionStamps = Pick<BoardCard, "column" | "doneAt" | "updatedAt" | "statusAt" | "humanActiveAt">;

/**
 * When the server will purge this card (epoch ms), or null when it never will / we cannot know:
 * outside `done`, retention unknown or off, or no stamp to count from. PURE.
 */
export function donePurgeAt(card: RetentionStamps, retentionDays: number | undefined): number | null {
  if (card.column !== "done") return null;
  if (!retentionDays || !(retentionDays > 0)) return null;
  const last = Math.max(card.doneAt ?? 0, card.updatedAt ?? 0, card.statusAt ?? 0, card.humanActiveAt ?? 0);
  if (last <= 0) return null;
  return last + retentionDays * DAY_MS;
}

/** What the card prints: a whole number of one unit, or "any moment now". */
export type PurgeCountdown = { unit: "now" } | { unit: "minutes" | "hours" | "days"; value: number };

/**
 * The time left, in the coarsest unit that still says something: days beyond two of them, hours
 * while at least one is left, then minutes (rounded UP, so the last minute reads "1 min", never
 * "0"). Past the deadline it is "now" — the hourly sweep simply has not reached the card yet. PURE.
 */
export function purgeCountdown(purgeAt: number, now: number): PurgeCountdown {
  const left = purgeAt - now;
  if (left <= 0) return { unit: "now" };
  if (left >= 2 * DAY_MS) return { unit: "days", value: Math.floor(left / DAY_MS) };
  if (left >= HOUR_MS) return { unit: "hours", value: Math.floor(left / HOUR_MS) };
  return { unit: "minutes", value: Math.ceil(left / MINUTE_MS) };
}
