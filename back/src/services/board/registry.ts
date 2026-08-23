import { randomUUID } from "node:crypto";
import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

/**
 * BOARD REGISTRY — the projects and cards of the kanban of Claude Code terminals.
 *
 * Every card is a unit of work with its own terminal: a dedicated tmux session (`card-<first 8 of
 * the id>`) inside the runner container, and its own git worktree (`card/<worktreeSlug>` branched
 * off the base branch).
 *
 * THE MIRROR RULE (the central behaviour of the product):
 *  - `working` and `waiting` MIRROR the status reported by the Claude Code hooks: a `working`
 *    report moves the card to `working`, a `waiting` report moves it to `waiting` — but ONLY when
 *    the card already sits in one of those two columns.
 *  - `backlog`, `paused` and `done` are STICKY: a hook status NEVER moves a card out of them.
 *    Finishing is always manual (PATCH column="done"); pausing is always manual (pauseCard).
 *  - Opening the terminal of a card in `backlog` OR `paused` moves it to `waiting` (work resumes:
 *    a freshly attached terminal is waiting for the user to type). A card in `done` stays in `done`.
 *  - Visual order of the board (the front-end is the only thing that orders it):
 *    Backlog -> Waiting -> Working -> Paused -> Done. `paused` means "started but dormant"
 *    ("I'll come back to it"), which is a different thing from `backlog` (never started).
 *
 * Persistence: one JSON document, `board.json`, holding `{ config, accounts, projects, cards, mcps }`.
 * Reads and writes go through {@link JsonStore}, which gives atomic writes, mode 600, and a single
 * serialized mutation queue — mandatory here, because status hooks fire constantly and concurrently
 * with the board's own edits, and an unserialized read-modify-write would silently undo them.
 */

// ---------------------------------------------------------------------------
// Columns and status
// ---------------------------------------------------------------------------

export type BoardColumn = "backlog" | "waiting" | "working" | "paused" | "done";
export const BOARD_COLUMNS: readonly BoardColumn[] = ["backlog", "waiting", "working", "paused", "done"] as const;

/** Status reported by the Claude Code hooks running inside the runner. */
export type CardStatus = "working" | "waiting";

/**
 * REASON a session restart is PENDING on a card: the shared brain or the MCP servers were edited, or
 * the card's own model/account was switched (`config`), while the card was `working`. It is only a
 * LABEL (so the UI can tell them apart in a badge); the restart mechanics are identical either way.
 * See `restartPendingAt` on the card and `shouldRestartOnStatus`.
 */
export type RestartReason = "brain" | "mcp" | "config";
export const RESTART_REASONS: readonly RestartReason[] = ["brain", "mcp", "config"] as const;

/**
 * Claude models a card may pin. When set, the session starts with `claude --model <id>`. Unset =
 * whatever the account defaults to (no flag at all). These ids end up on a shell command line, so
 * they are never taken raw: they are checked against this whitelist first.
 */
export const CLAUDE_MODELS = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] as const;
export type ClaudeModelId = (typeof CLAUDE_MODELS)[number];
const CLAUDE_MODEL_IDS: ReadonlySet<string> = new Set(CLAUDE_MODELS);

/** True when `id` is one of the whitelisted models. Used as a guard before building a session. PURE. */
export function isValidModel(id: string | null | undefined): id is ClaudeModelId {
  return typeof id === "string" && CLAUDE_MODEL_IDS.has(id);
}

/** Returns a whitelisted model id. THROWS otherwise — this value becomes a session env var. PURE. */
export function assertModel(id: string): ClaudeModelId {
  const v = String(id ?? "").trim();
  if (!CLAUDE_MODEL_IDS.has(v)) {
    throw new Error(`invalid model (expected one of ${CLAUDE_MODELS.join(", ")}): '${id}'`);
  }
  return v as ClaudeModelId;
}

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

/**
 * A Claude account on the runner: an isolated profile through `CLAUDE_CONFIG_DIR` (the native Claude
 * Code mechanism — credentials, settings and state live per directory), physically at
 * `~/.claude-profiles/<slug>`. The "default" account is the runner's plain `~/.claude`, and it is
 * represented by the ABSENCE of a slug on the card/project — it never has a record in this list.
 */
export interface Account {
  /** Derived from the name ([a-z0-9-]{2,30}, unique). It is a directory name, so never raw input. */
  slug: string;
  name: string;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  /** "owner/repo". Absent = a project with no repository (a scratch project). */
  repoFullName?: string;
  /** https clone URL (validated). Absent while repoFullName is present = derive it. */
  cloneUrl?: string;
  /** Base branch the card worktrees branch off (defaults to "dev"). */
  baseBranch: string;
  /** Default Claude account for this project's cards. Absent = the runner's default account. */
  defaultAccountSlug?: string;
  /**
   * GitHub CONNECTION (account) this project's repository belongs to — see {@link GithubConnection}.
   * Absent = the first connection in the list, which is what an install with a single account has.
   * Validated against the existing connections on create/update: a dangling id would make every
   * clone of this project fail with a credential that does not exist.
   */
  githubConnectionId?: string;
  /**
   * Position of the project in the sidebar (0..n-1, normalized). Projects written by older versions
   * may not carry the field — `listProjects` falls back to `createdAt` and normalizes on first load.
   */
  position: number;
  createdAt: number;
}

