import { del, get, patch, post } from "@/lib/api";
import type {
  Account,
  AccountsResponse,
  ApplyOutcome,
  Brain,
  BrainApplyResult,
  BrainWriteResult,
  Card,
  CardColumn,
  GithubConnection,
  GithubRepo,
  GithubState,
  Mcp,
  McpSecretsResponse,
  McpTransport,
  NewCard,
  OutboxStatus,
  PreviewPort,
  Project,
  QueueMessageResult,
  RestartAllResult,
  RestartedPreview,
  RunnerStatus,
  UploadResult,
} from "@/api/types";
import { t } from "@/i18n";

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

/**
 * The brain as the screen needs it: the stored view plus WHO saved it, when the server records that.
 * A shared instruction file that every terminal in the install obeys is not the kind of thing that
 * should have changed anonymously.
 */
export type BoardBrain = Brain & { by?: string };

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
 * Where a card lives inside the runner, as one line: worktree, base branch, tmux session.
 *
 * It is a TOOLTIP, not a row. This used to be a permanent footer under every terminal, which spent
 * a line of height on three strings you need roughly never — and the one thing this screen is short
 * of is height. Empty pieces are dropped rather than printed as blanks.
 */
export function cardRunnerHint(c: BoardCard | undefined): string {
  if (!c) return "";
  const worktree = cardWorktree(c);
  const session = cardSession(c);
  return [worktree ? `card/${worktree}` : "", c.base ? `base ${c.base}` : "", session ? `tmux ${session}` : ""]
    .filter(Boolean)
    .join(" · ");
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

/**
 * Does opening this card need `POST /open` at all?
 *
 * The call is not free: it runs the whole provisioning script in the runner (a `docker exec` that
 * re-seeds the profile, the MCPs and the brain, and makes sure the worktree and the tmux session
 * exist) and it is SERIALIZED PER PROJECT on the server. Firing it on every card you glance at puts
 * the card that genuinely needs provisioning behind a queue of cards that needed nothing — which is
 * exactly what "the card takes forever to load" feels like.
 *
 * So it is asked for only when it can change something:
 *  - the card has never been opened (nothing exists in the runner yet);
 *  - it was paused or hibernated (its session was killed and has to come back);
 *  - it sits in `backlog` or `paused`, where opening it is what moves it to `waiting`.
 *
 * A card that is already open and live needs none of that: the terminal's own websocket attaches
 * with `tmux new-session -A`, and it provisions on its own if the session turns out to be missing.
 * PURE.
 */
export function cardNeedsOpen(c: BoardCard | undefined | null): boolean {
  if (!c) return true; // nothing known about it: ask, and let the server decide
  if (!c.openedAt) return true;
  if (c.pausedAt || c.hibernatedAt) return true;
  return c.column === "backlog" || c.column === "paused";
}

/** Display name of an account. */
export function accountLabel(a: BoardAccount): string {
  return a.name || a.slug;
}

/**
 * What to call the runner's built-in profile.
 *
 * The install can rename it (`defaultAccountLabel` in settings, which `GET /api/accounts` echoes as
 * `defaultLabel`); until somebody does, it is addressed by its slug. The blank check matters: the
 * server sends `""` for "never named", and `??` would happily show an empty pill.
 */
export function defaultAccountLabelOr(label: string | null | undefined): string {
  return (label ?? "").trim() || DEFAULT_ACCOUNT_SLUG;
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
export const ACCOUNT_USAGE_KEY = ["board", "accounts", "usage"] as const;
export const MCPS_KEY = ["board", "mcps"] as const;
export const MCP_SECRETS_KEY = ["board", "mcps", "secrets"] as const;
export const BRAIN_KEY = ["board", "brain"] as const;
export const TRANSCRIBE_KEY = ["board", "transcribe"] as const;
export const RUNNER_KEY = ["board", "runner"] as const;
export const GITHUB_KEY = ["board", "github"] as const;
export const PREVIEW_PORTS_KEY = ["board", "preview", "ports"] as const;
/** Prefix matching EVERY project's card list — for invalidating the whole board at once. */
export const CARDS_PREFIX_KEY = ["board", "cards"] as const;
/**
 * Every card in the install, in ONE request — what the "Recent" list reads.
 *
 * It sits UNDER the cards prefix so invalidating the board invalidates it too, and the `@` keeps it
 * out of the project-id namespace: no project can ever be called `@all`.
 */
export const ALL_CARDS_KEY = ["board", "cards", "@all"] as const;
export const cardsKey = (projectId: string) => ["board", "cards", projectId] as const;
export const cardKey = (cardId: string) => ["board", "card", cardId] as const;
export const cardSessionKey = (cardId: string) => ["board", "card", cardId, "session"] as const;
/** The card's outbox: what was composed and has not reached the agent yet. */
export const cardMessagesKey = (cardId: string) => ["board", "card", cardId, "messages"] as const;
/** The repo/branch caches are keyed by CONNECTION too — the same name means a different repo per account. */
export const githubReposKey = (connection: string, q: string) =>
  ["board", "github", "repos", connection, q] as const;
export const githubBranchesKey = (connection: string, owner: string, repo: string) =>
  ["board", "github", "branches", connection, owner, repo] as const;

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
  /** GitHub account the repository is cloned with. Absent = the first connection. */
  githubConnectionId?: string | null;
}

/** `GET /api/transcribe` — what voice input can do on THIS install. */
export interface TranscribeStatus {
  /** An OpenAI key is stored; without one the microphone has nothing to talk to. */
  available: boolean;
  /** A Claude key is stored too, so transcriptions get proofread before they come back. */
  proofread: boolean;
  /** ISO 639-1 hint sent to the recogniser, or null for auto-detect. */
  language: string | null;
}

/** `POST /api/cards/:id/transcribe` */
export interface Transcription {
  text: string;
  proofread: boolean;
}

/**
 * `GET /api/cards/:id/session` — what the card is ACTUALLY running right now.
 *
 * The card record only says what was PINNED (`model`, `accountSlug`), and most cards pin nothing:
 * they inherit. So the pills used to read "Default model" and "Main (default)", which is the one
 * thing nobody wants from them — the question is always "which model is answering me", never
 * "did somebody type a model into this card".
 *
 * `model` is read from the live session transcript (the last assistant turn), so it is the truth
 * and not a guess; `account` is the effective account after card -> project -> default, already
 * resolved to a display name. A card whose agent has not answered yet has no turn to read, and the
 * route says so with nulls rather than inventing one.
 */
export interface CardSessionInfo {
  /** Model id from the last assistant turn, or null while the session has not answered yet. */
  model: string | null;
  /** Display name for that model when the server knows one. */
  modelLabel: string | null;
  /** The account the session is really using. */
  account: { slug: string | null; name: string };
  /**
   * What the terminal is doing right now. The chat needs it: with no card list beside it (a phone
   * has none) this poll is the only thing that says "the agent is still working".
   */
  situation: CardSituation;
}

/**
 * What a model/account switch did to the LIVE session, straight from the server: `restarted` = the
 * session was ended and the reattach starts Claude with the new one, in the same conversation;
 * `pending` = Claude was working, so it applies the moment the card goes idle; `none` = there was no
 * live session to change (the pin is simply what the next start uses).
 */
export type SessionChange = "none" | "restarted" | "pending";

/**
 * A terminal's current situation, as the server words it. `stopped` = the session is still there but
 * Claude has EXITED, leaving a bare shell (a `/exit`, a crash) — the chat surfaces it as
 * "Claude parou" with a Restart, instead of a silent shell that quietly swallows what you type.
 */
export type CardSituation = "working" | "waiting" | "paused" | "done" | "stopped" | "no session";

/** One metered plan window: how much is gone, and when it empties again. */
export interface UsageWindow {
  /** 0..100 percent of the window consumed. */
  utilization: number;
  /** ISO instant it resets, or null when the server did not say. */
  resetsAt: string | null;
}

/** Why an account has no numbers. Each one gets its OWN sentence — that is the point of the split. */
export type UsageError = "no_credentials" | "rate_limited" | "unauthorized" | "unreachable";

/**
 * Plan usage of one account. `available` is the only branch the UI needs: with it, three bars;
 * without it, the sentence for `error`.
 */
export interface AccountUsage {
  available: boolean;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  /** When the numbers were READ (not when they were served) — what makes `stale` legible. */
  fetchedAt: number;
  /** true = the last good reading, served while the server is backed off the usage endpoint. */
  stale?: boolean;
  /** Epoch ms the back-off lifts. */
  retryAt?: number;
  error?: UsageError;
}

export interface AccountsUsageResponse {
  /** Keyed by account slug, with `default` for the runner's built-in profile. */
  bySlug: Record<string, AccountUsage>;
  fetchedAt: number;
}

export interface CardPatchInput {
  title?: string;
  column?: CardColumn;
  position?: number;
  /** null clears it (inherit the project's account again). */
  accountSlug?: string | null;
  /** null clears it (back to the account default). */
  model?: string | null;
  /** Native chat (beta) opt-in for this card; false/null go back to the transcript chat. */
  sdkChat?: boolean | null;
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
      githubConnectionId: input.githubConnectionId,
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

  /**
   * Every card, from every project, in one request. The per-project lists stay the board's source;
   * this exists for the views that cut ACROSS projects, where N polls would be N times the work.
   */
  listAllCards: () => get<{ cards: BoardCard[] }>("/cards").then((r) => r.cards ?? []),

  /** Light read of one card — it does NOT touch the runner, so a deep link can decide how to open. */
  getCard: (id: string) => get<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}`).then((r) => r.card),

  createCard: (input: NewCard) => post<{ card: BoardCard }>("/cards", input).then((r) => r.card),

  patchCard: (id: string, body: CardPatchInput) =>
    patch<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}`, body).then((r) => r.card),

  /**
   * The same PATCH, keeping the server's verdict on the LIVE session: switching the model or the
   * account ends it so the reattach starts Claude with the new one ("restarted"), or flags it when
   * Claude is working ("pending"). The screen has to say which — promising a switch that has not
   * happened yet is the whole bug this answers.
   */
  patchCardSession: (id: string, body: CardPatchInput) =>
    patch<{ card: BoardCard; session?: SessionChange }>(`/cards/${encodeURIComponent(id)}`, body),

  deleteCard: (id: string) => del<{ ok: true }>(`/cards/${encodeURIComponent(id)}`),

  openCard: (id: string) =>
    post<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}/open`).then((r) => r.card),

  pauseCard: (id: string) =>
    post<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}/pause`).then((r) => r.card),

  restartCard: (id: string) =>
    post<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}/restart`).then((r) => r.card),

  /** Kills the session and leaves the card where it is — the manual version of the idle sweep. */
  hibernateCard: (id: string) =>
    post<{ card: BoardCard }>(`/cards/${encodeURIComponent(id)}/hibernate`).then((r) => r.card),

  restartAllCards: () => post<RestartAllResult>("/cards/restart-all"),

  /** What the card's live session is running — the model in the transcript and the real account. */
  cardSessionInfo: (id: string) =>
    get<Partial<CardSessionInfo>>(`/cards/${encodeURIComponent(id)}/session`).then(
      (r): CardSessionInfo => ({
        model: r?.model ?? null,
        modelLabel: r?.modelLabel ?? null,
        account: { slug: r?.account?.slug ?? null, name: r?.account?.name ?? "" },
        // A server that predates the field simply never looks busy — better than looking stuck.
        situation: r?.situation ?? "waiting",
      }),
    ),

  /**
   * Uploads an image so the agent can read it. The running server takes JSON `{ name, content }`
   * with base64 content (the doc says multipart); it answers with the path INSIDE the runner, which
   * is what gets typed into the prompt.
   */
  uploadCardImage: async (id: string, file: File): Promise<UploadResult> => {
    const content = await fileToBase64(file);
    return await post<UploadResult>(`/cards/${encodeURIComponent(id)}/upload`, { name: file.name, content });
  },

  /**
   * Sends a chat message: the server types it at the prompt of the SAME tmux session the terminal
   * is attached to. There is no separate chat conversation to keep in sync — there is one session.
   */
  sendCardChat: (id: string, text: string) => post<{ ok: true }>(`/cards/${encodeURIComponent(id)}/chat`, { text }),

  /** Presses one whitelisted key in that session — `escape` is the chat's Stop button. */
  sendCardChatKey: (id: string, key: "escape" | "interrupt") =>
    post<{ sent: true }>(`/cards/${encodeURIComponent(id)}/chat/key`, { key }),

  /**
   * Hands a composed message to the card's OUTBOX. It is delivered to a RUNNING Claude, or it waits
   * there until one exists — which is why this is a POST to the server and not a write into the
   * terminal websocket: a socket types into whatever the pane happens to be, including a bare shell
   * where the message simply disappears.
   */
  sendCardMessage: (id: string, text: string) =>
    post<Partial<QueueMessageResult>>(`/cards/${encodeURIComponent(id)}/messages`, { text }).then(
      (r): QueueMessageResult => ({
        delivered: Boolean(r?.delivered),
        pending: Array.isArray(r?.pending) ? r.pending : [],
        agent: r?.agent ?? "none",
      }),
    ),

  /** What is still queued for this card, and whether the agent is up to take it. */
  cardMessages: (id: string) =>
    get<Partial<OutboxStatus>>(`/cards/${encodeURIComponent(id)}/messages`).then(
      (r): OutboxStatus => ({
        pending: Array.isArray(r?.pending) ? r.pending : [],
        agent: r?.agent ?? "none",
      }),
    ),

  cancelCardMessage: (id: string, messageId: string) =>
    del<{ ok: true }>(`/cards/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`),

  startCardBrowser: (id: string) => post<unknown>(`/cards/${encodeURIComponent(id)}/browser`),
  stopCardBrowser: (id: string) => del<unknown>(`/cards/${encodeURIComponent(id)}/browser`),

  /** Ports listening inside the runner right now — what the Preview menu offers to open. */
  previewPorts: () =>
    get<{ ports?: PreviewPort[] }>("/preview/ports").then((r) => (Array.isArray(r?.ports) ? r.ports : [])),

  /**
   * Relaunches a stopped preview in its dedicated runner session and resolves once the port is
   * listening again — the "Reiniciar" of the stopped-preview screen. The server answers 409 with
   * a human message when there is nothing to relaunch (no stored command).
   */
  restartPreview: (cardId: string, port: number) =>
    post<RestartedPreview>(`/cards/${encodeURIComponent(cardId)}/previews/${port}/restart`),

  /** Stops a preview: kills its dedicated session and removes the chip from the card. */
  stopPreview: (cardId: string, port: number) =>
    del<{ stopped: true; port: number }>(`/cards/${encodeURIComponent(cardId)}/previews/${port}`),

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

  /** Plan usage per account. Never rejects for a single account: failures arrive as `error`. */
  accountsUsage: () =>
    get<Partial<AccountsUsageResponse>>("/accounts/usage").then(
      (r): AccountsUsageResponse => ({ bySlug: r?.bySlug ?? {}, fetchedAt: r?.fetchedAt ?? 0 }),
    ),

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

  /**
   * Stores one value in the vault — and the server APPLIES it on the way through, because an MCP
   * whose token has just arrived is precisely the one that was failing at its first call. The
   * outcome comes back so the toast can say what actually happened.
   */
  setMcpSecret: (id: string, key: string, value: string) =>
    post<ApplyOutcome & { ok?: true }>(`/mcps/${encodeURIComponent(id)}/secret`, { key, value }),

  /** Which declared names already have a value. Booleans only — no value ever comes back. */
  mcpSecrets: () =>
    get<McpSecretsResponse>("/mcps/secrets").then((r) => (r?.byMcp ?? {}) as Record<string, Record<string, boolean>>),

  applyMcps: () => post<{ runners?: number; mcps?: number }>("/mcps/apply"),

  /* brain — the shared CLAUDE.md every card's profile gets */
  brain: () => get<BoardBrain>("/brain"),

  /** Saves AND pushes: the response says how many terminals restarted and how many were deferred. */
  saveBrain: (text: string) => post<BrainWriteResult>("/brain", { text }),

  /** Back to the text the server ships with. Same push, same report. */
  resetBrain: () => del<BrainWriteResult>("/brain"),

  /** Manual re-push, for when a runner was down when the text was saved. */
  applyBrain: () => post<BrainApplyResult>("/brain/apply"),

  /* voice input */

  /** Whether the install can transcribe at all. Cheap, so the composer can ask on mount. */
  transcribeStatus: () =>
    get<TranscribeStatus>("/transcribe").then((r) => ({
      available: Boolean(r?.available),
      proofread: Boolean(r?.proofread),
      language: r?.language ?? null,
    })),

  /** Sends a recording and gets the text back. Same JSON-with-base64 shape as the image upload. */
  transcribeCardAudio: async (id: string, blob: Blob): Promise<Transcription> => {
    const base64 = await blobToBase64(blob);
    return await post<Transcription>(`/cards/${encodeURIComponent(id)}/transcribe`, {
      base64,
      mimeType: blob.type || "audio/webm",
    });
  },

  /* runner & github */
  runner: () => get<RunnerStatus & { provisioning?: boolean }>("/runner"),
  provisionRunner: () => post<{ ok: true }>("/runner/provision"),
  startRunner: () => post<RunnerStatus>("/runner/start"),

  /** Every connected GitHub account, in connection order. The first is what a project defaults to. */
  github: () =>
    get<GithubState>("/github").then((r) => ({
      connections: Array.isArray(r?.connections) ? r.connections : [],
    })),

  /** Adds an account: a pasted token, never an OAuth redirect. */
  addGithubConnection: (label: string, token: string) =>
    post<{ connection: GithubConnection }>("/github/connections", { label, token }).then((r) => r.connection),

  /** Removes an account. The server refuses (409) while a project still points at it. */
  removeGithubConnection: (id: string) =>
    del<{ ok: true }>(`/github/connections/${encodeURIComponent(id)}`),

  githubRepos: (connection: string, q: string) =>
    get<{ repos: GithubRepo[] }>("/github/repos", {
      params: { ...(connection ? { connection } : {}), ...(q ? { q } : {}) },
    }).then((r) => (Array.isArray(r?.repos) ? r.repos : [])),

  githubBranches: (connection: string, owner: string, repo: string) =>
    get<{ branches: string[] }>(
      `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      { params: connection ? { connection } : undefined },
    ).then((r) => (Array.isArray(r?.branches) ? r.branches : [])),
};

