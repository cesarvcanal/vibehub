# vibehub HTTP API

Everything lives under `/api`. JSON in, JSON out. Every route requires a session cookie except the
ones marked **public**. Errors are `{ "error": "message" }` with a 4xx/5xx status.

## Roles

Two, and only two:

- **owner** — the install is theirs: every project and card, the Claude accounts, the vault, the MCP
  servers, the brain, the settings, the runner, and the people. The setup wizard creates the first
  one.
- **member** — somebody the owner invited. They see only what has been **shared** with them: a card,
  or a whole project (every card in it, including the ones created later). A share carries a level —
  `work` (their terminal types into the session) or `view` (they read it; nothing they send reaches
  the agent). A card reached both ways takes the STRONGER of the two levels.

Routes marked **owner** answer `403 { "error": "owner only" }` to a member. A card-scoped route that
CHANGES the card or reaches its session answers `403` to a `view` share. Card-scoped routes
(`/api/cards/:id/...`) answer **404** when the card is not visible to the caller — to somebody who
cannot see a card, that card does not exist, and a 403 would confirm the id names something real.
The listings (`/api/projects`, `/api/cards`, `/api/projects/:id/cards`) are filtered to what the
caller may see rather than refused. `/mcp` accepts the runner token or an **owner** session.

## Setup & auth

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/setup/state` | **public** — `{ fresh, steps: { owner, runner, claude, github }, runner: RunnerStatus }`. Drives the wizard. |
| POST | `/api/setup/owner` | **public, only while `fresh`** — `{ username, password }` → creates the owner and signs in. |
| POST | `/api/auth/login` | **public** — `{ username, password }` → sets the session cookie. |
| POST | `/api/auth/logout` | — |
| POST | `/api/auth/password` | `{ password }` — change your own password |
| GET | `/api/auth/me` | `{ user: { id, username, role, createdAt } }` |

## Access — the install's people

**owner** only, all of it. There is no sign-up and no invitation email: the owner types a username
and a password and hands them over. The **last owner** can be neither demoted nor removed (400) —
an install with no owner is an install nobody can administer.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/users` | `{ users: [{ id, username, role, createdAt }] }` — never a hash or a salt |
| POST | `/api/users` | `{ username, password, role? }` → `{ user }`; `role` defaults to `"member"` |
| PATCH | `/api/users/:id` | `{ password?, role? }` → `{ user }` — reset a password, change a role, or both |
| DELETE | `/api/users/:id` | `{ ok: true, user }`; removing YOURSELF also clears your session cookie |

## Settings

**owner** only.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/settings` | `{ git: { name, email }, autonomous, defaultAccountLabel, setupCompletedAt, transcribeLanguage, idleHibernateMinutes, sdkDriver, runner: { kind, container, host, image, baseDir }, publicUrl }` |
| PATCH | `/api/settings` | `{ git?, autonomous?, defaultAccountLabel?, transcribeLanguage?, idleHibernateMinutes?, sdkDriver? }` — `idleHibernateMinutes` is a whole number of minutes, 0..10080 (0 = never hibernate) |
| POST | `/api/settings/setup-complete` | stamps the install as set up so the wizard stops taking over |

## GitHub

**owner** only.

There is no OAuth flow: a connection is a **pasted token** — a fine-grained PAT with Contents
read/write on the repositories you want, or a classic token with `repo`.

vibehub holds **several accounts** (a personal one and an org one is the usual pair). A connection is
`{ id, label, login, scopes?, createdAt }`; the token itself lives in the vault under
`GITHUB_TOKEN_<id>` and is never returned by any route. A project names the connection it clones
with through `githubConnectionId`; a project that names none uses the **first** connection.

An install from before multiple accounts is migrated on first read: its single `GITHUB_TOKEN` becomes
connection #1 (label = its login) and the secret moves to `GITHUB_TOKEN_<id>`. Idempotent.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/github` | `{ connections: [{ id, label, login, scopes?, createdAt, ok, error? }] }` — `ok` is a live check of the stored token |
| POST | `/api/github/connections` | `{ label, token }` → validates against the API, stores it → `201 { connection }` |
| DELETE | `/api/github/connections/:id` | `{ ok: true }`; **409** while a project still points at it, 404 when unknown |
| POST | `/api/github/token` | `{ token, label? }` → creates the FIRST connection or replaces its token (the setup wizard) → `{ connected: true, id, login, scopes }` |
| DELETE | `/api/github` | forgets every account |
| GET | `/api/github/repos?connection=&q=` | `{ repos: [{ fullName, cloneUrl, private, defaultBranch, updatedAt, description }] }` — `connection` defaults to the first |
| GET | `/api/github/repos/:owner/:repo/branches?connection=` | `{ branches: string[] }` |

