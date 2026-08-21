import { del, get, patch, post } from "@/lib/api";
import type {
  Account,
  AccountsResponse,
  Brain,
  BrainApplyResult,
  BrainWriteResult,
  Card,
  CardColumn,
  GithubRepo,
  GithubState,
  Mcp,
  McpSecretsResponse,
  McpTransport,
  NewCard,
  Project,
  RestartAllResult,
  RunnerStatus,
  UploadResult,
} from "@/api/types";

/**
 * The board's data layer: query keys plus one function per route.
 *
 * The types here come straight from `@/api/types`, which mirrors what the server sends. The tiny
 * accessors below exist so components ask for a concept ("this project's repository") instead of
 * reaching for a field name — the one place to touch if the shape ever moves.
 */

/* ------------------------------------------------------------------ types */

export type BoardProject = Project;
export type BoardCard = Card;
export type BoardAccount = Account;
export type BoardMcp = Mcp;

/* -------------------------------------------------------------- accessors */

/** `owner/repo` of a project, when it is backed by a repository. */
export function projectRepo(p: BoardProject | undefined): string | undefined {
  return p?.repoFullName;
}

/** Branch new card worktrees are cut from. */
export function projectBaseBranch(p: BoardProject | undefined): string | undefined {
  return p?.baseBranch;
}

/** Claude account the project's cards inherit. */
export function projectAccountSlug(p: BoardProject | undefined): string | undefined {
  return p?.defaultAccountSlug;
}

/** Worktree directory slug of a card inside the runner. */
export function cardWorktree(c: BoardCard | undefined): string | undefined {
  return c?.worktreeSlug;
}

/** tmux session name of a card inside the runner. */
export function cardSession(c: BoardCard | undefined): string | undefined {
  return c?.tmuxSession;
}

/**
 * Can the terminal attach right now, or does it have to wait for `POST /open`?
 *
 * A card that has been opened before (`openedAt`) or was pre-provisioned at creation (`preparedAt`)
 * already has a worktree and a tmux session in the runner, and the websocket attaches with
 * `tmux new-session -A` — a complete attach-or-create. Anything else is a first open, which may
 * have to clone a whole repository first.
 */
export function cardOpensInstantly(c: BoardCard | undefined | null): boolean {
  return Boolean(c?.openedAt || c?.preparedAt);
}

/** Display name of an account. */
export function accountLabel(a: BoardAccount): string {
  return a.name || a.slug;
}

/** Transport of an MCP server. */
export function mcpTransport(m: BoardMcp): McpTransport {
  return m.kind ?? "stdio";
}

/** Names of the secrets an MCP declares (env vars for stdio, headers for http/sse). */
export function mcpSecretNames(m: BoardMcp): string[] {
  return [...(m.envKeys ?? []), ...(m.headerKeys ?? [])];
}

/**
 * Whether an MCP is ready to be injected: every name it declares has a value in the vault.
 *
 * The status map comes from `GET /api/mcps/secrets` and is booleans only — the values never leave
 * the server. A name the map has not heard of counts as MISSING, not as fine: an MCP that will
 * start without its token is exactly the thing this badge exists to catch, and the safe default
 * for "unknown" is the one that makes you look.
 */
export interface McpSecretStatus {
  /** Names the MCP declares, in declaration order. */
  names: string[];
  /** The ones with no value in the vault. */
  missing: string[];
  /** Declares nothing — there is no status to show at all. */
  none: boolean;
  /** Declares at least one name and every one of them has a value. */
  ready: boolean;
}

export function mcpSecretStatus(
  m: BoardMcp,
  /** This MCP's entry from `GET /api/mcps/secrets` — `{ [name]: hasValue }`. */
  stored: Record<string, boolean> | undefined,
): McpSecretStatus {
  const names = mcpSecretNames(m);
  const missing = names.filter((name) => !stored?.[name]);
  return { names, missing, none: names.length === 0, ready: names.length > 0 && missing.length === 0 };
}

/* ------------------------------------------------------------- query keys */

