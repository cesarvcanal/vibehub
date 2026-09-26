import { readdir, rm, stat } from "node:fs/promises";
import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config, dataPath } from "../../config/env.js";
import * as registry from "./registry.js";
import type { Card, Project } from "./registry.js";
import { cardWorkPaths, purgeCardWorkspace, killCardSession, CARD_BRANCH_PREFIX } from "./workspace.js";
import { cardsWithPending, purgeCardQueue } from "./outbox.js";
import { removeHistory, SDK_HISTORY_DIR } from "../sdk/history.js";
import { clearInflightMarker, SDK_INFLIGHT_DIR } from "../sdk/inflight.js";
import { removeProvenance, PROVENANCE_DIR } from "../chat/provenance.js";
import { stopCardBrowser } from "../browser/browser.js";
import { markBrowserDown } from "../browser/activity.js";
import { dropPendingCaptures } from "../credentials/capture.js";
import { stopAllCardPreviews } from "../preview/lifecycle.js";
import { claudeProjectsDirName } from "../import/import.js";
import { cardBrowserPorts, BROWSER_DATA_DIR } from "../browser/ports.js";
import { CLAUDE_PROFILES_DIR, DEFAULT_CLAUDE_DIR } from "../accounts/profiles.js";
import { logger } from "../../utils/logger.js";

/**
 * CARD PURGE — deleting a card ERASES the card, not the tile that showed it.
 *
 * The bug this file exists to close: "Excluir card" removed the card from `board.json` and tore
 * down its worktree, and everything ELSE the card had accumulated stayed on the server —
 *
 *  - the whole conversation, twice over: the native chat's `sdk-history/<id>.ndjson` on the panel's
 *    data dir AND the Claude Code TRANSCRIPTS (`<profile>/projects/<cwd>/<session>.jsonl`) inside
 *    the runner, which also made a NEW card born on the same worktree path resume the deleted
 *    card's conversation;
 *  - who sent each message (`provenance/<id>.ndjson`), the interrupted-turn marker, and whatever
 *    the user had typed and not yet delivered (the outbox queue);
 *  - the card's Chromium profile — cookies and logged-in sessions — plus the browser itself, still
 *    RUNNING on a port a later card could be handed;
 *  - its GitHub token file, a live credential;
 *  - its preview servers, still listening, still reachable at `/preview/<port>/`;
 *  - its branch and commits in the clone.
 *
 * So the delete is a PURGE with an order that has a reason:
 *
 *  1. **Kill first.** Sessions (both tmux ones, tree-killed), the SDK driver, the preview servers,
 *     the browser and its capture listener. Nothing must be writing while we delete.
 *  2. **Drop the card from the board.** Every writer in vibehub resolves the card before it writes
 *     (an upload, a message, a status hook), so a card that is off the board cannot gain new
 *     content mid-purge — this is what makes "delete while an upload is in flight" safe.
 *  3. **Erase the files**, runner side and data-dir side, and REPORT each step.
 *
 * A step that fails does not abort the rest: the report names what survived, the audit log carries
 * it, and {@link sweepOrphanCardData} collects it later — so a runner that was down during a delete
 * cannot turn into data that stays forever.
 */

/** One thing the purge tried to erase. */
export interface PurgeStep {
  name: string;
  ok: boolean;
  /** Why it failed, or what it did ("3 messages", "2 sessions"). */
  detail?: string;
}

export interface PurgeReport {
  cardId: string;
  /** The card's slug, for the log and the audit trail. */
  card: string;
  steps: PurgeStep[];
  /** Names of the steps that did NOT complete. Empty = the card is gone, entirely. */
  incomplete: string[];
}

/** Runs one purge step, recording success or the reason it failed. Never throws. */
async function step(steps: PurgeStep[], name: string, work: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await work();
    steps.push({ name, ok: true, ...(detail ? { detail } : {}) });
  } catch (err) {
    steps.push({ name, ok: false, detail: (err as Error).message });
  }
}