export interface Card {
  id: string;
  projectId: string;
  title: string;
  column: BoardColumn;
  /** Position inside the column (0..n-1, normalized on every move). */
  position: number;
  /** Base branch of the worktree (inherited from the project AT CREATION — later project edits do not touch it). */
  base: string;
  /** tmux session inside the runner: "card-" + the first 8 chars of the id. DERIVED — never user input. */
  tmuxSession: string;
  /** Worktree slug: kebab of the title + "-" + the first 4 chars of the id. DERIVED — never reaches a shell raw. */
  worktreeSlug: string;
  /** Last status reported by the hooks (the dot): working = green, waiting = amber, null = no dot. */
  status?: CardStatus | null;
  statusAt?: number;
  /** Claude account for THIS card. Absent = inherit the project's (absent there = default account). */
  accountSlug?: string;
  /** Claude model for THIS card (one of CLAUDE_MODELS). Absent = the account default (no flag). */
  model?: string;
  /**
   * WHEN the pin above last changed (epoch ms). The session reader needs it: the pin and the
   * transcript can disagree (`/model` typed inside the terminal), and the NEWER of the two is the
   * one that is true. Absent = a pin older than this field, which never beats the transcript.
   */
  modelAt?: number;
  /**
   * When the card's terminal was opened for the FIRST time (worktree and session already exist in
   * the runner). Present = the front-end may attach the websocket immediately (attach-or-create) and
   * fire the open request in parallel; absent = first open, so it waits for the clone/worktree.
   */
  openedAt?: number;
  /**
   * Workspace PRE-PROVISIONED in the background at card creation (clone/worktree/tmux session already
   * exist) WITHOUT the card ever being opened: the column does not change and `openedAt` stays empty.
   * The front-end treats it like `openedAt` only to decide on instant attach; for ordering and pausing
   * the card is still "not started". Stamped once, never re-stamped.
   */
  preparedAt?: number;
  /**
   * PAUSED card: the tmux session (and the Claude process) was killed in the runner on request —
   * zero consumption while parked. It sits in `paused` (sticky) with no dot. Resuming = opening the
   * card (applyOpenTerminal clears this): the attach recreates the session with `claude -c`, in the
   * same conversation.
   */
  pausedAt?: number | null;
  /**
   * HIBERNATED card: the tmux session was killed because the card sat IDLE for too long (the idle
   * sweep, or the manual "hibernate") and NOTHING else changed — same column, same position on the
   * board. That is the whole point of it: pausing FILES a card away under `paused`, hibernating
   * leaves it exactly where you left it and only says "this one has gone cold". No dot while it is
   * hibernated (the front end draws a grey one from this stamp). Waking it up is just opening the
   * card — `applyOpenTerminal` clears the stamp and the attach recreates the session with
   * `claude -c`, same conversation. Any status the hooks report clears it too: activity means it is
   * alive again, whoever started it.
   */
  hibernatedAt?: number | null;
  /**
   * PENDING brain/MCP update: when the brain or the MCP servers are saved while Claude is WORKING on
   * this card, we do not restart right away (that would interrupt the task in flight) — we stamp the
   * moment here and the status hook restarts the session once the card goes idle
   * (shouldRestartOnStatus). The restart is what makes Claude re-read the brain and the MCPs, which
   * are only read at startup, while `claude -c` resumes the same conversation.
   * Null/absent = nothing pending. It mirrors the PENDING pause (`pausedAt`), but a PAUSE BEATS it.
   */
  restartPendingAt?: number | null;
  /** Where the pending restart came from — a label for the badge only: "brain" | "mcp" | "config". */
  restartReason?: RestartReason;
  /**
   * IMPORTED Claude session (migrating from another environment): the uuid of a conversation whose
   * transcript already lives in the runner profile. Present = the session starts with
   * `claude --resume <id>` (falling back to `-c`, then to a bare `claude`). Validated as a uuid,
   * because it becomes an argv entry.
   */
  resumeSessionId?: string;
  /** Worktree branch when it is NOT the derived `card/<worktreeSlug>` (assertBranchName). */
  branch?: string;
  createdAt: number;
  updatedAt: number;
}

export type McpKind = "stdio" | "http" | "sse";
export const MCP_KINDS: readonly McpKind[] = ["stdio", "http", "sse"] as const;

/**
 * An MCP server managed by vibehub: injected into EVERY profile in the runner (the default one and
 * each account) with `claude mcp add-json -s user`, so switching accounts never loses a connection.
 * Only the SHAPE lives here; env/header VALUES live in the vault (key `MCP_<ID>_<VAR_NAME>`) and are
 * resolved at injection time — they are never persisted in this document.
 */
export interface McpServer {
  /** 12 hex chars (a uuid without dashes, truncated) — it becomes part of a vault key, hence [0-9a-f]. */
  id: string;
  /** Server name as Claude sees it ([A-Za-z0-9_-]{2,40}, unique) — becomes an argv entry of `claude mcp`. */
  name: string;
  kind: McpKind;
  /** stdio: the executable (no shell — `claude mcp` runs it directly). */
  command?: string;
  args?: string[];
  /** http/sse: the server URL. */
  url?: string;
  /** Names of the environment variables (stdio) whose VALUES live in the vault. */
  envKeys?: string[];
  /** Names of the headers (http/sse) whose VALUES live in the vault. */
  headerKeys?: string[];
  createdAt: number;
}

/**
 * A GITHUB ACCOUNT vibehub can authenticate as — a personal account and an organization account are
 * the usual pair. Only the IDENTITY lives here; the token itself lives in the vault under
 * `GITHUB_TOKEN_<ID>` and is resolved per git command (see `services/github/client.ts`).
 *
 * A project points at one of these through `Project.githubConnectionId`; absent means "the first
 * one", which is exactly the behaviour of an install that only ever connected a single account.
 */
export interface GithubConnection {
  /** [A-Z][A-Z0-9_]{0,23} — it becomes part of a vault key, so it is never raw input. */
  id: string;
  /** What the human calls it ("personal", "acme org"). Display only. */
  label: string;
  /** GitHub login the token resolved to when it was stored. */
  login: string;
  /** OAuth scopes GitHub reported (classic tokens only — fine-grained tokens report none). */
  scopes?: string[];
  createdAt: number;
}

const CONNECTION_ID_RE = /^[A-Z][A-Z0-9_]{0,23}$/;

/** Validates a connection id ([A-Z][A-Z0-9_]{0,23}) — it becomes a vault key. THROWS otherwise. PURE. */
export function assertGithubConnectionId(id: string): string {
  const v = String(id ?? "").trim();
  if (!CONNECTION_ID_RE.test(v)) {
    throw new Error(`invalid GitHub connection id (expected [A-Z][A-Z0-9_]{0,23}): '${id}'`);
  }
  return v;
}

