# vibehub HTTP API

Everything lives under `/api`, except the MCP endpoint (`/mcp`), the OAuth routes (`/oauth/*`,
`/.well-known/*`) and the preview proxy (`/preview/*`). JSON in, JSON out. Every route requires a
session cookie except the ones marked **public**. Errors are `{ "error": "message" }` with a 4xx/5xx
status.

**Coverage:** every HTTP and websocket route registered in `back/src/routes/*.ts` and
`back/src/index.ts`, and every MCP tool registered in `back/src/mcp/*.ts`, has a line below. Those
files are the reference: when a line here and the code disagree, the code is right and this file is
the bug. The access helper of each route (`requireOwner`, `requireSession`, `requireCardAccess`,
`requireCardWork`, in `back/src/auth/`) is what the **owner** / **any session** / **view** / **work**
marks below stand for.

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
caller may see rather than refused. `/mcp` accepts the runner token, an **owner** session, or an
OAuth access token (see "MCP — the board, from outside"), which reaches what its user reaches.

## Setup & auth

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/health` | **public** — `{ ok: true, version }` |
| GET | `/api/setup/state` | **public** — `{ fresh, completed, steps: { owner, runner, claude, github }, runner: RunnerStatus }`. Drives the wizard; `completed` is whether `setup-complete` was stamped. |
| POST | `/api/setup/owner` | **public, only while `fresh`** — `{ username, password }` → creates the owner and signs in. **409** once the install has an owner (also when two setups race: the check runs inside the write). With `VIBEHUB_TRUST_PROXY` set, every try — 409s included — counts toward the 30/min address ceiling it shares with sign-in. |
| POST | `/api/auth/login` | **public** — `{ username, password }` → sets the session cookie. **429** + `retry-after` after 10 failed tries for one username from one client in 15 min — a browser that signed in as that username before (its `vibehub_device_<digest>` cookie — one per username, scoped to this path) is its own client, whatever its address; and, only when `VIBEHUB_TRUST_PROXY` is set, after 30 failed tries from one client in a minute across usernames (shared with setup). Only failures count; a successful sign-in clears that username's count. |
| POST | `/api/auth/logout` | — |
| POST | `/api/auth/password` | `{ password }` — change your own password. Revokes every other session: their requests 401 and the websockets they hold open (terminals, chat, VNC, preview tunnels) are closed; this one gets a fresh cookie, and its own sockets reconnect with it |
| GET | `/api/auth/me` | `{ user: { id, username, role, createdAt, claudeAccountSlug? } }` — `claudeAccountSlug` only when the owner tied this person to a Claude account. 401 without a session |

## Access — the install's people

**owner** only, all of it. There is no sign-up and no invitation email: the owner types a username
and a password and hands them over. The **last owner** can be neither demoted nor removed (400) —
an install with no owner is an install nobody can administer.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/users` | `{ users: [{ id, username, role, createdAt, git? }] }` — never a hash or a salt |
| POST | `/api/users` | `{ username, password, role? }` → `{ user }`; `role` defaults to `"member"` |
| PATCH | `/api/users/:id` | `{ password?, role?, githubConnectionId?, gitName?, gitEmail?, claudeAccountSlug? }` → `{ user, git? }`. `githubConnectionId`/`gitName`/`gitEmail` are that person's git identity; `null` CLEARS one (back to inheriting), an absent field is untouched. A `githubConnectionId` that does not exist is a 400. `claudeAccountSlug` is the Claude account the cards this person CREATES run on (an unknown slug is a 400; cards they already have keep theirs) |
| GET | `/api/me/git` | `{ git? }` — my own git identity. Any session, not just the owner's |
| PATCH | `/api/me/git` | `{ githubConnectionId?, gitName?, gitEmail? }` → `{ git }`. The same write as above, for MYSELF: a PAT expires, and rotating it must not be the owner's task. `role`/`password` are ignored here — those stay the owner's |
| DELETE | `/api/users/:id` | `{ ok: true, user }`; removing YOURSELF also clears your session cookie. The removed account's open websockets are closed |

## Settings

