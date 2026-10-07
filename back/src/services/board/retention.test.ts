import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expiredDoneCards,
  lastActivityAt,
  DONE_RETENTION_DAYS,
  DONE_SWEEP_MAX,
  DONE_SWEEP_INTERVAL_MS,
} from "./retention.js";
import type { Card } from "./registry.js";

/**
 * DONE CARDS DO NOT PILE UP — a card parked in `done` for a day is finished work, and it is
 * still holding a worktree, a branch, a conversation and a browser profile in the
 * runner. After {@link DONE_RETENTION_DAYS} of total silence it is PURGED (the same purge as the
 * delete button), not hidden.
 *
 * What is pinned here:
 *  - the rule is measured from the card's LAST SIGN OF LIFE, not just from the move to `done`: a
 *    rename, a hook status or a human typing resets the clock (a legacy card without `doneAt`
 *    falls back to `updatedAt`, so the feature works on cards written before the field existed);
 *  - only `done` is swept — every other column is untouched however old it is;
 *  - retention 0 = OFF (the escape hatch), and one pass is capped so a first run on an old install
 *    can never be a silent mass deletion;
 *  - a runner that is down still gets the card off the board (and the sweep says what survived).
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function card(over: Partial<Card> = {}): Card {
  return {
    id: over.id ?? "card-1",
    projectId: "p1",
    title: "Concluído",
    column: "done",
    position: 0,
    base: "dev",
    tmuxSession: "card-abc",
    worktreeSlug: "concluido-abcd",
    createdAt: NOW - 400 * DAY,
    updatedAt: NOW - 200 * DAY,
    ...over,
  } as Card;
}

describe("lastActivityAt (pure) — the clock the retention reads", () => {
  it("is the NEWEST of the card's stamps, so any sign of life resets the clock", () => {
    expect(
      lastActivityAt(card({ doneAt: NOW - 300 * DAY, updatedAt: NOW - 300 * DAY, statusAt: NOW - 2 * DAY })),
    ).toBe(NOW - 2 * DAY);
    expect(
      lastActivityAt(card({ doneAt: NOW - 300 * DAY, updatedAt: NOW - 300 * DAY, humanActiveAt: NOW - DAY })),
    ).toBe(NOW - DAY);
  });

  it("falls back to updatedAt on a card written before doneAt existed", () => {
    expect(lastActivityAt(card({ doneAt: undefined, updatedAt: NOW - 190 * DAY }))).toBe(NOW - 190 * DAY);
  });
});

describe("expiredDoneCards (pure) — what the sweep is allowed to delete", () => {
  const run = (cards: Card[], retentionDays = DONE_RETENTION_DAYS): Card[] =>
    expiredDoneCards(cards, { now: NOW, retentionDays });

  it("a done card silent for longer than the retention is expired", () => {
    const old = card({ id: "old", doneAt: NOW - 181 * DAY, updatedAt: NOW - 181 * DAY });
    expect(run([old]).map((c) => c.id)).toEqual(["old"]);
  });

  it("exactly at the threshold (one day) counts as expired; an hour short does not", () => {
    const at = card({ id: "at", doneAt: NOW - DAY, updatedAt: NOW - DAY });
    const almost = card({ id: "almost", doneAt: NOW - 23 * HOUR, updatedAt: NOW - 23 * HOUR });
    expect(run([at, almost]).map((c) => c.id)).toEqual(["at"]);
  });

  it("NEVER touches another column, however old the card is", () => {
    const cards = (["backlog", "waiting", "working", "paused"] as const).map((column, i) =>
      card({ id: `c${i}`, column, doneAt: undefined, updatedAt: NOW - 900 * DAY }),
    );
    expect(run(cards)).toEqual([]);
  });

  it("a done card that was touched recently is NOT expired (the rename, the hook, the keystroke)", () => {
    const renamed = card({ id: "renamed", doneAt: NOW - 300 * DAY, updatedAt: NOW - 3 * HOUR });
    const reported = card({ id: "reported", doneAt: NOW - 300 * DAY, updatedAt: NOW - 300 * DAY, statusAt: NOW - HOUR });
    const typed = card({ id: "typed", doneAt: NOW - 300 * DAY, updatedAt: NOW - 300 * DAY, humanActiveAt: NOW - HOUR });
    expect(run([renamed, reported, typed])).toEqual([]);
  });

  it("a legacy done card without doneAt is judged by updatedAt", () => {
    const legacy = card({ id: "legacy", doneAt: undefined, updatedAt: NOW - 400 * DAY });
    const legacyFresh = card({ id: "fresh", doneAt: undefined, updatedAt: NOW - 10 * HOUR });
    expect(run([legacy, legacyFresh]).map((c) => c.id)).toEqual(["legacy"]);
  });

  it("retention 0 turns the sweep OFF — the escape hatch, not 'delete everything now'", () => {
    const ancient = card({ id: "ancient", doneAt: NOW - 5000 * DAY, updatedAt: NOW - 5000 * DAY });
    expect(run([ancient], 0)).toEqual([]);
  });

  it("the oldest go first, so a capped pass always collects the worst offenders", () => {
    const cards = [200, 900, 400].map((age) =>
      card({ id: `d${age}`, doneAt: NOW - age * DAY, updatedAt: NOW - age * DAY }),
    );
    expect(run(cards).map((c) => c.id)).toEqual(["d900", "d400", "d200"]);
  });
});

/* ------------------------------------------------------------------ the sweep */

