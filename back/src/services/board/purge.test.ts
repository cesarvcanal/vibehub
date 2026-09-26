import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * DELETING A CARD MUST ERASE THE CARD — the fear this file exists to answer: "eu deleto, ele
 * desaparece da UI, mas os arquivos continuam no servidor e o chat continua no banco".
 *
 * What is pinned here:
 *  - every per-card artifact that vibehub writes is named and deleted: the native chat history, the
 *    provenance log, the interrupted-turn marker, the queued (never delivered) messages, and, in
 *    the runner, the worktree/branch/uploads/browser-profile/gh-token/transcripts;
 *  - the ORDER: every process that could still write is killed, then the card leaves the board (so
 *    an upload or a message in flight can no longer be authorized), and only then are bytes erased;
 *  - a step that FAILS (runner down) does not stop the others, is reported, and is collected later
 *    by the orphan sweep;
 *  - after the purge there is no old address that brings anything back (upload read/write, chat).
 *
 * The board and the data dir are REAL (temp dir); the host executor is mocked — this is about what
 * vibehub does, not about what docker does with it.
 */

const CONTAINER = "vibehub-runner";

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));
vi.mock("../github/client.js", () => ({ gitAuthHeaderFor: vi.fn(), tokenFor: vi.fn() }));

let dir = "";
let runScript: ReturnType<typeof vi.fn>;
let reg: typeof import("./registry.js");
let ws: typeof import("./workspace.js");
let purge: typeof import("./purge.js");
let history: typeof import("../sdk/history.js");
let provenance: typeof import("../chat/provenance.js");
let inflight: typeof import("../sdk/inflight.js");
let outbox: typeof import("./outbox.js");

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "test-key";
  env.config.publicUrl = "http://vibehub:3010";
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
  ws = await import("./workspace.js");
  purge = await import("./purge.js");
  history = await import("../sdk/history.js");
  provenance = await import("../chat/provenance.js");
  inflight = await import("../sdk/inflight.js");
  outbox = await import("./outbox.js");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-purge-"));
  await fresh();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const scripts = (): string[] => runScript.mock.calls.map((c) => String(c[0]));
const allScripts = (): string => scripts().join("\n");

async function seed() {
  const project = await reg.createProject({
    name: "erp-aux",
    repoFullName: "acme/erp-aux",
    cloneUrl: "https://github.com/acme/erp-aux.git",
  });
  const card = await reg.createCard({ projectId: project.id, title: "Deletar card" });
  return { project, card };
}

/** Gives the card the full set of things a worked-on card accumulates. */
async function fillCard(cardId: string): Promise<void> {
  await history.appendHistory(cardId, { type: "user", text: "segredo do chat", at: 1 });
  await history.appendHistory(cardId, { type: "assistant_text", text: "resposta", at: 2 });
  await provenance.recordOrigin(cardId, "segredo do chat", { kind: "owner", name: "cesar" }, 1);
  await inflight.writeInflightMarker(cardId, { startedAt: 1, preview: "segredo do chat", attempts: 0 });
  await outbox.queueMessage(cardId, "mensagem que nunca foi entregue");
}

const dataFiles = async (sub: string): Promise<string[]> => {
  try {
    return await readdir(join(dir, sub));
  } catch {
    return [];
  }
};