/**
 * PURGES a card and everything that belonged to it. Unknown id -> null (the caller decides the 404).
 *
 * Never throws: the card comes off the board even when the runner is unreachable, and what could
 * not be erased is named in the report (and swept later). The caller is expected to surface
 * `incomplete` rather than claim a clean deletion.
 */
export async function purgeCard(cardId: string, by?: string): Promise<PurgeReport | null> {
  const card = await registry.getCard(cardId);
  if (!card) return null;
  const steps: PurgeStep[] = [];

  // 1. KILL — nothing may be writing into the card while it is being erased.
  await stopEverything(card, steps, by);

  // 2. OFF THE BOARD — from here no request can add anything to this card (every writer resolves
  // the card first), so the deletions below cannot race new content into existence.
  await step(steps, "board", async () => {
    await registry.removeCard(card.id);
  });

  // 3. ERASE.
  await eraseEverything(card, steps, by);

  return finishReport(card, steps, by);
}

/** Step 1 for both entry points: every process that could still write into the card. */
async function stopEverything(card: Card, steps: PurgeStep[], by?: string): Promise<void> {
  await step(steps, "sessions", async () => {
    // Tree-kills both tmux sessions AND ends the card's SDK driver (the kill listener).
    await killCardSession(card, { includeShell: true });
  });
  await step(steps, "previews", async () => {
    const killed = await stopAllCardPreviews(card.id);
    return killed.length ? `${killed.length} preview session(s)` : undefined;
  });
  await step(steps, "browser", async () => {
    // The browser first (stopping it also stops the capture listener), then whatever it had
    // pending: a captured login is a PLAINTEXT password held in memory for this card.
    await stopCardBrowser(config.runner.container, card.id, by);
    markBrowserDown(card.id);
    const dropped = dropPendingCaptures(card.id);
    return dropped ? `${dropped} pending capture(s) dropped` : undefined;
  });
}

/** Step 3 for both entry points: the card's bytes, runner side and data-dir side. */
async function eraseEverything(card: Card, steps: PurgeStep[], by?: string, project?: Project): Promise<void> {
  await step(steps, "runner", async () => {
    await purgeCardWorkspace(card, { project, by });
  });
  await step(steps, "chat-history", async () => {
    await removeHistory(card.id);
  });
  await step(steps, "provenance", async () => {
    await removeProvenance(card.id);
  });
  await step(steps, "inflight", async () => {
    await clearInflightMarker(card.id);
  });
  await step(steps, "outbox", async () => {
    const dropped = await purgeCardQueue(card.id);
    return dropped ? `${dropped} queued message(s) dropped` : undefined;
  });
}

/** Builds the report and says, in the audit log, exactly how complete the deletion was. */
function finishReport(card: Card, steps: PurgeStep[], by?: string): PurgeReport {
  const incomplete = steps.filter((s) => !s.ok).map((s) => s.name);
  if (incomplete.length === 0) {
    logger.info(
      { audit: true, action: "card.delete", card: card.worktreeSlug, project: card.projectId, by },
      "card purged: conversation, uploads, files, credentials and processes are gone",
    );
  } else {
    logger.warn(
      {
        audit: true, action: "card.delete.incomplete", card: card.worktreeSlug, project: card.projectId, by,
        incomplete, steps: steps.filter((s) => !s.ok),
      },
      "card removed from the board but part of its data survived — the orphan sweep will collect it",
    );
  }
  return { cardId: card.id, card: card.worktreeSlug, steps, incomplete };
}

/* ------------------------------------------------------------------ the orphan sweep */

/**
 * THE ORPHAN SWEEP — the backstop, and the one-time cleanup of everything older deletes left.
 *
 * It answers one question per artifact: does a card that EXISTS own this? Nothing else. So it
 * collects both what a failed purge left behind and what the deletes from before this feature left
 * on disk — without ever needing to know which card it used to be.
 *
 * Three rules keep it from being dangerous:
 *  - **Shape.** Only paths that are unmistakably vibehub card artifacts are even considered. A
 *    transcript directory that is not a card worktree's (the login terminal's, a hand-made cwd) is
 *    left alone, always.
 *  - **Grace.** Nothing younger than {@link SWEEP_GRACE_MS} is touched, so a card being created
 *    right now can never be swept out from under itself.
 *  - **Cap.** At most {@link SWEEP_MAX} artifacts per pass, and what was left over is logged — a
 *    sweep must never be a silent mass deletion.
 */