const CONTAINER = "vibehub-runner";

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));
vi.mock("../github/client.js", () => ({ gitAuthHeaderFor: vi.fn(), tokenFor: vi.fn() }));

let dir = "";
let runScript: ReturnType<typeof vi.fn>;
let reg: typeof import("./registry.js");
let retention: typeof import("./retention.js");

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "test-key";
  env.config.runner.container = CONTAINER;
  const host = await import("../../runtime/host.js");
  runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
  (host.hostExecutor as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    kind: "local",
    label: "this machine",
    runScript,
    writeFile: vi.fn(),
    scriptArgs: vi.fn(() => ["bash", "-s"]),
  });
  reg = await import("./registry.js");
  retention = await import("./retention.js");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-retention-"));
  await fresh();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/**
 * The sweep is handed the CLOCK instead of the cards being back-dated: the stamps are written by
 * the registry itself (that is half of what is under test here), so the only honest way to make a
 * card a day old is to look at it a day from now.
 */
const inDays = (days: number): number => Date.now() + days * DAY;

describe("sweepDoneCards — the purge of what has been done for a day", () => {
  it("purges the card that has been done for too long and leaves the rest of the board alone", async () => {
    const project = await reg.createProject({ name: "erp-aux" });
    const done = await reg.createCard({ projectId: project.id, title: "Velho" });
    const working = await reg.createCard({ projectId: project.id, title: "Em curso" });
    await reg.updateCard(done.id, { column: "done" });
    await reg.updateCard(working.id, { column: "working" });

    const summary = await retention.sweepDoneCards({ now: inDays(200) });

    expect(summary).toMatchObject({ expired: 1, purged: 1, truncated: 0 });
    expect(await reg.getCard(done.id)).toBeUndefined();
    expect(await reg.getCard(working.id)).toBeDefined();
  });

  it("does nothing — and does not even touch the runner — when nothing is old enough", async () => {
    const project = await reg.createProject({ name: "erp-aux" });
    const c = await reg.createCard({ projectId: project.id, title: "Ontem" });
    await reg.updateCard(c.id, { column: "done" });
    runScript.mockClear();

    expect(await retention.sweepDoneCards({ now: Date.now() + 23 * HOUR })).toMatchObject({ expired: 0, purged: 0 });
    expect(runScript).not.toHaveBeenCalled();
    expect(await reg.getCard(c.id)).toBeDefined();
  });

  it("retention 0 deletes nothing, however ancient the done card is", async () => {
    const project = await reg.createProject({ name: "erp-aux" });
    const c = await reg.createCard({ projectId: project.id, title: "Ancestral" });
    await reg.updateCard(c.id, { column: "done" });

    expect(await retention.sweepDoneCards({ now: inDays(2000), retentionDays: 0 })).toMatchObject({
      expired: 0, purged: 0,
    });
    expect(await reg.getCard(c.id)).toBeDefined();
  });

  it("erases the card's files too — it is the delete button's purge, not a hide", async () => {
    const project = await reg.createProject({
      name: "erp-aux",
      repoFullName: "acme/erp-aux",
      cloneUrl: "https://github.com/acme/erp-aux.git",
    });
    const c = await reg.createCard({ projectId: project.id, title: "Velho" });
    await reg.updateCard(c.id, { column: "done" });
    runScript.mockClear();

    await retention.sweepDoneCards({ now: inDays(365) });

    const scripts = runScript.mock.calls.map((call) => String(call[0])).join("\n");
    expect(scripts).toContain(`tmux kill-session -t '${c.tmuxSession}'`);
    expect(scripts).toContain(c.worktreeSlug);
  });

  it("a runner that is down still gets the card off the board, and says what survived", async () => {
    const project = await reg.createProject({ name: "erp-aux" });
    const c = await reg.createCard({ projectId: project.id, title: "Velho" });
    await reg.updateCard(c.id, { column: "done" });
    runScript.mockRejectedValue(new Error("runner down"));

    const summary = await retention.sweepDoneCards({ now: inDays(365) });

    expect(summary.purged).toBe(1);
    expect(summary.incomplete).toBeGreaterThan(0);
    expect(await reg.getCard(c.id)).toBeUndefined();
  });

  it("a card RESCUED while the pass is running is not purged — the decision is re-taken per card", async () => {
    // The countdown says "any moment now"; the person drags the card out of done while the pass is
    // busy purging an older one (each purge is minutes of docker execs). The list was read before.
    const project = await reg.createProject({ name: "erp-aux" });
    const older = await reg.createCard({ projectId: project.id, title: "Mais velho" });
    const rescued = await reg.createCard({ projectId: project.id, title: "Resgatado" });
    await reg.updateCard(older.id, { column: "done" });
    await reg.updateCard(rescued.id, { column: "done" });
    let moved = false;
    runScript.mockImplementation(async () => {
      if (!moved) {
        moved = true;
        await reg.updateCard(rescued.id, { column: "waiting" });
      }
      return { stdout: "", stderr: "" };
    });

    const summary = await retention.sweepDoneCards({ now: inDays(365) });

    expect(await reg.getCard(older.id)).toBeUndefined();
    expect(await reg.getCard(rescued.id)).toBeDefined();
    expect(summary.purged).toBe(1);
  });

  it("two passes never run at once — a slow runner must not purge the same card twice", async () => {
    const project = await reg.createProject({ name: "erp-aux" });
    const c = await reg.createCard({ projectId: project.id, title: "Velho" });
    await reg.updateCard(c.id, { column: "done" });

    const [a, b] = await Promise.all([
      retention.sweepDoneCards({ now: inDays(365) }),
      retention.sweepDoneCards({ now: inDays(365) }),
    ]);

    expect(a.purged + b.purged).toBe(1);
  });

  it("caps one pass and reports what it left for the next — never a silent mass deletion", async () => {
    const project = await reg.createProject({ name: "erp-aux" });
    for (let i = 0; i < 3; i += 1) {
      const c = await reg.createCard({ projectId: project.id, title: `Velho ${i}` });
      await reg.updateCard(c.id, { column: "done" });
    }

    const summary = await retention.sweepDoneCards({ now: inDays(365), max: 2 });

    expect(summary).toMatchObject({ expired: 3, purged: 2, truncated: 1 });
    expect(await reg.listAllCards()).toHaveLength(1);
  });

  it("the defaults are the ones the product promises: ONE day, a capped pass", () => {
    expect(DONE_RETENTION_DAYS).toBe(1);
    expect(DONE_SWEEP_MAX).toBeGreaterThan(0);
  });

  it("sweeps at least hourly — a daily pass would turn the one-day promise into up to two", () => {
    expect(DONE_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(HOUR);
    expect(DONE_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
  });

});