describe("purgeCard — the card and everything that belonged to it", () => {
  it("an unknown card is null (the route's 404), and nothing is touched", async () => {
    expect(await purge.purgeCard("de4db33f-0000-0000-0000-000000000000")).toBeNull();
    expect(runScript).not.toHaveBeenCalled();
  });

  it("erases the conversation, the provenance, the marker and the queued messages", async () => {
    const { card } = await seed();
    await fillCard(card.id);
    // Everything is really there before the delete.
    expect(await history.readHistory(card.id)).toHaveLength(2);
    expect(await inflight.readInflightMarker(card.id)).not.toBeNull();
    expect(await outbox.pendingMessages(card.id)).toHaveLength(1);

    const report = await purge.purgeCard(card.id, "cesar");

    expect(report?.incomplete).toEqual([]);
    expect(await reg.getCard(card.id)).toBeUndefined();
    expect(await history.readHistory(card.id)).toEqual([]);
    expect(await inflight.readInflightMarker(card.id)).toBeNull();
    expect(await outbox.pendingMessages(card.id)).toEqual([]);
    // Not "empty" — GONE. A file left behind with zero bytes is still a file naming a card.
    expect(await dataFiles(history.SDK_HISTORY_DIR)).toEqual([]);
    expect(await dataFiles(provenance.PROVENANCE_DIR)).toEqual([]);
    expect(await dataFiles(inflight.SDK_INFLIGHT_DIR)).toEqual([]);
  });

  it("kills every process of the card and erases its files in the runner", async () => {
    const { card, project } = await seed();
    const cwd = ws.cardWorkPaths(project, card).cwd;
    await purge.purgeCard(card.id, "cesar");
    const s = allScripts();

    // Both tmux sessions, tree-killed (the card's and the Shell button's).
    expect(s).toContain(`tmux kill-session -t '${card.tmuxSession}'`);
    expect(s).toContain(`tmux kill-session -t '${card.tmuxSession}-sh'`);
    // The preview servers (they live OUTSIDE the pane's tree on purpose) are looked for by name.
    expect(s).toContain(`preview-${card.id.slice(0, 8)}-`);
    // The live browser: its X display, its VNC and its Chromium.
    expect(s).toContain("remote-debugging-port=");
    // And the bytes.
    expect(s).toContain(`rm -rf '${cwd}'`);
    expect(s).toContain(`rm -rf '/work/.uploads/${card.id}'`);
    expect(s).toContain(`rm -f '/root/.vibehub/gh/${card.id}.token'`);
    expect(s).toContain("$P/projects/");
  });

  it("KILLS FIRST, then takes the card off the board, then deletes — nothing can write mid-purge", async () => {
    const { card } = await seed();
    // The board is read inside the purge, so "when did the card leave the board" is observable by
    // watching the removal against the order of the scripts.
    const order: string[] = [];
    runScript.mockImplementation(async (script: string) => {
      order.push(/kill-session/.test(script) ? "kill" : /VIBEHUB_PURGE/.test(script) ? "erase" : "other");
      return { stdout: "", stderr: "" };
    });
    const removeCard = vi.spyOn(reg, "removeCard");
    removeCard.mockImplementation(async (id: string) => {
      order.push("board");
      return (await import("./registry.js")).getCard(id).then(async (c) => {
        removeCard.mockRestore();
        return await reg.removeCard(id).then(() => c);
      });
    });
    await purge.purgeCard(card.id);
    expect(order.indexOf("kill")).toBeLessThan(order.indexOf("board"));
    expect(order.indexOf("board")).toBeLessThan(order.lastIndexOf("erase"));
  });

  it("a card that never ran (no files, no session) purges cleanly — nothing to report", async () => {
    const { card } = await seed();
    const report = await purge.purgeCard(card.id);
    expect(report?.incomplete).toEqual([]);
    expect(await reg.getCard(card.id)).toBeUndefined();
  });

  it("a RUNNER THAT IS DOWN still deletes the card and the data dir — and says what survived", async () => {
    const { card } = await seed();
    await fillCard(card.id);
    runScript.mockRejectedValue(new Error("Cannot connect to the Docker daemon"));

    const report = await purge.purgeCard(card.id);

    // The card is gone from the board (a dead runner must never make a card undeletable)...
    expect(await reg.getCard(card.id)).toBeUndefined();
    // ...the data dir was erased anyway (it does not depend on the runner)...
    expect(await dataFiles(history.SDK_HISTORY_DIR)).toEqual([]);
    expect(await outbox.pendingMessages(card.id)).toEqual([]);
    // ...and the answer is HONEST about the runner half instead of claiming a clean deletion.
    expect(report?.incomplete).toContain("runner");
    expect(report?.steps.find((s) => s.name === "runner")?.detail).toMatch(/runner|docker/i);
  });

  it("a card whose PROJECT record is missing still gets killed and erased — and says so", async () => {
    const { card } = await seed();
    await fillCard(card.id);
    // A board where the card's project cannot be resolved: without it there are no runner paths.
    vi.spyOn(reg, "getProject").mockResolvedValue(undefined);

    const report = await purge.purgeCard(card.id);

    expect(await reg.getCard(card.id)).toBeUndefined();
    expect(allScripts()).toContain(`tmux kill-session -t '${card.tmuxSession}'`);
    expect(await dataFiles(history.SDK_HISTORY_DIR)).toEqual([]);
    expect(report?.incomplete).toEqual(["runner"]);
    expect(report?.steps.find((s) => s.name === "runner")?.detail).toMatch(/project for this card not found/);
  });

  it("after the purge there is NO old address that brings the card's content back", async () => {
    const { card } = await seed();
    await purge.purgeCard(card.id);
    // The two halves of the upload feature: nothing can be attached, nothing can be read.
    await expect(ws.uploadCardImage(card.id, "x.png", "AAAA")).rejects.toThrow(/card not found/);
    await expect(ws.readCardUpload(card.id, "1790375878344-x.png")).rejects.toThrow(/card not found/);
    // And the queue refuses to accept anything for it.
    await expect(outbox.queueMessage(card.id, "oi")).rejects.toThrow(/card not found/);
  });

  it("purgeRemovedCards: deleting a PROJECT purges each of its cards (not just the board rows)", async () => {
    const { card, project } = await seed();
    const second = await reg.createCard({ projectId: project.id, title: "Outro card" });
    await fillCard(card.id);
    await fillCard(second.id);

    const removed = await reg.removeProject(project.id);
    const reports = await purge.purgeRemovedCards(removed.cards, removed.project, "cesar");

    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.incomplete.length === 0)).toBe(true);
    expect(await dataFiles(history.SDK_HISTORY_DIR)).toEqual([]);
    expect(await dataFiles(provenance.PROVENANCE_DIR)).toEqual([]);
    expect(allScripts()).toContain(`rm -rf '/work/.uploads/${card.id}'`);
    expect(allScripts()).toContain(`rm -rf '/work/.uploads/${second.id}'`);
  });
});

