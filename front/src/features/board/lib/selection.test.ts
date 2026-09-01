import { describe, expect, it } from "vitest";
import {
  isMarqueeDrag,
  orderByBoard,
  planGroupDrop,
  planGroupDropByProject,
  rectFromPoints,
  rectsIntersect,
  toggleId,
} from "@/features/board/lib/selection";
import type { BoardCard } from "@/features/board/api";
import type { CardColumn } from "@/api/types";

function card(id: string, column: CardColumn, position: number, projectId = "p1"): BoardCard {
  return {
    id,
    projectId,
    title: id,
    column,
    position,
    tmuxSession: `card-${id}`,
    worktreeSlug: id,
    createdAt: 1,
  };
}

describe("toggleId", () => {
  it("adds an id that is not in", () => {
    expect([...toggleId(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
  });

  it("removes an id that is in", () => {
    expect([...toggleId(new Set(["a", "b"]), "b")]).toEqual(["a"]);
  });

  it("does not mutate the set it was given", () => {
    const before = new Set(["a"]);
    toggleId(before, "b");
    expect([...before]).toEqual(["a"]);
  });
});

describe("rectFromPoints / rectsIntersect", () => {
  it("normalises a drag in any direction", () => {
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 3, y: 5 })).toEqual({
      left: 3,
      top: 5,
      right: 10,
      bottom: 20,
    });
  });

  it("touching counts, disjoint does not", () => {
    const band = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(rectsIntersect(band, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true);
    expect(rectsIntersect(band, { left: 11, top: 0, right: 20, bottom: 10 })).toBe(false);
    // Sharing only an edge is not touching — the band has to actually cover part of the card.
    expect(rectsIntersect(band, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
  });
});

describe("isMarqueeDrag", () => {
  it("a wiggle under the threshold is a click", () => {
    expect(isMarqueeDrag({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false);
    expect(isMarqueeDrag({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
    expect(isMarqueeDrag({ x: 0, y: 0 }, { x: 0, y: -6 })).toBe(true);
  });
});

describe("orderByBoard", () => {
  it("orders the selection column-by-column, position within", () => {
    const cards = [
      card("d1", "done", 0),
      card("b2", "backlog", 1),
      card("w1", "working", 0),
      card("b1", "backlog", 0),
    ];
    const ordered = orderByBoard(cards, new Set(["d1", "w1", "b1", "b2"]));
    expect(ordered.map((c) => c.id)).toEqual(["b1", "b2", "w1", "d1"]);
  });

  it("ignores ids that are not on the board", () => {
    expect(orderByBoard([card("a", "backlog", 0)], new Set(["a", "ghost"])).map((c) => c.id)).toEqual(["a"]);
  });
});

/**
 * Applies a plan step by step, the way the server does: take the card out (a card arriving from
 * another column is not in the list yet), splice it in at `position`.
 */
function applyPlan(dest: string[], steps: { id: string; position: number }[]): string[] {
  const out = [...dest];
  for (const step of steps) {
    const from = out.indexOf(step.id);
    if (from !== -1) out.splice(from, 1);
    out.splice(step.position, 0, step.id);
  }
  return out;
}

describe("planGroupDrop", () => {
  it("drops a group from another column at the gap, order kept", () => {
    const steps = planGroupDrop(["a", "b"], ["m1", "m2"], 1);
    expect(applyPlan(["a", "b"], steps)).toEqual(["a", "m1", "m2", "b"]);
  });

  it("drops at the top and at the end", () => {
    expect(applyPlan(["a"], planGroupDrop(["a"], ["m1", "m2"], 0))).toEqual(["m1", "m2", "a"]);
    expect(applyPlan(["a"], planGroupDrop(["a"], ["m1", "m2"], 1))).toEqual(["a", "m1", "m2"]);
  });

  it("clamps a gap past the end", () => {
    expect(applyPlan([], planGroupDrop([], ["m1"], 99))).toEqual(["m1"]);
  });

  it("handles a moving card already sitting in the destination ABOVE the gap", () => {
    // Visual list [m2, a, b], group m1+m2 dropped at the very end.
    const steps = planGroupDrop(["m2", "a", "b"], ["m1", "m2"], 3);
    expect(applyPlan(["m2", "a", "b"], steps)).toEqual(["a", "b", "m1", "m2"]);
  });

  it("handles a moving card already sitting in the destination BELOW the gap", () => {
    // Visual list [a, m2, b], group dropped between a and m2 (gap 1).
    const steps = planGroupDrop(["a", "m2", "b"], ["m1", "m2"], 1);
    expect(applyPlan(["a", "m2", "b"], steps)).toEqual(["a", "m1", "m2", "b"]);
  });

  it("keeps the group's relative order whatever the destination held", () => {
    const dest = ["x", "m3", "y", "m1", "z"];
    const moving = ["m1", "m2", "m3"];
    const steps = planGroupDrop(dest, moving, 2);
    // Gap 2 in the visual list is after m3; m3 lifts out, so the block lands after x.
    expect(applyPlan(dest, steps)).toEqual(["x", "m1", "m2", "m3", "y", "z"]);
  });
});

describe("planGroupDropByProject", () => {
  it("splits by project and appends to each project's destination column", () => {
    const all = [
      card("a", "done", 0, "p1"),
      card("m1", "backlog", 0, "p1"),
      card("m2", "backlog", 0, "p2"),
      card("m3", "backlog", 1, "p1"),
    ];
    const moving = [all[1] as BoardCard, all[3] as BoardCard, all[2] as BoardCard];
    const steps = planGroupDropByProject(all, moving, "done");
    expect(steps).toEqual([
      { id: "m1", position: 1, projectId: "p1" },
      { id: "m3", position: 2, projectId: "p1" },
      { id: "m2", position: 0, projectId: "p2" },
    ]);
  });
});
