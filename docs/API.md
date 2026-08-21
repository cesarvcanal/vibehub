# vibehub HTTP API

Everything lives under `/api`. JSON in, JSON out. Every route requires a session cookie except the
ones marked **public**. Errors are `{ "error": "message" }` with a 4xx/5xx status.

## Setup & auth

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/setup/state` | **public** — `{ fresh, steps: { owner, runner, claude, github }, runner: RunnerStatus }`. Drives the wizard. |
| POST | `/api/setup/owner` | **public, only while `fresh`** — `{ username, password }` → creates the owner and signs in. |
| POST | `/api/auth/login` | **public** — `{ username, password }` → sets the session cookie. |
| POST | `/api/auth/logout` | — |
| POST | `/api/auth/password` | `{ password }` — change your own password |
| GET | `/api/auth/me` | `{ user: { id, username } }` |

## Settings

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/settings` | `{ git: { name, email }, autonomous, defaultAccountLabel, setupCompletedAt, runner: { kind, container, host, image, baseDir }, publicUrl }` |
| PATCH | `/api/settings` | `{ git?, autonomous?, defaultAccountLabel? }` |
| POST | `/api/settings/setup-complete` | stamps the install as set up so the wizard stops taking over |

## GitHub

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/github` | `{ connected, login?, scopes?, error? }` |
| POST | `/api/github/token` | `{ token }` → validates against the API, stores in the vault |
| DELETE | `/api/github` | forgets the token |
| GET | `/api/github/repos?q=` | `{ repos: [{ fullName, cloneUrl, private, defaultBranch, updatedAt }] }` |
| GET | `/api/github/repos/:owner/:repo/branches` | `{ branches: string[] }` |

## Runner

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/runner` | `RunnerStatus` = `{ running, exists, claudeInstalled, dockerReachable, container, host, detail? }` |
| POST | `/api/runner/provision` | `{ ok: true }` — idempotent; long-running |
| WS | `/api/runner/logs` | provisioning output, with the last run buffered for late subscribers |
| POST | `/api/runner/start` | starts a stopped container |
| POST | `/api/runner/status` | **public, `x-vibehub-token`** — `{ card, status: "working" \| "waiting" }`, the Claude hook callback |

## Projects & cards

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects` | `{ projects: Project[] }` |
| POST | `/api/projects` | `{ name, repoFullName?, cloneUrl?, baseBranch?, defaultAccountSlug? }` |
| PATCH | `/api/projects/:id` | partial update |
| DELETE | `/api/projects/:id` | also removes its cards |
| PATCH | `/api/projects/:id/order` | `{ position }` — sidebar position |
| GET | `/api/projects/:id/cards` | `{ cards: Card[] }` |
| POST | `/api/cards` | `{ projectId, title }` plus any editable field (`branch`, `accountSlug`, `model`, `resumeSessionId`), applied through the same validation an edit uses |
| GET | `/api/cards/:id` | `{ card }` |
| PATCH | `/api/cards/:id` | `{ title?, column?, accountSlug?, model? }` — moving to `done` is always manual |
| DELETE | `/api/cards/:id` | kills the session and drops the worktree |
| POST | `/api/cards/:id/open` | attach-or-create the tmux session; returns the card |
| POST | `/api/cards/:id/pause` | kills tmux, clears status, back to backlog |
| POST | `/api/cards/:id/restart` | fresh Claude process in the same worktree |
| POST | `/api/cards/restart-all` | `{ restarted, skipped }` |
| POST | `/api/cards/:id/upload` | `{ name, content }` with bare base64 → `{ path }` inside the runner (10 MB cap) |
| POST/DELETE | `/api/cards/:id/browser` | start/stop the card's live browser |
| WS | `/api/cards/:id/terminal` | xterm bridge (`?shell=1` for a plain shell in the same worktree) |
| WS | `/api/cards/:id/vnc` | noVNC bridge for the card browser |

## Claude accounts, MCPs, brain, import

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/accounts` | `{ accounts: Account[], defaultLabel }` |
| POST | `/api/accounts` | `{ name }` → creates the account; the profile directory slug is derived from it |
| DELETE | `/api/accounts/:slug` | |
| GET | `/api/accounts/tokens` | `{ bySlug, defaultHasToken }` — which accounts have a long-lived token |
| POST | `/api/accounts/:slug/token` | `{ token }` — long-lived Claude token, stored in the vault, planted in every runner profile |
| DELETE | `/api/accounts/:slug/token` | |
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
| POST | `/api/import` | `{ items: [{ repo, title, sessionId, branch?, column? }], stageDir? }` — adopt staged Claude sessions as cards |
| GET | `/api/cards/:id/paths` | where the card maps to inside the runner (debugging an import) |

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