/** How old an artifact must be before the sweep may consider it an orphan. */
export const SWEEP_GRACE_MS = 60 * 60_000;

/** Ceiling on one pass. Retroactive garbage is collected over a few passes instead of all at once. */
export const SWEEP_MAX = 200;

/** Heredoc delimiters of the sweep scripts — reserved words, never derived from input. */
const LIST_DELIM = "VIBEHUB_ORPHAN_LIST";
const SWEEP_DELIM = "VIBEHUB_ORPHAN_SWEEP";

export type OrphanKind = "upload" | "browser" | "gh" | "transcript" | "worktree";

/** One candidate artifact in the runner, as the listing script reports it. */
export interface OrphanEntry {
  kind: OrphanKind;
  path: string;
  /** Last modification, epoch ms. */
  mtimeMs: number;
}

/** What a live card owns, in the shapes the sweep compares against. */
export interface LiveCardArtifacts {
  /** Card ids (uploads directories, gh-token files). */
  ids: Set<string>;
  /** `card-<8>` browser profile directory names. */
  browserDirs: Set<string>;
  /** Worktree slugs (the last segment of a card's cwd). */
  slugs: Set<string>;
  /** Claude Code `projects/<name>` directory names of every live card's cwd. */
  transcriptDirs: Set<string>;
}

/** Reads the board and derives everything a live card owns. */
export async function liveCardArtifacts(): Promise<LiveCardArtifacts> {
  const cards = await registry.listAllCards();
  const projects = await registry.listProjects();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const live: LiveCardArtifacts = {
    ids: new Set(),
    browserDirs: new Set(),
    slugs: new Set(),
    transcriptDirs: new Set(),
  };
  for (const card of cards) {
    live.ids.add(card.id);
    live.slugs.add(card.worktreeSlug);
    live.browserDirs.add(cardBrowserPorts(card.id).userDataDir.split("/").pop() ?? "");
    const project = byId.get(card.projectId);
    if (!project) continue;
    try {
      live.transcriptDirs.add(claudeProjectsDirName(cardWorkPaths(project, card).cwd));
    } catch {
      // A card whose paths cannot be derived owns nothing the sweep can name — and a listing entry
      // it might have matched is left alone anyway (the sweep only deletes what it can attribute).
    }
  }
  return live;
}

/**
 * Read-only script: every candidate artifact in the runner with its mtime. `find -printf` (GNU
 * findutils, present in the runner image); every branch tolerates absence. PURE.
 */
export function buildOrphanListScript(containerName: string): string {
  const find = (kind: OrphanKind, roots: string, extra: string): string =>
    `find ${roots} -mindepth 1 -maxdepth 1 ${extra} -printf '${kind}\\t%p\\t%T@\\n' 2>/dev/null || true`;
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${LIST_DELIM}'`,
    find("upload", "/work/.uploads", "-type d"),
    find("browser", BROWSER_DATA_DIR, "-type d"),
    find("gh", "/root/.vibehub/gh", "-type f -name '*.token'"),
    find("transcript", `${DEFAULT_CLAUDE_DIR}/projects ${CLAUDE_PROFILES_DIR}/*/projects`, "-type d"),
    find("worktree", "/work/*-worktrees /work/scratch", "-type d"),
    "true",
    LIST_DELIM,
  ].join("\n");
}

const ORPHAN_KINDS: ReadonlySet<string> = new Set<OrphanKind>(["upload", "browser", "gh", "transcript", "worktree"]);