/* ---------------------------------------------------------------- helpers */

/** Splits `owner/repo`. Returns nulls rather than throwing — the caller is a form. */
export function splitRepo(fullName: string | undefined): { owner: string | null; repo: string | null } {
  const [owner, repo, ...rest] = String(fullName ?? "").trim().split("/");
  if (!owner || !repo || rest.length > 0) return { owner: null, repo: null };
  return { owner, repo };
}

/** Blob -> bare base64 (no `data:` prefix), which is what the upload routes want. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsDataURL(blob);
  });
}

/** A `File` is a `Blob`; kept as its own name because that is what the call sites read like. */
export const fileToBase64 = blobToBase64;

/** The runner rejects an image over 10 MB; catching it here saves a pointless round trip. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** And a recording over 20 MB — about 40 minutes of Opus, far past the recorder's own 5-minute cap. */
export const AUDIO_MAX_BYTES = 20 * 1024 * 1024;

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

/**
 * What Claude Code starts on when nothing has pinned a model and nothing has answered yet. It is
 * the first entry of the whitelist rather than a second constant, so the two cannot drift apart.
 */
export const IMPLICIT_MODEL = CLAUDE_MODELS[0] as { id: string; label: string };

/**
 * Title on the model pill for the one case where the answer is an assumption, not a reading. A
 * function, not a constant: it is copy, and copy follows the language the operator picked.
 */
