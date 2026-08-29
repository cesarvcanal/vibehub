/**
 * TypeScript mirror of the HTTP contract in `docs/API.md`.
 *
 * The back-end is the authority: nothing here invents a field the contract does not describe.
 * Fields the contract marks optional are optional here too, so a slightly older server never
 * crashes the UI.
 */

/* ------------------------------------------------------------------ auth */

/**
 * `owner` runs the install (every project, every card, the accounts, the vault, the settings, the
 * people). `member` is somebody the owner invited: they see only what has been shared with them.
 */
export type Role = "owner" | "member";

export interface User {
  id: string;
  username: string;
  role: Role;
  createdAt?: string;
}

/** `GET /api/users` — owner only. */
export interface UsersResponse {
  users: User[];
}

/**
 * What a member may do with a card that was shared with them: `work` types into the session,
 * `view` only reads it. A card reached through its project AND directly takes the stronger of the
 * two.
 */
export type ShareLevel = "work" | "view";

/** A share as the server answers it — the username rides along, because the screen shows people. */
export interface Share {
  kind: "card" | "project";
  targetId: string;
  userId: string;
  username: string;
  level: ShareLevel;
  createdAt: number;
}

/** `GET /api/cards/:id/shares` and `GET /api/projects/:id/shares` — owner only. */
export interface SharesResponse {
  shares: Share[];
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
  /**
   * `WS /api/runner/terminal` is available — a shell inside the runner container, which is where
   * `claude` and `gh` get signed in by hand. Absent on a server that predates the route.
   */
  terminal?: boolean;
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
  /** Display name of the built-in default Claude profile. */
  defaultAccountLabel: string | null;
  /** Set once the wizard finished, so it stops taking over the router. */
  setupCompletedAt: string | null;
  /** ISO 639-1 hint for voice transcription, or null to let Whisper detect. */
  transcribeLanguage?: string | null;
  /** Minutes a terminal may sit idle before it is hibernated. 0 = never. */
  idleHibernateMinutes?: number;
  runner: RunnerSettings;
  /** Externally reachable base URL, when the install has one. */
  publicUrl?: string;
}

/** `GET /api/transcribe` — voice input status. Key values never come back. */
export interface TranscribeStatus {
  available: boolean;
  proofread: boolean;
  language: string | null;
}

/** `PATCH /api/settings` — partial, only the keys you send are touched. */
export interface SettingsPatch {
  git?: Partial<GitIdentity>;
  autonomous?: boolean;
  defaultAccountLabel?: string | null;
  transcribeLanguage?: string | null;
  idleHibernateMinutes?: number;
  runner?: Partial<RunnerSettings>;
}

/* ---------------------------------------------------------------- github */

/**
 * A GitHub ACCOUNT vibehub can clone as. There is no OAuth: a connection is a token somebody pasted
 * (a fine-grained PAT with Contents read/write, or a classic token with `repo`). The token itself
 * never comes back from the server — only this identity does.
 */
export interface GithubConnection {
  id: string;
  /** What the human called it ("personal", "acme org"). */
  label: string;
  /** GitHub login the token resolves to. */
  login: string;
  /** OAuth scopes, when GitHub reports them (classic tokens only). */
  scopes?: string[];
  createdAt: number;
  /** The stored token still works — a live check the server did while answering. */
  ok?: boolean;
  /** Why it does not (revoked, expired). */
  error?: string;
}

/** `GET /api/github` — every account, in connection order. The first one is the default. */
export interface GithubState {
  connections: GithubConnection[];
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
  repoFullName?: string;
  cloneUrl?: string;
  /** Branch new card worktrees start from. */
  baseBranch: string;
  /** Claude account cards inherit. Absent = the runner's default profile. */
  defaultAccountSlug?: string;
  /** GitHub account this repository is cloned with. Absent = the first connection. */
  githubConnectionId?: string;
  /** Position in the sidebar, smallest first. */
  position: number;
  createdAt: number;
  updatedAt?: number;
}

export interface NewProject {
  name: string;
  repoFullName?: string;
  cloneUrl?: string;
  baseBranch?: string;
  defaultAccountSlug?: string;
  /** GitHub account the repository belongs to. Absent = the first connection. */
  githubConnectionId?: string | null;
}

/** `PATCH /api/projects/:id` */
export type ProjectPatch = Partial<NewProject> & { position?: number };

/** `PATCH /api/projects/:id/order` — the sidebar reorder route. */
export interface ReorderBody {
  /** Target index in the sidebar (0-based). Matches `Project.position`. */
  position: number;
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
  /** tmux session name inside the runner. Derived by the server — never user input. */
  tmuxSession: string;
  /** Worktree directory slug inside the runner. Derived by the server. */
  worktreeSlug: string;
  /** Live hook status. Absent/null = no running Claude process. */
  status?: CardStatus | null;
  statusAt?: number;
  accountSlug?: string;
  model?: string;
  /** Claude session id this card resumes. */
  resumeSessionId?: string;
  /** First time the card's terminal was opened — presence means "attach instantly". */
  openedAt?: number;
  /**
   * Workspace pre-provisioned in the background at creation (clone/worktree/session already exist)
   * without the card ever being opened. Also allows an instant attach.
   */
  preparedAt?: number;
  pausedAt?: number | null;
  /**
   * HIBERNATED: the session was killed for having sat idle, and nothing else changed — the card is
   * in the same column, in the same place, with no dot. It is the "gone cold" mark, not a move.
   * Opening the card clears it (the session comes back with `claude -c`, same conversation).
   */
  hibernatedAt?: number | null;
  /**
   * The shared brain, the MCP set, or this card's own model/account (`config`) changed while it was
   * mid-turn. Claude only reads any of them at start-up, so the server defers the restart instead of
   * interrupting work: the card picks the new configuration up the moment it goes idle. Absent/null
   * = nothing pending.
   */
  restartPendingAt?: number | null;
  /** Which write scheduled the deferred restart. */
  restartReason?: "brain" | "mcp" | "config";
  /**
   * What the agent inside the card SAID about its own work (via `vibehub_report`): 'working' (still
   * on it), 'ready' (done, ready to deliver/review), 'needs_me' (wants a decision from the user) or
   * 'blocked' (cannot proceed). Orthogonal to `status`/`column` — it never moves the card. Absent =
   * the agent has said nothing.
   */
  declaredState?: DeclaredState;
  /** One-line summary the agent reported with `declaredState`. */
  declaredSummary?: string;
  /** Last time a human typed into this card's terminal (epoch ms). */
  humanActiveAt?: number;
  createdAt: number;
  updatedAt?: number;
}