## Runner

**owner** only (except the public status callback).

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/runner` | `RunnerStatus` = `{ running, exists, claudeInstalled, dockerReachable, container, host, detail?, provisioning, terminal: true }` |
| POST | `/api/runner/provision` | `{ ok: true }` — idempotent; long-running |
| WS | `/api/runner/logs` | provisioning output, with the last run buffered for late subscribers |
| POST | `/api/runner/start` | starts a stopped container |
| WS | `/api/runner/terminal` | a shell inside the runner container itself — where you run `claude` / `gh auth login` once |
| POST | `/api/runner/status` | **public, `x-vibehub-token`** — `{ card, status: "working" \| "waiting" }`, the Claude hook callback |

The dot a card shows comes from those hooks, and they do not fire for every way a session goes
quiet — Claude parked on a menu or on a permission question is idle without a Stop hook. So the
server also **reconciles pending pauses every 60s**: for each card sitting in `paused` with a live
session it asks the runner what that tmux session is doing (`tmux capture-pane`, read-only) and
finishes the pause for the ones that are no longer generating. A card in Paused is never left
running.

## Sharing

**owner** only. Sharing with another owner is refused (400) — they already see everything.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/cards/:id/shares` | `{ shares: [{ kind, targetId, userId, username, level, createdAt }] }` |
| POST | `/api/cards/:id/shares` | `{ userId, level? }` → `{ share }`; `level` defaults to `"work"`. Idempotent: sharing again only sets the level |
| DELETE | `/api/cards/:id/shares/:userId` | `{ ok: true, removed }` — `removed: false` when there was no share |
| GET | `/api/projects/:id/shares` | same shape, for a whole project |
| POST | `/api/projects/:id/shares` | `{ userId, level? }` — every card in the project, now and later |
| DELETE | `/api/projects/:id/shares/:userId` | — |

A share never outlives what it points at: deleting a card, a project (with its cards) or a person
drops theirs.

`/mcp` is not narrowed by a share: it authenticates the RUNNER, and the maestro tools reach every
card on the board. A member cannot call it from a browser (owner session or runner token only), but
the agent inside a card they were given can — see "Who can see what" in `ARCHITECTURE.md`.

## Projects & cards