/* ---------------------------------------------------------------- the orphan sweep */

describe("planOrphanPurge (the whole safety of the sweep lives here)", () => {
  const live = (over: Partial<import("./purge.js").LiveCardArtifacts> = {}) => ({
    ids: new Set<string>(),
    browserDirs: new Set<string>(),
    slugs: new Set<string>(),
    transcriptDirs: new Set<string>(),
    ...over,
  });
  const OLD = 0; // epoch: as old as it gets
  const entry = (kind: import("./purge.js").OrphanKind, path: string, mtimeMs = OLD) => ({ kind, path, mtimeMs });
  const NOW = 10 * 60 * 60_000;

  it("keeps what a LIVE card owns and takes only the rest", () => {
    const mine = "aaaaaaaa-0000-0000-0000-000000000000";
    const gone = "bbbbbbbb-0000-0000-0000-000000000000";
    const plan = purge.planOrphanPurge(
      [
        entry("upload", `/work/.uploads/${mine}`),
        entry("upload", `/work/.uploads/${gone}`),
        entry("gh", `/root/.vibehub/gh/${mine}.token`),
        entry("gh", `/root/.vibehub/gh/${gone}.token`),
        entry("browser", "/work/.browser/card-aaaaaaaa"),
        entry("browser", "/work/.browser/card-bbbbbbbb"),
        entry("worktree", "/work/acme--erp-aux-worktrees/vivo"),
        entry("worktree", "/work/acme--erp-aux-worktrees/morto"),
        entry("transcript", "/root/.claude/projects/-work-acme--erp-aux-worktrees-vivo"),
        entry("transcript", "/root/.claude/projects/-work-acme--erp-aux-worktrees-morto"),
      ],
      live({
        ids: new Set([mine]),
        browserDirs: new Set(["card-aaaaaaaa"]),
        slugs: new Set(["vivo"]),
        transcriptDirs: new Set(["-work-acme--erp-aux-worktrees-vivo"]),
      }),
      { now: NOW },
    );
    expect(plan.purge.map((e) => e.path)).toEqual([
      `/work/.uploads/${gone}`,
      `/root/.vibehub/gh/${gone}.token`,
      "/work/.browser/card-bbbbbbbb",
      "/work/acme--erp-aux-worktrees/morto",
      "/root/.claude/projects/-work-acme--erp-aux-worktrees-morto",
    ]);
  });

  it("NEVER touches what is not recognisably a card artifact", () => {
    const plan = purge.planOrphanPurge(
      [
        // Another cwd's conversation: the login terminal, a directory someone used by hand.
        entry("transcript", "/root/.claude/projects/-root"),
        entry("transcript", "/root/.claude/projects/-home-cesar-meus-projetos"),
        entry("transcript", "/root/.claude-profiles/mussa/projects/-work-acme--erp-aux"),
        // Things whose names are not ids/slugs at all.
        entry("upload", "/work/.uploads/README"),
        entry("browser", "/work/.browser/Default"),
        entry("gh", "/root/.vibehub/gh/notes.token"),
        entry("worktree", "/work/scratch/Not A Slug"),
      ],
      live(),
      { now: NOW },
    );
    expect(plan.purge).toEqual([]);
  });

  it("respects the GRACE window — a card being created right now cannot be swept", () => {
    const gone = "bbbbbbbb-0000-0000-0000-000000000000";
    const plan = purge.planOrphanPurge(
      [entry("upload", `/work/.uploads/${gone}`, NOW - 60_000)],
      live(),
      { now: NOW, graceMs: purge.SWEEP_GRACE_MS },
    );
    expect(plan.purge).toEqual([]);
    expect(plan.young).toBe(1);
  });

  it("caps a pass and SAYS how much it left behind (a sweep is never a silent mass deletion)", () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      entry("upload", `/work/.uploads/cccccccc-0000-0000-0000-00000000000${i}`),
    );
    const plan = purge.planOrphanPurge(entries, live(), { now: NOW, max: 3 });
    expect(plan.purge).toHaveLength(3);
    expect(plan.truncated).toBe(4);
  });
});