/** The agent's own read of where its work stands — see `Card.declaredState`. */
export type DeclaredState = "working" | "ready" | "needs_me" | "blocked";

export interface NewCard {
  projectId: string;
  title: string;
  /** Optional fields go through the same validation an edit uses. */
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
  /** null clears it (back to the derived `card/<worktreeSlug>`). */
  branch?: string | null;
  base?: string;
  resumeSessionId?: string | null;
}

export interface RestartAllResult {
  restarted: number;
  skipped: number;
}

export interface UploadResult {
  /** Path of the uploaded file *inside the runner*. */
  path: string;
}

/* --------------------------------------------------------------- outbox */

/** What the agent's pane is running — see the server's services/board/outbox.ts. */
export type AgentState = "running" | "shell" | "none";

/** A composed message the server accepted but could not deliver yet. */
export interface OutboxMessage {
  id: string;
  text: string;
  createdAt: number;
  /** Failed delivery attempts. > 0 = it is not merely waiting, it is struggling. */
  attempts: number;
  lastError?: string;
}

/** `GET /api/cards/:id/messages` and the answer to a `POST`. */
export interface OutboxStatus {
  pending: OutboxMessage[];
  agent: AgentState;
}

export interface QueueMessageResult extends OutboxStatus {
  /** true = it went straight into the agent's prompt; false = it is waiting in `pending`. */
  delivered: boolean;
}

/* ------------------------------------------------- accounts, mcps, brain */

/**
 * A Claude account is an isolated profile directory inside the runner, so several logins can
 * coexist and cards can be pinned to one.
 */
export interface Account {
  slug: string;
  /** Display name. The slug is derived from it and is what the profile directory is called. */
  name: string;
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
  kind: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Names of the environment variables this MCP takes (stdio). Values live in the vault. */
  envKeys?: string[];
  /** Names of the headers this MCP takes (http/sse). Values live in the vault. */
  headerKeys?: string[];
  createdAt?: number;
}

export interface NewMcp {
  name: string;
  kind: McpTransport;
  /** stdio: the executable and its arguments. */
  command?: string;
  args?: string[];
  /** http/sse: the endpoint. */
  url?: string;
  /** Names only — values are stored one at a time through `POST /api/mcps/:id/secret`. */
  envKeys?: string[];
  headerKeys?: string[];
}

/** `GET /api/brain` — the shared CLAUDE.md planted into every card worktree. */
export interface Brain {
  text: string;
  /** What the server ships when nobody has customised it. */
  defaultText: string;
  /** Absent while nothing has been saved. */
  updatedAt?: string;
}

/**
 * What a write to the brain or to the MCP set reports back.
 *
 * Saving does not only persist: the server pushes the new text into every runner profile and
 * restarts the terminals it can. A card that is mid-turn is NOT interrupted — it is flagged
 * instead, and picks the change up when it finishes. So the three numbers are the whole story:
 * whether the push happened at all, how many restarted now, how many will restart later.
 */
export interface ApplyOutcome {
  /** The push into the runner profiles succeeded. False = saved but not live anywhere yet. */
  applied?: boolean;
  /** Idle terminals restarted immediately. */
  restarted?: number;
  /** Busy terminals flagged to restart when their current turn ends. */
  pending?: number;
}

/** `POST /api/brain` / `DELETE /api/brain` — the saved view plus what the push achieved. */
export type BrainWriteResult = Brain & ApplyOutcome;

/** `POST /api/brain/apply` — the manual re-push. */
export interface BrainApplyResult extends ApplyOutcome {
  /** Runner profiles the text was written into. */
  runners?: number;
}

/**
 * `GET /api/mcps/secrets` — which declared env vars / headers already have a value in the vault.
 * Booleans only: the values themselves never leave the server.
 */
export interface McpSecretsResponse {
  byMcp: Record<string, Record<string, boolean>>;
}

/** `POST /api/import` — adopt Claude Code sessions that already exist on disk. */
export interface ImportSession {
  sessionId: string;
  title?: string;
  projectId?: string;
  cwd?: string;
  updatedAt?: number;
}

/** One TCP port listening inside the runner — `GET /api/preview/ports`. */
export interface PreviewPort {
  port: number;
  /** Where the server bound. Informational: the proxy reaches all of them. */
  address: "loopback" | "all" | "other";
  /** Best-effort process name ("node", "vite", …). */
  process?: string;
  pid?: number;
}

/* --------------------------------------------------------------- generic */

/** Every non-2xx response body. */
export interface ApiErrorBody {
  error: string;
}
