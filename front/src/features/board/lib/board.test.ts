import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  FRESH_CARD_MS,
  groupByColumn,
  lastActivity,
  dropPosition,
  moveCardLocal,
  moveProjectLocal,
  nextPosition,
  readLocation,
  sameLocation,
  sortByRecency,
  sortCards,
  sortProjects,
  cardDot,
  cardHref,
  declaredStateChip,
  dotClass,
  locationHref,
  recentCards,
  splitSidebarCards,
  statusDot,
  writeLocation,
} from "@/features/board/lib/board";
import type { BoardCard, BoardProject } from "@/features/board/api";
import type { CardColumn } from "@/api/types";

function card(overrides: Partial<BoardCard> & { id: string }): BoardCard {
  return {
    projectId: "p1",
    title: overrides.id,
    column: "backlog" as CardColumn,
    position: 0,
    // Derived server-side from the id and the title; fixtures mirror that shape.
    tmuxSession: `card-${overrides.id}`,
    worktreeSlug: overrides.id,
    createdAt: 1_000,
    ...overrides,
  };
}

function project(overrides: Partial<BoardProject> & { id: string }): BoardProject {
  return { name: overrides.id, baseBranch: "dev", position: 0, createdAt: 1_000, ...overrides };
}

describe("columns", () => {
  it("reads as a life cycle: backlog, paused, then the two live columns, then done", () => {
    // Paused sits next to Backlog because a parked card is work that has not resumed; Waiting sits
    // left of Working because what needs a human should be read first.
    expect(COLUMNS.map((c) => c.key)).toEqual(["backlog", "paused", "waiting", "working", "done"]);
  });
});