Creating, editing and deleting a project (and creating or deleting a card) is the **owner**'s. The
listings are filtered to what the caller may see; reading and editing ONE card follows access to
that card.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects` | `{ projects: Project[] }` |
| POST | `/api/projects` | `{ name, repoFullName?, cloneUrl?, baseBranch?, defaultAccountSlug?, githubConnectionId? }` — `githubConnectionId` must name an existing GitHub connection; absent = the first |
| PATCH | `/api/projects/:id` | partial update |
| DELETE | `/api/projects/:id` | also removes its cards |
| PATCH | `/api/projects/:id/order` | `{ position }` — sidebar position |
| GET | `/api/projects/:id/cards` | `{ cards: Card[] }` |
| GET | `/api/cards` | `{ cards: Card[] }` — every card in the install, for the views that cut across projects (the sidebar's Recent list) |
| POST | `/api/cards` | `{ projectId, title }` plus any editable field (`branch`, `accountSlug`, `model`, `resumeSessionId`), applied through the same validation an edit uses. Answers immediately and **pre-provisions the workspace in the background** (clone, worktree, tmux), so the first open is instant |
| GET | `/api/cards/:id` | `{ card }` |
| PATCH | `/api/cards/:id` | `{ title?, column?, accountSlug?, model?, sdkChat? }` — `sdkChat` is the per-card "Chat nativo (beta)" opt-in (SDK driver socket) — moving to `done` is always manual. A column is not just a label: moving **into `paused` pauses the card for real** (same rules as the pause route) and moving a paused card into `waiting`/`working` **resumes it** (the session comes back in the background) |
| DELETE | `/api/cards/:id` | kills the session and drops the worktree |
| POST | `/api/cards/:id/open` | attach-or-create the tmux session; returns the card. Also resumes a paused or hibernated one |
| POST | `/api/cards/:id/pause` | moves the card to `paused` and ends its tmux sessions. A card that is REALLY working (the runner is asked, not the dot) becomes a *pending* pause: the session lives until Claude finishes. A stale `working` dot — a card parked on Claude's "Resume from summary" screen never fires a Stop hook — does not defer anything: it is paused on the spot |
| POST | `/api/cards/:id/hibernate` | kills tmux and stamps `hibernatedAt` — the card KEEPS its column and position and loses its dot; a card with nothing to hibernate (never opened, already cold, or `working`) comes back unchanged |
| POST | `/api/cards/:id/restart` | fresh Claude process in the same worktree |
| POST | `/api/cards/restart-all` | `{ restarted, skipped }` |
| POST | `/api/cards/:id/upload` | `{ name, content }` with bare base64 → `{ path }` inside the runner (10 MB cap) |
| POST | `/api/cards/:id/messages` | `{ text }` → `{ delivered, pending, agent }` — the composer's Enter. Delivered to a RUNNING Claude, otherwise QUEUED until there is one |
| GET | `/api/cards/:id/messages` | `{ pending: OutboxMessage[], agent }` — `agent` is `running` / `shell` / `none` |
| DELETE | `/api/cards/:id/messages/:messageId` | gives up on one queued message |
| POST/DELETE | `/api/cards/:id/browser` | start/stop the card's live browser |
| WS | `/api/cards/:id/terminal` | xterm bridge (`?shell=1` for a plain shell in the same worktree) |
| WS | `/api/cards/:id/chat` | the SAME session read as a conversation: one JSON `ChatEvent` per frame (`{ id, kind: "user"\|"assistant"\|"tool", at, text, tool? }`), parsed from Claude Code's transcript. Opens with the last turns and streams what is appended; blank frames are the follower's heartbeat |
| POST | `/api/cards/:id/chat` | `{ text }` — types it at that session's prompt and presses Enter (409 when the card has no live session) |
| WS | `/api/cards/:id/sdk` | **native chat (beta)** — the Agent-SDK driver, gated by the `sdkDriver` setting. One JSON `DriverEvent` per frame (`ready`, `session`, `assistant_delta`, `assistant_text`, `tool_use`, `permission_request`, `permission`, `result`, `error`, `parse_error`); the client sends `{ type: "user", text }`, `{ type: "interrupt" }` or `{ type: "permission_decision", id, allow }`. On connect the route **replays the conversation**: the newest TUI/SDK transcript tail (converted to frames, incl. `{ type: "user" }`) plus the per-card event log (`<dataDir>/sdk-history/<cardId>.ndjson`), then spawns the driver resuming the **newest session** in the card's worktree (falling back to `resumeSessionId`). The route persists each new `session_id` on the card (`resumeSessionId`) so a reconnect resumes the same conversation. Contract in `back/src/services/sdk/protocol.ts` + `docs/sdk-driver.md` |
| POST | `/api/cards/:id/chat/key` | `{ key: "escape" \| "interrupt" }` — the chat's Stop button |
| WS | `/api/cards/:id/vnc` | noVNC bridge for the card browser |

## Claude accounts, MCPs, brain, import

**owner** only, except the card-scoped routes (`/api/cards/:id/upload`, `/api/cards/:id/transcribe`, `/api/cards/:id/paths`), which follow the card.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/accounts` | `{ accounts: Account[], defaultLabel }` |
| POST | `/api/accounts` | `{ name }` → creates the account; the profile directory slug is derived from it |
| DELETE | `/api/accounts/:slug` | |
| GET | `/api/accounts/tokens` | `{ bySlug, defaultHasToken }` — which accounts have a long-lived token |
| GET | `/api/accounts/usage` | `{ bySlug: { <slug>: AccountUsage }, fetchedAt }` — plan usage per account (see below) |
| POST | `/api/accounts/:slug/token` | `{ token }` — long-lived Claude token, stored in the vault, planted in every runner profile |
| DELETE | `/api/accounts/:slug/token` | |
| WS | `/api/accounts/:slug/login-terminal` | interactive `claude /login` terminal for that profile (`default` = the built-in one) — writes the refreshable credentials the usage meter reads |
| GET | `/api/mcps` | `{ mcps: Mcp[] }` — `{ id, name, kind: "stdio"\|"http"\|"sse", command?, args?, url?, envKeys?, headerKeys? }` |
| POST | `/api/mcps` | `{ name, kind, command?, args?, url?, envKeys?, headerKeys? }` — names only; values go in one at a time |
| GET | `/api/mcps/secrets` | `{ byMcp: { [mcpId]: { [name]: boolean } } }` — which declared secrets already have a value |
| DELETE | `/api/mcps/:id` | |
| POST | `/api/mcps/:id/secret` | `{ key, value }` |
| POST | `/api/mcps/apply` | re-injects every MCP into every profile |
| GET | `/api/brain` | `{ text, ... }` — shared CLAUDE.md planted in each card |
| POST | `/api/brain` | `{ text }` — save it |
| DELETE | `/api/brain` | back to the built-in default |
| POST | `/api/brain/apply` | push it into every profile |
| GET | `/api/brain/projects/:id` | `{ text, ... }` — the PROJECT's brain (CLAUDE.local.md in its card worktrees); `""` = none |
| POST | `/api/brain/projects/:id` | `{ text }` — save it (empty text clears it); auto-applies to that project only |
| POST | `/api/brain/projects/:id/apply` | rewrite it in that project's worktrees |
| GET | `/api/transcribe` | `{ available, proofread, language }` — voice input status (keys are never returned) |
| POST | `/api/transcribe/keys` | `{ openaiKey?, anthropicKey? }` — empty string clears; Whisper transcribes, Claude proofreads against the brain |
| POST | `/api/cards/:id/transcribe` | `{ base64, mimeType }` → `{ text, proofread }`; 503 when voice input is not configured |
| POST | `/api/import` | `{ items: [{ repo, title, sessionId, branch?, column? }], stageDir? }` — adopt staged Claude sessions as cards |
| GET | `/api/cards/:id/session` | `{ model, modelLabel, account: { slug, name }, situation }` — what the session is REALLY using: model from the last assistant turn, effective account, and whether the agent is `working`/`waiting`/`paused`/`done`/`no session` |
| GET | `/api/cards/:id/paths` | where the card maps to inside the runner (debugging an import) |