export const PROJECTS_KEY = ["board", "projects"] as const;
export const ACCOUNTS_KEY = ["board", "accounts"] as const;
export const ACCOUNT_TOKENS_KEY = ["board", "accounts", "tokens"] as const;
export const MCPS_KEY = ["board", "mcps"] as const;
export const MCP_SECRETS_KEY = ["board", "mcps", "secrets"] as const;
export const BRAIN_KEY = ["board", "brain"] as const;
export const RUNNER_KEY = ["board", "runner"] as const;
export const GITHUB_KEY = ["board", "github"] as const;
/** Prefix matching EVERY project's card list — for invalidating the whole board at once. */
export const CARDS_PREFIX_KEY = ["board", "cards"] as const;
export const cardsKey = (projectId: string) => ["board", "cards", projectId] as const;
export const cardKey = (cardId: string) => ["board", "card", cardId] as const;
export const githubReposKey = (q: string) => ["board", "github", "repos", q] as const;
export const githubBranchesKey = (owner: string, repo: string) =>
  ["board", "github", "branches", owner, repo] as const;

/* ---------------------------------------------------------------- inputs */

export interface NewProjectInput {
  name: string;
  /** `owner/repo`. Absent = a scratch project with no repository. */
  repo?: string;
  cloneUrl?: string;
  /** Branch card worktrees are cut from. */
  defaultBranch?: string;
  /** Claude account the project's cards inherit. */
  accountSlug?: string;
}

export interface CardPatchInput {
  title?: string;
  column?: CardColumn;
  position?: number;
  /** null clears it (inherit the project's account again). */
  accountSlug?: string | null;
  /** null clears it (back to the account default). */
  model?: string | null;
}

/* --------------------------------------------------------------- requests */