describe("sortCards", () => {
  it("orders by position, then creation, then id", () => {
    const cards = [
      card({ id: "c", position: 1, createdAt: 5 }),
      card({ id: "a", position: 0, createdAt: 9 }),
      card({ id: "b", position: 1, createdAt: 2 }),
    ];
    expect(sortCards(cards).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("sends a card with no position to the end instead of treating it as first", () => {
    const cards = [card({ id: "none", position: undefined }), card({ id: "zero", position: 0 })];
    expect(sortCards(cards).map((c) => c.id)).toEqual(["zero", "none"]);
  });

  it("does not mutate the list it is given (it is a query cache)", () => {
    const cards = [card({ id: "b", position: 1 }), card({ id: "a", position: 0 })];
    sortCards(cards);
    expect(cards.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("groupByColumn", () => {
  it("returns every column, ordered, even the empty ones", () => {
    const groups = groupByColumn([
      card({ id: "w2", column: "working", position: 1 }),
      card({ id: "w1", column: "working", position: 0 }),
      card({ id: "d", column: "done" }),
    ]);
    expect(Object.keys(groups)).toEqual(["backlog", "waiting", "working", "paused", "done"]);
    expect(groups.working.map((c) => c.id)).toEqual(["w1", "w2"]);
    expect(groups.backlog).toEqual([]);
  });

  it("drops a column the server sends that this build does not know", () => {
    const rogue = { ...card({ id: "x" }), column: "archived" as unknown as CardColumn };
    const groups = groupByColumn([rogue, card({ id: "ok" })]);
    expect(groups.backlog.map((c) => c.id)).toEqual(["ok"]);
  });
});

describe("nextPosition", () => {
  it("is one past the highest position in the target column", () => {
    const cards = [
      card({ id: "a", column: "done", position: 0 }),
      card({ id: "b", column: "done", position: 4 }),
      card({ id: "c", column: "backlog", position: 9 }),
    ];
    expect(nextPosition(cards, "done")).toBe(5);
  });

  it("is 0 for an empty column", () => {
    expect(nextPosition([card({ id: "a", column: "backlog" })], "done")).toBe(0);
  });
});

describe("moveCardLocal", () => {
  it("moves only the card it was asked to move", () => {
    const cards = [card({ id: "a" }), card({ id: "b" })];
    const next = moveCardLocal(cards, "a", "done", 3);
    // Clamped to the end of an empty column, exactly as the server clamps it.
    expect(next.find((c) => c.id === "a")).toMatchObject({ column: "done", position: 0 });
    expect(next.find((c) => c.id === "b")).toMatchObject({ column: "backlog" });
  });

  it("renumbers the column it lands in, so a reorder holds until the refetch", () => {
    const cards = [
      card({ id: "a", position: 0 }),
      card({ id: "b", position: 1 }),
      card({ id: "c", position: 2 }),
    ];
    // Third card to the top of its own column.
    const next = sortCards(moveCardLocal(cards, "c", "backlog", 0));
    expect(next.map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(next.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it("closes the gap left behind in the column it came from", () => {
    const cards = [
      card({ id: "a", position: 0 }),
      card({ id: "b", position: 1 }),
      card({ id: "c", position: 2 }),
    ];
    const next = moveCardLocal(cards, "a", "done", 0);
    expect(next.filter((c) => c.column === "backlog").map((c) => c.position)).toEqual([0, 1]);
  });

  it("leaves the input untouched", () => {
    const cards = [card({ id: "a" }), card({ id: "b", position: 1 })];
    moveCardLocal(cards, "b", "backlog", 0);
    expect(cards.map((c) => c.position)).toEqual([0, 1]);
    expect(cards[0]?.column).toBe("backlog");
  });
});

describe("dropPosition", () => {
  it("is the gap itself for a card arriving from another column", () => {
    expect(dropPosition(0, -1, 3)).toBe(0);
    expect(dropPosition(2, -1, 3)).toBe(2);
  });

  it("clamps a gap past the end of the destination", () => {
    expect(dropPosition(9, -1, 3)).toBe(3);
  });

  it("discounts the card's own slot when it is already in the column", () => {
    // [a, b, c], dragging c (index 2) to the very top.
    expect(dropPosition(0, 2, 3)).toBe(0);
    // ...and dragging a (index 0) to the very bottom.
    expect(dropPosition(3, 0, 3)).toBe(2);
  });

  it("answers null for the two gaps either side of the card itself", () => {
    expect(dropPosition(1, 1, 3)).toBeNull();
    expect(dropPosition(2, 1, 3)).toBeNull();
  });
});

describe("statusDot", () => {
  it("is green and live while the agent is working", () => {
    expect(statusDot("working")).toEqual({ tone: "ok", label: "Working", live: true });
  });

  it("is amber and still while it waits for you", () => {
    expect(statusDot("waiting")).toEqual({ tone: "warn", label: "Waiting for you", live: false });
  });

  it("shows NO dot when the runner has reported nothing", () => {
    expect(statusDot(null)).toBeNull();
    expect(statusDot(undefined)).toBeNull();
  });
});

describe("cardDot", () => {
  it("is the status dot for a card with a session", () => {
    expect(cardDot(card({ id: "a", status: "working" }))?.tone).toBe("ok");
    expect(cardDot(card({ id: "a", status: "waiting" }))?.tone).toBe("warn");
    expect(cardDot(card({ id: "a" }))).toBeNull();
  });

  it("goes grey and still once the card is hibernated, whatever the last status said", () => {
    const dot = cardDot(card({ id: "a", status: "waiting", hibernatedAt: 5 }));
    expect(dot?.tone).toBe("cold");
    expect(dot?.live).toBe(false);
    // A green dot on a card with no process behind it would be a lie.
    expect(cardDot(card({ id: "a", status: "working", hibernatedAt: 5 }))?.tone).toBe("cold");
  });

  it("gives each tone its own colour", () => {
    const classes = (["ok", "warn", "cold"] as const).map(dotClass);
    expect(new Set(classes).size).toBe(3);
  });
});

describe("declaredStateChip", () => {
  it("is null until the agent has declared a state", () => {
    expect(declaredStateChip(card({ id: "a" }))).toBeNull();
  });

  it("labels each state and gives each its own colour", () => {
    expect(declaredStateChip(card({ id: "a", declaredState: "ready" }))?.label).toBe("Ready");
    expect(declaredStateChip(card({ id: "a", declaredState: "needs_me" }))?.label).toBe("Needs you");
    const classes = (["working", "ready", "needs_me", "blocked"] as const).map(
      (s) => declaredStateChip(card({ id: "a", declaredState: s }))?.className,
    );
    expect(new Set(classes).size).toBe(4);
  });
});

describe("recentCards", () => {
  it("is the conversations you have actually been in, newest first", () => {
    const recent = recentCards([
      card({ id: "never-opened", column: "backlog" }),
      card({ id: "oldest", column: "waiting", openedAt: 1_010 }),
      card({ id: "newest", column: "working", openedAt: 1_005, statusAt: 1_090 }),
      card({ id: "middle", column: "paused", openedAt: 1_050 }),
    ]);
    expect(recent.map((c) => c.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("drops what you finished, keeps what merely went cold", () => {
    const recent = recentCards([
      card({ id: "done", column: "done", openedAt: 1_099 }),
      card({ id: "hibernated", column: "waiting", openedAt: 1_010, hibernatedAt: 1_020 }),
    ]);
    expect(recent.map((c) => c.id)).toEqual(["hibernated"]);
  });

  it("is the WHOLE history by default — the component gives it a scroll, not a cut", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      card({ id: `c${i}`, column: "waiting", openedAt: 2_000 + i }),
    );
    expect(recentCards(many)).toHaveLength(9);
    expect(recentCards(many, 2).map((c) => c.id)).toEqual(["c8", "c7"]);
    expect(recentCards(many, 0)).toEqual([]);
  });
});

describe("recency", () => {
  it("takes the latest stamp the card carries: status, open, pause, hibernate, creation", () => {
    expect(lastActivity(card({ id: "a", statusAt: 2_005, openedAt: 2_009 }))).toBe(2_009);
    // Pausing/hibernating clears statusAt on the server; the stamp of the kill is the stand-in.
    expect(lastActivity(card({ id: "a", openedAt: 2_009, pausedAt: 2_020 }))).toBe(2_020);
    expect(lastActivity(card({ id: "a", openedAt: 2_009, hibernatedAt: 2_030 }))).toBe(2_030);
    // A card that was only just written down counts as touched at creation, not never.
    expect(lastActivity(card({ id: "a" }))).toBe(1_000);
  });

  it("puts the most recently touched card first, with a stable tie-break", () => {
    const cards = [
      card({ id: "old", statusAt: 2_010 }),
      card({ id: "new", statusAt: 2_030 }),
      card({ id: "tie-b", createdAt: 2 }),
      card({ id: "tie-a", createdAt: 1 }),
    ];
    expect(sortByRecency(cards).map((c) => c.id)).toEqual(["new", "old", "tie-b", "tie-a"]);
  });
});

describe("splitSidebarCards", () => {
  // A fixed "now", so the freshness window is deterministic. The fixtures' default createdAt is
  // 1_000 — far outside the window — unless a test says otherwise.
  const NOW = 100 * 60_000;

  it("keeps the live conversations visible and folds paused and stale backlog away", () => {
    const { active, idle } = splitSidebarCards(
      [
        card({ id: "backlog", column: "backlog" }),
        card({ id: "paused", column: "paused", openedAt: 1_500, pausedAt: 2_000 }),
        card({ id: "waiting", column: "waiting", statusAt: 2_001 }),
        card({ id: "working", column: "working", statusAt: 2_002 }),
      ],
      NOW,
    );
    expect(active.map((c) => c.id)).toEqual(["working", "waiting"]);
    expect(idle.map((c) => c.id)).toEqual(["paused", "backlog"]);
  });

  it("never lists a finished card", () => {
    const { active, idle } = splitSidebarCards([card({ id: "done", column: "done" })], NOW);
    expect([...active, ...idle]).toEqual([]);
  });

  it("orders the live list purely by recency — the conversation that just spoke rises", () => {
    const { active } = splitSidebarCards(
      [
        card({ id: "waiting-old", column: "waiting", statusAt: 2_010 }),
        card({ id: "working-old", column: "working", statusAt: 2_020 }),
        card({ id: "waiting-new", column: "waiting", statusAt: 2_030 }),
        card({ id: "working-new", column: "working", statusAt: 2_040 }),
      ],
      NOW,
    );
    expect(active.map((c) => c.id)).toEqual([
      "working-new",
      "waiting-new",
      "working-old",
      "waiting-old",
    ]);
  });

  it("folds a HIBERNATED card away even though it kept its live column — grey is abandoned", () => {
    const { active, idle } = splitSidebarCards(
      [
        card({ id: "cold", column: "waiting", openedAt: 1_500, statusAt: 0, hibernatedAt: 2_000 }),
        card({ id: "hot", column: "working", openedAt: 1_500, statusAt: 2_500 }),
      ],
      NOW,
    );
    expect(active.map((c) => c.id)).toEqual(["hot"]);
    expect(idle.map((c) => c.id)).toEqual(["cold"]);
  });

  it("puts a card created moments ago at the TOP of the main list, never behind show-more", () => {
    const { active, idle } = splitSidebarCards(
      [
        card({ id: "just-created", column: "backlog", createdAt: NOW - 1_000 }),
        card({ id: "live", column: "working", openedAt: 1_500, statusAt: 2_000 }),
        card({ id: "stale-backlog", column: "backlog" }),
      ],
      NOW,
    );
    expect(active.map((c) => c.id)).toEqual(["just-created", "live"]);
    expect(idle.map((c) => c.id)).toEqual(["stale-backlog"]);
  });

  it("lets an unopened card fold away once the freshness window has passed", () => {
    const created = NOW - FRESH_CARD_MS - 1;
    const { active, idle } = splitSidebarCards(
      [card({ id: "forgotten", column: "backlog", createdAt: created })],
      NOW,
    );
    expect(active).toEqual([]);
    expect(idle.map((c) => c.id)).toEqual(["forgotten"]);
  });

  it("orders the fold by recency too — the most recently abandoned thread first", () => {
    const { idle } = splitSidebarCards(
      [
        card({ id: "cold-old", column: "working", openedAt: 1_500, hibernatedAt: 2_000 }),
        card({ id: "cold-new", column: "waiting", openedAt: 1_500, hibernatedAt: 3_000 }),
        card({ id: "parked", column: "paused", openedAt: 1_500, pausedAt: 2_500 }),
      ],
      NOW,
    );
    expect(idle.map((c) => c.id)).toEqual(["cold-new", "parked", "cold-old"]);
  });

  it("breaks a tie stably, so an idle board never reshuffles between polls", () => {
    const cards = [
      card({ id: "b", column: "waiting", statusAt: 2_005, createdAt: 1 }),
      card({ id: "a", column: "waiting", statusAt: 2_005, createdAt: 1 }),
    ];
    expect(splitSidebarCards(cards, NOW).active.map((c) => c.id)).toEqual(["a", "b"]);
    expect(splitSidebarCards([...cards].reverse(), NOW).active.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the list it is given", () => {
    const cards = [
      card({ id: "working", column: "working", statusAt: 2_002 }),
      card({ id: "waiting", column: "waiting", statusAt: 2_001 }),
    ];
    splitSidebarCards(cards, NOW);
    expect(cards.map((c) => c.id)).toEqual(["working", "waiting"]);
  });
});

describe("locationHref", () => {
  it("is a relative query string, so every card is a real link", () => {
    expect(cardHref("p1", "c2")).toBe("?project=p1&card=c2");
    expect(locationHref({ projectId: "p1", cardId: null })).toBe("?project=p1");
  });

  it("is the aggregated board when nothing is selected", () => {
    expect(locationHref({ projectId: null, cardId: null })).toBe("?");
  });

  it("escapes an id rather than pasting it in raw", () => {
    expect(cardHref("a b", "c/d")).toBe("?project=a+b&card=c%2Fd");
  });
});

describe("sortProjects", () => {
  it("orders by position and falls back to creation for a project written before it existed", () => {
    // "legacy" has no `position` at all — a document written before the field existed.
    const legacy = { ...project({ id: "legacy", createdAt: 1 }) } as Partial<BoardProject> & { id: string };
    delete legacy.position;
    const projects = [
      legacy as BoardProject,
      project({ id: "second", position: 1, createdAt: 50 }),
      project({ id: "first", position: 0, createdAt: 99 }),
    ];
    expect(sortProjects(projects).map((p) => p.id)).toEqual(["first", "second", "legacy"]);
  });
});

describe("moveProjectLocal", () => {
  const projects = [
    project({ id: "a", position: 0 }),
    project({ id: "b", position: 1 }),
    project({ id: "c", position: 2 }),
  ];

  it("renumbers 0..n-1 so the optimistic list matches what the server returns", () => {
    const next = moveProjectLocal(projects, "c", 0);
    expect(next.map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(next.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it("clamps an index past the end", () => {
    expect(moveProjectLocal(projects, "a", 99).map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("returns the input unchanged for an unknown id", () => {
    expect(moveProjectLocal(projects, "nope", 0)).toBe(projects);
  });

  it("does not mutate the input", () => {
    moveProjectLocal(projects, "c", 0);
    expect(projects.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("deep links", () => {
  it("round-trips a project and a card", () => {
    const params = writeLocation({ projectId: "p1", cardId: "c1" });
    expect(params.toString()).toBe("project=p1&card=c1");
    expect(readLocation(params)).toEqual({ projectId: "p1", cardId: "c1" });
  });

  it("keeps a bare project", () => {
    expect(readLocation(writeLocation({ projectId: "p1", cardId: null }))).toEqual({
      projectId: "p1",
      cardId: null,
    });
  });

  it("ignores a card with no project — the terminal view needs both", () => {
    expect(readLocation(new URLSearchParams("card=c1"))).toEqual({ projectId: null, cardId: null });
    expect(writeLocation({ projectId: null, cardId: "c1" }).toString()).toBe("");
  });

  it("treats blank values as absent", () => {
    expect(readLocation(new URLSearchParams("project=%20&card=c1"))).toEqual({
      projectId: null,
      cardId: null,
    });
  });

  it("compares locations", () => {
    expect(sameLocation({ projectId: "p", cardId: null }, { projectId: "p", cardId: null })).toBe(true);
    expect(sameLocation({ projectId: "p", cardId: "a" }, { projectId: "p", cardId: "b" })).toBe(false);
  });
});
