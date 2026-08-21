import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { runnerStatus } from "../../runtime/runner.js";
import { profileDirFor } from "../mcp/mcp.js";
import { logger } from "../../utils/logger.js";

/**
 * IMPORT — adopts Claude Code sessions that already exist as vibehub cards. Each imported item
 * becomes a card that, when opened, runs `claude --resume <sessionId>` and picks the conversation
 * back up where it was left.
 *
 * The delicate part is SEEDING the transcript. `claude --resume <id>` looks for the file at
 * `<profile>/projects/<sanitized-cwd>/<id>.jsonl` INSIDE the runner. The transcripts have already
 * been copied into a STAGING directory in the runner (default /work/import); importing MOVES each
 * one into the card's directory. The name of that `projects` directory is DETERMINISTIC from the
 * card's cwd and does NOT depend on the worktree existing yet — so we do not pre-provision anything
 * (no clone): we derive the path and seed straight into it. Cloning and creating the worktree is
 * what opening the card does, idempotently, later.
 *
 * SECURITY INVARIANT: no raw input reaches a shell. `stageDir` is validated (assertSafeRemotePath)
 * and shell-quoted; `sessionId` is validated as a uuid (assertSessionId) BEFORE it is interpolated
 * into a path; the destination is DERIVED from the board and validated too. No transcript content
 * is ever logged.
 */

/** Default staging directory inside the runner, where the .jsonl files were placed. */
export const DEFAULT_STAGE_DIR = "/work/import";

/** Heredoc delimiters and stdout markers — reserved words, never derived from input. */
const SEED_DELIM = "VIBEHUB_IMPORT";
const CHECK_DELIM = "VIBEHUB_CHECK";
const MARK_OK = "VIBEHUB_IMPORT_OK";
const MARK_MISSING = "VIBEHUB_IMPORT_MISSING";
const MARK_PRESENT = "VIBEHUB_IMPORT_PRESENT";
const MARK_ABSENT = "VIBEHUB_IMPORT_ABSENT";

/**
 * A Claude session id is a uuid. This is NOT cosmetic validation: the value becomes part of a file
 * path that is shell-quoted into a script, and it is the only field of an import item that reaches
 * the runner at all. Reject anything that is not a uuid.
 */
export function assertSessionId(value: string): string {
  const v = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) {
    throw new Error(`invalid session id: '${value}' (expected a uuid)`);
  }
  return v;
}

/** Canonical repo key: lowercase owner/repo, no trailing .git. PURE. */
export function normalizeRepoKey(full: string): string {
  return String(full ?? "").trim().replace(/\.git$/i, "").toLowerCase();
}

/** Canonical repo key of a project, from its full name or its clone URL. undefined = no repo. PURE. */
export function projectRepoKey(project: { repoFullName?: string | null; cloneUrl?: string | null }): string | undefined {
  const full = project.repoFullName?.trim();
  if (full) return normalizeRepoKey(full);
  const url = project.cloneUrl?.trim();
  const m = url ? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(url) : null;
  if (m) return normalizeRepoKey(`${m[1]}/${m[2]}`);
  return undefined;
}

/**
 * Name of Claude Code's `projects` directory for a given cwd: every character that is not
 * [A-Za-z0-9] becomes '-'. This is the SAME rule `claude --resume` uses to find a session's
 * transcript, which is why it is pure and directly tested. PURE.
 */
export function claudeProjectsDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Where a transcript must live for `claude --resume` to find it: <profile>/projects/<cwd-sanitized>. PURE. */
export function seedDestDir(profileDir: string, cwd: string): string {
  return `${profileDir}/projects/${claudeProjectsDirName(cwd)}`;
}

/**
 * Script (host → `docker exec -i <container> bash -s`) that seeds ONE transcript: when the source
 * exists it creates the destination and copies over it (idempotent); when it does not, it prints
 * MARK_MISSING and does NOT fail — the caller tells the two apart by reading stdout, so one missing
 * file produces a per-item error instead of aborting the batch. Paths are DERIVED, validated and
 * shell-quoted. PURE.
 */
