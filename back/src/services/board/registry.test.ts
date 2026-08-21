import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kebab,
  worktreeSlugFor,
  tmuxSessionFor,
  assertBranchName,
  assertSessionId,
  assertCloneUrl,
  assertRepoFullName,
  assertAccountSlug,
  accountSlugFor,
  assertMcpName,
  effectiveAccountSlug,
  assertModel,
  isValidModel,
  CLAUDE_MODELS,
  sanitizeDefaultAccountLabel,
  LABEL_MAX,
  BOARD_COLUMNS,
  columnAfterStatus,
  columnAfterOpen,
  reactivatesOnActivity,
  hasLiveSession,
  shouldEndSessionOnMove,
  shouldEndSessionOnStatus,
  sortProjects,
  normalizeProjectPositions,
  placeProject,
  normalizeMcpInput,
  type BoardColumn,
  type Project,
} from "./registry.js";

/**
 * The board registry. Pure helpers are imported once at the top; everything that touches the disk
 * goes through `freshRegistry()`, which points `config.dataDir` at a temp directory and re-imports
 * the module so it builds a brand new JsonStore (same pattern as secrets/vault.test.ts).
 *
 * THE MIRROR RULE — the central behaviour of the product — has its own describe blocks, both at the
 * pure level and at the registry level.
 */

let dir = "";

async function freshRegistry() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  return await import("./registry.js");
}

type Registry = Awaited<ReturnType<typeof freshRegistry>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-board-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure derivations and validation
// ---------------------------------------------------------------------------