export function implicitModelTitle(): string {
  return t("cardView.implicitModelTitle");
}

export interface ModelInUse {
  /** Value the select carries — always a real model id, never the empty "inherit" option. */
  id: string;
  label: string;
  /** Set only while the label is the assumed default rather than something observed. */
  title?: string;
}

/**
 * The model the pill must SHOW: what is in use, whether or not it was chosen here.
 *
 * The SESSION answers first, not the card's pin. The two can disagree — `/model` typed inside the
 * terminal, or a switch still waiting for Claude to go idle — and the pin loses that argument: it is
 * what the next start will use, and the bar is about the conversation on screen. (The server already
 * weighs the pin against the transcript by date, so a switch that restarted the session shows up
 * here immediately.) Then the pin, for a card that has never been opened, and last the model Claude
 * Code boots on, flagged in the title as the assumption it is. There is no "Default model" outcome:
 * "whatever the account gives you" is not an answer to "which model am I talking to". PURE.
 */
export function modelInUse(
  card: { model?: string | null } | null | undefined,
  session: CardSessionInfo | null | undefined,
): ModelInUse {
  const live = session?.model?.trim();
  if (live) return { id: live, label: modelLabelFor(live, session?.modelLabel ?? null) };
  const pinned = card?.model?.trim();
  if (pinned) return { id: pinned, label: modelLabelFor(pinned, null) };
  return { id: IMPLICIT_MODEL.id, label: IMPLICIT_MODEL.label, title: implicitModelTitle() };
}