export function buildImportSeedScript(containerName: string, srcPath: string, destDir: string): string {
  assertSafeRemotePath(srcPath);
  assertSafeRemotePath(destDir);
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${SEED_DELIM}'`,
    "set -e",
    `SRC=${shQuote(srcPath)}`,
    `DEST=${shQuote(destDir)}`,
    `if [ ! -f "$SRC" ]; then printf '${MARK_MISSING}\\n'; else mkdir -p "$DEST"; cp -f "$SRC" "$DEST/"; printf '${MARK_OK}\\n'; fi`,
    SEED_DELIM,
  ].join("\n");
}

/**
 * Script (host → `docker exec -i <container> bash -s`) that ASKS whether a transcript is ALREADY at
 * its destination: prints MARK_PRESENT when `<destPath>` exists, MARK_ABSENT otherwise. Read-only —
 * it is what makes re-running an import decide between re-seeding (a previous run created the card
 * but the seed failed, leaving an orphan card with no conversation) and genuinely skipping. The
 * path is DERIVED, validated and shell-quoted. PURE.
 */
export function buildTranscriptExistsScript(containerName: string, destPath: string): string {
  assertSafeRemotePath(destPath);
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'${CHECK_DELIM}'`,
    "set -e",
    `DEST=${shQuote(destPath)}`,
    `if [ -f "$DEST" ]; then printf '${MARK_PRESENT}\\n'; else printf '${MARK_ABSENT}\\n'; fi`,
    CHECK_DELIM,
  ].join("\n");
}

/* -------------------------------------------------------------------------------------------- */

/** The little the import needs to know about a project. Structural: the real Project satisfies it. */
export interface ImportProject {
  id: string;
  repoFullName?: string | null;
  cloneUrl?: string | null;
}

/** The little the import needs to know about a card. */
export interface ImportCard {
  id: string;
  resumeSessionId?: string | null;
}

/**
 * Everything the import needs from the board, injected rather than imported.
 *
 * The board document is another module's concern and its write API is wider than what belongs in an
 * importer's blast radius; taking exactly these six operations keeps the coupling honest and lets
 * this module be tested against an in-memory board with no mocking of someone else's file.
 */
export interface ImportBoard {
  listProjects(): Promise<ImportProject[]>;
  createProject(input: { name: string; repoFullName: string; cloneUrl: string }): Promise<ImportProject>;
  listCards(projectId: string): Promise<ImportCard[]>;
  createCard(input: { projectId: string; title: string }): Promise<ImportCard>;
  updateCard(
    id: string,
    patch: { resumeSessionId?: string; branch?: string | null; column?: string },
  ): Promise<ImportCard>;
  /** Working directory of the card's worktree inside the runner — the cwd its terminal opens in. */
  cardCwd(project: ImportProject, card: ImportCard): string;
  /** Slug of the Claude account the card runs under (undefined/"default" = the default profile). */
  accountSlugFor(card: ImportCard, project: ImportProject): string | undefined;
}

export interface ImportItem {
  /** "owner/repo". */
  repo: string;
  title: string;
  /** uuid of the Claude session whose transcript sits in staging. */
  sessionId: string;
  /** Branch for the card's worktree (optional). */
  branch?: string;
  /** Target board column (optional; the board's own default applies when omitted). */
  column?: string;
}

export interface ImportInput {
  items: ImportItem[];
  /** Staging directory in the runner (default DEFAULT_STAGE_DIR). */
  stageDir?: string;
}

export interface ImportItemResult {
  title: string;
  repo: string;
  cardId?: string;
  projectId?: string;
  /** true = transcript copied into the card's directory (new card OR re-seed of an orphan). */
  seeded: boolean;
  /** Final path of the transcript in the runner, when seeded. */
  destPath?: string;
  /** true = the card already existed AND the transcript was already in place (nothing to do). */
  skipped?: boolean;
  error?: string;
}

export interface ImportResult {
  results: ImportItemResult[];
  created: number;
  skipped: number;
  failed: number;
}

/**
 * Imports each item, sequentially, with a try/catch PER ITEM — one bad transcript never takes the
 * rest of the batch down. Idempotent by (project, sessionId): importing twice does not duplicate a
 * card.
 *
 * Redesign note: the original checked "is a runner provisioned on this project's server?" once per
 * item, because each project could live on a different host. vibehub has one runner, so the check
 * happens ONCE, up front, and fails the whole call — there is no partial answer to give.
 */
export async function importSessions(input: ImportInput, board: ImportBoard, by?: string): Promise<ImportResult> {
  const stageDir = (input.stageDir ?? DEFAULT_STAGE_DIR).trim();
  assertSafeRemotePath(stageDir);

  const container = config.runner.container;
  const status = await runnerStatus();
  if (!status.running) {
    throw new Error(
      status.exists
        ? "the runner container is not running — start it before importing"
        : "the runner is not provisioned — set it up before importing",
    );
  }

  const host = hostExecutor();

  // Project cache by repo key — several items from the same repo must share one project.
  const projectCache = new Map<string, ImportProject>();
  for (const p of await board.listProjects()) {
    const key = projectRepoKey(p);
    if (key && !projectCache.has(key)) projectCache.set(key, p);
  }

  const results: ImportItemResult[] = [];
  for (const item of input.items) {
    const r: ImportItemResult = { title: item.title, repo: item.repo, seeded: false };
    try {
      const repoKey = normalizeRepoKey(item.repo);
      if (!repoKey) throw new Error("repo is required (owner/repo)");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repoKey)) throw new Error(`invalid repo '${item.repo}' (expected owner/repo)`);

      // a) Project: reuse the one matching this repo, otherwise create it.
      let project = projectCache.get(repoKey);
      if (!project) {
        project = await board.createProject({
          name: repoKey.split("/")[1] ?? repoKey,
          repoFullName: item.repo.trim(),
          cloneUrl: `https://github.com/${repoKey}.git`,
        });
        projectCache.set(repoKey, project);
      }
      r.projectId = project.id;

      const sessionId = assertSessionId(item.sessionId);

      // b) Card: reuse the one already carrying this session id, otherwise create and patch it.
      const existing = (await board.listCards(project.id)).find((c) => c.resumeSessionId === sessionId);
      let card: ImportCard;
      if (existing) {
        card = existing;
      } else {
        card = await board.createCard({ projectId: project.id, title: item.title });
        await board.updateCard(card.id, {
          resumeSessionId: sessionId,
          branch: item.branch ?? null,
          ...(item.column ? { column: item.column } : {}),
        });
      }
      r.cardId = card.id;

      // c) Destination: the `projects` directory of the card's EFFECTIVE profile, derived from the
      //    cwd its terminal will open in.
      const cwd = board.cardCwd(project, card);
      const profileDir = profileDirFor(board.accountSlugFor(card, project));
      assertSafeRemotePath(profileDir);
      const destDir = seedDestDir(profileDir, cwd);
      const destPath = `${destDir}/${sessionId}.jsonl`;
      const srcPath = `${stageDir}/${sessionId}.jsonl`;

      // d) REAL idempotency: when the card already existed, only re-seed if the transcript is NOT at
      //    the destination (a previous attempt created the card but the seed failed → orphan card
      //    with no conversation). If it is there, this is a genuine skip. A new card goes straight
      //    to the seed.
      if (existing) {
        const check = await host.runScript(buildTranscriptExistsScript(container, destPath), { timeoutMs: 30_000 });
        if (check.stdout.includes(MARK_PRESENT)) {
          r.skipped = true;
          results.push(r);
          continue;
        }
        if (!check.stdout.includes(MARK_ABSENT)) {
          throw new Error("transcript check did not confirm (no PRESENT/ABSENT marker)");
        }
        // ABSENT → fall through and re-seed the orphan card.
      }

      // e) Seed: copy from staging into the card's directory in the runner.
      const out = await host.runScript(buildImportSeedScript(container, srcPath, destDir), { timeoutMs: 60_000 });
      if (out.stdout.includes(MARK_MISSING)) throw new Error("transcript is not in the staging directory");
      if (!out.stdout.includes(MARK_OK)) throw new Error("transcript seed did not confirm (no OK marker)");
      r.seeded = true;
      r.destPath = destPath;
    } catch (e) {
      r.error = (e as Error).message;
    }
    results.push(r);
  }

  const created = results.filter((r) => r.cardId && !r.skipped && !r.error).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => r.error).length;
  // Audit: counts only. A transcript is a whole conversation and never goes near a log line.
  logger.info(
    { audit: true, action: "import.sessions", by, total: input.items.length, created, skipped, failed },
    "imported Claude sessions as cards",
  );
  return { results, created, skipped, failed };
}