/** Parses the listing (`kind \t path \t mtime-seconds`). Anything malformed is skipped. PURE. */
export function parseOrphanListing(stdout: string): OrphanEntry[] {
  const out: OrphanEntry[] = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 3) continue;
    const [kind, path, mtime] = parts as [string, string, string];
    if (!ORPHAN_KINDS.has(kind) || !path.startsWith("/")) continue;
    const seconds = Number.parseFloat(mtime);
    if (!Number.isFinite(seconds)) continue;
    out.push({ kind: kind as OrphanKind, path, mtimeMs: Math.round(seconds * 1000) });
  }
  return out;
}

/** Card ids name directories; the same rule as everywhere else that turns an id into a path. */
const CARD_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;
/** Worktree slugs, as the registry mints them. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A browser profile directory: `card-` plus the head of an id. */
const BROWSER_DIR_RE = /^card-[0-9a-zA-Z]{1,8}$/;
/**
 * A transcript directory that belongs to a CARD's cwd: the sanitized form of
 * `/work/<repo>-worktrees/<slug>` or `/work/scratch/<slug>`. Anything else in `projects/` is
 * another cwd's conversation (the login terminal, a directory someone used by hand) and is never
 * touched by the sweep.
 */
const CARD_TRANSCRIPT_DIR_RE = /^-work-(?:.+-worktrees|scratch)-[0-9a-zA-Z-]+$/;

export interface OrphanPlan {
  /** What this pass will erase. */
  purge: OrphanEntry[];
  /** Artifacts inside the grace window (too young to judge). */
  young: number;
  /** Orphans left for the next pass because of the cap. */
  truncated: number;
}

/**
 * Decides what is an orphan. Keeps anything that a live card owns, anything whose name is not a
 * card artifact's, and anything younger than the grace window. PURE — the whole safety of the sweep
 * is in this function, which is why it does no I/O and is tested directly.
 */
export function planOrphanPurge(
  entries: readonly OrphanEntry[],
  live: LiveCardArtifacts,
  opts: { now?: number; graceMs?: number; max?: number } = {},
): OrphanPlan {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? SWEEP_GRACE_MS;
  const max = opts.max ?? SWEEP_MAX;
  const orphans: OrphanEntry[] = [];
  let young = 0;
  for (const entry of entries) {
    const name = entry.path.split("/").pop() ?? "";
    let orphan = false;
    switch (entry.kind) {
      case "upload":
        orphan = CARD_ID_RE.test(name) && !live.ids.has(name);
        break;
      case "browser":
        orphan = BROWSER_DIR_RE.test(name) && !live.browserDirs.has(name);
        break;
      case "gh": {
        const id = name.endsWith(".token") ? name.slice(0, -".token".length) : "";
        orphan = CARD_ID_RE.test(id) && !live.ids.has(id);
        break;
      }
      case "transcript":
        orphan = CARD_TRANSCRIPT_DIR_RE.test(name) && !live.transcriptDirs.has(name);
        break;
      case "worktree":
        orphan = SLUG_RE.test(name) && !live.slugs.has(name);
        break;
    }
    if (!orphan) continue;
    if (now - entry.mtimeMs < graceMs) {
      young += 1;
      continue;
    }
    orphans.push(entry);
  }
  return { purge: orphans.slice(0, max), young, truncated: Math.max(0, orphans.length - max) };
}

/**
 * The delete script for a plan. Same discipline as the card purge: no `set -e` inside the
 * container, every line tolerant, paths validated and shell-quoted. A worktree orphan also gets its
 * clone's registration pruned and its `card/<slug>` branch dropped — the worktree directory alone
 * was never the whole thing. PURE.
 */