describe("the sweep's scripts", () => {
  it("lists every candidate with its mtime and tolerates every missing root", () => {
    const s = purge.buildOrphanListScript(CONTAINER);
    expect(s).toContain("/work/.uploads");
    expect(s).toContain("/work/.browser");
    expect(s).toContain("/root/.vibehub/gh");
    expect(s).toContain("/root/.claude/projects /root/.claude-profiles/*/projects");
    expect(s).toContain("/work/*-worktrees /work/scratch");
    expect(s.match(/\|\| true/g)?.length).toBeGreaterThanOrEqual(5);
    expect(s).toContain("-printf 'upload\\t%p\\t%T@\\n'");
  });

  it("parses the listing and skips anything malformed", () => {
    const parsed = purge.parseOrphanListing(
      [
        "upload\t/work/.uploads/aaa\t1790000000.5",
        "browser\t/work/.browser/card-aa\t1790000001",
        "nonsense\t/etc/passwd\t1790000002", // unknown kind
        "upload\trelative/path\t1790000003", // not absolute
        "upload\t/work/.uploads/bbb\tnot-a-number",
        "garbage",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { kind: "upload", path: "/work/.uploads/aaa", mtimeMs: 1790000000500 },
      { kind: "browser", path: "/work/.browser/card-aa", mtimeMs: 1790000001000 },
    ]);
  });

  it("deletes a transcript with its todos, and a worktree with its registration and branch", () => {
    const s = purge.buildOrphanPurgeScript(CONTAINER, [
      { kind: "transcript", path: "/root/.claude-profiles/mussa/projects/-work-r-worktrees-x", mtimeMs: 0 },
      { kind: "worktree", path: "/work/acme--erp-aux-worktrees/morto", mtimeMs: 0 },
      { kind: "worktree", path: "/work/scratch/ideia", mtimeMs: 0 },
      { kind: "upload", path: "/work/.uploads/aaaaaaaa-0000-0000-0000-000000000000", mtimeMs: 0 },
    ]);
    expect(s).toContain(`rm -rf '/root/.claude-profiles/mussa/todos'/"$S"*`);
    expect(s).toContain(`rm -rf '/root/.claude-profiles/mussa/projects/-work-r-worktrees-x'`);
    expect(s).toContain(`git -C '/work/acme--erp-aux' worktree remove --force '/work/acme--erp-aux-worktrees/morto'`);
    expect(s).toContain(`git -C '/work/acme--erp-aux' branch -D 'card/morto'`);
    // A scratch directory has no clone behind it: no git, just the directory.
    expect(s).toContain(`rm -rf '/work/scratch/ideia'`);
    expect(s).not.toContain("git -C '/work'");
    expect(s).toContain(`rm -rf '/work/.uploads/aaaaaaaa-0000-0000-0000-000000000000'`);
  });

  it("refuses a path that is not a safe absolute path", () => {
    expect(() =>
      purge.buildOrphanPurgeScript(CONTAINER, [{ kind: "upload", path: "/work/../etc", mtimeMs: 0 }]),
    ).toThrow(/\.\./);
  });
});