/** A random connection id — the fallback when a seed does not derive a usable one. */
export function randomGithubConnectionId(): string {
  return `GH${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/**
 * Derives a connection id from a seed (the GitHub login, usually): upper snake, max 24 chars. Falls
 * back to a random id when the seed derives nothing usable (starts with a digit, is empty, …). PURE.
 */
export function githubConnectionIdFor(seed: string): string {
  const base = String(seed ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/_+$/, "");
  return CONNECTION_ID_RE.test(base) ? base : randomGithubConnectionId();
}

/** Display label for a connection: trimmed, at most LABEL_MAX. Empty falls back to the login. PURE. */
export function sanitizeConnectionLabel(label: string | null | undefined, login: string): string {
  return String(label ?? "").trim().slice(0, LABEL_MAX) || String(login ?? "").trim() || "GitHub";
}

/**
 * Global board configuration (a single key in the document). Today it only holds the LABEL of the
 * default account (`~/.claude`, which has no record): the UI shows this instead of "default" in
 * dropdowns and chips. Empty/absent = the UI falls back to its own wording. Display only — it never
 * becomes a directory name or an env var in the runner.
 */
export interface BoardConfig {
  defaultAccountLabel?: string;
}

/** Display label for the default account: trimmed, at most 40 chars. Empty -> undefined (clears). PURE. */
export const LABEL_MAX = 40;
export function sanitizeDefaultAccountLabel(label: string | null | undefined): string | undefined {
  const v = String(label ?? "").trim().slice(0, LABEL_MAX);
  return v || undefined;
}

export interface BoardDoc {
  config: BoardConfig;
  accounts: Account[];
  projects: Project[];
  cards: Card[];
  mcps: McpServer[];
  /** GitHub accounts vibehub can clone as. Older documents have none — the field is filled on load. */
  githubConnections: GithubConnection[];
}

const store = new JsonStore<BoardDoc>(
  dataPath("board.json"),
  () => ({ config: {}, accounts: [], projects: [], cards: [], mcps: [], githubConnections: [] }),
  (raw) => {
    const doc = raw as Partial<BoardDoc> | null;
    return {
      config: doc?.config && typeof doc.config === "object" ? doc.config : {},
      accounts: Array.isArray(doc?.accounts) ? doc.accounts : [],
      projects: Array.isArray(doc?.projects) ? doc.projects : [],
      cards: Array.isArray(doc?.cards) ? doc.cards : [],
      mcps: Array.isArray(doc?.mcps) ? doc.mcps : [],
      githubConnections: Array.isArray(doc?.githubConnections) ? doc.githubConnections : [],
    };
  },
);

/** Drops the in-memory cache. Tests only. */
export function resetForTesting(): void {
  store.resetForTesting();
}

// ---------------------------------------------------------------------------
// Derivations and validation (pure)
// ---------------------------------------------------------------------------

/** kebab-case that is safe for a shell and a filesystem (accents stripped; empty -> "card"). PURE. */
export function kebab(s: string): string {
  const base = String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return base || "card";
}

/** Worktree slug of a card: kebab of the title + "-" + the first 4 chars of the id. Charset [a-z0-9-]. PURE. */
export function worktreeSlugFor(title: string, id: string): string {
  return `${kebab(title)}-${id.slice(0, 4)}`;
}

/** tmux session of a card: "card-" + the first 8 chars of the id (a uuid is pure hex there). PURE. */
export function tmuxSessionFor(id: string): string {
  return `card-${id.slice(0, 8)}`;
}

const ACCOUNT_SLUG_RE = /^[a-z0-9-]{2,30}$/;

/**
 * A sane account slug ([a-z0-9-]{2,30}). It becomes a directory name under `~/.claude-profiles/<slug>`
 * in the runner, so it NEVER passes through unchecked: THROWS when invalid. "default" is RESERVED
 * (the default account is the ABSENCE of a slug — `~/.claude` — and never has a record). PURE.
 */
export function assertAccountSlug(slug: string): string {
  const v = String(slug ?? "").trim();
  if (!ACCOUNT_SLUG_RE.test(v)) throw new Error(`invalid account slug (expected [a-z0-9-]{2,30}): '${slug}'`);
  if (v === "default") throw new Error("'default' is reserved — the default account is the absence of an account");
  return v;
}

/** Slug derived from an account NAME (kebab, max 30, no dangling dashes). THROWS when it cannot. PURE. */
export function accountSlugFor(name: string): string {
  const base = String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  if (base.length < 2) throw new Error(`invalid account name — does not derive a [a-z0-9-]{2,30} slug: '${name}'`);
  return assertAccountSlug(base);
}

/**
 * EFFECTIVE account of a card: the card's own, else the project default, else undefined (= the
 * runner's default account, `~/.claude`). PURE.
 */
export function effectiveAccountSlug(
  card: Pick<Card, "accountSlug">,
  project: Pick<Project, "defaultAccountSlug">,
): string | undefined {
  return card.accountSlug ?? project.defaultAccountSlug ?? undefined;
}

/** Sane branch name: [\w./-]{1,80}, not starting with "-" and without "..". THROWS otherwise. PURE. */
export function assertBranchName(branch: string): string {
  const v = String(branch ?? "").trim();
  if (!v || v.startsWith("-") || v.includes("..") || !/^[\w./-]{1,80}$/.test(v)) {
    throw new Error(`invalid branch name: '${branch}'`);
  }
  return v;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude session uuid (resumeSessionId) — becomes argv of `claude --resume`. THROWS otherwise. PURE. */
export function assertSessionId(id: string): string {
  const v = String(id ?? "").trim().toLowerCase();
  if (!UUID_RE.test(v)) throw new Error(`invalid resumeSessionId (expected a uuid): '${id}'`);
  return v;
}

const MCP_NAME_RE = /^[A-Za-z0-9_-]{2,40}$/;
const MCP_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MCP_HEADER_RE = /^[A-Za-z0-9-]{1,60}$/;
const MCP_URL_RE = /^https?:\/\/[^\s"'`$\\]{1,300}$/;

/** MCP server name ([A-Za-z0-9_-]{2,40}) — becomes argv of `claude mcp`. THROWS otherwise. PURE. */
export function assertMcpName(name: string): string {
  const v = String(name ?? "").trim();
  if (!MCP_NAME_RE.test(v)) throw new Error(`invalid MCP name (expected [A-Za-z0-9_-]{2,40}): '${name}'`);
  return v;
}

const CLONE_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;

/** Clone URL: only https://github.com/owner/repo(.git). THROWS otherwise. PURE. */
export function assertCloneUrl(url: string): string {
  const v = String(url ?? "").trim();
  if (!CLONE_URL_RE.test(v)) {
    throw new Error(`invalid cloneUrl (expected https://github.com/owner/repo[.git]): '${url}'`);
  }
  return v;
}