export function buildOrphanPurgeScript(containerName: string, entries: readonly OrphanEntry[]): string {
  const inner: string[] = [];
  for (const entry of entries) {
    assertSafeRemotePath(entry.path);
    if (entry.kind === "transcript") {
      const profile = entry.path.replace(/\/projects\/[^/]+$/, "");
      assertSafeRemotePath(profile);
      inner.push(
        `for F in ${shQuote(entry.path)}/*.jsonl; do [ -f "$F" ] || continue; S=$(basename "$F" .jsonl); ` +
          `rm -rf ${shQuote(`${profile}/todos`)}/"$S"* 2>/dev/null || true; done`,
        `rm -rf ${shQuote(entry.path)} 2>/dev/null || true`,
      );
      continue;
    }
    if (entry.kind === "worktree") {
      const slug = entry.path.split("/").pop() ?? "";
      const parent = entry.path.slice(0, entry.path.length - slug.length - 1);
      const repoDir = parent.endsWith("-worktrees") ? parent.slice(0, -"-worktrees".length) : "";
      if (repoDir) {
        assertSafeRemotePath(repoDir);
        inner.push(
          `git -C ${shQuote(repoDir)} worktree remove --force ${shQuote(entry.path)} 2>/dev/null || true`,
          `git -C ${shQuote(repoDir)} worktree prune 2>/dev/null || true`,
          // Always the `card/` namespace, derived from the directory's own name — the sweep can no
          // more reach `dev`/`prod` than the card purge can (see CARD_BRANCH_PREFIX).
          `git -C ${shQuote(repoDir)} branch -D ${shQuote(`${CARD_BRANCH_PREFIX}${slug}`)} 2>/dev/null || true`,
        );
      }
      inner.push(`rm -rf ${shQuote(entry.path)} 2>/dev/null || true`);
      continue;
    }
    inner.push(`rm -rf ${shQuote(entry.path)} 2>/dev/null || true`);
  }
  inner.push("true");
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${SWEEP_DELIM}'`,
    ...inner,
    SWEEP_DELIM,
  ].join("\n");
}

/** What one sweep pass did. */
export interface SweepSummary {
  /** Files under the data dir (chat history, provenance, in-flight markers) that were deleted. */
  dataFiles: number;
  /** Outbox queues of cards that no longer exist. */
  outboxQueues: number;
  /** Artifacts deleted inside the runner. */
  runnerArtifacts: number;
  /** Orphans the cap left for the next pass. */
  truncated: number;
  /** true = the runner half did not run (host down). The data-dir half still did. */
  runnerFailed: boolean;
}

/** The per-card files under the data dir, by directory and file suffix. */
const DATA_DIRS: ReadonlyArray<{ dir: string; suffix: string }> = [
  { dir: SDK_HISTORY_DIR, suffix: ".ndjson" },
  { dir: PROVENANCE_DIR, suffix: ".ndjson" },
  { dir: SDK_INFLIGHT_DIR, suffix: ".json" },
];

/** Deletes the data-dir files of cards that no longer exist. Returns how many went. */
async function sweepDataDir(live: LiveCardArtifacts, now: number, graceMs: number): Promise<number> {
  let removed = 0;
  for (const { dir, suffix } of DATA_DIRS) {
    let names: string[];
    try {
      names = await readdir(dataPath(dir));
    } catch {
      continue; // the directory does not exist yet: nothing to sweep
    }
    for (const name of names) {
      if (!name.endsWith(suffix)) continue;
      const cardId = name.slice(0, -suffix.length);
      if (!CARD_ID_RE.test(cardId) || live.ids.has(cardId)) continue;
      const file = dataPath(dir, name);
      try {
        const info = await stat(file);
        if (now - info.mtimeMs < graceMs) continue;
        await rm(file, { force: true });
        removed += 1;
      } catch (err) {
        logger.warn({ file, detail: (err as Error).message }, "could not sweep an orphan card file");
      }
    }
  }
  return removed;
}

/**
 * ONE SWEEP PASS. Best-effort in both halves and independent between them: a runner that is down
 * still lets the data dir be cleaned. Never throws.
 */
