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
| GET | `/api/auth/me` | `{ user: { id, username } }` |

## Settings

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/settings` | `{ git: { name, email }, autonomous, runner: { kind, container, host, image }, publicUrl }` |
| PATCH | `/api/settings` | `{ git?, autonomous?, defaultAccountLabel? }` |

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
| POST | `/api/runner/provision` | `{ ok: true }` — idempotent; logs stream over `WS /api/runner/logs` |
| POST | `/api/runner/start` | starts a stopped container |
| POST | `/api/runner/status` | **public, `x-vibehub-token`** — `{ card, status: "working" \| "waiting" }`, the Claude hook callback |

## Projects & cards

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects` | `{ projects: Project[] }` |
| POST | `/api/projects` | `{ name, repo?, defaultBranch?, accountSlug?, model? }` |
| PATCH | `/api/projects/:id` | partial update |
| DELETE | `/api/projects/:id` | also removes its cards |
| PATCH | `/api/projects/:id/order` | `{ position }` — sidebar position |
| GET | `/api/projects/:id/cards` | `{ cards: Card[] }` |
| POST | `/api/cards` | `{ projectId, title, branch?, accountSlug?, model?, resumeSessionId? }` |
| GET | `/api/cards/:id` | `{ card }` |
| PATCH | `/api/cards/:id` | `{ title?, column?, accountSlug?, model? }` — moving to `done` is always manual |
| DELETE | `/api/cards/:id` | kills the session and drops the worktree |
| POST | `/api/cards/:id/open` | attach-or-create the tmux session; returns the card |
| POST | `/api/cards/:id/pause` | kills tmux, clears status, back to backlog |
| POST | `/api/cards/:id/restart` | fresh Claude process in the same worktree |
| POST | `/api/cards/restart-all` | `{ restarted, skipped }` |
| POST | `/api/cards/:id/upload` | multipart image → `{ path }` inside the runner |
| POST/DELETE | `/api/cards/:id/browser` | start/stop the card's live browser |
| WS | `/api/cards/:id/terminal` | xterm bridge (`?shell=1` for a plain shell in the same worktree) |
| WS | `/api/cards/:id/vnc` | noVNC bridge for the card browser |

## Claude accounts, MCPs, brain, import

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/accounts` | `{ accounts: Account[], defaultLabel }` |
| POST | `/api/accounts` | `{ label }` → creates a profile directory slug |
| DELETE | `/api/accounts/:slug` | |
| POST | `/api/accounts/:slug/token` | `{ token }` — long-lived Claude token, stored in the vault, planted in every runner profile |
| DELETE | `/api/accounts/:slug/token` | |
| GET | `/api/mcps` | `{ mcps: Mcp[] }` |
| POST | `/api/mcps` | `{ name, command, args?, env?, secrets? }` |
| DELETE | `/api/mcps/:id` | |
| POST | `/api/mcps/:id/secret` | `{ key, value }` |
| POST | `/api/mcps/apply` | re-injects every MCP into every profile |
| GET | `/api/brain` | `{ text, defaultText }` — shared CLAUDE.md planted in each card |
| POST | `/api/brain/apply` | `{ text }` |
| POST | `/api/import` | `{ sessions: [...] }` — adopt existing Claude Code sessions as cards |
