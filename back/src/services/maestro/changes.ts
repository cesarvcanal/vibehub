import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { getCard, getProject, assertBranchName } from "../board/registry.js";
import { cardWorkPaths, cardBranch } from "../board/workspace.js";
import { cardConnectionToken, ghTokenPreamble } from "./deliver.js";
import { logger } from "../../utils/logger.js";

/**
 * CHANGES — what a card has produced, in git terms: its branch, the commits ahead of its base, the
 * files it touched (committed and not yet committed) and its pull request. It is how someone driving
 * the card from OUTSIDE the board (ChatGPT, by voice) can say "it committed two fixes to login.ts and
 * the PR is open" without opening anything.
 *
 * READ ONLY by construction: no push, no fetch, no checkout — the base is compared as the worktree
 * already knows it (`origin/<base>` when the clone has it). The `gh` lookup authenticates exactly like
 * deliver does (the card's connection token, planted over STDIN, never in argv); with no connection
 * the git part still answers and the PR is null with the reason.
 */

const MARKER = "__VIBEHUB_CHANGES__";
const DELIM = "VIBEHUB_CHANGES";
/** Caps per section — a card that rewrote half the repository must not flood the answer. */
const MAX_LINES = 200;
const MAX_COMMITS = 50;
const NO_CONNECTION = "no GitHub connection for this card's project — the pull request cannot be looked up";

export interface FileChange {
  /** git's status letters: `M`, `A`, `D`, `R100`, `??` (untracked)… */
  status: string;
  path: string;
}

export interface CommitInfo {
  sha: string;
  author: string;
  /** ISO 8601, as git wrote it. */
  at: string;
  subject: string;
}

export interface PullRequestInfo {
  url: string;
  state: string;
  title: string;
  isDraft: boolean;
  baseRefName: string;
}

export interface CardChanges {
  branch: string;
  /** The ref the branch was compared to (`origin/dev`, or `dev` when the clone has no remote ref). */
  base: string;
  /** Not committed yet (`git status --porcelain`). */
  uncommitted: FileChange[];
  /** Commits on the branch and not on the base, newest first. */
  commits: CommitInfo[];
  /** Files the branch changed relative to the base. */
  files: FileChange[];
  stat: { files: number; insertions: number; deletions: number };
  /** The branch's newest pull request (any state), null = none or not looked up. */
  pr: PullRequestInfo | null;
  /** Why `pr` is null when the lookup itself failed. */
  prError?: string;
}

/**
 * The runner-side script. Every value that reaches the shell is validated and quoted; the token
 * (when there is one) goes through deliver's preamble, inside the heredoc on stdin. PURE.
 */
export function buildChangesScript(
  containerName: string, cardId: string, token: string | null, cwd: string, branch: string, base: string,
): string {
  assertSafeRemotePath(cwd);
  const head = assertBranchName(branch);
  const baseName = assertBranchName(base);
  const section = (name: string) => `echo "${MARKER} ${name}"`;
  const body = [
    ...(token ? ghTokenPreamble(token) : ["set +e"]),
    `cd ${shQuote(cwd)} 2>/dev/null || { echo "${MARKER} error cwd"; exit 0; }`,
    section("branch"),
    "git rev-parse --abbrev-ref HEAD 2>/dev/null",
    `B=${shQuote(`origin/${baseName}`)}`,
    `git rev-parse --verify -q "$B" >/dev/null 2>&1 || B=${shQuote(baseName)}`,
    section("base"),
    'echo "$B"',
    section("status"),
    `git status --porcelain=v1 2>/dev/null | head -n ${MAX_LINES}`,
    section("commits"),
    `git log --format='%h%x09%an%x09%aI%x09%s' "$B..HEAD" 2>/dev/null | head -n ${MAX_COMMITS}`,
    section("files"),
    `git diff --name-status "$B...HEAD" 2>/dev/null | head -n ${MAX_LINES}`,
    section("shortstat"),
    'git diff --shortstat "$B...HEAD" 2>/dev/null',
    section("pr"),
    token
      ? `gh pr list --head ${shQuote(head)} --state all --limit 1 --json url,state,title,isDraft,baseRefName 2>&1 | head -c 4000; echo`
      : `echo ${shQuote(NO_CONNECTION)}`,
    section("end"),
  ];
  return ["set -e", `docker exec -i ${shQuote(containerName)} bash -s <<'${DELIM}'`, ...body, DELIM].join("\n");
}

function lines(text: string | undefined): string[] {
  return String(text ?? "").split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
}

function parsePr(raw: string): { pr: PullRequestInfo | null; prError?: string } {
  const text = raw.trim();
  if (!text) return { pr: null };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      const first = parsed[0] as Record<string, unknown> | undefined;
      if (!first || typeof first.url !== "string") return { pr: null };
      return {
        pr: {
          url: first.url,
          state: String(first.state ?? ""),
          title: String(first.title ?? ""),
          isDraft: first.isDraft === true,
          baseRefName: String(first.baseRefName ?? ""),
        },
      };
    }
  } catch { /* not JSON: gh said why it could not look */ }
  return { pr: null, prError: text.slice(0, 300) };
}