**owner** only, except `/api/features`.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/features` | **any session** — `{ sdkChat, doneRetentionDays }`: the install-wide flags every user needs to render the right UI (`sdkChat` mirrors the `sdkDriver` setting: on = the native chat IS every card's Chat tab; `doneRetentionDays` is how long a card sits untouched in `done` before the hourly retention sweep purges it — the countdown on a done card reads it). The settings themselves stay owner-only |
| GET | `/api/settings` | `{ git: { name, email }, autonomous, defaultAccountLabel, setupCompletedAt, transcribeLanguage, transcribeProofread, transcribeKeywords, idleHibernateMinutes, sdkDriver, sdkPermissionMode, sdkAutoResume, selfProjectId, runner: { kind, container, host, image, baseDir }, publicUrl }` |
| PATCH | `/api/settings` | `{ git?, autonomous?, defaultAccountLabel?, transcribeLanguage?, transcribeProofread?, transcribeKeywords?, idleHibernateMinutes?, sdkDriver?, sdkPermissionMode?, sdkAutoResume?, selfProjectId? }` → the settings. `sdkPermissionMode` is `"same-as-terminal"` or `"ask-sensitive"` (the native chat asks before sensitive tools); `sdkAutoResume` resumes, once, a native-chat turn a restart of the back interrupted; `selfProjectId` names the project that holds vibehub's own repository, where platform-failure investigations open their cards (an unknown id is a 400); `idleHibernateMinutes` is a whole number of minutes, 0..10080 (0 = never hibernate); `transcribeKeywords` is a list of up to 100 terms of up to 60 characters each, with no comma, line break, `<` or `>` (terms are trimmed, empty ones dropped); an invalid list answers 400 and saves nothing |
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
| GET | `/api/runner` | `RunnerStatus` = `{ running, exists, claudeInstalled, dockerReachable, container, host, detail?, provisioning, terminal: true, processes }` — `processes` is the last process-reaper sweep inside the runner (`null` before the first one) |
| POST | `/api/runner/provision` | `{ ok: true }` (`alreadyRunning: true` when a provisioning is in progress) — idempotent; long-running, its output goes to the logs socket |
| WS | `/api/runner/logs` | provisioning output, with the last run buffered for late subscribers |
| POST | `/api/runner/start` | starts a stopped container → `RunnerStatus`; 502 when it fails |
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

`/mcp` called with the RUNNER's token is not narrowed by a share: the maestro tools reach every card
on the board. A member cannot call it with a browser session (only an owner's session is accepted),
but the agent inside a card they were given can — see "Who can see what" in `ARCHITECTURE.md`. An
OAuth access token (see "MCP — the board, from outside") IS narrowed: it reaches what its user
reaches.

## Projects & cards

Creating, editing and deleting a project (and creating or deleting a card) is the **owner**'s. The
listings are filtered to what the caller may see; reading and editing ONE card follows access to
that card.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects` | `{ projects: Project[] }` |
| POST | `/api/projects` | `{ name, repoFullName?, cloneUrl?, baseBranch?, defaultAccountSlug?, githubConnectionId? }` — `githubConnectionId` must name an existing GitHub connection; absent = the first |
| PATCH | `/api/projects/:id` | partial update |
| DELETE | `/api/projects/:id` | also removes its cards — and PURGES each of them (same teardown as `DELETE /api/cards/:id`), in the background. `{ ok: true, cards }` |
| PATCH | `/api/projects/:id/order` | `{ position }` — sidebar position |
| GET | `/api/projects/:id/cards` | `{ cards: Card[] }` |
| GET | `/api/cards` | `{ cards: Card[] }` — every card in the install, for the views that cut across projects (the sidebar's Recent list) |
| POST | `/api/cards` | `{ projectId, title }` plus any editable field (`branch`, `base`, `locked`, `accountSlug`, `model`, `effort`, `resumeSessionId`), applied through the same validation an edit uses. Answers immediately and **pre-provisions the workspace in the background** (clone, worktree, tmux), so the first open is instant |
| GET | `/api/cards/:id` | `{ card }` |
| DELETE | `/api/cards/:id/wait` | **work** — cancels the wait this card registered with `vibehub_wait_for_card` → `{ ok: true }`; 404 when there is none |
| POST | `/api/cards/:id/wait/fire` | **work** — wakes this card now with the wait's instruction → `{ fired: true }`; 409 when the awaited card has not finished, this card is paused, or a wake is already running |
| PATCH | `/api/cards/:id` | **work** — `{ title?, column?, position?, model?, effort?, accountSlug?, branch?, base?, locked?, resumeSessionId? }` → `{ card, session }`. All-or-nothing: one invalid field and nothing is applied. A **member** (with `work`) may send only `title`, `column`, `position`, `model` and `effort` — any other field refuses the whole patch with `403 { error: "only the owner can change: …" }`. `accountSlug`/`branch`/`resumeSessionId`: `null` clears (back to the project's account / `card/<slug>` / `claude -c`); `model` is a family alias (`fable`/`opus`/`sonnet`/`haiku`) that the CLI resolves to its newest release — a versioned id from an older client (`claude-opus-5`) is stored as its family; `effort` is `low`/`medium`/`high`/`xhigh`/`max`; both: `null`/`""` clears, and a change restarts the live session (or flags it while Claude works). A `sdkChat` field is still accepted (owner only) and stored, but nothing reads it: whether a card's Chat tab is the native chat is the install-wide `sdkDriver` setting. `locked` is the per-card lock described below (`null`/`false` unlocks) — moving to `done` is always manual. A column is not just a label: moving **into `paused` pauses the card for real** (same rules as the pause route) and moving a paused card into `waiting`/`working` **resumes it** (the session comes back in the background) |
| DELETE | `/api/cards/:id` | **owner** — a PURGE, not a hide: `{ ok: true, incomplete: string[], steps }`. Kills both tmux sessions and the SDK driver, the preview servers and the card's browser; then erases the native chat history, the provenance log, the in-flight marker, the queued messages, the worktree, **the `card/<slug>` branch the card created, LOCALLY** (a branch that existed before the card — `dev`, `prod`, an imported session — is left alone, and nothing remote is ever touched: the script carries no `push`/`fetch`/`gh`), `/work/.uploads/<id>`, the card's `/tmp/vibehub/<id>` (after killing every runner process born with its `VIBEHUB_CARD_ID`), the browser profile, the gh-token file and the Claude Code transcripts/prompt history of the card's cwd in every account profile. The card leaves the board even when the runner is down — `incomplete` names the steps that did not finish and the hourly orphan sweep collects them. Nothing pushed to GitHub is touched |
| POST | `/api/cards/:id/open` | attach-or-create the tmux session; returns the card. Also resumes a paused or hibernated one |
| POST | `/api/cards/:id/pause` | moves the card to `paused` and ends its tmux sessions. A card that is REALLY working (the runner is asked, not the dot) becomes a *pending* pause: the session lives until Claude finishes. A stale `working` dot — a card parked on Claude's "Resume from summary" screen never fires a Stop hook — does not defer anything: it is paused on the spot |
| POST | `/api/cards/:id/hibernate` | kills tmux and stamps `hibernatedAt` — the card KEEPS its column and position and loses its dot; a card with nothing to hibernate (never opened, already cold, or `working`) comes back unchanged |
| POST | `/api/cards/:id/restart` | fresh Claude process in the same worktree |
| POST | `/api/cards/restart-all` | `{ restarted, skipped }` |
| POST | `/api/cards/:id/upload` | **work** — the raw file as `application/octet-stream`, name in `?name=`, size in `Content-Length` (required, up to 1 GB) → `{ path }` inside the runner. Streamed to the runner without being held in memory; an upload cut short leaves no file behind. 411 without a size, 413 over 1 GB, 408 when no byte arrives for 60 s, 415 for any other content type (a page loaded before the change: reload it), 502 when the runner fails. The chat shows an attachment back only up to 10 MB; past that it prints the path. Kept for **180 days** (`UPLOAD_RETENTION_DAYS`, swept daily) and erased with the card (DELETE above) |
| GET | `/api/cards/:id/uploads/:file` | **view** — the attached file back (image, PDF, audio, any document): types the browser opens are served `inline`, the rest as a download. Honours `Range` (206/416), so attached audio shows its duration and plays in Safari. Only names the upload route itself writes (`<stamp>-<name>.<ext>`); anything missing is a 404, cached `immutable` because the name carries the upload's timestamp |
| GET | `/api/cards/:id/uploads/:file/preview` | **view** — the attachment as text, for the formats the browser does not open (spreadsheet, Word, PowerPoint…) → `{ formato, texto, truncado }`; 422 when it cannot be read |
| POST | `/api/cards/:id/messages` | `{ text }` → `{ delivered, pending, agent }` — the composer's Enter. Delivered to a RUNNING Claude, otherwise QUEUED until there is one |
| GET | `/api/cards/:id/messages` | `{ pending: OutboxMessage[], agent }` — `agent` is `running` / `shell` / `none` |
| DELETE | `/api/cards/:id/messages/:messageId` | gives up on one queued message |
| GET | `/api/cards/:id/browser` | `{ live, liveSince, busy, control: "agent"\|"human", controlBy }` — answered from memory, cheap enough to poll |
| POST/DELETE | `/api/cards/:id/browser` | start/stop the card's live browser |
| POST | `/api/cards/:id/browser/control` | **take the wheel**: the browser pane stops being view-only and the agent is asked before it drives. Answers the same shape as the GET |
| DELETE | `/api/cards/:id/browser/control` | hand it back to the agent — releases only YOUR own hold |
| WS | `/api/cards/:id/terminal` | **view** (a `view` socket only watches) — xterm bridge (`?shell=1` for a plain shell in the same worktree) |
| WS | `/api/cards/:id/chat` | the SAME session read as a conversation: one JSON `ChatEvent` per frame (`{ id, kind: "user"\|"assistant"\|"tool", at, text, tool? }`), parsed from Claude Code's transcript. Opens with the last turns and streams what is appended; blank frames are the follower's heartbeat |
| POST | `/api/cards/:id/chat` | **work** — `{ text }` → `{ ok: true }`: types it at that session's prompt and presses Enter. 409 when the card has no live session, Claude is not running in it, or a menu is open in the terminal |
| WS | `/api/cards/:id/sdk` | **work** — **native chat**, the Agent-SDK driver, gated by the `sdkDriver` setting (on by default; off, the socket sends one `error` frame and closes). One JSON `DriverEvent` per frame (among them `ready`, `session`, `assistant_delta`, `assistant_text`, `tool_use`, `permission_request`, `permission`, `user_question`, `question_result`, `result`, `system_note`, `workflow_progress`, `error`, `parse_error`); the client sends `{ type: "user", text }`, `{ type: "interrupt" }`, `{ type: "permission_decision", id, allow }`, `{ type: "question_answer", id, answers }`, plus the ephemeral `typing`, `question_draft` and `workflow_feed` frames. The driver belongs to the card, not to the socket: closing the page leaves a turn running. On connect the route **replays the conversation**: the newest TUI/SDK transcript tail (converted to frames, incl. `{ type: "user" }`) plus the per-card event log (`<dataDir>/sdk-history/<cardId>.ndjson`), then spawns the driver resuming the **newest session** in the card's worktree (falling back to `resumeSessionId`). The route persists each new `session_id` on the card (`resumeSessionId`) so a reconnect resumes the same conversation. Contract in `back/src/services/sdk/protocol.ts` + `docs/sdk-driver.md` |
| POST | `/api/cards/:id/chat/key` | `{ key: "escape" \| "interrupt" }` — the chat's Stop button |
| WS | `/api/cards/:id/vnc` | **work** — noVNC bridge for the card browser |

### Documented pull requests — every PR explains itself

`vibehub_deliver` never opens a PR with `gh pr create --fill` (a body that is just the list of
commits). The AI that did the work sends the documentation with the delivery:

- `title`, and `body` — markdown with the headings Contexto, Problema identificado, Objetivo, Solução
  implementada, Detalhamento técnico, Comportamento esperado, Impactos, Testes e validações, Pontos de
  atenção, Conformidade com as regras do repositório (English equivalents are accepted, such as
  Compliance);
- `comments` — `[{ path, line, body, side?, startLine? }]`, one per relevant block of the diff, each
  120 to 8 000 characters (what changed, why, how, responsibility, impact, rules).

A NEW PR needs all three. Invalid documentation is refused before anything runs; missing documentation
with no open PR pushes the branch and stops at `{ reason: "undocumented" }`. An open PR is reused, and
rewritten (`gh pr edit`) when a title or body comes along. The comments go up before the gate as ONE
`COMMENT` review pinned to the pushed commit, skipping those already on the PR (same file and text);
GitHub refusing them (a line outside the diff) answers `{ reason: "comments_failed", prUrl }` and
nothing is merged. The answer carries `comments: { posted, skipped }`.

### Locked cards — deliver only as a pull request

A card can be **locked to its base** (`locked: true`, owner-only, off by default and absent from
every card that does not ask for it). A locked card still works the way every card works — its own
worktree, its own branch cut from `base` — but its DELIVERY is fixed:

- the pull request is opened against **that card's `base`**, whatever target the caller asked for;
- it is **never merged** from vibehub, `authorized: true` or not. `vibehub_deliver` answers
  `{ reason: "locked", locked: true, prUrl }` with the gate already run, and merging is the
  reviewer's;
- the rule is also written into the card's `CLAUDE.local.md`, so its agent knows it before trying.

It is the hotfix shape made the only shape that card has, and it is how somebody is given a card to
work without being given the ability to ship it: share the card at `work`, lock it, review the PR.

**What the lock does not do:** a card's terminal is still a shell with `git` in it. The lock is the
board's half — to stop a merge made by hand, the repository has to say so too (a GitHub ruleset
requiring a pull request on the protected branches, on an account that cannot bypass it).

## Preview

An app running inside the runner, opened in your own tab through vibehub — see `docs/preview.md`.
Access is narrower than "has a session": vibehub's own browser ports (VNC 5900–6799, CDP
9222–10121) are never proxied, for anyone; the **owner** reaches every other port; a **member**
reaches only a port whose **current** card — the newest `vibehub_preview` registration of it — is
visible to them, at any share level.
Anything else answers **404**, like a card you cannot see.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/preview/ports` | `{ ports: [{ port, address: "loopback"\|"all"\|"other", process?, pid? }] }` — what is listening in the runner, minus vibehub's plumbing; a member gets only the ports whose current card is visible to them. Also prunes registered previews whose port went silent and that store no start command. 502 when the runner cannot be scanned |
| POST | `/api/cards/:id/previews/:port/restart` | **work** on the card — relaunches the stored command in the preview's own tmux session and waits for the port → `{ restarted: true, port, path }`. **409** = nothing to relaunch (no such preview, no stored command); **502** = the relaunch failed (never listened — the error carries the pane's last lines) |
| DELETE | `/api/cards/:id/previews/:port` | **work** on the card — tree-kills the preview's session and removes the chip → `{ stopped: true, port }`; stopping twice is a **409** |
| ANY | `/preview/:port/*` | **the proxy** (outside `/api`; GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS) — relays the request to `127.0.0.1:<port>` in the runner with the prefix stripped, and the app's response back verbatim. `/preview/:port` redirects to the trailing slash; a malformed port is a 400; a port the caller may not reach is a 404; a dead port is a 502 — JSON for assets/API calls, the "Preview parado" HTML screen for a navigation. The `vibehub_session` cookie never reaches the app |
| WS | `/preview/:port/*` | the same, for websockets (vite HMR), relayed byte-for-byte. Same access rule: 401 without a live session (a deleted account or a cookie revoked by a password change included), 404 for a port the caller may not reach |

## Cofre — credentials and captured logins

Credential CRUD and **saving** a capture are the **owner**'s (both create a credential for the whole
install). Values go in and never come back: listings carry names, types and timestamps only.
Listing and dismissing captures follow **work** on the card, and a capture is reachable only
through the card whose browser saw it — another card's capture id is a 404 on save and
`{ ok: false }` on dismiss.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/credentials` | `{ credentials: [{ id, name, type: "userpass"\|"token", createdAt, usedAt? }] }` |
| POST | `/api/credentials` | `{ name, type, username?, password?, value? }` — `userpass` takes `username` + `password`, `token` takes `value` → `{ credential }`; 400 on a bad or duplicate name |
| DELETE | `/api/credentials/:id` | `{ ok: true }`; 404 when unknown |
| GET | `/api/credentials/agent-write` | `{ projectIds }` — the projects whose card agents may WRITE to the Cofre (`vibehub_credential_generate`, `vibehub_credential_save_capture`) |
| PUT | `/api/credentials/agent-write` | `{ projectIds }` → `{ projectIds }` — replaces that list |
| GET | `/api/cards/:id/captures` | `{ captures: [{ id, host, suggestedName, username, at }] }` — logins the card's browser saw and nobody decided on yet. Never the password |
| POST | `/api/cards/:id/captures/save` | **owner** — `{ captureId, name? }` → `{ credential }`; `name` defaults to the suggested one. The password goes from the server-held capture straight to the vault |
| POST | `/api/cards/:id/captures/dismiss` | `{ captureId }` → `{ ok }` — forgets it without saving |

## Claude accounts, MCPs, brain, import

**owner** only, except `GET /api/transcribe` (any session) and the card-scoped routes
(`/api/cards/:id/transcribe`, `/api/cards/:id/session`, `/api/cards/:id/usage`,
`/api/cards/:id/paths`), which follow the card.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/accounts` | `{ accounts: Account[], defaultLabel }` |
| POST | `/api/accounts` | `{ name }` → `{ account }`; the profile directory slug is derived from it |
| PATCH | `/api/accounts/:slug` | `{ name }` → `{ account }` — renames it; the slug does not change |
| DELETE | `/api/accounts/:slug` | `{ account }`; refused (400) while a person is tied to it through `claudeAccountSlug`, or a card or project still uses it |
| GET | `/api/accounts/tokens` | `{ bySlug, defaultHasToken }` — which accounts have a long-lived token |
| GET | `/api/accounts/usage` | `{ bySlug: { <slug>: AccountUsage }, fetchedAt }` — plan usage per account (see below) |
| POST | `/api/accounts/:slug/token` | `{ token }` — long-lived Claude token, stored in the vault, planted in every runner profile |
| DELETE | `/api/accounts/:slug/token` | |
| WS | `/api/accounts/:slug/login-terminal` | interactive `claude /login` terminal for that profile (`default` = the built-in one) — writes the refreshable credentials the usage meter reads |
| GET | `/api/mcps` | `{ mcps: Mcp[] }` — `{ id, name, kind: "stdio"\|"http"\|"sse", command?, args?, url?, envKeys?, headerKeys? }` |
| POST | `/api/mcps` | `{ name, kind, command?, args?, url?, envKeys?, headerKeys? }` — names only; values go in one at a time |
| GET | `/api/mcps/secrets` | `{ byMcp: { [mcpId]: { [name]: boolean } } }` — which declared secrets already have a value |
| DELETE | `/api/mcps/:id` | its secrets leave the vault at once; its removal from the runner's profiles is recorded on the board and paid by this apply — or, with the runner down, by the next one |
| POST | `/api/mcps/:id/secret` | `{ key, value }` |
| POST | `/api/mcps/apply` | removes the deleted MCPs still owed, then re-injects every MCP into every profile |
| GET | `/api/brain` | `{ text, ... }` — shared CLAUDE.md planted in each card |
| POST | `/api/brain` | `{ text }` — save it |
| DELETE | `/api/brain` | back to the built-in default |
| POST | `/api/brain/apply` | push it into every profile |
| GET | `/api/brain/projects/:id` | `{ text, ... }` — the PROJECT's brain (CLAUDE.local.md in its card worktrees); `""` = none |
| POST | `/api/brain/projects/:id` | `{ text }` — save it (empty text clears it); auto-applies to that project only |
| POST | `/api/brain/projects/:id/apply` | rewrite it in that project's worktrees |
| GET | `/api/plugins` | `{ marketplace, plugins: [{ name, description, installs, installed, enabled }] }` — Anthropic's official plugin marketplace, read from the runner |
| POST | `/api/plugins/:name` | install it into every profile and remember it (auto-applies + staggered restart) |
| DELETE | `/api/plugins/:name` | drop it from the wanted list and uninstall it everywhere |
| POST | `/api/plugins/apply` | reconcile every profile with the wanted list |
| GET | `/api/transcribe` | **any session** — `{ available, proofread, language }` — voice input status (keys are never returned); `proofread` is on only with a Claude key stored AND the `transcribeProofread` setting on |
| POST | `/api/transcribe/keys` | `{ openaiKey?, anthropicKey? }` → the same status — empty string clears; OpenAI gpt-transcribe transcribes (with `transcribeKeywords` as keywords), Claude proofreads against the brain |
| POST | `/api/cards/:id/transcribe` | **work** — `{ base64, mimeType }` → `{ text, proofread }`; 503 when voice input is not configured |
| POST | `/api/import` | `{ items: [{ repo, title, sessionId, branch?, column? }], stageDir? }` — adopt staged Claude sessions as cards |
| GET | `/api/cards/:id/session` | **view** — `{ model, modelLabel, effort, account: { slug, name }, situation }` — what the session is REALLY using: model from the last assistant turn (`modelLabel` carries the version, e.g. `Opus 5.5`), reasoning level, effective account, and whether the agent is `working`/`waiting`/`paused`/`done`/`stopped`/`no session` (`stopped` = the session is there but Claude exited to the shell) |
| GET | `/api/cards/:id/usage` | **view** — `{ slug, usage: AccountUsage }` — plan usage of the ONE account this card runs on, so a member sees how close the limit is without seeing the account list |
| GET | `/api/cards/:id/paths` | **view** — where the card maps to inside the runner (debugging an import) |

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
    "work": { "available": false, "error": "no_credentials", "fetchedAt": 1755880000000 }
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

## Voice mode

A spoken conversation with GPT-Live over WebRTC — see `docs/voice.md`. The OpenAI key never leaves
the server: the browser sends its SDP offer and gets the answer back. A call inside a card's chat
takes the same right as typing in it (**work**).

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/voice/live` | **any session** — `{ enabled, available, model, speech }`, booleans and the model name only |
| POST | `/api/voice/live/sessions` | **any session** — `{ sdp }` (the browser's offer) → `201 { sessionId, sdp }`. 404 when voice mode is disabled; 400 on a missing or invalid offer |
| POST | `/api/cards/:id/voice/sessions` | **work** — the same trade for a call in this card's chat; the instructions carry the card's recent thread |
| POST | `/api/cards/:id/voice/actions` | **work** — `{ callId, name, arguments }` (a function call the model made, `arguments` as its JSON text) → `{ output }`. Runs the board action as the caller, once per `callId`; a board refusal keeps its status (400/404/409), any other failure is a 502 |
| POST | `/api/cards/:id/voice/turns` | **work** — `{ turns: [{ vid, role, text, at }] }` → `{ saved, duplicate }`: the call's spoken turns saved in the card's chat. Idempotent on `vid` |
| POST | `/api/cards/:id/voice/speech` | **work** — `{ text }` (one piece of an answer) → `audio/mpeg`, streamed: reads it aloud |

## Pull request review and analysis

Two flows, both driven by cards (see the `[vibehub · revisão de PR]` and `[vibehub · análise de PR]`
prompts in `back/src/services/review/prompts.ts`): a **review** in rounds, where a reviewer AI and
the author's AI take turns on one PR of a card; and an **analysis**, where one analysis card judges
a project's PR and can merge it.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects/:id/prs` | **any session**, project visible (else 404) — `{ pulls }`, the project's open PRs as the caller's GitHub account sees them. 403 `{ error, login, repo }` when that account cannot see the repository; 502 when GitHub fails |
| WS | `/api/projects/:id/prs/live` | project visible — who is looking at which PR. The client sends `{ type: "claim" \| "release", prNumber }`; the server sends `claims`, `pulls-changed`, `claim-refused` and, to a `view` share that claims, `{ type: "error", code: "read_only" }` |
| GET | `/api/projects/:id/analysis-people` | **any session**, project visible — `{ people }` who may review or co-author an analysis there |
| POST | `/api/projects/:id/prs/:number/analysis` | `work` on the project — `{ reviewerUserId, coauthorUserId? }` → `{ card, created }`: creates (or reuses) the analysis card. 409 `{ error, username }` while another person is setting up that PR's analysis |
| GET | `/api/cards/:id/analysis` | **view** — `{ analysis, health, verdict, uncheckedDimensions, canMerge, merging, mergedAt?, lastMergeRefusal?, mergeGate? }`; `{ analysis: null }` before the first report |
| GET | `/api/cards/:id/analysis/conversation` | **view** — `{ conversation }` of the analysis fleet |
| POST | `/api/cards/:id/analysis/merge-gate` | **work** — runs the merge gate again → `{ mergeGate }`, or the refusal with its status |
| POST | `/api/cards/:id/analysis/merge` | **work** — merges the analysed PR as the caller → `{ result }`, or the refusal with its status |
| GET | `/api/cards/:id/people` | **view** — `{ people }` who can take a role in this card's review |
| POST | `/api/cards/:id/review` | **work** — `{ prNumber, reviewerUserId, authorUserId?, coauthorUserId?, mergerUserId? }` → `{ review }`: starts a review of that PR |
| GET | `/api/cards/:id/review?pr=` | **view** — `{ review, working, merging, fleet }` for the active (or latest) review; `pr` picks one PR among those the card follows. `{ review: null }` when there is none |
| GET | `/api/cards/:id/review/agents/:runId/:agentId/feed` | **view** — `{ items }`, the recent steps of one reviewer subagent. 400 bad id, 409 reviewer session closed, 502 runner probe failed |
| GET | `/api/cards/:id/review/conversation/:runId` | **view** — `{ conversation }` of one reviewer fleet run |
| POST | `/api/reviews/:id/decide` | reviewer or owner — `{ findingId, decision: "block" \| "drop" \| "keep" \| "accept_risk" }` → `{ review }` |
| POST | `/api/reviews/:id/retry` | reviewer, merger, co-author or owner → `{ review }`; 409 when there is nothing to retry |
| POST | `/api/reviews/:id/suggestions` | reviewer, author, co-author, merger or owner — `{ apply?, skip? }` (suggestion ids; `findingIds` is the old name of `apply`) → `{ review }` |
| POST | `/api/reviews/:id/cancel` | reviewer, author, co-author, merger or owner → `{ review }`; 409 when the review is closed |
| POST | `/api/reviews/:id/merge` | merger, reviewer, author or co-author (an owner without a role is refused) → `{ review, result }`. Only in `ready`, pinned to the approved commit, with the clicker's own GitHub connection; otherwise the refusal with its status |

The `/api/reviews/:id/*` routes need only a session; the role is checked inside: 404 for an unknown
review, 403 for a caller outside the roles listed.

## Platform failures

A failure or inconsistency of vibehub ITSELF, reported by a card's agent
(`vibehub_report_platform_failure`) or by the screen, waiting for the owner to approve a fix. The
investigation card records its conclusion on the failure (`vibehub_failure_investigation_report`), and
`investigationReport` comes in the failure.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/platform-failures` | **owner** — `{ failures }` waiting on the owner |
| POST | `/api/platform-failures/:id/investigate` | **owner** — opens (or reuses) an investigation card in the project named by the `selfProjectId` setting and sends it the brief → `{ failure, card }`. 400 when that project is not set |
| POST | `/api/platform-failures/:id/dismiss` | **owner** → `{ failure }` |
| POST | `/api/platform-failures/screen-errors` | **any session** — `{ message, screen, stack? }` → `{ recorded }`: an error the front caught, with secrets redacted |

## MCP — the board, from inside a card

| Method | Path | Body / notes |
|---|---|---|
| POST | `/mcp` | **Bearer = the runner's service token**; an **owner**'s browser session also works (a member's does not). MCP streamable HTTP, stateless. |
| GET | `/mcp` | 405 — this endpoint is POST-only. |

vibehub registers itself as an MCP server in every card's profile, so the agent running in a card can
coordinate the other cards. They are real parallel terminals, not sub-agents: each keeps its own
context, worktree and branch. The tools below are the whole set a card gets (`back/src/mcp/tools.ts`,
`credentialTools.ts`, `attachmentTools.ts`, `platformFailureTools.ts`); each tool's description in
those files is the full contract. "Own card" = the caller passes its `$VIBEHUB_CARD_ID` as `card`.

| Tool | What it does |
|---|---|
| **Coordinating cards** | |
| `vibehub_list_terminals` | lists the cards with their situation (`working`, `waiting`, `paused`, `done`, `no session`); `project` filters |
| `vibehub_list_projects` | lists every project (id, name, repository, base branch), even one with no card yet, and whether the person who gave the calling card its order may create a card there (`canCreateCard`, `reason`) |
| `vibehub_create_card` | creates a card in any project, at the top of its backlog, authored by the person who gave the calling card its order; refused with the reason unless that person is the owner and the GitHub account their cards use can push to the project's repository |
| `vibehub_send_to_terminal` | delivers an instruction to another card as a message of its conversation (see below); wakes a hibernated or never-opened card; refuses a card paused on purpose and a PR reviewer card. `from` = the caller's own card id, shown as the sender; `inReplyTo` closes the event it answers |
| `vibehub_read_terminal` | reads that card's last assistant answers (`last`, default 3), stripped to text; works on a paused card |
| `vibehub_wait_for_card` | own card — wakes the caller with `instruction` when the awaited card gets a PR merged through vibehub (on `base`, if given), is concluded or is deleted. One wait per card; refused for itself, a card already in done and a cycle |
| `vibehub_cancel_wait` | own card — drops that wait |
| `vibehub_move_cards` | moves one or more cards to `done` or `backlog`; each card succeeds or fails on its own line |
| **Own state** | |
| `vibehub_report` | own card — declares `working` / `ready` / `needs_me` / `blocked` with a one-line `summary`; never moves the card |
| `vibehub_notify` | own card — a message to whoever follows the board (MCP push `card.event` and the inbox): `info`, `error`, `done`, or `question` / `approval`, which ask for an answer; `idempotencyKey` announces a retry once |
| `vibehub_brain_learn` | own card — appends a dated learning under `## Aprendizados` of the project's brain; append-only, deduplicated |
| `vibehub_preview` | own card — registers a server listening in the runner as a preview chip and returns its `/preview/<port>/` path; refuses a port not listening or a page that cannot be opened |
| `vibehub_report_platform_failure` | reports a failure or inconsistency of vibehub itself (see "Platform failures") |
| `vibehub_failure_investigation_report` | own card — the investigation card records its conclusion on the failure it investigates (verdict, how it happened, cause, what fixes it, a decision left to the owner), shown in the failures panel; refused for a card investigating nothing |
| **Shipping** | |
| `vibehub_deliver` | push, PR (documented, see "Documented pull requests"), the PR's GitHub CI as the gate (a PR without CI is refused with `no_ci`, never merged), and a merge commit only with `authorized: true` → `{ prUrl, merged, reason }` |
| `vibehub_act_as` | makes the card's git and gh act as another participant of the card, until the next person's message |
| **PR review and analysis** | |
| `vibehub_review_start` | own card — starts a review of the card's PR, as the "Pedir revisão" button does |
| `vibehub_attach_prs` | own card — attaches open PRs of the project to the card for review → `{ attached, refused, next }` |
| `vibehub_review_submit` | reviewer card only — hands back a review round (findings or verdicts) |
| `vibehub_review_respond` | author card only — answers the reviewer's findings after fixing |
| `vibehub_analysis_report` | analysis card only — records the analysis report (`fleet_unavailable`, `analysed`, `done`) |
| `vibehub_analysis_step` | analysis card only — records a fixing step for the panel's timeline (`fixing`, `fixed` with the commit, `recheck`) |
| **Attachments** | |
| `vibehub_read_document` | reads a document on the runner (Excel, Word, PowerPoint, OpenDocument, PDF text layer, plain text) as markdown |
| `vibehub_transcribe_audio` | transcribes an audio or video file on the runner with OpenAI's gpt-transcribe |
| **Cofre (credentials)** | |
| `vibehub_credential_list` | own card — names and types of the credentials, never a value |
| `vibehub_credential_fill` | own card — types a named credential into the card's live browser over CDP; the value never reaches the agent |
| `vibehub_credential_generate` | own card — creates a credential with a random password the agent never sees; needs agent writes enabled for the project |
| `vibehub_credential_captures` | own card — logins the card's browser captured and nobody saved yet, never the password |
| `vibehub_credential_save_capture` | own card — saves one of those captures as a named credential; same rule as generate |

**How `vibehub_send_to_terminal` delivers** (`sendToTerminal` in `back/src/services/maestro/maestro.ts`):
when the destination card's native chat has a live driver, the instruction is a TURN of that driver.
With no live driver, the `sdkDriver` setting on and nobody generating in the card's terminal, a
driver is started for it and takes the turn. Otherwise the instruction travels over stdin inside a
quoted heredoc and is typed with `tmux send-keys -l`, so an instruction that contains the word
"Enter" is text, not a keystroke; that route refuses when a menu is open in the terminal. Reading is
a read-only tail of the newest transcript.

## MCP — the board, from outside (ChatGPT, Claude.ai)

An app on the internet connects to the same `/mcp` with OAuth 2.1 and drives the board **as one
user**: their role and their shares decide every tool, exactly as on the board. Nothing to
configure: every OAuth URL is built from the origin of the request (`X-Forwarded-Host`/`-Proto`, else
`Host`), so a gateway that publishes `/mcp`, `/oauth/` and `/.well-known/oauth-` of
`mcp.example.com` gets `https://mcp.example.com/...` back — the board itself can stay on a VPN. The
connector URL is `https://<that domain>/mcp`.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource` | **public** — RFC 9728 (also under `/mcp` suffixed). The 401 of `/mcp` points here. |
| GET | `/.well-known/oauth-authorization-server` | **public** — RFC 8414. Code flow, PKCE `S256` only, public clients. |
| POST | `/oauth/register` | **public** — RFC 7591. `{ client_name, redirect_uris }`; https, or loopback http. At most 100 clients. |
| GET | `/oauth/authorize` | **public** — the sign-in page (vibehub username + password). An unknown client or unregistered `redirect_uri` is an error page, never a redirect. |
| POST | `/oauth/authorize` | **public**, form — signs in, issues a 10-minute single-use code, sends the browser back with `code`, `state`, `iss`. Failures throttled per address+username. |
| POST | `/oauth/token` | **public**, form — `grant_type=authorization_code` + `code_verifier` → `{ access_token: "vhm_…", expires_in }` (90 days, no refresh token). |

Tokens are stored hashed in `oauth.json` and die with the account, or when its password changes.

The tools below are the whole set an OAuth caller gets (`back/src/mcp/externalTools.ts`).

| Tool | Who / what |
|---|---|
| `vibehub_list_projects` | the projects the user reaches; `canCreateCards` (owner only) |
| `vibehub_list_terminals` | the cards the user reaches, with their `access` (`work` / `view`) |
| `vibehub_create_card` | **owner** — creates a card and opens it (answers `opening` while the workspace is prepared) |
| `vibehub_open_card` | `work` — opens or resumes a session |
| `vibehub_send_to_terminal` | `work` — the user's own message, attributed to them; delivered the way the in-card tool delivers (a turn of the native chat when it is live or can be started, else typed at the terminal prompt). Wakes a sleeping card; refuses a card paused on purpose or asleep in `done`. Returns `sentAt` |
| `vibehub_wait_for_card` | `view` — holds up to 50 s until the turn ends or the card needs the user: `outcome` `finished` / `question` / `permission` / `timeout` / `not_started` / `no session`, with `answers`, `activity` and what is pending. `since` = the send's `sentAt` |
| `vibehub_read_terminal` | `view` — the card's last answers, plus `pendingQuestion` (the question card or terminal menu waiting on the user) |
| `vibehub_card_activity` | `view` — situation, `busy`, `pendingQuestion` / `pendingPermission` and recent events (messages, one line per tool call, answers); `since` for only what is new |
| `vibehub_card_changes` | `view` — read-only git: branch, commits ahead of the base, files changed, uncommitted work, the branch's PR |
| `vibehub_move_cards` | `work` on each card — `done` or `backlog` |
| `vibehub_deliver` | `work` — PR + checks; merges only with `authorized: true`. A NEW PR opens only documented: `title`, `body` with the standard's sections and `comments` on the diff (`reason: "undocumented"` otherwise; see "Documented pull requests") |
| `vibehub_inbox` | the user's open events (cards that finished a turn, asked a question, wait for a permission or need the user) → `{ events, cursor }`; `since` = a previous `cursor`. Other tool answers also carry new events once, as `notifications` |

The read tools carry `readOnlyHint`, so the app does not ask the user to confirm every poll.

A card the user cannot see answers `card not found`; a `view` share answers `read-only`. The
card-only tools (`vibehub_report`, `vibehub_preview`, credentials…) are not offered: the app has no
card of its own.

## MCP 2026-07-28 and MCP Events webhooks (ChatGPT Work)

The same `/mcp`, behind the same credentials, also speaks protocol **2026-07-28** (stateless: no
`initialize`; the version rides in the `MCP-Protocol-Version` header and in `params._meta`). A request
recognised as modern is answered by `back/src/mcp/modern.ts`; everything else still goes to the SDK, so
legacy clients see no change.

| Method (2026-07-28) | Answer |
|---|---|
| `server/discover` | `{ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} }, instructions, ttlMs, cacheScope: "private" }` |
| `tools/list`, `tools/call` | the caller's own tools (same ACL as their legacy session), plus `resultType` |
| `events/list` | `card.event`, `delivery: ["webhook"]`, filters `cardId` / `projectId` / `types` / `kinds` |
| `events/subscribe` | `{ name, arguments, delivery: { mode: "webhook", url, secret: "whsec_…" }, cursor, ttlMs? }` → `{ id, refreshBefore, cursor, truncated }` |
| `events/unsubscribe` | `{ name, arguments, delivery: { url } }` → `{}` (idempotent) |

Errors: header/body disagreement `400` + `-32020`; another modern version `400` + `-32022`
(`data.supported`); unknown method `404` + `-32601`. Events errors are JSON-RPC errors (HTTP 200):
`-32602` invalid params, `-32011` unknown event, `-32012` forbidden, `-32013` limit, `-32014` delivery
mode, `-32015` callback verification (`data.reason`). `-32015` is the code OpenAI documents for
ChatGPT; the others follow the same draft revision (the current draft renumbers them `-32023…-32027`,
which the legacy push stream keeps).

**Delivery** (`back/src/services/webhooks/`): before the first event to a URL, a signed
`{"type":"verification","challenge":…}` that the endpoint must echo in a 2xx (cached per principal +
URL). Then one `EventOccurrence` per POST (`eventId`, `name`, `timestamp`, `data`, `cursor`), Standard
Webhooks headers (`webhook-id` = `eventId`, `webhook-timestamp`, `webhook-signature`) plus
`X-MCP-Subscription-Id`, at most 256 KiB (long text is cut and `data.truncated` set). Transient
failures are retried with backoff (5 attempts); `410`, `413` and other definitive 4xx are not. The
credential that subscribed (kept hashed) and the board's ACL are re-checked at every delivery — a
revoked token drops the subscription. Callbacks must be `https`, resolve only to public addresses
(checked at every connect, the socket pinned to the checked address), and redirects are never
followed. Subscriptions, the verification cache and pending deliveries persist in
`webhook-subscriptions.json` (signing secrets encrypted with the vault key). `VIBEHUB_WEBHOOK_ALLOW_PRIVATE=1`
lifts the address check — tests only; never set it on an install.

### Turning it on in ChatGPT (manual, per OpenAI's MCP Events guide)

Preconditions: the connector URL `https://<public domain>/mcp` already works in ChatGPT (OAuth), and
the vibehub server can make **outbound HTTPS** requests to the internet (the callbacks are ChatGPT's).

1. Deploy this version; in ChatGPT, rescan the vibehub plugin/connector so it re-reads tools and
   events. The plugin page should list the `card.event` event next to the tools.
2. Open a **Work chat** (ChatGPT web, or the desktop app with **Work** and **Cloud** selected; a dot
   also works). MCP Events is not available in ordinary chats or voice.
3. Ask ChatGPT to monitor vibehub, naming the filter and what to do, e.g. "Subscribe to vibehub
   card.event for project my-app, kinds question and needs_me. When one arrives, tell me the
   question and the options, and answer it with vibehub_send_to_terminal only after I confirm."
4. On the server, confirm `events/subscribe` arrived and the verification passed (log line
   `MCP events` or the subscription in `webhook-subscriptions.json`).
5. Make a card ask something (`vibehub_notify` type `question`, or an AskUserQuestion in the native
   chat) and confirm the callback got a 2xx.
6. **The real test**: without typing anything in that Work chat, ChatGPT must start a run on its own
   and act on the event as instructed. Only this step proves the agent woke up; steps 4–5 only prove
   that the webhook was delivered.
7. Stop monitoring in ChatGPT and confirm the server processed `events/unsubscribe` (no more POSTs).