describe("sweepOrphanCardData (the backstop: what earlier deletes left behind)", () => {
  /** Writes a data-dir file and back-dates it past the grace window. */
  async function stale(sub: string, name: string, body = "{}"): Promise<string> {
    const path = join(dir, sub, name);
    await mkdir(join(dir, sub), { recursive: true });
    await writeFile(path, body, "utf8");
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(path, old, old);
    return path;
  }

  it("deletes the files of cards that no longer exist and KEEPS the live card's", async () => {
    const { card } = await seed();
    await fillCard(card.id);
    const ghost = "dddddddd-0000-0000-0000-000000000000";
    await stale(history.SDK_HISTORY_DIR, `${ghost}.ndjson`, '{"type":"user","text":"conversa de um card morto"}\n');
    await stale(provenance.PROVENANCE_DIR, `${ghost}.ndjson`, '{"at":1,"key":"x","origin":{"kind":"owner","name":"c"}}\n');
    await stale(inflight.SDK_INFLIGHT_DIR, `${ghost}.json`, '{"startedAt":1,"attempts":0}');

    const summary = await purge.sweepOrphanCardData();

    expect(summary.dataFiles).toBe(3);
    expect(await dataFiles(history.SDK_HISTORY_DIR)).toEqual([`${card.id}.ndjson`]);
    expect(await dataFiles(provenance.PROVENANCE_DIR)).toEqual([`${card.id}.ndjson`]);
    expect(await dataFiles(inflight.SDK_INFLIGHT_DIR)).toEqual([`${card.id}.json`]);
    // The live card's conversation is untouched.
    expect(await history.readHistory(card.id)).toHaveLength(2);
  });

  it("drops the queued messages of a card that no longer exists", async () => {
    const { card } = await seed();
    await outbox.queueMessage(card.id, "fica");
    // A queue whose card was deleted straight out of board.json (an older delete).
    await reg.removeCard(card.id);

    const summary = await purge.sweepOrphanCardData();
    expect(summary.outboxQueues).toBe(1);
    expect(await outbox.pendingMessages(card.id)).toEqual([]);
  });

  it("does NOTHING when the board cannot be read — every artifact would look like an orphan", async () => {
    await stale(history.SDK_HISTORY_DIR, "dddddddd-0000-0000-0000-000000000000.ndjson", "{}\n");
    vi.spyOn(reg, "listAllCards").mockRejectedValue(new Error("board.json is unreadable"));

    const summary = await purge.sweepOrphanCardData();

    expect(summary).toMatchObject({ dataFiles: 0, runnerArtifacts: 0 });
    expect(await dataFiles(history.SDK_HISTORY_DIR)).toHaveLength(1);
    expect(runScript).not.toHaveBeenCalled();
  });

  /**
   * THE DISASTER THIS PINS: `JsonStore` seeds a missing board.json instead of throwing, so the
   * "board could not be read" guard never fires for the way it actually goes wrong — the data dir
   * is lost while the runner's bind mount survives, or a second backend is started against the
   * same container with its own VIBEHUB_DATA_DIR (the default is `./data`, relative to the cwd).
   * The live set is then empty, every worktree in the runner reads as an orphan, and the sweep
   * answers with `git worktree remove --force` + `git branch -D` on work nobody pushed.
   */
  it("with a board that names NO cards, the runner is not touched at all", async () => {
    const old = (Date.now() - 48 * 60 * 60_000) / 1000;
    runScript.mockResolvedValue({
      stdout: [
        `worktree\t/work/acme--erp-worktrees/pagamentos-a1b2\t${old}`,
        `worktree\t/work/acme--erp-worktrees/conciliacao-c3d4\t${old}`,
        `browser\t/work/.browser/card-9f8e7d6c\t${old}`,
        `gh\t/root/.vibehub/gh/dddddddd-0000-0000-0000-000000000000.token\t${old}`,
      ].join("\n") + "\n",
      stderr: "",
    });

    const summary = await purge.sweepOrphanCardData();

    expect(summary.runnerArtifacts).toBe(0);
    expect(summary.runnerFailed).toBe(false); // it declined, it did not fail
    expect(runScript).not.toHaveBeenCalled(); // not even the listing
  });

  it("sweeps the runner from the listing, and a dead runner still lets the data dir be cleaned", async () => {
    await seed(); // a board that names at least one card is what licenses the runner half
    const ghost = "dddddddd-0000-0000-0000-000000000000";
    await stale(history.SDK_HISTORY_DIR, `${ghost}.ndjson`, "{}\n");
    const old = (Date.now() - 48 * 60 * 60_000) / 1000;
    runScript
      .mockResolvedValueOnce({ stdout: `upload\t/work/.uploads/${ghost}\t${old}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const summary = await purge.sweepOrphanCardData();
    expect(summary.dataFiles).toBe(1);
    expect(summary.runnerArtifacts).toBe(1);
    expect(scripts()[1]).toContain(`rm -rf '/work/.uploads/${ghost}'`);

    // And now with the runner down.
    await stale(history.SDK_HISTORY_DIR, "eeeeeeee-0000-0000-0000-000000000000.ndjson", "{}\n");
    runScript.mockRejectedValue(new Error("host is down"));
    const second = await purge.sweepOrphanCardData();
    expect(second.runnerFailed).toBe(true);
    expect(second.dataFiles).toBe(1);
  });
});

/**
 * A FAXINA TAMBÉM NÃO PODE ENCOSTAR EM dev/prod. O que ela apaga vem do NOME da pasta órfã
 * (`/work/<repo>-worktrees/<slug>`), e o nome só produz `card/<slug>` — nunca a branch que estava
 * dentro daquela worktree.
 */
describe("the sweep never deletes a person's branch", () => {
  it("only ever forms card/<slug> from the directory name", () => {
    const s = purge.buildOrphanPurgeScript(CONTAINER, [
      { kind: "worktree", path: "/work/acme--erp-aux-worktrees/um-card", mtimeMs: 0 },
    ]);
    expect(s).toContain(`branch -D 'card/um-card'`);
    for (const branch of ["'dev'", "'prod'", "'main'", "'master'"]) {
      expect(s).not.toContain(`branch -D ${branch}`);
    }
  });

  it("a worktree that had dev checked out loses the directory, not the branch", () => {
    const s = purge.buildOrphanPurgeScript(CONTAINER, [
      { kind: "worktree", path: "/work/acme--erp-aux-worktrees/dev", mtimeMs: 0 },
    ]);
    // The slug happens to be "dev" — the branch line is still namespaced, and `card/dev` is a
    // vibehub branch, never the real `dev`.
    expect(s).toContain(`branch -D 'card/dev'`);
    expect(s).not.toContain(`branch -D 'dev'`);
    expect(s).toContain(`rm -rf '/work/acme--erp-aux-worktrees/dev'`);
  });
});

/**
 * NUNCA `dev`, NUNCA `prod` — pelo caminho REAL da exclusão.
 *
 * Os testes acima cobrem as peças (a regra do chamador, a trava do construtor de script, a faxina).
 * Este cobre o que o botão faz: `purgeCard` num card apontado para uma branch de verdade. Se algum
 * dia alguém religar a exclusão de branch em outro ponto do caminho, é aqui que quebra.
 */
describe("purgeCard nunca apaga a branch de uma pessoa", () => {
  const PROTEGIDAS = ["dev", "prod", "main", "master", "release/1.0", "feat/pdv", "hotfix/nfe"];

  it("um card em dev/prod/main perde a worktree e NENHUMA branch", async () => {
    const { project } = await seed();
    for (const branch of PROTEGIDAS) {
      const card = await reg.createCard({ projectId: project.id, title: `card em ${branch}` });
      await reg.updateCard(card.id, { branch });
      runScript.mockClear();

      const report = await purge.purgeCard(card.id, "cesar");

      // A exclusão acontece por inteiro...
      expect(report?.incomplete).toEqual([]);
      expect(await reg.getCard(card.id)).toBeUndefined();
      const s = allScripts();
      expect(s).toContain("worktree remove --force");
      // ...e nenhum `branch -D` sai, de forma alguma: nem a protegida, nem qualquer outra.
      expect(s).not.toContain("branch -D");
      expect(s).not.toContain(`'${branch}'`);
    }
  });

  it("o card comum continua perdendo a SUA branch — a trava não desligou a feature", async () => {
    const { card } = await seed();
    await purge.purgeCard(card.id);
    expect(allScripts()).toContain(`branch -D 'card/${card.worktreeSlug}'`);
  });

  it("nenhum script que a purga manda pro runner pode carregar um `branch -D` fora de card/", async () => {
    const { project } = await seed();
    const emDev = await reg.createCard({ projectId: project.id, title: "em dev" });
    await reg.updateCard(emDev.id, { branch: "dev" });
    const normal = await reg.createCard({ projectId: project.id, title: "normal" });
    runScript.mockClear();
    await purge.purgeCard(emDev.id);
    await purge.purgeCard(normal.id);

    // Varre TODA linha de exclusão de branch de TODOS os scripts enviados: cada uma tem de estar
    // no namespace `card/`. Uma linha nova em qualquer ponto do caminho cai neste laço.
    const linhas = allScripts().split("\n").filter((l) => l.includes("branch -D"));
    expect(linhas.length).toBeGreaterThan(0);
    for (const linha of linhas) expect(linha).toMatch(/branch -D 'card\//);
  });
});