/**
 * The whitelist entry a model id BELONGS TO — by exact id, or by family when the id is one of the
 * many other spellings of the same model: the alias settings.json stores (`opus`), a dated id from a
 * transcript (`claude-opus-4-5-20251101`). Without this, "the model in use" never matches any row of
 * the menu, so the menu grew a second, checked "Opus" underneath the real one. PURE.
 */
export function whitelistModel(id: string | null | undefined): { id: string; label: string } | undefined {
  const raw = (id ?? "").trim();
  if (!raw) return undefined;
  const exact = CLAUDE_MODELS.find((m) => m.id === raw);
  if (exact) return exact;
  const lower = raw.toLowerCase();
  return CLAUDE_MODELS.find((m) => lower.includes(m.label.toLowerCase()));
}

/** Whitelist label for a model id (family included), the server's own label, or the raw id. PURE. */
export function modelLabelFor(id: string, serverLabel: string | null): string {
  const known = whitelistModel(id)?.label;
  if (known) return known;
  return (serverLabel ?? "").trim() || id;
}

/**
 * The account NAME the pill must show — the effective one, with no "(default)" or "(inherited)"
 * suffix attached. Which account it came from is not the question; which one is signed in is. PURE.
 */
export function accountInUseName(
  card: { accountSlug?: string | null } | null | undefined,
  session: CardSessionInfo | null | undefined,
  accounts: readonly BoardAccount[],
  /** What the card inherits when it pins nothing: the project's account, or the install default. */
  inherited: string,
): string {
  const live = session?.account?.name?.trim();
  if (live) return live;
  const pinned = card?.accountSlug?.trim();
  if (pinned) {
    const match = accounts.find((a) => a.slug === pinned);
    return match ? accountLabel(match) : pinned;
  }
  return inherited;
}

/**
 * The account slug whose usage the pill must show — the EFFECTIVE one, as a key into `bySlug`.
 *
 * Once the session route has answered, it is the truth (a null slug there means the built-in
 * profile, which is keyed `default`); before that, the card's pin, then the project's, then the
 * default. Mirrors `accountInUseName`, but answers with a key instead of a label. PURE.
 */
export function accountInUseSlug(
  card: { accountSlug?: string | null } | null | undefined,
  session: CardSessionInfo | null | undefined,
  projectDefaultSlug?: string | null,
): string {
  if (session) return session.account.slug?.trim() || DEFAULT_ACCOUNT_SLUG;
  return card?.accountSlug?.trim() || projectDefaultSlug?.trim() || DEFAULT_ACCOUNT_SLUG;
}

/**
 * Where an account's Claude profile lives inside the runner. Shown verbatim in the accounts list,
 * and quoted in the "log in once" instruction — a path you can paste is worth more than a noun. PURE.
 */
export function profilePathFor(slug: string): string {
  return slug === DEFAULT_ACCOUNT_SLUG ? "/root/.claude" : `/root/.claude-profiles/${slug}`;
}