/** repoFullName "owner/repo". THROWS otherwise. PURE. */
export function assertRepoFullName(full: string): string {
  const v = String(full ?? "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(v)) throw new Error(`invalid repoFullName (expected owner/repo): '${full}'`);
  return v;
}

// ---------------------------------------------------------------------------
// The mirror rule (pure)
// ---------------------------------------------------------------------------

/**
 * THE MIRROR RULE — the column a card lands in after a status reported by the hooks. Only `working`
 * and `waiting` mirror; `backlog`, `paused` and `done` are STICKY (a status never moves a card out
 * of them). PURE.
 */
export function columnAfterStatus(current: BoardColumn, status: CardStatus): BoardColumn {
  if (current !== "working" && current !== "waiting") return current;
  return status === "working" ? "working" : "waiting";
}

/**
 * The column a card lands in after its terminal is OPENED: `backlog` OR `paused` -> `waiting` (work
 * resumes — a freshly attached terminal is waiting for the user to type). `done` never leaves `done`
 * on reopen; `working`/`waiting` stay where they are. PURE.
 */
export function columnAfterOpen(current: BoardColumn): BoardColumn {
  return current === "backlog" || current === "paused" ? "waiting" : current;
}

/**
 * REACTIVATION BY ACTIVITY: a `working` report (= the user TYPED a prompt in that terminal) on a
 * PAUSED card or on a card in `done` proves the work came back — the card leaves the pause/done and
 * goes to `working`. Only `working` reactivates: `waiting` (SessionStart/Stop/Notification, which
 * fire without anybody asking for anything) still never moves a card out of done/backlog, so the
 * mirror rule stays intact. PURE.
 */
export function reactivatesOnActivity(card: Pick<Card, "column" | "pausedAt">, status: CardStatus): boolean {
  return status === "working" && (!!card.pausedAt || card.column === "done" || card.column === "paused");
}

/**
 * A card with a LIVE session in the runner: it has been opened (`openedAt`), is not paused (an
 * effective pause kills the session and stamps `pausedAt`) and is not HIBERNATED (the idle sweep
 * killed the session and left the card where it was). A card in `paused` that STILL has a live
 * session is a PENDING pause (moved there while Claude was working; it waits for Claude to finish). PURE.
 */
export function hasLiveSession(c: Pick<Card, "openedAt" | "pausedAt" | "hibernatedAt">): boolean {
  return !!c.openedAt && !c.pausedAt && !c.hibernatedAt;
}

/**
 * PURE pause decision when MOVING a card into `paused`: end the session right away only when the card
 * is NOT `working` (idle = "waiting" or no status at all). `working` -> do NOT end it now: it becomes a
 * PENDING pause (the session lives on until Claude finishes; the status hook ends it then). The caller
 * still checks whether there is a live session worth ending. PURE.
 */
export function shouldEndSessionOnMove(currentStatus: CardStatus | null | undefined): boolean {
  return currentStatus !== "working";
}

/**
 * PURE pause decision when a hook STATUS arrives: carry out the PENDING pause once Claude finishes —
 * `newStatus` stops being `working`, the card sits in `paused`, and it still has a live session. This
 * is the "wait for it to finish, then pause" half. Idempotent by construction: once the session is
 * gone (liveSession=false) it returns false. PURE.
 */
export function shouldEndSessionOnStatus(
  newStatus: CardStatus,
  currentColumn: BoardColumn,
  liveSession: boolean,
): boolean {
  return newStatus !== "working" && currentColumn === "paused" && liveSession;
}

/**
 * PURE restart decision for a PENDING brain/MCP update when a hook STATUS arrives: carry the restart
 * out once Claude finishes — `newStatus` stops being `working`, the card HAS a pending restart, and it
 * still has a live session. It mirrors `shouldEndSessionOnStatus`; the side effect (restartCard)
 * belongs to the hook ROUTE, not here.
 *
 * A PAUSE BEATS IT: when a pending pause is also due, the route takes the shouldEndSessionOnStatus
 * branch (ending the session) and never reaches the restart — restarting something that is about to
 * sleep is wasted work — and applyCardStatus already drops the pending flag in that case. Idempotent
 * by construction: once the session is gone (liveSession=false) it returns false. PURE.
 */
export function shouldRestartOnStatus(
  newStatus: CardStatus,
  hasPending: boolean,
  liveSession: boolean,
): boolean {
  return newStatus !== "working" && hasPending && liveSession;
}

// ---------------------------------------------------------------------------
// Ordering helpers (pure)
// ---------------------------------------------------------------------------

/** Renumbers the given columns of a project as 0..n-1, in place, keeping the relative order. */
function normalizeColumns(cards: Card[], projectId: string, columns: BoardColumn[]): void {
  for (const col of columns) {
    cards
      .filter((c) => c.projectId === projectId && c.column === col)
      .sort((a, b) => a.position - b.position)
      .forEach((c, i) => {
        c.position = i;
      });
  }
}

/** Puts the card in the target column at the requested (clamped) position, renumbering both columns. */
function placeCard(cards: Card[], card: Card, column: BoardColumn, position?: number): void {
  const from = card.column;
  card.column = column;
  const dest = cards
    .filter((c) => c.projectId === card.projectId && c.column === column && c.id !== card.id)
    .sort((a, b) => a.position - b.position);
  const at = position === undefined ? dest.length : Math.max(0, Math.min(Math.trunc(position), dest.length));
  dest.splice(at, 0, card);
  dest.forEach((c, i) => {
    c.position = i;
  });
  if (from !== column) normalizeColumns(cards, card.projectId, [from]);
}

/**
 * Sorts projects by `position` (ascending), falling back to `createdAt` when `position` is absent
 * (a project written before the field existed) — numbered ones first, unnumbered ones at the end by
 * creation time. Stable final tiebreak by id. Does NOT mutate the input. PURE.
 */
export function sortProjects<T extends { id: string; position?: number; createdAt: number }>(projects: T[]): T[] {
  return [...projects].sort((a, b) => {
    const aHas = Number.isFinite(a.position);
    const bHas = Number.isFinite(b.position);
    if (aHas && bHas) {
      return (a.position as number) - (b.position as number) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    }
    if (aHas) return -1;
    if (bHas) return 1;
    return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  });
}

/**
 * Renumbers project `position` as 0..n-1 in the canonical order (sortProjects), IN PLACE. Returns
 * true when something actually changed (so the caller can decide whether persisting is worth it).
 */
export function normalizeProjectPositions(projects: Project[]): boolean {
  let changed = false;
  sortProjects(projects).forEach((p, i) => {
    if (p.position !== i) {
      p.position = i;
      changed = true;
    }
  });
  return changed;
}

/**
 * Moves project `id` to `position` (clamped to 0..n-1) and renumbers everything 0..n-1. IN PLACE.
 * THROWS when the id does not exist. Same mechanics as placeCard, but on a flat list (no columns).
 */
export function placeProject(projects: Project[], id: string, position: number): void {
  const target = projects.find((p) => p.id === id);
  if (!target) throw new Error("project not found");
  const rest = sortProjects(projects).filter((p) => p.id !== id);
  const at = Math.max(0, Math.min(Math.trunc(position), rest.length));
  rest.splice(at, 0, target);
  rest.forEach((p, i) => {
    p.position = i;
  });
}

/** A slug that is both valid AND known to the document. THROWS "does not exist" when unknown. */
function requireAccountSlug(doc: BoardDoc, slug: string): string {
  const v = assertAccountSlug(slug);
  if (!doc.accounts.some((a) => a.slug === v)) throw new Error(`account '${v}' does not exist`);
  return v;
}

/** Same idea for a GitHub connection: the id must be shaped AND must exist in this document. */
function requireGithubConnectionId(doc: BoardDoc, id: string): string {
  const v = assertGithubConnectionId(id);
  if (!doc.githubConnections.some((c) => c.id === v)) {
    throw new Error(`GitHub connection '${v}' does not exist`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// GitHub connections
// ---------------------------------------------------------------------------

/** Every stored GitHub account, in the order they were connected (the first one is the default). */
export async function listGithubConnections(): Promise<GithubConnection[]> {
  return (await store.load()).githubConnections;
}

export async function getGithubConnection(id: string): Promise<GithubConnection | undefined> {
  return (await store.load()).githubConnections.find((c) => c.id === id);
}

export interface AddGithubConnectionInput {
  /** Preferred id. Absent = derived from the login. Made unique against what is already stored. */
  id?: string;
  label?: string;
  login: string;
  scopes?: string[];
}

/**
 * Registers a GitHub account. The id is derived from the login when none is given, and de-duplicated
 * with a numeric suffix — two tokens for the same login are a legitimate thing to have (a personal
 * token and a fine-grained one scoped to an org's repos).
 *
 * This only records the IDENTITY; storing the token under `GITHUB_TOKEN_<id>` is the caller's job
 * (services/github/client.ts), which is also the only place that ever holds the secret.
 */
export async function addGithubConnection(input: AddGithubConnectionInput): Promise<GithubConnection> {
  const login = String(input.login ?? "").trim();
  if (!login) throw new Error("login is required");
  const wanted = input.id ? assertGithubConnectionId(input.id) : githubConnectionIdFor(login);
  return store.mutate((doc) => {
    let id = wanted;
    for (let n = 2; doc.githubConnections.some((c) => c.id === id); n += 1) {
      const suffix = `_${n}`;
      id = `${wanted.slice(0, 24 - suffix.length)}${suffix}`;
    }
    const connection: GithubConnection = {
      id,
      label: sanitizeConnectionLabel(input.label, login),
      login,
      ...(input.scopes?.length ? { scopes: input.scopes } : {}),
      createdAt: Date.now(),
    };
    doc.githubConnections.push(connection);
    return connection;
  });
}

/** Refreshes the identity of an existing connection (a token was replaced). */
export async function updateGithubConnection(
  id: string,
  patch: { label?: string; login?: string; scopes?: string[] },
): Promise<GithubConnection> {
  const v = assertGithubConnectionId(id);
  return store.mutate((doc) => {
    const idx = doc.githubConnections.findIndex((c) => c.id === v);
    if (idx < 0) throw new Error("GitHub connection not found");
    const current = doc.githubConnections[idx]!;
    const login = patch.login?.trim() || current.login;
    const next: GithubConnection = {
      ...current,
      login,
      label: patch.label !== undefined ? sanitizeConnectionLabel(patch.label, login) : current.label,
      ...(patch.scopes !== undefined ? { scopes: patch.scopes.length ? patch.scopes : undefined } : {}),
    };
    doc.githubConnections[idx] = next;
    return next;
  });
}

/** Projects that explicitly point at this connection — what makes a removal unsafe. */
export async function projectsUsingGithubConnection(id: string): Promise<Project[]> {
  return (await store.load()).projects.filter((p) => p.githubConnectionId === id);
}

/**
 * Removes a GitHub account. REFUSES while any project still points at it — dropping it blindly would
 * leave projects with a credential that no longer exists and every clone would fail at open time.
 */
export async function removeGithubConnection(id: string): Promise<GithubConnection> {
  const v = assertGithubConnectionId(id);
  return store.mutate((doc) => {
    const found = doc.githubConnections.find((c) => c.id === v);
    if (!found) throw new Error("GitHub connection not found");
    const used = doc.projects.filter((p) => p.githubConnectionId === v);
    if (used.length > 0) {
      throw new Error(
        `GitHub account '${found.label}' is in use by ${used.length} project(s) — point them at another account first`,
      );
    }
    doc.githubConnections = doc.githubConnections.filter((c) => c.id !== v);
    return found;
  });
}

/** Drops EVERY connection (the "disconnect GitHub" button) and reports which ids went. */
export async function clearGithubConnections(): Promise<GithubConnection[]> {
  return store.mutate((doc) => {
    const gone = doc.githubConnections;
    doc.githubConnections = [];
    for (const p of doc.projects) delete p.githubConnectionId;
    return gone;
  });
}

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

/** Global board config (today only the default-account label). A fresh document = an empty object. */
export async function getConfig(): Promise<BoardConfig> {
  return (await store.load()).config ?? {};
}

/**
 * Stores the display label of the default account (trimmed, <= 40; empty/null CLEARS it). Display
 * only — it never becomes a directory name or an env var in the runner.
 */
export async function setDefaultAccountLabel(label: string | null | undefined): Promise<BoardConfig> {
  const clean = sanitizeDefaultAccountLabel(label);
  return store.mutate((doc) => {
    doc.config = { ...doc.config, defaultAccountLabel: clean };
    return doc.config;
  });
}

// ---------------------------------------------------------------------------
// Claude accounts
// ---------------------------------------------------------------------------

export async function listAccounts(): Promise<Account[]> {
  return (await store.load()).accounts;
}

export async function createAccount(input: { name: string }): Promise<Account> {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name is required");
  const slug = accountSlugFor(name);
  return store.mutate((doc) => {
    if (doc.accounts.some((a) => a.slug === slug)) throw new Error(`account '${slug}' already exists`);
    const account: Account = { slug, name, createdAt: Date.now() };
    doc.accounts.push(account);
    return account;
  });
}

/**
 * Removes an account. REFUSES ("in use") while ANY card or project still references the slug —
 * removing it blindly would leave a dangling reference and break the next open of those cards.
 */
export async function removeAccount(slug: string): Promise<Account> {
  const v = assertAccountSlug(slug);
  return store.mutate((doc) => {
    const found = doc.accounts.find((a) => a.slug === v);
    if (!found) throw new Error("account not found");
    const cards = doc.cards.filter((c) => c.accountSlug === v).length;
    const projects = doc.projects.filter((p) => p.defaultAccountSlug === v).length;
    if (cards > 0 || projects > 0) {
      throw new Error(
        `account '${v}' is in use by ${cards} card(s) and ${projects} project(s) — move them to another account first`,
      );
    }
    doc.accounts = doc.accounts.filter((a) => a.slug !== v);
    return found;
  });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const doc = await store.load();
  const sorted = sortProjects(doc.projects);
  // First load (older projects with no `position`) or drift (a gap left by a delete): normalize
  // 0..n-1 and PERSIST — but only when needed, so a plain listing stays a pure read.
  if (!sorted.some((p, i) => p.position !== i)) return sorted;
  return store.mutate((d) => {
    normalizeProjectPositions(d.projects);
    return sortProjects(d.projects);
  });
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await store.load()).projects.find((p) => p.id === id);
}

export interface CreateProjectInput {
  name: string;
  repoFullName?: string;
  cloneUrl?: string;
  baseBranch?: string;
  /** Default Claude account for the cards. Absent/empty = the runner's default account. */
  defaultAccountSlug?: string;
  /** GitHub account the repository belongs to. Absent/empty = the first connection. */
  githubConnectionId?: string;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name is required");
  const repoFullName = input.repoFullName?.trim() ? assertRepoFullName(input.repoFullName) : undefined;
  const cloneUrl = input.cloneUrl?.trim() ? assertCloneUrl(input.cloneUrl) : undefined;
  const baseBranch = assertBranchName(input.baseBranch?.trim() || "dev");

  return store.mutate((doc) => {
    const project: Project = {
      id: randomUUID(),
      name,
      repoFullName,
      cloneUrl,
      baseBranch,
      // Whether the account exists can only be checked with the document at hand — hence in here.
      defaultAccountSlug: input.defaultAccountSlug?.trim()
        ? requireAccountSlug(doc, input.defaultAccountSlug)
        : undefined,
      githubConnectionId: input.githubConnectionId?.trim()
        ? requireGithubConnectionId(doc, input.githubConnectionId)
        : undefined,
      // Goes to the END of the sidebar (after normalization the existing ones are 0..n-1, so the new one is n).
      position: doc.projects.length,
      createdAt: Date.now(),
    };
    doc.projects.push(project);
    return project;
  });
}

/**
 * Reorders the sidebar: puts project `id` at `position` and renumbers everything 0..n-1. Returns the
 * already-sorted list. THROWS when `position` is not an integer >= 0, or when the id does not exist.
 */
export async function reorderProject(id: string, position: number): Promise<Project[]> {
  if (!Number.isInteger(position) || position < 0) throw new Error("invalid position (expected an integer >= 0)");
  return store.mutate((doc) => {
    if (!doc.projects.some((p) => p.id === id)) throw new Error("project not found");
    // Guarantee the 0..n-1 baseline (covers older projects with no `position`) before moving.
    normalizeProjectPositions(doc.projects);
    placeProject(doc.projects, id, position);
    return sortProjects(doc.projects);
  });
}

export interface UpdateProjectInput {
  name?: string;
  repoFullName?: string | null;
  cloneUrl?: string | null;
  baseBranch?: string;
  /** null or "" = CLEAR (back to the runner's default account); a string = an existing account. */
  defaultAccountSlug?: string | null;
  /** null or "" = CLEAR (back to the first connection); a string = an existing connection. */
  githubConnectionId?: string | null;
}

export async function updateProject(id: string, patch: UpdateProjectInput): Promise<Project> {
  return store.mutate((doc) => {
    const idx = doc.projects.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error("project not found");
    const current = doc.projects[idx]!;
    const next: Project = { ...current };
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error("name cannot be empty");
      next.name = name;
    }
    // repoFullName/cloneUrl: null or "" = CLEAR (the project becomes a scratch project); a string is validated.
    if (patch.repoFullName !== undefined) {
      next.repoFullName = patch.repoFullName?.trim() ? assertRepoFullName(patch.repoFullName) : undefined;
    }
    if (patch.cloneUrl !== undefined) {
      next.cloneUrl = patch.cloneUrl?.trim() ? assertCloneUrl(patch.cloneUrl) : undefined;
    }
    if (patch.baseBranch !== undefined) next.baseBranch = assertBranchName(patch.baseBranch);
    // defaultAccountSlug: null or "" = CLEAR (default account); a string must exist.
    if (patch.defaultAccountSlug !== undefined) {
      next.defaultAccountSlug = patch.defaultAccountSlug?.trim()
        ? requireAccountSlug(doc, patch.defaultAccountSlug)
        : undefined;
    }
    // githubConnectionId: null or "" = CLEAR (back to the first connection); a string must exist.
    if (patch.githubConnectionId !== undefined) {
      next.githubConnectionId = patch.githubConnectionId?.trim()
        ? requireGithubConnectionId(doc, patch.githubConnectionId)
        : undefined;
    }
    doc.projects[idx] = next;
    return next;
  });
}

/** What `removeProject` gives back: the project that was deleted plus the cards that went with it. */
export interface RemovedProject {
  project: Project;
  /** The project's cards, removed in the same mutation. The caller still has to tear down their runner workspaces. */
  cards: Card[];
}

/**
 * Removes a project AND every card that belonged to it — a card without a project is unreachable on
 * the board, so orphaning them would only leak state. The removed cards come back in the result so
 * the caller can kill their tmux sessions and worktrees in the runner. The remaining projects are
 * renumbered 0..n-1 so the sidebar keeps no gap.
 */
export async function removeProject(id: string): Promise<RemovedProject> {
  const result = await store.mutate((doc) => {
    const project = doc.projects.find((p) => p.id === id);
    if (!project) throw new Error("project not found");
    const cards = doc.cards.filter((c) => c.projectId === id);
    doc.cards = doc.cards.filter((c) => c.projectId !== id);
    doc.projects = doc.projects.filter((p) => p.id !== id);
    normalizeProjectPositions(doc.projects);
    return { project, cards };
  });
  if (result.cards.length > 0) {
    logger.info({ projectId: id, cards: result.cards.length }, "project removed with its cards");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const COLUMN_IDX: Record<BoardColumn, number> = { backlog: 0, waiting: 1, working: 2, paused: 3, done: 4 };

export async function listCards(projectId: string): Promise<Card[]> {
  return (await store.load()).cards
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => COLUMN_IDX[a.column] - COLUMN_IDX[b.column] || a.position - b.position);
}

export async function getCard(id: string): Promise<Card | undefined> {
  return (await store.load()).cards.find((c) => c.id === id);
}

/** EVERY card of every project, unordered. Used by bulk operations such as "restart everything". */
export async function listAllCards(): Promise<Card[]> {
  return (await store.load()).cards;
}

export interface CreateCardInput {
  projectId: string;
  title: string;
}

/** Creates a card at the end of the backlog, base inherited from the project, session/slug DERIVED. */
export async function createCard(input: CreateCardInput): Promise<Card> {
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("title is required");
  return store.mutate((doc) => {
    const project = doc.projects.find((p) => p.id === input.projectId);
    if (!project) throw new Error("project not found");

    const id = randomUUID();
    const now = Date.now();
    const card: Card = {
      id,
      projectId: project.id,
      title,
      column: "backlog",
      position: doc.cards.filter((c) => c.projectId === project.id && c.column === "backlog").length,
      base: assertBranchName(project.baseBranch),
      tmuxSession: tmuxSessionFor(id),
      worktreeSlug: worktreeSlugFor(title, id),
      status: null,
      createdAt: now,
      updatedAt: now,
    };
    doc.cards.push(card);
    return card;
  });
}

export interface UpdateCardInput {
  title?: string;
  column?: BoardColumn;
  position?: number;
  /** null = CLEAR (inherit from the project again); a string = an existing account. */
  accountSlug?: string | null;
  /** Claude model (one of CLAUDE_MODELS); null/"" clears it (back to the account default). */
  model?: string | null;
  /** Imported session (uuid); null clears it (back to `claude -c`). */
  resumeSessionId?: string | null;
  /** The card's own worktree branch; null clears it (back to `card/<worktreeSlug>`). */
  branch?: string | null;
  /** Base branch of the worktree (just the label the next open/worktree uses); validated. */
  base?: string;
}

/**
 * MANUAL edit/move of a card. A manual move is NEVER blocked (any column, including finishing in
 * `done`). Positions are renumbered in both the source and the destination column. The title may
 * change, but `worktreeSlug`/`tmuxSession` do NOT — the worktree and session already exist in the
 * runner under the old names.
 */
export async function updateCard(id: string, patch: UpdateCardInput): Promise<Card> {
  return store.mutate((doc) => {
    const card = doc.cards.find((c) => c.id === id);
    if (!card) throw new Error("card not found");

    // VALIDATE EVERYTHING FIRST, then apply. A patch is all-or-nothing: the document lives in a
    // cache shared with the next mutation, so a half-applied patch whose last field throws would
    // survive in memory and get persisted by whatever writes next.
    const next: Partial<Card> = {};
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw new Error("title cannot be empty");
      next.title = title;
    }
    let move: { column: BoardColumn; position?: number } | undefined;
    if (patch.column !== undefined || patch.position !== undefined) {
      const column = patch.column ?? card.column;
      if (!BOARD_COLUMNS.includes(column)) throw new Error(`invalid column: ${String(patch.column)}`);
      if (patch.position !== undefined && (!Number.isInteger(patch.position) || patch.position < 0)) {
        throw new Error("invalid position (expected an integer >= 0)");
      }
      move = { column, position: patch.position };
    }
    // accountSlug: null = CLEAR (inherit from the project); a string must be an account that EXISTS.
    // Switching accounts on a live session is handled by the caller (kill-session) — this is the record only.
    if (patch.accountSlug !== undefined) {
      next.accountSlug = patch.accountSlug === null ? undefined : requireAccountSlug(doc, patch.accountSlug);
    }
    // model: null/"" = CLEAR (back to the account default); a string must be whitelisted. A change
    // stamps `modelAt`: from that instant the pin is newer than any turn already in the transcript,
    // which is what makes the pill show the model the session is being restarted onto.
    if (patch.model !== undefined) {
      next.model = patch.model === null || !String(patch.model).trim() ? undefined : assertModel(patch.model);
      if (next.model !== card.model) next.modelAt = Date.now();
    }
    // Imported session / own branch: validated here (uuid / assertBranchName) because both become
    // argv or script content in the runner and must never pass through raw. null clears.
    if (patch.resumeSessionId !== undefined) {
      next.resumeSessionId = patch.resumeSessionId === null ? undefined : assertSessionId(patch.resumeSessionId);
    }
    if (patch.branch !== undefined) {
      next.branch = patch.branch === null || !String(patch.branch).trim() ? undefined : assertBranchName(patch.branch);
    }
    // base: the label of the base branch the NEXT open/worktree uses (it does not touch an existing
    // worktree or tmux session). Validated here — it becomes argv/script in the runner. There is no
    // `null`: the base is always required (inherited from the project at creation), so fixing it is
    // always a string.
    if (patch.base !== undefined) next.base = assertBranchName(patch.base);

    // Nothing below this line can throw. (Object.assign copies keys explicitly set to `undefined`
    // too, which is exactly how a field gets cleared.)
    Object.assign(card, next);
    if (move) placeCard(doc.cards, card, move.column, move.position);
    card.updatedAt = Date.now();
    return card;
  });
}

/** Removes a card and renumbers the column it came from. Unknown id -> undefined (the caller decides the 404). */
export async function removeCard(id: string): Promise<Card | undefined> {
  return store.mutate((doc) => {
    const found = doc.cards.find((c) => c.id === id);
    if (!found) return undefined;
    doc.cards = doc.cards.filter((c) => c.id !== id);
    normalizeColumns(doc.cards, found.projectId, [found.column]);
    return found;
  });
}

/**
 * Applies a STATUS reported by the runner hooks (working|waiting): stores the dot (status/statusAt)
 * and moves the column according to the mirror rule (columnAfterStatus) — `backlog`, `paused` and
 * `done` never move by status — with ONE exception: reactivation by activity (`working` on a paused
 * card or on one in `done` clears the pause and sends it to `working`). Unknown card -> undefined.
 */
export async function applyCardStatus(cardId: string, status: CardStatus): Promise<Card | undefined> {
  return store.mutate((doc) => {
    const card = doc.cards.find((c) => c.id === cardId);
    if (!card) return undefined;
    // PENDING pause: the card sits in `paused` with its session STILL alive (it was moved there while
    // Claude was working). The column is sticky — the status does NOT take the card out of `paused`;
    // it only refreshes the dot while Claude works and, once Claude finishes (status != working),
    // CARRIES OUT the pause (stamps pausedAt, clears the dot). Killing the tmux session is the
    // caller's job (see shouldEndSessionOnStatus).
    if (card.column === "paused" && hasLiveSession(card)) {
      if (status === "working") {
        card.status = status;
        card.statusAt = Date.now();
      } else {
        card.pausedAt = Date.now();
        card.status = null;
        card.statusAt = undefined;
        // A PAUSE BEATS the pending restart: the card is going to sleep, so restarting it buys
        // nothing. Drop the flag (the hook route ends the session for the pause and must not go on
        // to restart it afterwards).
        card.restartPendingAt = null;
        card.restartReason = undefined;
      }
      card.updatedAt = Date.now();
      return card;
    }
    card.status = status;
    card.statusAt = Date.now();
    // A hook fired, so there IS a session again — whoever started it. Hibernation is a statement
    // about silence and this is the opposite of silence.
    if (card.hibernatedAt) card.hibernatedAt = null;
    let target: BoardColumn;
    if (reactivatesOnActivity(card, status)) {
      card.pausedAt = null;
      target = "working";
    } else {
      target = columnAfterStatus(card.column, status);
    }
    if (target !== card.column) placeCard(doc.cards, card, target);
    // PENDING brain/MCP update carried out: Claude went idle (status != working) — the flag is cleared
    // HERE, while the side effect (restartCard) belongs to the hook ROUTE (shouldRestartOnStatus),
    // mirroring how the pending pause is split. A card that is still `working` keeps the flag: the
    // task goes on and the restart waits for it to finish.
    if (status !== "working" && card.restartPendingAt) {
      card.restartPendingAt = null;
      card.restartReason = undefined;
    }
    card.updatedAt = Date.now();
    return card;
  });
}

/**
 * Applies the OPEN rule: `backlog`/`paused` -> `waiting`; every other column stays put (`done` never
 * leaves `done` just because a terminal was opened). It does not touch the status (the dot belongs to
 * the hooks). Idempotent. Stamps `openedAt` on the FIRST open and never re-stamps it — that stamp is
 * what lets the front-end open the card instantly next time.
 */
export async function applyOpenTerminal(cardId: string): Promise<Card | undefined> {
  return store.mutate((doc) => {
    const card = doc.cards.find((c) => c.id === cardId);
    if (!card) return undefined;
    let changed = false;
    const target = columnAfterOpen(card.column);
    if (target !== card.column) {
      placeCard(doc.cards, card, target);
      changed = true;
    }
    if (!card.openedAt) {
      card.openedAt = Date.now();
      changed = true;
    }
    // Resuming a paused card IS opening it: the pause stamp goes away (the session exists again).
    if (card.pausedAt) {
      card.pausedAt = null;
      changed = true;
    }
    // Same for a hibernated one: the attach recreates the session, so the card is warm again.
    if (card.hibernatedAt) {
      card.hibernatedAt = null;
      changed = true;
    }
    if (changed) card.updatedAt = Date.now();
    return card;
  });
}

/**
 * Stamps `preparedAt` once the background pre-provisioning of the workspace (at card creation) has
 * finished. It does NOT touch the column, the status or `openedAt` — the card stays in the backlog as
 * "not started"; only the front-end gains the right to attach the websocket immediately. Idempotent:
 * the stamp is never rewritten. Unknown card -> undefined.
 */
export async function markPrepared(cardId: string): Promise<Card | undefined> {
  return store.mutate((doc) => {
    const card = doc.cards.find((c) => c.id === cardId);
    if (!card) return undefined;
    if (card.preparedAt) return card;
    card.preparedAt = Date.now();
    card.updatedAt = Date.now();
    return card;
  });
}

/**
 * Stamps a PENDING brain/MCP update on a card — the staggered restart marks the card here instead of
 * restarting it on the spot when Claude is `working`, so the task in flight is never interrupted. The
 * status hook carries the restart out later, once the card goes idle (shouldRestartOnStatus). It does
 * not validate the status: the caller (restartStaggered) already picked only `working` cards with a
 * live session. Unknown card -> undefined.
 */
export async function markRestartPending(cardId: string, reason: RestartReason): Promise<Card | undefined> {
  return store.mutate((doc) => {
    const card = doc.cards.find((c) => c.id === cardId);
    if (!card) return undefined;
    card.restartPendingAt = Date.now();
    card.restartReason = reason;
    card.updatedAt = Date.now();
    return card;
  });
}

/**
 * PAUSES the card in the registry and moves it to `paused` (a sticky column: a paused card mirrors
 * nothing, and no late hook moves it). It only makes sense on a card that has had a session
 * (`openedAt`) — otherwise it THROWS. Idempotent: pausing twice changes nothing.
 *
 * The "wait for it to finish, then pause" rule (shouldEndSessionOnMove):
 *  - IDLE card (status != "working") -> EFFECTIVE pause right away: stamps `pausedAt` and clears the
 *    dot (the session is about to die, so the old status would be a lie). Killing the tmux session is
 *    the caller's job.
 *  - `working` card -> PENDING pause: it only MOVES to `paused` and keeps the session alive and the
 *    dot green (it does NOT stamp `pausedAt`). The session runs until Claude finishes; the status hook
 *    (applyCardStatus) stamps `pausedAt` then, and the caller ends the session at that point.
 *    `pausedAt` therefore always means "the session is dead".
 */
export async function pauseCard(cardId: string): Promise<Card> {
  return store.mutate((doc) => {
    const card = doc.cards.find((c) => c.id === cardId);
    if (!card) throw new Error("card not found");
    if (!card.openedAt) throw new Error("card was never opened — there is no session to pause");
    if (card.pausedAt) return card;
    // `done` is the user's own sticky column: pausing does NOT take the card out of it. And a card
    // already in `paused` has nowhere to move.
    if (card.column !== "paused" && card.column !== "done") placeCard(doc.cards, card, "paused");
    if (shouldEndSessionOnMove(card.status)) {
      // Idle -> effective pause: the caller kills the session now.
      card.pausedAt = Date.now();
      card.status = null;
      card.statusAt = undefined;
    }
    // working -> PENDING pause: the session stays alive and the green dot is kept; the status hook
    // ends it when Claude finishes (`pausedAt` is NOT stamped now).
    card.updatedAt = Date.now();
    return card;
  });
}

/**
 * HIBERNATES the card: the session is about to be killed for having sat IDLE, and NOTHING else about
 * the card changes — same column, same position, same conversation. It is the quiet cousin of the
 * pause: `pauseCard` files the card away under `paused` because a human decided to park it, this one
 * only records that a terminal went cold, so the board keeps reading like the board you left.
 *
 * Refuses (returns undefined, no throw — the caller is a sweep) anything that is not an idle live
 * session: a card that was never opened, one that is already paused or hibernated, and above all a
 * `working` one, which is Claude in the middle of a task. The dot is cleared with the session: a
 * green or amber dot on a card with no process behind it is a lie.
 */
export async function hibernateCard(cardId: string): Promise<Card | undefined> {
  return store.mutate((doc) => {
    const card = doc.cards.find((c) => c.id === cardId);
    if (!card) return undefined;
    if (!hasLiveSession(card)) return undefined;
    if (card.status === "working") return undefined;
    card.hibernatedAt = Date.now();
    card.status = null;
    card.statusAt = undefined;
    // A restart that was waiting for the card to go idle has nothing left to restart.
    card.restartPendingAt = null;
    card.restartReason = undefined;
    card.updatedAt = Date.now();
    return card;
  });
}

// ---------------------------------------------------------------------------
// Managed MCP servers
// ---------------------------------------------------------------------------

export async function listMcps(): Promise<McpServer[]> {
  return (await store.load()).mcps;
}

export async function getMcp(id: string): Promise<McpServer | undefined> {
  return (await store.load()).mcps.find((m) => m.id === id);
}

export interface CreateMcpInput {
  name: string;
  kind: McpKind;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
}

const MCP_ARG_MAX = 200;

/** A sanitized list of variable/header names (trimmed, de-duplicated); THROWS on a bad name. PURE. */
function sanitizeKeys(keys: string[] | undefined, re: RegExp, label: string): string[] | undefined {
  if (!keys || keys.length === 0) return undefined;
  const out: string[] = [];
  for (const k of keys) {
    const v = String(k ?? "").trim();
    if (!re.test(v)) throw new Error(`invalid ${label}: '${k}'`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Validates the SHAPE of an MCP server: stdio needs a command (no dangerous control characters —
 * `claude mcp` executes it directly, but the name lands inside a JSON heredoc); http/sse need an
 * http(s) URL. Env/header VALUES never appear here (they go to the vault through their own route).
 * PURE, apart from uniqueness of the name, which is checked inside the mutation.
 */
export function normalizeMcpInput(input: CreateMcpInput): Omit<McpServer, "id" | "createdAt"> {
  const name = assertMcpName(input.name);
  const kind = input.kind;
  if (!MCP_KINDS.includes(kind)) throw new Error(`invalid MCP kind: ${String(kind)}`);
  const out: Omit<McpServer, "id" | "createdAt"> = { name, kind };
  if (kind === "stdio") {
    const command = String(input.command ?? "").trim();
    if (!command || command.length > MCP_ARG_MAX || /[\r\n\0]/.test(command)) {
      throw new Error("command is required on a stdio MCP");
    }
    out.command = command;
    const args = (input.args ?? []).map((a) => String(a ?? "")).filter((a) => a.length > 0);
    for (const a of args) {
      if (a.length > MCP_ARG_MAX || /[\r\n\0]/.test(a)) throw new Error(`invalid arg: '${a}'`);
    }
    if (args.length) out.args = args;
    out.envKeys = sanitizeKeys(input.envKeys, MCP_VAR_RE, "environment variable name");
  } else {
    const url = String(input.url ?? "").trim();
    if (!MCP_URL_RE.test(url)) throw new Error("invalid url (expected http(s)://…) on an http/sse MCP");
    out.url = url;
    out.headerKeys = sanitizeKeys(input.headerKeys, MCP_HEADER_RE, "header name");
  }
  return out;
}

export async function createMcp(input: CreateMcpInput): Promise<McpServer> {
  const shape = normalizeMcpInput(input);
  return store.mutate((doc) => {
    if (doc.mcps.some((m) => m.name === shape.name)) throw new Error(`MCP '${shape.name}' already exists`);
    const mcp: McpServer = { id: randomUUID().replace(/-/g, "").slice(0, 12), ...shape, createdAt: Date.now() };
    doc.mcps.push(mcp);
    return mcp;
  });
}

export async function removeMcp(id: string): Promise<McpServer> {
  return store.mutate((doc) => {
    const found = doc.mcps.find((m) => m.id === id);
    if (!found) throw new Error("MCP not found");
    doc.mcps = doc.mcps.filter((m) => m.id !== id);
    return found;
  });
}
