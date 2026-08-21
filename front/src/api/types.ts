/**
 * TypeScript mirror of the HTTP contract in `docs/API.md`.
 *
 * The back-end is the authority: nothing here invents a field the contract does not describe.
 * Fields the contract marks optional are optional here too, so a slightly older server never
 * crashes the UI.
 */

/* ------------------------------------------------------------------ auth */

export interface User {
  id: string;
  username: string;
}

/** `GET /api/auth/me` */
export interface MeResponse {
  user: User;
}

export interface Credentials {
  username: string;
  password: string;
}

/* ----------------------------------------------------------------- setup */

/**
 * The four things a fresh install has to get through. Every one is a boolean the server
 * computes from real state, which is what makes the wizard resumable: reloading the page
 * re-reads this and lands on the same step.
 */
export interface SetupSteps {
  /** An owner account exists. */
  owner: boolean;
  /** A runner container has been provisioned and is reachable. */
  runner: boolean;
  /** Claude is installed and signed in inside the runner. */
  claude: boolean;
  /** A GitHub token is stored. Optional in practice — the wizard lets you skip it. */
  github: boolean;
}

/** `GET /api/setup/state` (public) */
export interface SetupState {
  /** No owner account yet — the install has never been configured. */
  fresh: boolean;
  steps: SetupSteps;
  runner: RunnerStatus;
}

/* ---------------------------------------------------------------- runner */

/** `GET /api/runner` */
export interface RunnerStatus {
  /** The container is up right now. */
  running: boolean;
  /** The container exists (running or stopped). */
  exists: boolean;
  /** `claude` is on PATH inside the container. */
  claudeInstalled: boolean;
  /** The Docker daemon we were told to use answered. */
  dockerReachable: boolean;
  /** Container name. */
  container: string;
  /** Host the Docker daemon lives on — empty/undefined means this machine. */
  host?: string;
  /** Free-form explanation for whatever is currently wrong. */
  detail?: string;
}

/**
 * Where the runner lives.
 * - `local` — the Docker daemon on the same machine as the vibehub server.
 * - `ssh`   — a Docker daemon on another host, reached over SSH.
 */
export type RunnerKind = "local" | "ssh";

export interface RunnerSettings {
  kind: RunnerKind;
  /** Container name vibehub manages. */
  container: string;
  /** `user@host` target when `kind === "ssh"`. */
  host?: string;
  /** SSH login user when `kind === "ssh"`. */
  user?: string;
  /** Path to the private key on the vibehub server when `kind === "ssh"`. */
  keyPath?: string;
  /** Image the runner container is built from. */
  image?: string;
}

/** A single line of `WS /api/runner/logs`. Plain strings are also accepted. */
export interface RunnerLogEvent {
  line?: string;
  /** Terminal event: provisioning finished. */
  done?: boolean;
  ok?: boolean;
  error?: string;
}

/* -------------------------------------------------------------- settings */

export interface GitIdentity {
  name: string;
  email: string;
}

/** `GET /api/settings` */
export interface Settings {
  git: GitIdentity;
  /** Let cards keep running without asking for confirmation on every tool call. */
  autonomous: boolean;
  runner: RunnerSettings;
  /** Externally reachable base URL, when the install has one. */
  publicUrl?: string;
}

/** `PATCH /api/settings` — partial, only the keys you send are touched. */
export interface SettingsPatch {
  git?: Partial<GitIdentity>;
  autonomous?: boolean;
  defaultAccountLabel?: string;
  runner?: Partial<RunnerSettings>;
}

/* ---------------------------------------------------------------- github */

/** `GET /api/github` */
export interface GithubState {
  connected: boolean;
  /** GitHub login the stored token resolves to. */
  login?: string;
  scopes?: string[];
  /** Why the stored token is not usable. */
  error?: string;
}

export interface GithubRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

/* ------------------------------------------------------- projects & cards */

/**
 * Board columns. `waiting` and `working` mirror what the Claude hooks report from inside the
 * runner; `backlog`, `paused` and `done` are only ever set by a human.
 */
export type CardColumn = "backlog" | "waiting" | "working" | "paused" | "done";