export async function sweepOrphanCardData(
  opts: { now?: number; graceMs?: number; max?: number } = {},
): Promise<SweepSummary> {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? SWEEP_GRACE_MS;
  const summary: SweepSummary = {
    dataFiles: 0, outboxQueues: 0, runnerArtifacts: 0, truncated: 0, runnerFailed: false,
  };
  let live: LiveCardArtifacts;
  try {
    live = await liveCardArtifacts();
  } catch (err) {
    // The board could not be read: EVERY artifact would look like an orphan. Do nothing at all.
    logger.warn({ detail: (err as Error).message }, "orphan sweep skipped — the board could not be read");
    return summary;
  }

  summary.dataFiles = await sweepDataDir(live, now, graceMs);

  // The outbox: queued text of cards that no longer exist.
  try {
    for (const cardId of await cardsWithPending()) {
      if (live.ids.has(cardId)) continue;
      const dropped = await purgeCardQueue(cardId);
      if (dropped > 0) summary.outboxQueues += 1;
    }
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "could not sweep orphan outbox queues");
  }

  // The runner half — and ONLY when the board still names at least one card.
  //
  // The catch above is not the guard it looks like: `JsonStore` SEEDS a missing board.json instead
  // of throwing, so "the board could not be read" never fires for the case that actually happens —
  // the data dir was lost while the runner's bind mount survived (`docker compose down -v`), or a
  // second instance was pointed at the same container with its own VIBEHUB_DATA_DIR, which is
  // precisely what running the backend from another cwd does (`VIBEHUB_DATA_DIR` defaults to
  // `./data`). An empty live set makes EVERY worktree, branch, transcript and browser profile in
  // the runner an orphan, and this half answers that with `git worktree remove --force`,
  // `git branch -D card/<slug>` and `rm -rf` — on real work that was never pushed.
  //
  // Nothing to attribute means nothing to delete. The data-dir half above stays unconditional:
  // those files live under THIS instance's own VIBEHUB_DATA_DIR, so a board without cards is
  // authority enough to clean them.
  if (live.ids.size === 0) {
    logger.warn(
      { container: config.runner.container },
      "orphan sweep left the runner alone — the board names no cards, so nothing there can be attributed to one",
    );
    return summary;
  }

  try {
    const { stdout } = await hostExecutor().runScript(buildOrphanListScript(config.runner.container), {
      timeoutMs: 120_000,
    });
    const plan = planOrphanPurge(parseOrphanListing(stdout), live, { now, graceMs, max: opts.max });
    summary.truncated = plan.truncated;
    if (plan.purge.length > 0) {
      await hostExecutor().runScript(buildOrphanPurgeScript(config.runner.container, plan.purge), {
        timeoutMs: 300_000,
      });
      summary.runnerArtifacts = plan.purge.length;
    }
  } catch (err) {
    summary.runnerFailed = true;
    logger.warn({ detail: (err as Error).message }, "the orphan sweep did not reach the runner this pass");
  }

  const total = summary.dataFiles + summary.outboxQueues + summary.runnerArtifacts;
  if (total > 0 || summary.truncated > 0) {
    logger.info(
      { audit: true, action: "card.orphan_sweep", ...summary },
      "orphan card data swept (artifacts of cards that no longer exist)",
    );
  }
  return summary;
}

/**
 * PURGES every card of a project that was just deleted. The project's cards come off the board in
 * the same mutation as the project itself (`removeProject`), so this is handed BOTH the cards it
 * must erase and the project record they no longer belong to — without that record their paths in
 * the runner cannot be derived. Otherwise deleting a PROJECT would be the way around the card
 * purge, leaving every conversation, upload and running session of its cards on the server.
 *
 * Sequential on purpose: each card is a handful of docker execs, and a project with thirty cards
 * must not fire ninety of them at the runner at once.
 */
export async function purgeRemovedCards(
  cards: readonly Card[],
  project: Project | undefined,
  by?: string,
): Promise<PurgeReport[]> {
  const reports: PurgeReport[] = [];
  for (const card of cards) {
    const steps: PurgeStep[] = [];
    await stopEverything(card, steps, by);
    await eraseEverything(card, steps, by, project);
    reports.push(finishReport(card, steps, by));
  }
  return reports;
}