export const boardApi = {
  /* projects */
  listProjects: () => get<{ projects: BoardProject[] }>("/projects").then((r) => r.projects ?? []),

  createProject: (input: NewProjectInput) =>
    post<{ project: BoardProject }>("/projects", {
      name: input.name,
      repoFullName: input.repo,
      cloneUrl: input.cloneUrl,
      baseBranch: input.defaultBranch,
      defaultAccountSlug: input.accountSlug,
    }).then((r) => r.project),

  deleteProject: (id: string) => del<{ ok: true }>(`/projects/${encodeURIComponent(id)}`),

  /** Moves a project to `position` in the sidebar; the server renumbers and returns the new list. */
  reorderProject: (id: string, position: number) =>
    patch<{ projects: BoardProject[] }>(`/projects/${encodeURIComponent(id)}/order`, { position }).then(
      (r) => r.projects ?? [],
    ),

  /* cards */
  listCards: (projectId: string) =>
    get<{ cards: BoardCard[] }>(`/projects/${encodeURIComponent(projectId)}/cards`).then((r) => r.cards ?? []),

  /** Light read of one card — it does NOT touch the runner, so a deep link can decide how to open. */
  getCard: (id: string) => get<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}`).then((r) => r.card),

  createCard: (input: NewCard) => post<{ card: BoardCard }>("/cards", input).then((r) => r.card),

  patchCard: (id: string, body: CardPatchInput) =>
    patch<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}`, body).then((r) => r.card),

  deleteCard: (id: string) => del<{ ok: true }>(`/cards/${encodeURIComponent(id)}`),

  openCard: (id: string) =>
    post<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}/open`).then((r) => r.card),

  pauseCard: (id: string) =>
    post<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}/pause`).then((r) => r.card),

  restartCard: (id: string) =>
    post<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}/restart`).then((r) => r.card),

  restartAllCards: () => post<RestartAllResult>("/cards/restart-all"),

  /**
   * Uploads an image so the agent can read it. The running server takes JSON `{ name, content }`
   * with base64 content (the doc says multipart); it answers with the path INSIDE the runner, which
   * is what gets typed into the prompt.
   */
  uploadCardImage: async (id: string, file: File): Promise<UploadResult> => {
    const content = await fileToBase64(file);
    return await post<UploadResult>(`/cards/${encodeURIComponent(id)}/upload`, { name: file.name, content });
  },

  startCardBrowser: (id: string) => post<unknown>(`/cards/${encodeURIComponent(id)}/browser`),
  stopCardBrowser: (id: string) => del<unknown>(`/cards/${encodeURIComponent(id)}/browser`),

  /* accounts */
  listAccounts: () =>
    get<AccountsResponse & { accounts: BoardAccount[] }>("/accounts").then((r) => ({
      accounts: Array.isArray(r?.accounts) ? r.accounts : [],
      defaultLabel: r?.defaultLabel ?? "",
    })),

  accountTokens: () =>
    get<{ bySlug?: Record<string, boolean>; defaultHasToken?: boolean }>("/accounts/tokens").then((r) => ({
      bySlug: r?.bySlug ?? {},
      defaultHasToken: Boolean(r?.defaultHasToken),
    })),

  createAccount: (label: string) =>
    post<{ account: BoardAccount }>("/accounts", { name: label }).then((r) => r.account),

  deleteAccount: (slug: string) => del<unknown>(`/accounts/${encodeURIComponent(slug)}`),

  setAccountToken: (slug: string, token: string) =>
    post<unknown>(`/accounts/${encodeURIComponent(slug)}/token`, { token }),

  deleteAccountToken: (slug: string) => del<unknown>(`/accounts/${encodeURIComponent(slug)}/token`),

  setDefaultAccountLabel: (defaultAccountLabel: string) =>
    patch<unknown>("/settings", { defaultAccountLabel }),

  /* mcps */
  listMcps: () => get<{ mcps: BoardMcp[] }>("/mcps").then((r) => (Array.isArray(r?.mcps) ? r.mcps : [])),

  createMcp: (input: {
    name: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    keys?: string[];
  }) =>
    post<{ mcp: BoardMcp }>("/mcps", {
      name: input.name,
      kind: input.transport,
      command: input.command,
      args: input.args,
      url: input.url,
      ...(input.transport === "stdio" ? { envKeys: input.keys } : { headerKeys: input.keys }),
    }).then((r) => r.mcp),

  deleteMcp: (id: string) => del<unknown>(`/mcps/${encodeURIComponent(id)}`),

  setMcpSecret: (id: string, key: string, value: string) =>
    post<unknown>(`/mcps/${encodeURIComponent(id)}/secret`, { key, value }),

  /** Which declared names already have a value. Booleans only — no value ever comes back. */
  mcpSecrets: () =>
    get<McpSecretsResponse>("/mcps/secrets").then((r) => (r?.byMcp ?? {}) as Record<string, Record<string, boolean>>),

  applyMcps: () => post<{ runners?: number; mcps?: number }>("/mcps/apply"),

  /* brain — the shared CLAUDE.md every card's profile gets */
  brain: () => get<Brain>("/brain"),

  /** Saves AND pushes: the response says how many terminals restarted and how many were deferred. */
  saveBrain: (text: string) => post<BrainWriteResult>("/brain", { text }),

  /** Back to the text the server ships with. Same push, same report. */
  resetBrain: () => del<BrainWriteResult>("/brain"),

  /** Manual re-push, for when a runner was down when the text was saved. */
  applyBrain: () => post<BrainApplyResult>("/brain/apply"),

  /* runner & github */
  runner: () => get<RunnerStatus & { provisioning?: boolean }>("/runner"),
  provisionRunner: () => post<{ ok: true }>("/runner/provision"),
  startRunner: () => post<RunnerStatus>("/runner/start"),

  github: () => get<GithubState>("/github"),
  githubRepos: (q: string) =>
    get<{ repos: GithubRepo[] }>("/github/repos", { params: q ? { q } : undefined }).then((r) =>
      Array.isArray(r?.repos) ? r.repos : [],
    ),
  githubBranches: (owner: string, repo: string) =>
    get<{ branches: string[] }>(
      `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    ).then((r) => (Array.isArray(r?.branches) ? r.branches : [])),
};

/* ---------------------------------------------------------------- helpers */

/** Splits `owner/repo`. Returns nulls rather than throwing — the caller is a form. */
export function splitRepo(fullName: string | undefined): { owner: string | null; repo: string | null } {
  const [owner, repo, ...rest] = String(fullName ?? "").trim().split("/");
  if (!owner || !repo || rest.length > 0) return { owner: null, repo: null };
  return { owner, repo };
}

/** File -> bare base64 (no `data:` prefix), which is what the upload route wants. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsDataURL(file);
  });
}

/** The runner rejects an image over 10 MB; catching it here saves a pointless round trip. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Claude models a card can be pinned to. Mirrors the server's list; absent on a card means "the
 * account default", which is why the empty option is never written back.
 */
export const CLAUDE_MODELS: readonly { id: string; label: string }[] = [
  { id: "claude-fable-5", label: "Fable" },
  { id: "claude-opus-5", label: "Opus" },
  { id: "claude-sonnet-5", label: "Sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku" },
] as const;

/** Slug the token routes use to address the built-in profile, which has no account record. */
export const DEFAULT_ACCOUNT_SLUG = "default";
