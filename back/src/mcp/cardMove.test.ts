import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `vibehub_move_cards` — an agent moving cards between columns, in bulk.
 *
 * Three things are pinned here, because they are what makes the tool safe to point at ten cards:
 *  - the target column is one the registry says has NO session effect (the invariant block below
 *    checks the whitelist against `cardMoveEffect` itself, so the two cannot drift apart);
 *  - the batch survives its own failures — an unknown id, or a card the caller may not touch, fails
 *    on its own line and everything else still moves;
 *  - the caller's reach is its own project.
 *
 * Everything that touches the disk goes through `fresh()`, which points `config.dataDir` at a temp
 * directory and re-imports the modules so the registry builds a brand new JsonStore (the same
 * pattern as registry.test.ts).
 */

let dir = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  return {
    move: await import("./cardMove.js"),
    registry: await import("../services/board/registry.js"),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-cardmove-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A project with `n` cards in the backlog. */
async function seed(registry: Awaited<ReturnType<typeof fresh>>["registry"], name: string, titles: string[]) {
  const project = await registry.createProject({ name });
  const cards = [];
  for (const title of titles) cards.push(await registry.createCard({ projectId: project.id, title }));
  return { project, cards };
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe("assertMovableColumn (pure)", () => {
  it("accepts the two columns with no session effect", async () => {
    const { move } = await fresh();
    expect(move.assertMovableColumn("done")).toBe("done");
    expect(move.assertMovableColumn(" backlog ")).toBe("backlog");
    expect(move.AGENT_MOVABLE_COLUMNS).toEqual(["backlog", "done"]);
  });

  it("refuses the lifecycle columns and says why", async () => {
    const { move } = await fresh();
    for (const column of ["paused", "waiting", "working"]) {
      expect(() => move.assertMovableColumn(column)).toThrow(/only moves cards to backlog or done/);
      expect(() => move.assertMovableColumn(column)).toThrow(/session/);
    }
  });

  it("refuses anything that is not a column at all", async () => {
    const { move } = await fresh();
    expect(() => move.assertMovableColumn("")).toThrow(/invalid column/);
    expect(() => move.assertMovableColumn("Done")).toThrow(/invalid column/);
    expect(() => move.assertMovableColumn("finished")).toThrow(/invalid column/);
  });
});

describe("normalizeCardIds (pure)", () => {
  it("trims, drops empties and dedupes keeping the given order", async () => {
    const { move } = await fresh();
    expect(move.normalizeCardIds([" a ", "b", "", "   ", "a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("refuses an empty list and an oversized batch", async () => {
    const { move } = await fresh();
    expect(() => move.normalizeCardIds([])).toThrow(/at least one card id/);
    expect(() => move.normalizeCardIds(["  "])).toThrow(/at least one card id/);
    expect(() => move.normalizeCardIds(undefined)).toThrow(/at least one card id/);
    const many = Array.from({ length: move.MOVE_BATCH_MAX + 1 }, (_, i) => `card-${i}`);
    expect(() => move.normalizeCardIds(many)).toThrow(/too many cards/);
  });
});

describe("accessError (pure) — an agent reaches its own project", () => {
  it("allows the same project and refuses another one", async () => {
    const { move } = await fresh();
    expect(move.accessError({ projectId: "p1" }, { projectId: "p1" })).toBeNull();
    expect(move.accessError({ projectId: "p1" }, { projectId: "p2" })).toMatch(/another project/);
  });

  it("no caller (the owner's browser, not a card) reaches everything", async () => {
    const { move } = await fresh();
    expect(move.accessError(undefined, { projectId: "p2" })).toBeNull();
  });
});

describe("the whitelist is derived from the registry's own rule", () => {
  it("no movable column produces a session effect, whatever shape the card is in", async () => {
    const { move, registry } = await fresh();
    const shapes = [
      { label: "never opened", openedAt: undefined, pausedAt: null, hibernatedAt: null },
      { label: "live session", openedAt: 1, pausedAt: null, hibernatedAt: null },
      { label: "paused", openedAt: 1, pausedAt: 2, hibernatedAt: null },
      { label: "hibernated", openedAt: 1, pausedAt: null, hibernatedAt: 2 },
    ];
    for (const target of move.AGENT_MOVABLE_COLUMNS) {
      for (const from of registry.BOARD_COLUMNS) {
        for (const shape of shapes) {
          const before = { column: from, openedAt: shape.openedAt, pausedAt: shape.pausedAt, hibernatedAt: shape.hibernatedAt };
          expect(registry.cardMoveEffect(before, { column: target }), `${from} -> ${target} (${shape.label})`).toBe("none");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// moveCards
// ---------------------------------------------------------------------------

describe("moveCards — the batch", () => {
  it("concludes a whole batch and renumbers the columns", async () => {
    const { move, registry } = await fresh();
    const { project, cards } = await seed(registry, "billing", ["one", "two", "three", "stays"]);
    await registry.updateCard(cards[0]!.id, { column: "working" });
    await registry.updateCard(cards[1]!.id, { column: "waiting" });

    const out = await move.moveCards([cards[0]!.id, cards[1]!.id, cards[2]!.id], "done", { by: "test" });

    expect(out).toMatchObject({ column: "done", moved: 3, unchanged: 0, failed: 0 });
    expect(out.results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(out.results[0]).toMatchObject({ title: "one", project: "billing", was: "working", column: "done", changed: true });
    expect(out.results[2]).toMatchObject({ was: "backlog", column: "done", changed: true });

    const board = await registry.listCards(project.id);
    expect(board.filter((c) => c.column === "done").map((c) => [c.title, c.position]))
      .toEqual([["one", 0], ["two", 1], ["three", 2]]);
    // The untouched card keeps its column, renumbered to the top of the backlog it now owns alone.
    expect(board.find((c) => c.title === "stays")).toMatchObject({ column: "backlog", position: 0 });
  });

  it("sends cards back to the backlog too — one verb, an explicit target", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["parked"]);
    await registry.updateCard(cards[0]!.id, { column: "done" });
    const out = await move.moveCards([cards[0]!.id], "backlog", {});
    expect(out).toMatchObject({ column: "backlog", moved: 1, failed: 0 });
    expect((await registry.getCard(cards[0]!.id))?.column).toBe("backlog");
  });

  it("a card already in the target column is a no-op success (re-running a batch is safe)", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["a", "b"]);
    await move.moveCards([cards[0]!.id, cards[1]!.id], "done", {});
    const again = await move.moveCards([cards[0]!.id, cards[1]!.id], "done", {});
    expect(again).toMatchObject({ moved: 0, unchanged: 2, failed: 0 });
    expect(again.results.every((r) => r.ok && r.changed === false)).toBe(true);
  });

  it("never touches the card's session state", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["open one"]);
    const opened = await registry.applyOpenTerminal(cards[0]!.id);
    expect(opened?.openedAt).toBeTruthy();

    await move.moveCards([cards[0]!.id], "done", {});

    const after = await registry.getCard(cards[0]!.id);
    expect(after?.column).toBe("done");
    expect(after?.openedAt).toBe(opened?.openedAt);
    expect(after?.pausedAt ?? null).toBeNull();
    expect(after?.hibernatedAt ?? null).toBeNull();
  });

  it("done is STICKY: a hook status does not undo the conclusion", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["shipped"]);
    await registry.updateCard(cards[0]!.id, { column: "waiting" });
    await move.moveCards([cards[0]!.id], "done", {});
    // The dying session's Stop hook lands right after — it must not drag the card back to waiting.
    await registry.applyCardStatus(cards[0]!.id, "waiting");
    expect((await registry.getCard(cards[0]!.id))?.column).toBe("done");
  });
});

describe("moveCards — partial failure", () => {
  it("one bad id does not abort the batch, and comes back with its own error", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["first", "third"]);

    const out = await move.moveCards([cards[0]!.id, "does-not-exist", cards[1]!.id], "done", {});

    expect(out).toMatchObject({ moved: 2, failed: 1 });
    expect(out.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out.results[1]).toMatchObject({ cardId: "does-not-exist", ok: false, error: "card not found" });
    expect((await registry.getCard(cards[0]!.id))?.column).toBe("done");
    expect((await registry.getCard(cards[1]!.id))?.column).toBe("done");
  });

  it("aborts the whole call only when nothing could work: bad column, empty list", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["a"]);
    await expect(move.moveCards([cards[0]!.id], "paused", {})).rejects.toThrow(/only moves cards to/);
    await expect(move.moveCards([], "done", {})).rejects.toThrow(/at least one card id/);
    // nothing was written by the refused calls
    expect((await registry.getCard(cards[0]!.id))?.column).toBe("backlog");
  });
});

describe("moveCards — authorization (the caller acts from its own card)", () => {
  it("refuses a card of another project, and still moves the caller's own", async () => {
    const { move, registry } = await fresh();
    const mine = await seed(registry, "billing", ["mine", "also mine"]);
    const theirs = await seed(registry, "gateway", ["not mine"]);

    const out = await move.moveCards(
      [mine.cards[1]!.id, theirs.cards[0]!.id],
      "done",
      { from: mine.cards[0]!.id },
    );

    expect(out).toMatchObject({ moved: 1, failed: 1 });
    expect(out.results[1]).toMatchObject({ cardId: theirs.cards[0]!.id, ok: false });
    expect(out.results[1]?.error).toMatch(/another project/);
    expect((await registry.getCard(mine.cards[1]!.id))?.column).toBe("done");
    // The other project's card was NOT written.
    expect((await registry.getCard(theirs.cards[0]!.id))?.column).toBe("backlog");
  });

  it("a caller may conclude its own card", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["me"]);
    const out = await move.moveCards([cards[0]!.id], "done", { from: cards[0]!.id });
    expect(out).toMatchObject({ moved: 1, failed: 0 });
  });

  it("refuses the whole call when `from` names no card", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["a"]);
    await expect(move.moveCards([cards[0]!.id], "done", { from: "ghost" })).rejects.toThrow(/caller card not found/);
    expect((await registry.getCard(cards[0]!.id))?.column).toBe("backlog");
  });

  it("a card caller must identify itself; the owner's browser need not", async () => {
    const { move, registry } = await fresh();
    const { cards } = await seed(registry, "billing", ["a"]);
    await expect(move.moveCards([cards[0]!.id], "done", { requireFrom: true })).rejects.toThrow(/\$VIBEHUB_CARD_ID/);
    // No caller and no requirement = the whole board, exactly like the UI.
    const out = await move.moveCards([cards[0]!.id], "done", {});
    expect(out).toMatchObject({ moved: 1, failed: 0 });
  });
});
