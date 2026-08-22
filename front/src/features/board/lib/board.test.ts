import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  groupByColumn,
  lastActivity,
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
    expect(next.find((c) => c.id === "a")).toMatchObject({ column: "done", position: 3 });
    expect(next.find((c) => c.id === "b")).toMatchObject({ column: "backlog" });
  });

  it("leaves the input untouched", () => {
    const cards = [card({ id: "a" })];
    moveCardLocal(cards, "a", "done", 1);
    expect(cards[0]?.column).toBe("backlog");
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

describe("recentCards", () => {
  it("is the conversations you have actually been in, newest first", () => {
    const recent = recentCards([
      card({ id: "never-opened", column: "backlog" }),
      card({ id: "oldest", column: "waiting", openedAt: 10 }),
      card({ id: "newest", column: "working", openedAt: 5, statusAt: 90 }),
      card({ id: "middle", column: "paused", openedAt: 50 }),
    ]);
    expect(recent.map((c) => c.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("drops what you finished, keeps what merely went cold", () => {
    const recent = recentCards([
      card({ id: "done", column: "done", openedAt: 99 }),
      card({ id: "hibernated", column: "waiting", openedAt: 10, hibernatedAt: 20 }),
    ]);
    expect(recent.map((c) => c.id)).toEqual(["hibernated"]);
  });

  it("stops at the limit — it is a glance, not a second board", () => {
    const many = Array.from({ length: 9 }, (_, i) => card({ id: `c${i}`, column: "waiting", openedAt: i + 1 }));
    expect(recentCards(many)).toHaveLength(5);
    expect(recentCards(many, 2).map((c) => c.id)).toEqual(["c8", "c7"]);
    expect(recentCards(many, 0)).toEqual([]);
  });
});

describe("recency", () => {
  it("takes the latest of statusAt and openedAt", () => {
    expect(lastActivity(card({ id: "a", statusAt: 5, openedAt: 9 }))).toBe(9);
    expect(lastActivity(card({ id: "a" }))).toBe(0);
  });

  it("puts the most recently touched card first, with a stable tie-break", () => {
    const cards = [
      card({ id: "old", statusAt: 10 }),
      card({ id: "new", statusAt: 30 }),
      card({ id: "tie-b", createdAt: 2 }),
      card({ id: "tie-a", createdAt: 1 }),
    ];
    expect(sortByRecency(cards).map((c) => c.id)).toEqual(["new", "old", "tie-a", "tie-b"]);
  });
});

describe("splitSidebarCards", () => {
  it("keeps the mirrored columns visible and hides paused then backlog behind show-more", () => {
    const { active, idle } = splitSidebarCards([
      card({ id: "backlog", column: "backlog" }),
      card({ id: "paused", column: "paused" }),
      card({ id: "waiting", column: "waiting", statusAt: 1 }),
      card({ id: "working", column: "working", statusAt: 2 }),
    ]);
    expect(active.map((c) => c.id)).toEqual(["waiting", "working"]);
    expect(idle.map((c) => c.id)).toEqual(["paused", "backlog"]);
  });

  it("never lists a finished card", () => {
    const { active, idle } = splitSidebarCards([card({ id: "done", column: "done" })]);
    expect([...active, ...idle]).toEqual([]);
  });

  it("puts every waiting card above every working one, however recent the working one is", () => {
    // The regression this rule exists for: `fresh` went green a moment ago, `stale` has been
    // waiting for a human since forever. Recency alone would bury the one that needs an answer.
    const { active } = splitSidebarCards([
      card({ id: "fresh", column: "working", statusAt: 9_000 }),
      card({ id: "stale", column: "waiting", statusAt: 10 }),
    ]);
    expect(active.map((c) => c.id)).toEqual(["stale", "fresh"]);
  });

  it("orders by recency inside each group", () => {
    const { active } = splitSidebarCards([
      card({ id: "waiting-old", column: "waiting", statusAt: 10 }),
      card({ id: "working-old", column: "working", statusAt: 20 }),
      card({ id: "waiting-new", column: "waiting", statusAt: 30 }),
      card({ id: "working-new", column: "working", statusAt: 40 }),
    ]);
    expect(active.map((c) => c.id)).toEqual([
      "waiting-new",
      "waiting-old",
      "working-new",
      "working-old",
    ]);
  });

  it("breaks a tie stably, so an idle board never reshuffles between polls", () => {
    const cards = [
      card({ id: "b", column: "waiting", statusAt: 5, createdAt: 1 }),
      card({ id: "a", column: "waiting", statusAt: 5, createdAt: 1 }),
    ];
    expect(splitSidebarCards(cards).active.map((c) => c.id)).toEqual(["a", "b"]);
    expect(splitSidebarCards([...cards].reverse()).active.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the list it is given", () => {
    const cards = [
      card({ id: "working", column: "working", statusAt: 2 }),
      card({ id: "waiting", column: "waiting", statusAt: 1 }),
    ];
    splitSidebarCards(cards);
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
