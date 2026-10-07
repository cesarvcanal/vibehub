import { describe, expect, it } from "vitest";
import { donePurgeAt, purgeCountdown } from "@/features/board/lib/doneRetention";
import type { BoardCard } from "@/features/board/api";

/**
 * THE COUNTDOWN ON A DONE CARD — the server purges a card that sat untouched in `done` for
 * `doneRetentionDays` (back/src/services/board/retention.ts). The card has to say WHEN, and the
 * moment it shows must be the one the server will act on: same clock (the card's last sign of
 * life), same column rule, same off switch.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "c1",
    projectId: "p1",
    title: "entregue",
    column: "done",
    tmuxSession: "card-c1",
    worktreeSlug: "entregue-c1",
    createdAt: NOW - 10 * DAY,
    ...over,
  };
}

describe("donePurgeAt — when the server will purge the card", () => {
  it("is the card's last sign of life plus the retention", () => {
    expect(donePurgeAt(card({ doneAt: NOW - 2 * HOUR, updatedAt: NOW - 2 * HOUR }), 1)).toBe(NOW - 2 * HOUR + DAY);
  });

  it("reads the SAME stamps as the server: a hook status or a keystroke resets the clock", () => {
    expect(donePurgeAt(card({ doneAt: NOW - 5 * HOUR, statusAt: NOW - HOUR }), 1)).toBe(NOW - HOUR + DAY);
    expect(donePurgeAt(card({ doneAt: NOW - 5 * HOUR, humanActiveAt: NOW - MIN }), 1)).toBe(NOW - MIN + DAY);
    expect(donePurgeAt(card({ doneAt: NOW - 5 * HOUR, updatedAt: NOW - 3 * HOUR }), 1)).toBe(NOW - 3 * HOUR + DAY);
  });

  it("ignores stamps the server does not count (opening the card is not activity there)", () => {
    expect(donePurgeAt(card({ doneAt: NOW - 5 * HOUR, openedAt: NOW - MIN, pausedAt: NOW - MIN }), 1)).toBe(
      NOW - 5 * HOUR + DAY,
    );
  });

  it("is null outside `done` — no other column is ever swept", () => {
    for (const column of ["backlog", "waiting", "working", "paused"] as const) {
      expect(donePurgeAt(card({ column, doneAt: NOW - HOUR }), 1)).toBeNull();
    }
  });

  it("is null when the retention is unknown or off (0) — no countdown beats a wrong one", () => {
    expect(donePurgeAt(card({ doneAt: NOW - HOUR }), undefined)).toBeNull();
    expect(donePurgeAt(card({ doneAt: NOW - HOUR }), 0)).toBeNull();
  });

  it("is null for a done card with no stamp at all, rather than counting from 1970", () => {
    expect(donePurgeAt(card({ doneAt: undefined, updatedAt: undefined }), 1)).toBeNull();
  });
});

describe("purgeCountdown — what the card prints", () => {
  it("counts hours while there is at least one left", () => {
    expect(purgeCountdown(NOW + 23 * HOUR + 40 * MIN, NOW)).toEqual({ unit: "hours", value: 23 });
    expect(purgeCountdown(NOW + HOUR, NOW)).toEqual({ unit: "hours", value: 1 });
  });

  it("switches to minutes in the last hour, never printing '0 h'", () => {
    expect(purgeCountdown(NOW + 59 * MIN + 10_000, NOW)).toEqual({ unit: "minutes", value: 60 });
    expect(purgeCountdown(NOW + 45 * MIN, NOW)).toEqual({ unit: "minutes", value: 45 });
    expect(purgeCountdown(NOW + 10_000, NOW)).toEqual({ unit: "minutes", value: 1 });
  });

  it("counts days when the retention is longer than two of them", () => {
    expect(purgeCountdown(NOW + 3 * DAY + 5 * HOUR, NOW)).toEqual({ unit: "days", value: 3 });
    expect(purgeCountdown(NOW + 47 * HOUR, NOW)).toEqual({ unit: "hours", value: 47 });
  });

  it("past the deadline it is 'any moment now' — the hourly sweep has not reached it yet", () => {
    expect(purgeCountdown(NOW, NOW)).toEqual({ unit: "now" });
    expect(purgeCountdown(NOW - 3 * HOUR, NOW)).toEqual({ unit: "now" });
  });
});