export const CARD_COLUMNS: readonly CardColumn[] = [
  "backlog",
  "waiting",
  "working",
  "paused",
  "done",
] as const;

/** What the Claude hook callback (`POST /api/runner/status`) reports. */
export type CardStatus = "working" | "waiting";

export interface Project {
  id: string;
  name: string;
  /** `owner/repo`, when the project is backed by a GitHub repository. */
  repo?: string;
  cloneUrl?: string;
  /** Branch new card worktrees start from. */
  defaultBranch?: string;
  /** Claude account cards inherit. Absent = the runner's default profile. */
  accountSlug?: string;
  /** Claude model cards inherit. Absent = the account default. */
  model?: string;
  /** Position in the sidebar, smallest first. */
  position?: number;
  createdAt: number;
  updatedAt?: number;
}

export interface NewProject {
  name: string;
  repo?: string;
  defaultBranch?: string;
  accountSlug?: string;
  model?: string;
}

/** `PATCH /api/projects/:id` */
export type ProjectPatch = Partial<NewProject> & { position?: number };

/**
 * `PATCH /api/projects/:id/order` — the sidebar reorder route. Its body key is `order` (that is
 * the contract), while the resulting value is read back on the entity as `position`.
 */
export interface ReorderBody {
  order: number;
}

export interface Card {
  id: string;
  projectId: string;
  title: string;
  column: CardColumn;
  /** Position inside the column, smallest first. */
  position?: number;
  /** Branch the card's worktree is on. */
  branch?: string;
  /** Branch the worktree was cut from. */
  base?: string;
  /** tmux session name inside the runner. */
  session?: string;
  /** Worktree directory slug inside the runner. */
  worktree?: string;
  /** Live hook status. Absent/null = no running Claude process. */
  status?: CardStatus | null;
  statusAt?: number;
  accountSlug?: string;
  model?: string;
  /** Claude session id this card resumes. */
  resumeSessionId?: string;
  openedAt?: number;
  pausedAt?: number | null;
  createdAt: number;
  updatedAt?: number;
}

export interface NewCard {
  projectId: string;
  title: string;
  branch?: string;
  accountSlug?: string;
  model?: string;
  resumeSessionId?: string;
}

/** `PATCH /api/cards/:id` — moving to `done` is always a manual, human action. */
export interface CardPatch {
  title?: string;
  column?: CardColumn;
  position?: number;
  accountSlug?: string | null;
  model?: string | null;
}

export interface RestartAllResult {
  restarted: number;
  skipped: number;
}

export interface UploadResult {
  /** Path of the uploaded file *inside the runner*. */
  path: string;
}

/* ------------------------------------------------- accounts, mcps, brain */

/**
 * A Claude account is an isolated profile directory inside the runner, so several logins can
 * coexist and cards can be pinned to one.
 */
export interface Account {
  slug: string;
  label: string;
  /** A long-lived token is in the vault. The value itself never comes back. */
  hasToken?: boolean;
  createdAt?: number;
}

/** `GET /api/accounts` */
export interface AccountsResponse {
  accounts: Account[];
  /** Display name of the built-in default profile. */
  defaultLabel: string;
}

export type McpTransport = "stdio" | "http" | "sse";

/** An MCP server injected into every Claude profile in the runner. */
export interface Mcp {
  id: string;
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Names of the environment variables this MCP takes. Values live in the vault. */
  env?: string[];
  /** Which of those names already have a value stored. */
  secrets?: Record<string, boolean>;
  createdAt?: number;
}

export interface NewMcp {
  name: string;
  command: string;
  args?: string[];
  env?: string[];
  secrets?: Record<string, string>;
}

/** `GET /api/brain` — the shared CLAUDE.md planted into every card worktree. */
export interface Brain {
  text: string;
  /** What the server ships when nobody has customised it. */
  defaultText: string;
}

/** `POST /api/import` — adopt Claude Code sessions that already exist on disk. */
export interface ImportSession {
  sessionId: string;
  title?: string;
  projectId?: string;
  cwd?: string;
  updatedAt?: number;
}

/* --------------------------------------------------------------- generic */

/** Every non-2xx response body. */
export interface ApiErrorBody {
  error: string;
}