describe("derivations and validation (pure)", () => {
  it("kebab: lower case, no accents, dashes; empty -> 'card'", () => {
    expect(kebab("Fix the checkout bug")).toBe("fix-the-checkout-bug");
    expect(kebab("Ação & Reação!!")).toBe("acao-reacao");
    expect(kebab("---")).toBe("card");
    expect(kebab("")).toBe("card");
    expect(kebab("a".repeat(80))).toHaveLength(40);
  });

  it("worktreeSlug = kebab of the title + first 4 of the id; tmuxSession = card- + first 8", () => {
    const id = "a1b2c3d4-e5f6-4a4a-8b8b-000011112222";
    expect(worktreeSlugFor("Inventory intake", id)).toBe("inventory-intake-a1b2");
    expect(tmuxSessionFor(id)).toBe("card-a1b2c3d4");
  });

  it("worktreeSlug stays shell-safe even for a hostile title", () => {
    const id = "a1b2c3d4-e5f6-4a4a-8b8b-000011112222";
    expect(worktreeSlugFor("Ção /$(rm -rf ~) `id` ; :", id)).toMatch(/^[a-z0-9-]+$/);
    expect(worktreeSlugFor("../../etc/passwd", id)).toMatch(/^[a-z0-9-]+$/);
  });

  it("assertBranchName: accepts sane names; rejects '-' prefix, '..', bad charset and empty", () => {
    expect(assertBranchName("dev")).toBe("dev");
    expect(assertBranchName("feat/checkout-2.0")).toBe("feat/checkout-2.0");
    expect(assertBranchName("  main  ")).toBe("main");
    expect(() => assertBranchName("-rf")).toThrow(/invalid branch/);
    expect(() => assertBranchName("a..b")).toThrow(/invalid branch/);
    expect(() => assertBranchName("has space")).toThrow(/invalid branch/);
    expect(() => assertBranchName("")).toThrow(/invalid branch/);
    expect(() => assertBranchName("a".repeat(81))).toThrow(/invalid branch/);
  });

  it("assertBranchName rejects every shell metacharacter", () => {
    for (const bad of [
      "b;rm -rf /",
      "b && whoami",
      "b|cat",
      "b`id`",
      "b$(id)",
      "b>out",
      "b<in",
      "b\nrm",
      "b'q'",
      'b"q"',
      "b*",
      "b#c",
      "b(c)",
      "b&",
      "b\\c",
      "b!c",
      "$IFS",
    ]) {
      expect(() => assertBranchName(bad)).toThrow(/invalid branch/);
    }
  });

  it("assertSessionId: uuid only, normalized to lower case; anything else throws", () => {
    expect(assertSessionId("A1B2C3D4-E5F6-4A4A-8B8B-000011112222")).toBe("a1b2c3d4-e5f6-4a4a-8b8b-000011112222");
    expect(() => assertSessionId("not-a-uuid")).toThrow(/resumeSessionId/);
    expect(() => assertSessionId("")).toThrow(/resumeSessionId/);
  });

  it("assertSessionId rejects a uuid with shell metacharacters appended", () => {
    for (const bad of [
      "a1b2c3d4-e5f6-4a4a-8b8b-000011112222; rm -rf /",
      "a1b2c3d4-e5f6-4a4a-8b8b-000011112222 && id",
      "$(id)",
      "`id`",
      "a1b2c3d4-e5f6-4a4a-8b8b-000011112222\nid",
    ]) {
      expect(() => assertSessionId(bad)).toThrow(/resumeSessionId/);
    }
  });

  it("assertCloneUrl: https://github.com/owner/repo[.git] only", () => {
    expect(assertCloneUrl("https://github.com/acme/widgets.git")).toBe("https://github.com/acme/widgets.git");
    expect(assertCloneUrl("https://github.com/acme/widgets")).toBe("https://github.com/acme/widgets");
    expect(() => assertCloneUrl("git@github.com:acme/widgets.git")).toThrow(/invalid cloneUrl/);
    expect(() => assertCloneUrl("http://github.com/acme/widgets")).toThrow(/invalid cloneUrl/);
    expect(() => assertCloneUrl("https://github.com/acme/widgets.git; rm -rf /")).toThrow(/invalid cloneUrl/);
    expect(() => assertCloneUrl("https://github.com/acme/widgets$(id)")).toThrow(/invalid cloneUrl/);
  });

  it("assertRepoFullName: owner/repo", () => {
    expect(assertRepoFullName("acme/widgets")).toBe("acme/widgets");
    expect(() => assertRepoFullName("widgets")).toThrow(/invalid repoFullName/);
    expect(() => assertRepoFullName("a/b/c")).toThrow(/invalid repoFullName/);
    expect(() => assertRepoFullName("acme/widgets;id")).toThrow(/invalid repoFullName/);
  });

  it("assertAccountSlug: [a-z0-9-]{2,30}; 'default' is reserved; injection rejected", () => {
    expect(assertAccountSlug("work")).toBe("work");
    expect(assertAccountSlug("team-two")).toBe("team-two");
    expect(() => assertAccountSlug("default")).toThrow(/reserved/);
    expect(() => assertAccountSlug("A")).toThrow(/invalid account slug/);
    expect(() => assertAccountSlug("Upper")).toThrow(/invalid account slug/);
    expect(() => assertAccountSlug("a/../b")).toThrow(/invalid account slug/);
    expect(() => assertAccountSlug("a;id")).toThrow(/invalid account slug/);
    expect(() => assertAccountSlug("a".repeat(31))).toThrow(/invalid account slug/);
  });

  it("accountSlugFor: kebab of the name, max 30; a name that derives nothing is rejected", () => {
    expect(accountSlugFor("Work Account")).toBe("work-account");
    expect(accountSlugFor("Créditos")).toBe("creditos");
    expect(accountSlugFor("a".repeat(60))).toHaveLength(30);
    expect(() => accountSlugFor("!")).toThrow(/invalid account name/);
    expect(() => accountSlugFor("")).toThrow(/invalid account name/);
  });

  it("assertMcpName: [A-Za-z0-9_-]{2,40}", () => {
    expect(assertMcpName("my_server-1")).toBe("my_server-1");
    expect(() => assertMcpName("a")).toThrow(/invalid MCP name/);
    expect(() => assertMcpName("bad name")).toThrow(/invalid MCP name/);
    expect(() => assertMcpName("bad;name")).toThrow(/invalid MCP name/);
  });

  it("effectiveAccountSlug: card > project > undefined (= the runner default account)", () => {
    expect(effectiveAccountSlug({ accountSlug: "work" }, { defaultAccountSlug: "team" })).toBe("work");
    expect(effectiveAccountSlug({}, { defaultAccountSlug: "team" })).toBe("team");
    expect(effectiveAccountSlug({}, {})).toBeUndefined();
  });

  it("model whitelist: exactly the four ids, and nothing else passes", () => {
    expect([...CLAUDE_MODELS]).toEqual(["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
    for (const id of CLAUDE_MODELS) {
      expect(isValidModel(id)).toBe(true);
      expect(assertModel(id)).toBe(id);
    }
    expect(assertModel("  claude-opus-5  ")).toBe("claude-opus-5");
    for (const bad of ["gpt-4", "claude-opus-5; rm -rf /", "claude-opus-5$(id)", "", "CLAUDE-OPUS-5"]) {
      expect(isValidModel(bad)).toBe(false);
      expect(() => assertModel(bad)).toThrow(/invalid model/);
    }
    expect(isValidModel(null)).toBe(false);
    expect(isValidModel(undefined)).toBe(false);
  });

  it("sanitizeDefaultAccountLabel: trims, caps at 40, empty -> undefined", () => {
    expect(sanitizeDefaultAccountLabel("  Main  ")).toBe("Main");
    expect(sanitizeDefaultAccountLabel("x".repeat(60))).toHaveLength(LABEL_MAX);
    expect(sanitizeDefaultAccountLabel("   ")).toBeUndefined();
    expect(sanitizeDefaultAccountLabel(null)).toBeUndefined();
    expect(sanitizeDefaultAccountLabel(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The mirror rule (pure)
// ---------------------------------------------------------------------------

describe("THE MIRROR RULE (columnAfterStatus / columnAfterOpen — pure)", () => {
  it("working moves waiting -> working", () => {
    expect(columnAfterStatus("waiting", "working")).toBe("working");
  });

  it("waiting moves working -> waiting", () => {
    expect(columnAfterStatus("working", "waiting")).toBe("waiting");
  });

  it("a status does not take a card out of the matching mirror column (idempotent)", () => {
    expect(columnAfterStatus("working", "working")).toBe("working");
    expect(columnAfterStatus("waiting", "waiting")).toBe("waiting");
  });

  it("backlog, paused and done are sticky for BOTH statuses", () => {
    for (const sticky of ["backlog", "paused", "done"] as BoardColumn[]) {
      expect(columnAfterStatus(sticky, "working")).toBe(sticky);
      expect(columnAfterStatus(sticky, "waiting")).toBe(sticky);
    }
  });

  it("every column is covered by the mirror rule with a defined answer", () => {
    for (const col of BOARD_COLUMNS) {
      for (const status of ["working", "waiting"] as const) {
        expect(BOARD_COLUMNS).toContain(columnAfterStatus(col, status));
      }
      expect(BOARD_COLUMNS).toContain(columnAfterOpen(col));
    }
  });

  it("opening: backlog AND paused -> waiting; done stays done; the mirror columns stay put", () => {
    expect(columnAfterOpen("backlog")).toBe("waiting");
    expect(columnAfterOpen("paused")).toBe("waiting");
    expect(columnAfterOpen("done")).toBe("done");
    expect(columnAfterOpen("working")).toBe("working");
    expect(columnAfterOpen("waiting")).toBe("waiting");
  });
});

describe("pause decisions (hasLiveSession / shouldEndSessionOnMove / shouldEndSessionOnStatus — pure)", () => {
  it("hasLiveSession: only with openedAt and without pausedAt", () => {
    expect(hasLiveSession({ openedAt: 1 })).toBe(true);
    expect(hasLiveSession({ openedAt: 1, pausedAt: null })).toBe(true);
    expect(hasLiveSession({ openedAt: 1, pausedAt: 2 })).toBe(false);
    expect(hasLiveSession({})).toBe(false);
  });

  it("shouldEndSessionOnMove: ends now when idle; working means a pending pause", () => {
    expect(shouldEndSessionOnMove("waiting")).toBe(true);
    expect(shouldEndSessionOnMove(null)).toBe(true);
    expect(shouldEndSessionOnMove(undefined)).toBe(true);
    expect(shouldEndSessionOnMove("working")).toBe(false);
  });

  it("shouldEndSessionOnStatus: only in paused, with a live session, and once Claude stopped working", () => {
    expect(shouldEndSessionOnStatus("waiting", "paused", true)).toBe(true);
    expect(shouldEndSessionOnStatus("working", "paused", true)).toBe(false);
    expect(shouldEndSessionOnStatus("waiting", "paused", false)).toBe(false);
    expect(shouldEndSessionOnStatus("waiting", "working", true)).toBe(false);
  });

  it("reactivatesOnActivity: only working, and only on paused/done", () => {
    expect(reactivatesOnActivity({ column: "done" }, "working")).toBe(true);
    expect(reactivatesOnActivity({ column: "paused" }, "working")).toBe(true);
    expect(reactivatesOnActivity({ column: "backlog", pausedAt: 1 }, "working")).toBe(true);
    expect(reactivatesOnActivity({ column: "done" }, "waiting")).toBe(false);
    expect(reactivatesOnActivity({ column: "paused" }, "waiting")).toBe(false);
    expect(reactivatesOnActivity({ column: "backlog" }, "working")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Project ordering (pure)
// ---------------------------------------------------------------------------

describe("project ordering (sortProjects / normalizeProjectPositions / placeProject — pure)", () => {
  function p(id: string, position: number | undefined, createdAt: number): Project {
    return { id, name: id, baseBranch: "dev", position: position as number, createdAt };
  }

  it("sortProjects: by position, tiebreak by createdAt then id", () => {
    const list = [p("c", 2, 30), p("a", 0, 10), p("b", 1, 20)];
    expect(sortProjects(list).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("sortProjects: projects with no position fall back to createdAt and go last", () => {
    const list = [p("old2", undefined, 200), p("num", 0, 999), p("old1", undefined, 100)];
    expect(sortProjects(list).map((x) => x.id)).toEqual(["num", "old1", "old2"]);
  });

  it("sortProjects does not mutate the input", () => {
    const list = [p("b", 1, 20), p("a", 0, 10)];
    const copy = list.map((x) => ({ ...x }));
    sortProjects(list);
    expect(list).toEqual(copy);
  });

  it("normalizeProjectPositions: renumbers 0..n-1 and reports whether anything changed", () => {
    const list = [p("b", 5, 20), p("a", 3, 10)];
    expect(normalizeProjectPositions(list)).toBe(true);
    expect(list.map((x) => [x.id, x.position])).toEqual([
      ["b", 1],
      ["a", 0],
    ]);
    expect(normalizeProjectPositions(list)).toBe(false);
  });

  it("placeProject: moves to the requested slot and renumbers everything", () => {
    const list = [p("a", 0, 10), p("b", 1, 20), p("c", 2, 30)];
    placeProject(list, "c", 0);
    expect(sortProjects(list).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("placeProject: a position past the end is clamped; an unknown id throws", () => {
    const list = [p("a", 0, 10), p("b", 1, 20)];
    placeProject(list, "a", 99);
    expect(sortProjects(list).map((x) => x.id)).toEqual(["b", "a"]);
    expect(() => placeProject(list, "nope", 0)).toThrow(/project not found/);
  });
});

// ---------------------------------------------------------------------------
// MCP shape validation (pure)
// ---------------------------------------------------------------------------

describe("normalizeMcpInput (pure)", () => {
  it("stdio: keeps command/args and de-duplicates env keys", () => {
    const out = normalizeMcpInput({
      name: "files",
      kind: "stdio",
      command: "npx",
      args: ["-y", "some-server", ""],
      envKeys: ["API_TOKEN", "API_TOKEN", "OTHER"],
    });
    expect(out).toEqual({ name: "files", kind: "stdio", command: "npx", args: ["-y", "some-server"], envKeys: ["API_TOKEN", "OTHER"] });
  });

  it("http/sse: requires an http(s) url and validates header names", () => {
    expect(normalizeMcpInput({ name: "remote", kind: "http", url: "https://example.test/mcp", headerKeys: ["Authorization"] })).toEqual({
      name: "remote",
      kind: "http",
      url: "https://example.test/mcp",
      headerKeys: ["Authorization"],
    });
    expect(() => normalizeMcpInput({ name: "remote", kind: "sse", url: "ftp://example.test" })).toThrow(/invalid url/);
    expect(() => normalizeMcpInput({ name: "remote", kind: "http", url: "https://example.test/$(id)" })).toThrow(/invalid url/);
    expect(() => normalizeMcpInput({ name: "remote", kind: "http", url: "https://x.test", headerKeys: ["Bad Header"] })).toThrow(
      /invalid header name/,
    );
  });

  it("rejects a bad kind, a missing command, and control characters", () => {
    expect(() => normalizeMcpInput({ name: "x1", kind: "socket" as never })).toThrow(/invalid MCP kind/);
    expect(() => normalizeMcpInput({ name: "x1", kind: "stdio" })).toThrow(/command is required/);
    expect(() => normalizeMcpInput({ name: "x1", kind: "stdio", command: "np\nx" })).toThrow(/command is required/);
    expect(() => normalizeMcpInput({ name: "x1", kind: "stdio", command: "npx", args: ["a\nb"] })).toThrow(/invalid arg/);
    expect(() => normalizeMcpInput({ name: "x1", kind: "stdio", command: "npx", envKeys: ["1BAD"] })).toThrow(
      /invalid environment variable name/,
    );
  });
});

// ---------------------------------------------------------------------------
// Registry on disk
// ---------------------------------------------------------------------------

describe("board registry (persisted)", () => {
  let reg: Registry;

  beforeEach(async () => {
    reg = await freshRegistry();
  });

  async function seedProject(over: Partial<Parameters<Registry["createProject"]>[0]> = {}) {
    return reg.createProject({
      name: "widgets",
      repoFullName: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      ...over,
    });
  }

  it("starts empty when there is no file yet", async () => {
    expect(await reg.listProjects()).toEqual([]);
    expect(await reg.listCards("nope")).toEqual([]);
    expect(await reg.listAccounts()).toEqual([]);
    expect(await reg.listMcps()).toEqual([]);
    expect(await reg.getConfig()).toEqual({});
  });

  it("persists board.json with mode 600 and the documented shape", async () => {
    await seedProject();
    const file = join(dir, "board.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["accounts", "cards", "config", "mcps", "projects"]);
  });

  it("createProject: default base branch 'dev', validated repo/clone/branch", async () => {
    const p = await seedProject();
    expect(p.baseBranch).toBe("dev");
    expect(p.position).toBe(0);
    expect(p.repoFullName).toBe("acme/widgets");
    await expect(seedProject({ name: "" })).rejects.toThrow(/name is required/);
    await expect(seedProject({ baseBranch: "a;rm" })).rejects.toThrow(/invalid branch/);
    await expect(seedProject({ cloneUrl: "https://evil.test/x/y" })).rejects.toThrow(/invalid cloneUrl/);
    await expect(seedProject({ repoFullName: "nope" })).rejects.toThrow(/invalid repoFullName/);
  });

  it("updateProject: clearing repo/clone with null turns it into a scratch project", async () => {
    const p = await seedProject();
    const updated = await reg.updateProject(p.id, { repoFullName: null, cloneUrl: null, name: "scratch" });
    expect(updated.repoFullName).toBeUndefined();
    expect(updated.cloneUrl).toBeUndefined();
    expect(updated.name).toBe("scratch");
    await expect(reg.updateProject(p.id, { name: "  " })).rejects.toThrow(/name cannot be empty/);
    await expect(reg.updateProject("nope", { name: "x" })).rejects.toThrow(/project not found/);
  });

  it("createCard: lands at the end of the backlog with derived session/slug and inherited base", async () => {
    const p = await seedProject({ baseBranch: "main" });
    const a = await reg.createCard({ projectId: p.id, title: "First card" });
    const b = await reg.createCard({ projectId: p.id, title: "Second card" });
    expect(a.column).toBe("backlog");
    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    expect(a.base).toBe("main");
    expect(a.tmuxSession).toBe(`card-${a.id.slice(0, 8)}`);
    expect(a.worktreeSlug).toBe(`first-card-${a.id.slice(0, 4)}`);
    expect(a.status).toBeNull();
    await expect(reg.createCard({ projectId: p.id, title: " " })).rejects.toThrow(/title is required/);
    await expect(reg.createCard({ projectId: "nope", title: "x" })).rejects.toThrow(/project not found/);
  });

  it("removing a project also removes its cards, and renumbers the sidebar", async () => {
    const keep = await seedProject({ name: "keep" });
    const doomed = await seedProject({ name: "doomed" });
    const last = await seedProject({ name: "last" });
    const keptCard = await reg.createCard({ projectId: keep.id, title: "keep me" });
    await reg.createCard({ projectId: doomed.id, title: "goes away 1" });
    await reg.createCard({ projectId: doomed.id, title: "goes away 2" });

    const removed = await reg.removeProject(doomed.id);
    expect(removed.project.id).toBe(doomed.id);
    expect(removed.cards).toHaveLength(2);

    expect(await reg.listCards(doomed.id)).toEqual([]);
    expect((await reg.listAllCards()).map((c) => c.id)).toEqual([keptCard.id]);
    expect((await reg.listProjects()).map((p) => [p.name, p.position])).toEqual([
      ["keep", 0],
      ["last", 1],
    ]);
    expect(await reg.getProject(last.id)).toBeTruthy();
    await expect(reg.removeProject("nope")).rejects.toThrow(/project not found/);
  });

  it("a manual move is never blocked and renumbers both columns", async () => {
    const p = await seedProject();
    const a = await reg.createCard({ projectId: p.id, title: "a" });
    const b = await reg.createCard({ projectId: p.id, title: "b" });
    const c = await reg.createCard({ projectId: p.id, title: "c" });

    // b: backlog -> done (finishing is always manual)
    const movedB = await reg.updateCard(b.id, { column: "done" });
    expect(movedB.column).toBe("done");
    expect(movedB.position).toBe(0);
    // the backlog closed the gap
    const backlog = (await reg.listCards(p.id)).filter((x) => x.column === "backlog");
    expect(backlog.map((x) => [x.id, x.position])).toEqual([
      [a.id, 0],
      [c.id, 1],
    ]);

    // c to the front of the backlog
    await reg.updateCard(c.id, { column: "backlog", position: 0 });
    const reordered = (await reg.listCards(p.id)).filter((x) => x.column === "backlog");
    expect(reordered.map((x) => x.id)).toEqual([c.id, a.id]);

    // a position past the end is clamped
    await reg.updateCard(c.id, { position: 99 });
    expect((await reg.listCards(p.id)).filter((x) => x.column === "backlog").map((x) => x.id)).toEqual([a.id, c.id]);
  });

  it("listCards orders by column (backlog, waiting, working, paused, done) then position", async () => {
    const p = await seedProject();
    const backlog = await reg.createCard({ projectId: p.id, title: "in backlog" });
    const waiting = await reg.createCard({ projectId: p.id, title: "in waiting" });
    const working = await reg.createCard({ projectId: p.id, title: "in working" });
    const paused = await reg.createCard({ projectId: p.id, title: "in paused" });
    const done = await reg.createCard({ projectId: p.id, title: "in done" });
    await reg.updateCard(waiting.id, { column: "waiting" });
    await reg.updateCard(working.id, { column: "working" });
    await reg.updateCard(paused.id, { column: "paused" });
    await reg.updateCard(done.id, { column: "done" });
    expect((await reg.listCards(p.id)).map((c) => c.id)).toEqual([backlog.id, waiting.id, working.id, paused.id, done.id]);
  });

  it("rejects an invalid column and an invalid position", async () => {
    const p = await seedProject();
    const card = await reg.createCard({ projectId: p.id, title: "a" });
    await expect(reg.updateCard(card.id, { column: "nope" as never })).rejects.toThrow(/invalid column/);
    await expect(reg.updateCard(card.id, { position: -1 })).rejects.toThrow(/invalid position/);
    await expect(reg.updateCard(card.id, { position: 1.5 })).rejects.toThrow(/invalid position/);
    await expect(reg.updateCard("nope", { title: "x" })).rejects.toThrow(/card not found/);
    await expect(reg.updateCard(card.id, { title: " " })).rejects.toThrow(/title cannot be empty/);
  });

  it("renaming a card never changes worktreeSlug or tmuxSession (they exist in the runner already)", async () => {
    const p = await seedProject();
    const card = await reg.createCard({ projectId: p.id, title: "old title" });
    const renamed = await reg.updateCard(card.id, { title: "brand new title" });
    expect(renamed.title).toBe("brand new title");
    expect(renamed.worktreeSlug).toBe(card.worktreeSlug);
    expect(renamed.tmuxSession).toBe(card.tmuxSession);
  });

  it("removeCard renumbers its column and drops it from the listing", async () => {
    const p = await seedProject();
    const a = await reg.createCard({ projectId: p.id, title: "a" });
    const b = await reg.createCard({ projectId: p.id, title: "b" });
    const c = await reg.createCard({ projectId: p.id, title: "c" });
    expect((await reg.removeCard(b.id))?.id).toBe(b.id);
    expect((await reg.listCards(p.id)).map((x) => [x.id, x.position])).toEqual([
      [a.id, 0],
      [c.id, 1],
    ]);
    expect(await reg.removeCard("nope")).toBeUndefined();
  });

  // -------------------------------------------------------------------------

  describe("THE MIRROR RULE applied on the registry (applyCardStatus / applyOpenTerminal)", () => {
    async function cardIn(column: BoardColumn) {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: `card in ${column}` });
      return column === "backlog" ? card : await reg.updateCard(card.id, { column });
    }

    it("working moves waiting -> working and stores the dot", async () => {
      const card = await cardIn("waiting");
      const after = await reg.applyCardStatus(card.id, "working");
      expect(after?.column).toBe("working");
      expect(after?.status).toBe("working");
      expect(after?.statusAt).toBeGreaterThan(0);
    });

    it("waiting moves working -> waiting", async () => {
      const card = await cardIn("working");
      expect((await reg.applyCardStatus(card.id, "waiting"))?.column).toBe("waiting");
    });

    it("a card in backlog is never moved by a status (either one), but the dot is stored", async () => {
      const card = await cardIn("backlog");
      expect((await reg.applyCardStatus(card.id, "waiting"))?.column).toBe("backlog");
      const after = await reg.applyCardStatus(card.id, "working");
      expect(after?.column).toBe("backlog");
      expect(after?.status).toBe("working");
    });

    it("a card in done stays in done for waiting AND for opening the terminal", async () => {
      const card = await cardIn("done");
      expect((await reg.applyCardStatus(card.id, "waiting"))?.column).toBe("done");
      expect((await reg.applyOpenTerminal(card.id))?.column).toBe("done");
    });

    it("a card in paused (moved by hand, never opened) is not moved by waiting", async () => {
      const card = await cardIn("paused");
      expect((await reg.applyCardStatus(card.id, "waiting"))?.column).toBe("paused");
    });

    it("opening a card in backlog moves it to waiting, and is idempotent", async () => {
      const card = await cardIn("backlog");
      const first = await reg.applyOpenTerminal(card.id);
      expect(first?.column).toBe("waiting");
      expect((await reg.applyOpenTerminal(card.id))?.column).toBe("waiting");
    });

    it("opening stamps openedAt on the first open and never re-stamps it", async () => {
      const card = await cardIn("backlog");
      const first = await reg.applyOpenTerminal(card.id);
      expect(first?.openedAt).toBeGreaterThan(0);
      const second = await reg.applyOpenTerminal(card.id);
      expect(second?.openedAt).toBe(first?.openedAt);
    });

    it("opening does not touch the status dot (that belongs to the hooks)", async () => {
      const card = await cardIn("backlog");
      await reg.applyCardStatus(card.id, "waiting");
      const opened = await reg.applyOpenTerminal(card.id);
      expect(opened?.status).toBe("waiting");
    });

    it("an unknown card returns undefined (the caller decides the 404)", async () => {
      expect(await reg.applyCardStatus("nope", "working")).toBeUndefined();
      expect(await reg.applyOpenTerminal("nope")).toBeUndefined();
      expect(await reg.markPrepared("nope")).toBeUndefined();
    });
  });

  describe("pre-provisioning (markPrepared)", () => {
    it("stamps preparedAt once and touches nothing else", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      const prepared = await reg.markPrepared(card.id);
      expect(prepared?.preparedAt).toBeGreaterThan(0);
      expect(prepared?.column).toBe("backlog");
      expect(prepared?.openedAt).toBeUndefined();
      expect(prepared?.status).toBeNull();
      const again = await reg.markPrepared(card.id);
      expect(again?.preparedAt).toBe(prepared?.preparedAt);
    });

    it("opening after preparing still moves backlog -> waiting and keeps preparedAt", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      const prepared = await reg.markPrepared(card.id);
      const opened = await reg.applyOpenTerminal(card.id);
      expect(opened?.column).toBe("waiting");
      expect(opened?.openedAt).toBeGreaterThan(0);
      expect(opened?.preparedAt).toBe(prepared?.preparedAt);
    });
  });

  describe("reactivation by activity", () => {
    it("working on a card in DONE sends it to working (the user typed: the work is back)", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await reg.updateCard(card.id, { column: "done" });
      const after = await reg.applyCardStatus(card.id, "working");
      expect(after?.column).toBe("working");
      expect(after?.status).toBe("working");
    });

    it("working on a PAUSED card sends it to working and clears pausedAt", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await reg.applyOpenTerminal(card.id);
      await reg.pauseCard(card.id);
      const paused = await reg.getCard(card.id);
      expect(paused?.pausedAt).toBeGreaterThan(0);
      const after = await reg.applyCardStatus(card.id, "working");
      expect(after?.column).toBe("working");
      expect(after?.pausedAt).toBeNull();
    });

    it("waiting never reactivates: done stays done, paused stays paused, backlog stays backlog", async () => {
      const p = await seedProject();
      const done = await reg.createCard({ projectId: p.id, title: "done" });
      const paused = await reg.createCard({ projectId: p.id, title: "paused" });
      const backlog = await reg.createCard({ projectId: p.id, title: "backlog" });
      await reg.updateCard(done.id, { column: "done" });
      await reg.applyOpenTerminal(paused.id);
      await reg.pauseCard(paused.id);
      expect((await reg.applyCardStatus(done.id, "waiting"))?.column).toBe("done");
      expect((await reg.applyCardStatus(paused.id, "waiting"))?.column).toBe("paused");
      expect((await reg.applyCardStatus(backlog.id, "waiting"))?.column).toBe("backlog");
    });
  });

  describe("card fields validated because they reach a shell", () => {
    it("resumeSessionId: stores a lower-cased uuid, null clears, non-uuid rejected", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      const set = await reg.updateCard(card.id, { resumeSessionId: "A1B2C3D4-E5F6-4A4A-8B8B-000011112222" });
      expect(set.resumeSessionId).toBe("a1b2c3d4-e5f6-4a4a-8b8b-000011112222");
      expect((await reg.updateCard(card.id, { resumeSessionId: null })).resumeSessionId).toBeUndefined();
      await expect(reg.updateCard(card.id, { resumeSessionId: "abc; rm -rf /" })).rejects.toThrow(/resumeSessionId/);
    });

    it("branch and base: validated, null/'' clears branch, injection rejected", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      expect((await reg.updateCard(card.id, { branch: "feat/x" })).branch).toBe("feat/x");
      expect((await reg.updateCard(card.id, { branch: "" })).branch).toBeUndefined();
      expect((await reg.updateCard(card.id, { base: "release/1.0" })).base).toBe("release/1.0");
      await expect(reg.updateCard(card.id, { branch: "x`id`" })).rejects.toThrow(/invalid branch/);
      await expect(reg.updateCard(card.id, { base: "x && id" })).rejects.toThrow(/invalid branch/);
    });

    it("model: only the whitelist is stored; null/'' clears it", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      expect((await reg.updateCard(card.id, { model: "claude-opus-5" })).model).toBe("claude-opus-5");
      expect((await reg.updateCard(card.id, { model: null })).model).toBeUndefined();
      expect((await reg.updateCard(card.id, { model: "claude-fable-5" })).model).toBe("claude-fable-5");
      expect((await reg.updateCard(card.id, { model: "" })).model).toBeUndefined();
      await expect(reg.updateCard(card.id, { model: "claude-opus-5; rm -rf /" })).rejects.toThrow(/invalid model/);
      await expect(reg.updateCard(card.id, { model: "gpt-4" })).rejects.toThrow(/invalid model/);
    });
  });

  describe("pause and resume (pauseCard / applyOpenTerminal)", () => {
    it("pausing an IDLE card stamps pausedAt, clears the dot and moves it to paused (sticky)", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await reg.applyOpenTerminal(card.id);
      await reg.applyCardStatus(card.id, "waiting");
      const paused = await reg.pauseCard(card.id);
      expect(paused.column).toBe("paused");
      expect(paused.pausedAt).toBeGreaterThan(0);
      expect(paused.status).toBeNull();
      expect(paused.statusAt).toBeUndefined();
      // a late waiting hook does not move it
      expect((await reg.applyCardStatus(card.id, "waiting"))?.column).toBe("paused");
    });

    it("pausing a WORKING card is a PENDING pause: it moves but keeps the live session and the green dot", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await reg.applyOpenTerminal(card.id);
      await reg.applyCardStatus(card.id, "working");
      const pending = await reg.pauseCard(card.id);
      expect(pending.column).toBe("paused");
      expect(pending.pausedAt).toBeUndefined();
      expect(pending.status).toBe("working");
      expect(hasLiveSession(pending)).toBe(true);
      expect(shouldEndSessionOnMove(pending.status)).toBe(false);

      // still working -> stays pending, dot refreshed
      const stillWorking = await reg.applyCardStatus(card.id, "working");
      expect(stillWorking?.column).toBe("paused");
      expect(stillWorking?.pausedAt).toBeUndefined();

      // Claude finishes -> the pause is carried out
      const finished = await reg.applyCardStatus(card.id, "waiting");
      expect(finished?.column).toBe("paused");
      expect(finished?.pausedAt).toBeGreaterThan(0);
      expect(finished?.status).toBeNull();
      expect(hasLiveSession(finished!)).toBe(false);
    });

    it("a pending pause is cancelled by reopening the card before Claude finishes", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await reg.applyOpenTerminal(card.id);
      await reg.applyCardStatus(card.id, "working");
      await reg.pauseCard(card.id);
      const reopened = await reg.applyOpenTerminal(card.id);
      expect(reopened?.column).toBe("waiting");
      expect(reopened?.pausedAt).toBeFalsy();
    });

    it("pausing an idle card in DONE keeps it in done (the user's own sticky column)", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await reg.applyOpenTerminal(card.id);
      await reg.updateCard(card.id, { column: "done" });
      const paused = await reg.pauseCard(card.id);
      expect(paused.column).toBe("done");
      expect(paused.pausedAt).toBeGreaterThan(0);
    });

    it("pausing is idempotent and renumbers the source column", async () => {
      const p = await seedProject();
      const a = await reg.createCard({ projectId: p.id, title: "a" });
      const b = await reg.createCard({ projectId: p.id, title: "b" });
      await reg.applyOpenTerminal(a.id);
      const first = await reg.pauseCard(a.id);
      const second = await reg.pauseCard(a.id);
      expect(second.pausedAt).toBe(first.pausedAt);
      expect((await reg.getCard(b.id))?.position).toBe(0);
    });

    it("pausing a card that was never opened, or one that does not exist, throws", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await expect(reg.pauseCard(card.id)).rejects.toThrow(/never opened/);
      await expect(reg.pauseCard("nope")).rejects.toThrow(/card not found/);
    });

    it("resuming = opening: it leaves paused, clears pausedAt, goes to waiting and keeps openedAt", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      const opened = await reg.applyOpenTerminal(card.id);
      await reg.pauseCard(card.id);
      const resumed = await reg.applyOpenTerminal(card.id);
      expect(resumed?.column).toBe("waiting");
      expect(resumed?.pausedAt).toBeNull();
      expect(resumed?.openedAt).toBe(opened?.openedAt);
    });
  });

  describe("concurrent mutations (the whole read-modify-write is serialized)", () => {
    it("two concurrent applyCardStatus on different cards: no update is lost", async () => {
      const p = await seedProject();
      const a = await reg.createCard({ projectId: p.id, title: "a" });
      const b = await reg.createCard({ projectId: p.id, title: "b" });
      await reg.updateCard(a.id, { column: "waiting" });
      await reg.updateCard(b.id, { column: "waiting" });
      await Promise.all([reg.applyCardStatus(a.id, "working"), reg.applyCardStatus(b.id, "working")]);
      expect((await reg.getCard(a.id))?.column).toBe("working");
      expect((await reg.getCard(b.id))?.column).toBe("working");
    });

    it("a manual 'done' racing a late status hook is not undone, in either order", async () => {
      const p = await seedProject();
      for (const order of ["manual-first", "hook-first"] as const) {
        const card = await reg.createCard({ projectId: p.id, title: `race ${order}` });
        await reg.updateCard(card.id, { column: "working" });
        const manual = () => reg.updateCard(card.id, { column: "done" });
        const hook = () => reg.applyCardStatus(card.id, "waiting");
        await (order === "manual-first" ? Promise.all([manual(), hook()]) : Promise.all([hook(), manual()]));
        expect((await reg.getCard(card.id))?.column).toBe("done");
      }
    });

    it("concurrent creations do not swallow each other", async () => {
      const p = await seedProject();
      await Promise.all(Array.from({ length: 20 }, (_, i) => reg.createCard({ projectId: p.id, title: `c${i}` })));
      const cards = await reg.listCards(p.id);
      expect(cards).toHaveLength(20);
      expect(new Set(cards.map((c) => c.id)).size).toBe(20);
      expect(cards.map((c) => c.position).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });

    it("a mutation that throws persists nothing and does not jam the queue", async () => {
      const p = await seedProject();
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await expect(reg.updateCard(card.id, { title: "renamed", base: "bad;branch" })).rejects.toThrow(/invalid branch/);
      const after = await reg.createCard({ projectId: p.id, title: "b" });
      expect(after.title).toBe("b");
      // the failed mutation is not persisted
      const file = JSON.parse(await readFile(join(dir, "board.json"), "utf8")) as { cards: { title: string }[] };
      expect(file.cards.map((c) => c.title).sort()).toEqual(["a", "b"]);
    });
  });

  describe("Claude accounts", () => {
    it("creates an account with a slug derived from the name; duplicates and bad names are rejected", async () => {
      const acc = await reg.createAccount({ name: "Work Account" });
      expect(acc.slug).toBe("work-account");
      expect((await reg.listAccounts()).map((a) => a.slug)).toEqual(["work-account"]);
      await expect(reg.createAccount({ name: "work account" })).rejects.toThrow(/already exists/);
      await expect(reg.createAccount({ name: " " })).rejects.toThrow(/name is required/);
      await expect(reg.createAccount({ name: "!" })).rejects.toThrow(/invalid account name/);
    });

    it("removes an unreferenced account; an unknown one throws", async () => {
      await reg.createAccount({ name: "temp one" });
      expect((await reg.removeAccount("temp-one")).slug).toBe("temp-one");
      expect(await reg.listAccounts()).toEqual([]);
      await expect(reg.removeAccount("temp-one")).rejects.toThrow(/account not found/);
    });

    it("removal REFUSES while a card or a project still references the slug", async () => {
      await reg.createAccount({ name: "shared" });
      const p = await seedProject({ defaultAccountSlug: "shared" });
      await expect(reg.removeAccount("shared")).rejects.toThrow(/in use/);
      await reg.updateProject(p.id, { defaultAccountSlug: null });
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await reg.updateCard(card.id, { accountSlug: "shared" });
      await expect(reg.removeAccount("shared")).rejects.toThrow(/in use/);
      await reg.updateCard(card.id, { accountSlug: null });
      expect((await reg.removeAccount("shared")).slug).toBe("shared");
    });

    it("card and project accounts must exist; null clears them", async () => {
      await reg.createAccount({ name: "team" });
      const p = await seedProject({ defaultAccountSlug: "team" });
      expect(p.defaultAccountSlug).toBe("team");
      const card = await reg.createCard({ projectId: p.id, title: "a" });
      await expect(reg.updateCard(card.id, { accountSlug: "ghost" })).rejects.toThrow(/does not exist/);
      await expect(seedProject({ defaultAccountSlug: "ghost" })).rejects.toThrow(/does not exist/);
      expect((await reg.updateCard(card.id, { accountSlug: "team" })).accountSlug).toBe("team");
      expect((await reg.updateCard(card.id, { accountSlug: null })).accountSlug).toBeUndefined();
      expect(effectiveAccountSlug((await reg.getCard(card.id))!, (await reg.getProject(p.id))!)).toBe("team");
    });
  });

  describe("global config", () => {
    it("stores and clears the default account label, and it survives a reopen", async () => {
      expect(await reg.getConfig()).toEqual({});
      expect((await reg.setDefaultAccountLabel("  Main profile  ")).defaultAccountLabel).toBe("Main profile");
      const reopened = await freshRegistry();
      expect((await reopened.getConfig()).defaultAccountLabel).toBe("Main profile");
      expect((await reopened.setDefaultAccountLabel("")).defaultAccountLabel).toBeUndefined();
    });
  });

  describe("sidebar ordering on the registry", () => {
    it("createProject numbers 0..n-1 and reorderProject moves and renumbers", async () => {
      const a = await seedProject({ name: "a" });
      const b = await seedProject({ name: "b" });
      const c = await seedProject({ name: "c" });
      expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);
      const reordered = await reg.reorderProject(c.id, 0);
      expect(reordered.map((p) => [p.name, p.position])).toEqual([
        ["c", 0],
        ["a", 1],
        ["b", 2],
      ]);
      await expect(reg.reorderProject(a.id, -1)).rejects.toThrow(/invalid position/);
      await expect(reg.reorderProject("nope", 0)).rejects.toThrow(/project not found/);
    });

    it("listProjects normalizes and PERSISTS projects written without a position", async () => {
      await seedProject({ name: "a" });
      await seedProject({ name: "b" });
      const file = join(dir, "board.json");
      const doc = JSON.parse(await readFile(file, "utf8")) as { projects: Record<string, unknown>[] };
      for (const p of doc.projects) delete p.position;
      doc.projects[0]!.createdAt = 200;
      doc.projects[1]!.createdAt = 100;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, JSON.stringify(doc), "utf8");

      const reopened = await freshRegistry();
      expect((await reopened.listProjects()).map((p) => [p.name, p.position])).toEqual([
        ["b", 0],
        ["a", 1],
      ]);
      const persisted = JSON.parse(await readFile(file, "utf8")) as { projects: { name: string; position: number }[] };
      expect(persisted.projects.map((p) => [p.name, p.position]).sort()).toEqual([
        ["a", 1],
        ["b", 0],
      ].sort());
    });
  });

  describe("managed MCP servers", () => {
    it("creates stdio and http servers with a 12-hex id and lists them", async () => {
      const stdio = await reg.createMcp({ name: "files", kind: "stdio", command: "npx", args: ["-y", "srv"], envKeys: ["TOKEN"] });
      const http = await reg.createMcp({ name: "remote", kind: "http", url: "https://example.test/mcp", headerKeys: ["Authorization"] });
      expect(stdio.id).toMatch(/^[0-9a-f]{12}$/);
      expect(http.url).toBe("https://example.test/mcp");
      expect((await reg.listMcps()).map((m) => m.name)).toEqual(["files", "remote"]);
      expect((await reg.getMcp(stdio.id))?.command).toBe("npx");
    });

    it("names are unique and validated", async () => {
      await reg.createMcp({ name: "files", kind: "stdio", command: "npx" });
      await expect(reg.createMcp({ name: "files", kind: "stdio", command: "npx" })).rejects.toThrow(/already exists/);
      await expect(reg.createMcp({ name: "bad name", kind: "stdio", command: "npx" })).rejects.toThrow(/invalid MCP name/);
    });

    it("removes an MCP; an unknown one throws", async () => {
      const mcp = await reg.createMcp({ name: "files", kind: "stdio", command: "npx" });
      expect((await reg.removeMcp(mcp.id)).id).toBe(mcp.id);
      expect(await reg.listMcps()).toEqual([]);
      await expect(reg.removeMcp(mcp.id)).rejects.toThrow(/MCP not found/);
    });
  });
});