/** Parses the script's output. THROWS when the worktree is not there. PURE. */
export function parseChanges(stdout: string): CardChanges {
  if (new RegExp(`${MARKER} error cwd`).test(stdout)) {
    throw new Error("the card's worktree is not there — open the card first");
  }
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const m = new RegExp(`^${MARKER} (\\w+)$`).exec(raw.trim());
    if (m) {
      current = [];
      sections.set(m[1]!, current);
      continue;
    }
    current?.push(raw);
  }
  const text = (name: string) => (sections.get(name) ?? []).join("\n");

  const uncommitted = lines(text("status")).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  const commits = lines(text("commits")).map((l) => {
    const [sha = "", author = "", at = "", ...subject] = l.split("\t");
    return { sha, author, at, subject: subject.join("\t") };
  });
  const files = lines(text("files")).map((l) => {
    const [status = "", ...paths] = l.split("\t");
    return { status, path: paths.join(" -> ") };
  });
  const short = text("shortstat");
  const num = (re: RegExp) => Number(re.exec(short)?.[1] ?? 0);
  return {
    branch: lines(text("branch"))[0] ?? "",
    base: lines(text("base"))[0] ?? "",
    uncommitted,
    commits,
    files,
    stat: { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) },
    ...parsePr(text("pr")),
  };
}

/** What a card has produced so far (see the file header). Read-only. */
export async function readCardChanges(cardId: string): Promise<CardChanges & { cardId: string; title: string }> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");
  const { cwd } = cardWorkPaths(project, card);
  let token: string | null = null;
  try {
    token = await cardConnectionToken(card, project);
  } catch (err) {
    logger.info({ card: card.worktreeSlug, detail: (err as Error).message }, "card changes: no GitHub token, reading git only");
  }
  const { stdout } = await hostExecutor().runScript(
    buildChangesScript(config.runner.container, card.id, token, cwd, cardBranch(card), card.base || project.baseBranch),
    { timeoutMs: 60_000 },
  );
  const changes = parseChanges(stdout);
  logger.info(
    { audit: true, action: "maestro.changes", card: card.worktreeSlug, commits: changes.commits.length, files: changes.files.length },
    "card changes read",
  );
  return { cardId: card.id, title: card.title, ...changes };
}

/* ------------------------------------------------------------- o diff de UM arquivo */

/** Teto do diff de um arquivo (vai inteiro para um frame do websocket). */
export const FILE_DIFF_MAX_BYTES = 400_000;

/**
 * Um caminho RELATIVO ao worktree, sem `..`, sem começar por `/` ou `-` (não pode virar flag do git)
 * e só com caracteres de nome de arquivo comuns. Lança no resto. PURE.
 */
export function assertWorktreeRelativePath(path: string): string {
  const p = String(path ?? "");
  if (p === "" || p.length > 500) throw new Error("invalid path");
  if (p.startsWith("/") || p.startsWith("-") || p.split("/").includes("..")) throw new Error(`invalid path: ${p}`);
  if (!/^[A-Za-z0-9 _./@+-]+$/.test(p)) throw new Error(`invalid path: ${p}`);
  return p;
}

/**
 * O que mudou em UM arquivo desde a base do branch: commitado E não commitado (o worktree contra o
 * merge-base). Arquivo que o git ainda não conhece vira o diff contra o vazio. Só leitura. PURE.
 */
export function buildFileDiffScript(containerName: string, cwd: string, base: string, path: string): string {
  assertSafeRemotePath(cwd);
  const baseName = assertBranchName(base);
  const file = assertWorktreeRelativePath(path);
  const body = [
    "set +e",
    `cd ${shQuote(cwd)} 2>/dev/null || { echo "${MARKER} error cwd"; exit 0; }`,
    `B=${shQuote(`origin/${baseName}`)}`,
    `git rev-parse --verify -q "$B" >/dev/null 2>&1 || B=${shQuote(baseName)}`,
    'MB=$(git merge-base HEAD "$B" 2>/dev/null || echo HEAD)',
    `if git ls-files --error-unmatch -- ${shQuote(file)} >/dev/null 2>&1 || git cat-file -e "$MB:"${shQuote(file)} 2>/dev/null; then`,
    `  git diff --no-color --no-ext-diff "$MB" -- ${shQuote(file)} | head -c ${FILE_DIFF_MAX_BYTES}`,
    "else",
    `  git diff --no-color --no-ext-diff --no-index -- /dev/null ${shQuote(file)} | head -c ${FILE_DIFF_MAX_BYTES}`,
    "fi",
  ];
  return [`docker exec -i ${shQuote(containerName)} bash -s <<'${DELIM}'`, ...body, DELIM].join("\n");
}

/** O diff de um arquivo do card (texto unificado do git). Lança quando o worktree não está lá. */
export async function readCardFileDiff(cardId: string, path: string): Promise<{ path: string; diff: string; truncated: boolean }> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");
  const { cwd } = cardWorkPaths(project, card);
  const { stdout } = await hostExecutor().runScript(
    buildFileDiffScript(config.runner.container, cwd, card.base || project.baseBranch, path),
    { timeoutMs: 30_000 },
  );
  if (stdout.includes(`${MARKER} error cwd`)) throw new Error("the card's worktree is not there — open the card first");
  return { path, diff: stdout, truncated: Buffer.byteLength(stdout) >= FILE_DIFF_MAX_BYTES };
}