### `AccountUsage` — how much of the plan is gone

`GET /api/accounts/usage` answers `{ bySlug, fetchedAt }`, with one entry per account plus `default`
for the runner's built-in profile:

```jsonc
{
  "bySlug": {
    "default": {
      "available": true,
      "fiveHour":     { "utilization": 31, "resetsAt": "2026-08-22T18:00:00Z" },
      "sevenDay":     { "utilization": 12, "resetsAt": "2026-08-27T00:00:00Z" },
      "sevenDayOpus": { "utilization": 74, "resetsAt": "2026-08-27T00:00:00Z" },
      "fetchedAt": 1755880000000
    },
    "tech": { "available": false, "error": "no_credentials", "fetchedAt": 1755880000000 }
  },
  "fetchedAt": 1755880000000
}
```

`utilization` is a percentage (0..100) of the plan window; `resetsAt` is when it empties again.
`stale: true` means the numbers are the last good reading, served while the endpoint is backed off —
`fetchedAt` says how old they are, and `retryAt` when the next call will be attempted.

The route NEVER fails: everything that can go wrong becomes a per-account `error`.

| `error` | Meaning | What fixes it |
|---|---|---|
| `no_credentials` | the profile has no `claudeAiOauth` block — an account set up only with a long-lived `setup-token` never logged in interactively | open the runner shell and run `CLAUDE_CONFIG_DIR=<profile> claude`, then `/login`, once |
| `rate_limited` | the usage endpoint is throttling **vibehub** (it throttles by caller, not by account) | nothing — the service backs off 2min → 30min and keeps serving the last good value |
| `unauthorized` | there is a token, but it cannot read usage (missing `user:profile` scope, or expired) | log in again in that profile |
| `unreachable` | the runner is down, or the endpoint answered something else | check the runner |

Numbers come from `GET https://api.anthropic.com/api/oauth/usage` with the profile's **Claude Code
access token**, read read-only out of `<profile>/.credentials.json` in the runner, used for one call
and dropped. The token is never logged, never returned and never stored on the vibehub side. The
long-lived `setup-token` in the vault is NOT accepted by that endpoint and is never used here.
Readings are cached 60s per account and the accounts are polled in series.

## MCP — the board, from inside a card

| Method | Path | Body / notes |
|---|---|---|
| POST | `/mcp` | **Bearer = the runner's service token** (a browser session also works). MCP streamable HTTP, stateless. |
| GET | `/mcp` | 405 — this endpoint is POST-only. |

vibehub registers itself as an MCP server in every card's profile, so the agent running in a card can
coordinate the other cards. They are real parallel terminals, not sub-agents: each keeps its own
context, worktree and branch.

| Tool | What it does |
|---|---|
| `vibehub_list_terminals` | lists the cards with their situation (`working`, `waiting`, `paused`, `done`, `no session`); `project` filters |
| `vibehub_send_to_terminal` | types an instruction at another card's prompt and submits it |
| `vibehub_read_terminal` | reads that card's last assistant answers, stripped to text |

The instruction travels over stdin inside a quoted heredoc and is typed with `tmux send-keys -l`, so
an instruction that contains the word "Enter" is text, not a keystroke. Reading is a read-only tail
of the newest transcript.
