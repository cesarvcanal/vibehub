# Architecture

vibehub is one app and one runner container.

```
                 browser
                    │  https  (session cookie)
                    ▼
        ┌───────────────────────────┐
        │  vibehub                  │   Fastify 5 + React, one image
        │                           │
        │  routes/     HTTP + WS    │
        │  services/   accounts, attachments, board, brain, browser,
        │              chat, credentials, events, github, import,
        │              maestro, mcp, platformFailures, plugins, preview,
        │              reaper, review, sdk, settings, transcribe, voice,
        │              waits, webhooks
        │  auth/       accounts, sessions, access preHandlers, OAuth
        │  mcp/        the MCP server and its tools
        │  runtime/    host executor, runner lifecycle
        │  secrets/    AES-256-GCM vault
        │  store/      atomic JSON documents
        └───────────┬───────────────┘
                    │  bash over local shell or ssh
                    ▼
        ┌───────────────────────────┐
        │  runner container         │   node image, `sleep infinity`
        │                           │
        │  /root   Claude config, profiles, tokens   (bind mount)
        │  /work   clones + one worktree per card    (bind mount)
        │  tmux    one session per card, `claude` in it
        │  sdk-driver  one Agent SDK process per card
        │              whose native chat is running
        └───────────┬───────────────┘
                    │  status hooks: POST /api/runner/status
                    └──────────────► back to vibehub
```

## Why a separate container

The agent needs a machine: apt packages, a browser, git worktrees, long-lived processes. Putting
that inside the app process would mean vibehub could not restart without killing every session, and
an agent bug would land in the app's blast radius. Keeping it in one container it manages means:

- vibehub restarts freely — every tmux session survives and reconnects. The native chat's SDK
  drivers are the exception: they are children of the back and die with it, so a turn they had in
  flight is marked on disk and resumed once at the next boot (`sdkAutoResume`,
  `services/sdk/resume.ts`).
- The agent runs as root inside an isolated container (`IS_SANDBOX=1`), which is what lets it work
  without a permission prompt on every command.
- What the agent can reach is exactly what you mounted and configured: the repos you connected, the
  MCP servers you registered, the tokens you planted.

Claude's own first-run walls are taken down per profile before the session starts (see
`services/accounts/firstRun.ts`): the setup wizard and the trust dialog would otherwise greet every
card of an account whose profile is new, and every freshly created worktree. Neither asks anything
the user has not already answered — the account was logged in on the Accounts screen, the worktree
is a clone of the repository attached to the project.

## The host executor

`runtime/host.ts` is the only module that knows how a command reaches Docker. Two implementations,
one contract:

- **local** — vibehub sits on the machine with the Docker socket. Scripts run through `bash -s`.
- **ssh** — Docker is on another host. The same scripts, piped through ssh.

Everything above writes plain bash and never learns which one it got. That is why the same code runs
on a laptop and on a VPS.

Scripts and file contents reach the runner over stdin, and card ids, branch names, session uuids
and container names end up inside a `docker exec` line; the rules for both are in
[AGENTS.md §10](../AGENTS.md#10-segurança-autorização-e-escopo).

## The mirror rule

Columns are not a workflow the user drives by hand; three of them are, and two are a mirror.

- `backlog`, `paused`, `done` — **sticky**. Nothing but an explicit action moves a card in or out.
- `working`, `waiting` — **mirrored** from Claude Code hooks (`runnerSettingsJson` in
  `runtime/runner.ts`). A prompt or a tool call moves the card to `working`; a session start, a
  stop, a failed stop, a permission request or a notification moves it to `waiting`.

Two deliberate exceptions:

- **Opening** a card in `backlog` or `paused` moves it to `waiting` — a terminal that just opened is
  waiting for you.
- **A new turn** in a card that is `done` (a `working` report on a card whose last status was not
  `working`) brings it back to `working` (`reactivatesOnActivity`). `waiting` reports never do this,
  so a `done` card stays done while the session merely exists, and the tool calls an agent makes
  after concluding its own card mid-turn do not pull it back. A hook never takes a card out of
  `paused`: the dying session's own hooks land after the pause, so leaving it is always a person's
  action (opening or dragging the card).

## Two ways to read one session

A card is ONE conversation, and the board shows it in two tabs, switched by hand from the card bar
on every screen size:

- **Terminal** — an xterm attached to the pty of the card's tmux session, where `claude` runs.
  Everything the TUI can do works here: `/login`, `/model`, its own menus. The cost is that it
  ships a REPAINTING SCREEN — an idle spinner is thousands of frames an hour, and a phone rasterises
  each.
- **Chat** — by default the **native chat**: a separate process per card, the SDK driver
  (`services/sdk/sdk-driver.mjs`), runs the same conversation through the Agent SDK inside the
  runner and streams structured events (text, tool calls, permission requests, questions, the
  turn's result) over `WS /api/cards/:id/sdk`. The driver belongs to the back, not to the socket
  (`services/sdk/manager.ts`): every tab of the card attaches to the one driver, a turn keeps
  running with no tab open, and a driver with no socket and no running turn for 15 minutes
  (`DRIVER_IDLE_MS`) shuts down; the next connect resumes the conversation. What the screen
  replays on every connect is kept in `sdk-history/<cardId>.ndjson`. Details in
  [sdk-driver.md](sdk-driver.md).

The two processes share the profile's transcript directory, so the conversation is one: the driver
resumes the newest transcript in the card's worktree (`resumeTargetFor`), whichever tab wrote it,
and while a native chat is connected the back follows the transcript and mirrors what is typed in
the Terminal into the chat (`services/sdk/mirror.ts`). The Terminal's `claude` does not draw a turn
the driver runs while it runs; its next resume picks it up.

The native chat is the install's `sdkDriver` setting, `true` by default
(`services/settings/settings.ts`), served to every signed-in user as `sdkChat` by
`GET /api/features`. With it off, the Chat tab mounts the **classic chat** in every card: the tmux
session read from the transcript Claude Code writes (`<profile>/projects/<cwd>/<id>.jsonl`),
followed with one `tail -F`, parsed into events and pushed over `WS /api/cards/:id/chat`; sending
goes through the maestro's `tmux send-keys`, so a message written there lands at the prompt the
terminal types into. What the classic chat cannot show is anything drawn only on the screen, so
when the agent goes quiet mid-turn it says so and offers the terminal.

Switching to chat UNMOUNTS the terminal, which closes its websocket. The choice is remembered per
card and per device (localStorage), never inferred from the width of the screen. A card nobody has
switched opens in CHAT: opening a card is usually reading what the agent said, and that is the view
that neither repaints nor costs a pty.

## Cards stay open

Switching cards in the browser is a change of which pane is VISIBLE, not a reconnect. Every card you
open joins a deck of live panes (`front/src/features/board/lib/deck.ts`): the pane stays mounted
with its socket — the terminal's, or the chat's — and the scrollback (or the transcript, and the
half-written message in the field) stays where you left it. Hopping between agents costs nothing,
and going back to the kanban parks the whole deck off screen, still connected.

Three consequences worth knowing:

- **One socket per live pane**, and one `tmux attach` process for each pane that is on the terminal
  — up to 6 panes on a desktop and 3 on a phone (a WebGL context each, which browsers cap). The
  least recently used card leaves the deck when it is full; nothing is lost, because the session is
  in the runner and reattaching is what opening a card always did.
- **Hidden panes are hidden, not disabled.** A pane that is not on top keeps its socket but gives up
  everything that reaches outside it: the tab title, the phone's scroll lock, the keyboard (`inert`,
  so a reconnect cannot steal it), the microphone, and the polls that only feed its own bar. Pausing
  a card, or deleting it anywhere, drops its pane rather than leaving a socket retrying at a session
  that no longer exists.
- **`POST /open` is asked for only when it can change something** (`cardNeedsOpen`): a card that has
  never been opened, one whose session was killed (paused, hibernated), or one whose column the open
  rule would move. That call runs the provisioning script and is serialized per project repository
  (`provisionLockKey`), so firing it for every card you glance at is how the one card that genuinely
  needs provisioning ends up waiting behind a queue of cards that needed nothing. A live card needs
  none of it: the pane's own websocket provisions by itself if the session turns out to be gone.

## Hibernation — the third thing a session can be

Pausing MOVES a card (to `paused`); hibernating does not move it at all. A sweep every five minutes
kills the tmux session of every card that has had no sign of life for longer than
`idleHibernateMinutes` (default 180, `0` = off) and stamps `hibernatedAt`. The column, the position
and the conversation are untouched — the card simply loses its dot and goes grey, which is how the
board tells "what I am working on now" apart from "what I walked away from".

An open card that is `working` is never hibernated, whatever the clock says: the hooks go quiet
while Claude thinks, and a long task is not an abandoned one. Nor is a card whose native chat is
in use (its driver casts a veto, `isCardInUse`), nor one whose pane the runner reports as busy or
cannot report on: the sweep asks the runner before killing anything. With the sweep on, a card in
`done` follows its own clock instead: silent for an hour (`DONE_HIBERNATE_MS`), it is hibernated
whatever its status (`cardsToHibernate` in `services/board/workspace.ts`). Hibernating also ends
the card's SDK driver.

Waking up is opening the card (or any hook report): `hibernatedAt` is cleared and the attach
recreates the session with `claude -c`, same conversation.

## State

No database. Under `VIBEHUB_DATA_DIR`:

| File | Holds | Owner |
|---|---|---|
| `board.json` | projects, cards, Claude accounts, MCP servers, GitHub connections, shares, pending MCP removals, browser slots held by deleted cards | `services/board/registry.ts` |
| `outbox.json` | messages composed in the terminal for a card that its agent has not received yet | `services/board/outbox.ts` |
| `session-spec.json` | fingerprint of the command a card session is born with; a deploy that changes it restarts the open sessions | `services/board/sessionSpec.ts` |
| `settings.json` | git identity, autonomy, setup stamp, idle-hibernation threshold, transcription options, native chat switches, the project where platform-failure investigation cards are created | `services/settings/settings.ts` |
| `brain.json` | the global brain text and the per-project brain texts | `services/brain/brain.ts` |
| `plugins.json` | the official plugins the install wants in every profile | `services/plugins/plugins.ts` |
| `credentials.json` | name and type of each saved browser login, and the projects whose agents may write one (the values are in the vault) | `services/credentials/credentials.ts` |
| `reviews.json` | PR reviews in rounds: findings, log, phase | `services/review/store.ts` |
| `analyses.json` | PR analysis reports per card, refused merges and the merge gate per analysed commit | `services/review/analysisStore.ts` |
| `card-events.json` | the card moments a person away from the board must hear about (turn finished, question, permission…), and what each person already received | `services/events/cardEvents.ts` |
| `webhook-subscriptions.json` | MCP Events webhook subscriptions, passed verifications and pending deliveries (signing secrets encrypted with the vault key) | `services/webhooks/subscriptions.ts` |
| `platform-failures.json` | failures of vibehub itself: back errors, slow or stalled turns, screen errors, agent reports | `services/platformFailures/platformFailures.ts` |
| `sdk-history/<cardId>.ndjson` | the native chat's conversation, per card — what a reconnect replays | `services/sdk/history.ts` |
| `sdk-inflight/<cardId>.json` | marker: this card had a turn in flight when the back died | `services/sdk/inflight.ts` |
| `sdk-catalog/<cardId>.json` | the last "/" menu the card's driver announced | `services/sdk/catalog.ts` |
| `sdk-context/<cardId>.json` | the card's last context-usage reading, per session | `services/sdk/lastContext.ts` |
| `sdk-question-drafts/<cardId>.json` | what each person ticked on an open question, until it closes | `services/sdk/questionDrafts.ts` |
| `provenance/<cardId>.ndjson` | who sent each message into a card through the classic chat | `services/chat/provenance.ts` |
| `users.json` | local accounts (scrypt hashes) | `auth/users.ts` |
| `userGit.json` | per person: commit author, GitHub connection and Claude account | `auth/userGit.ts` |
| `oauth.json` | OAuth clients of the external MCP and their tokens, stored hashed | `auth/oauth.ts` |
| `session.key` | cookie signing key | `auth/session.ts` |
| `secrets.enc` | AES-256-GCM vault: GitHub connection tokens, Claude account tokens, MCP secrets, browser login values, the OpenAI and Anthropic API keys set under transcription (voice and failure narratives read them too), runner token | `secrets/vault.ts` |
| `master.key` | vault key, generated on first boot unless `VIBEHUB_SECRET_KEY` is set | `secrets/vault.ts` |

The top-level `.json` documents go through `JsonStore` (`store/jsonStore.ts`): atomic writes
(tmp + rename) at mode 600 and mutations serialized per document — the status hooks are frequent
and concurrent, and a lost update there would silently corrupt the board. `session-spec.json` and
`secrets.enc` are written atomically by their own modules, and the keys by `store/keyFile.ts` at
mode 600. The per-card files under a directory are written by their own module: the `.ndjson`
logs append a line, and the rest are rewritten whole.

## The outbox

A card's terminal runs `claude; exec bash`, so a pane whose Claude exited is still attached and
still accepting keystrokes — into a SHELL. Typing a composed message into that moment executed it as
a command; typing one into a card that was never opened wrote it to nothing.

So the card's composer, outside the native chat, no longer writes into the terminal websocket. It
POSTs to the card's outbox (`services/board/outbox.ts`), which probes what the pane is really running
(`tmux list-panes -F '#{pane_current_command}'`) and either delivers with `send-keys` — the same
path the maestro uses — or keeps the message in `outbox.json` until it can. A flush is attempted on
enqueue, when a terminal attaches, when a status hook reports the agent went idle, and on a slow
ticker as the backstop.

Delivery is at-least-once (deliver, then remove): a crash between the two repeats a message, which
is visible, while the alternative loses one silently.

The native chat does not use the outbox: its messages go to the SDK driver, not to the tmux pane. A
message sent before that chat is ready waits in the browser's own queue
(`front/src/features/board/lib/sdkQueue.ts`, in localStorage) and is delivered when it connects.

## Deleting a card deletes the card

"Excluir card" used to drop the row from `board.json` and tear down the worktree. Everything else
the card had accumulated stayed on the server: the conversation twice over (the native chat's
`sdk-history/<id>.ndjson` here, and Claude Code's own transcripts
`<profile>/projects/<cwd-sanitized>/<session>.jsonl` inside the runner), the provenance log, the
in-flight marker, the messages still queued in the outbox, the attached images, the card's Chromium
profile — cookies and logged-in sessions — with the browser itself still RUNNING, its GitHub token
file, its preview servers still listening behind `/preview/<port>/`, and its branch and commits in
the clone. A deleted card was fully readable, and a new card born on the same worktree path RESUMED
its conversation.

So the delete is a purge (`services/board/purge.ts`), in an order that has a reason:

1. **Kill first** — both tmux sessions (tree-killed), the SDK driver, the preview sessions, the
   browser and its credential-capture listener. Nothing may be writing while we delete.
2. **Drop the card from the board** — every writer in vibehub resolves the card before it writes (an
   upload, a message, a status hook), so a card that is off the board cannot gain new content
   mid-purge. That is what makes "delete while an upload is in flight" safe, and what makes every
   old address (`/api/cards/:id/uploads/...`, the chat sockets) answer 404 from that instant.
   The card's browser SLOT (its X display / CDP port) does not go free with it: it is held in
   `board.json` (`browserSlotHolds`) and released only once the browser step went through. A
   Chromium that could not be stopped (runner down), or that has not been yet (a project's cards
   leave the board before they are purged), is still up there, logged in — a new card handed that
   slot would drive it.
3. **Erase the bytes** — data dir and runner, each step reported. `DELETE /api/cards/:id` answers
   with `incomplete: []` when nothing survived, and names the steps that failed otherwise: a runner
   that is down must never make a card undeletable, and must never be reported as a clean deletion.

Deleting a PROJECT cascades into the same purge for each of its cards (it used to be the way around
it). So does the **done-card retention** (`services/board/retention.ts`): a card that has sat in
`done` for ONE DAY without a single sign of life — no move, no rename, no hook status, no
keystroke — is purged by an HOURLY sweep, because `done` is the column nobody cleans and every card
left there keeps a worktree, a branch, a transcript, its attachments and a browser profile in the
runner. Only `done` is swept, touching a finished card buys it another day, a pass is capped (and
logs what it left for the next one), and a retention of `0` turns it off. Every done card shows a
countdown ("Deleted in 22 h"), computed in the browser from the same stamps and the retention that
`GET /api/features` serves (`front/src/features/board/lib/doneRetention.ts`). What is purged is the
runner's copy: the card's LOCAL branch goes with it, so work that was never pushed is lost.

An **hourly orphan sweep** is the backstop and the retroactive cleanup: it deletes only artifacts
that belong to no card that exists, with three guards — the path must be unmistakably a card
artifact, nothing younger than an hour is touched, and a pass is capped and logs what it left.

The branch it drops is the one the card CREATED (`card/<worktreeSlug>`), and it drops it LOCALLY.
Two guards, both structural:

- **Only the `card/` namespace.** `ownBranch` decides it, and `buildCardPurgeScript` THROWS on
  anything else (`CARD_BRANCH_PREFIX`) — so `dev`, `prod`, `main` or a `feat/...` a card was pointed
  at cannot be deleted by any caller, present or future. A card opened on an existing branch keeps
  it: that branch is not the card's work, it is work the card visited.
- **Nothing remote.** `git branch -D` is local by definition (deleting a remote branch needs
  `git push origin --delete`), and the purge script carries no command that reaches the network —
  no `push`, no `fetch`, no `origin`, no `gh`. A branch or PR on GitHub is another machine's data
  and the delete cannot touch it. Both rules are pinned by tests.

What deliberately SURVIVES, and why: anything already pushed to **GitHub** (a branch, a PR — another
machine's data), the **project brain** a card contributed to (`vibehub_brain_learn` writes knowledge that
belongs to the project), the **credentials saved to the vault** from a card's browser (they were
saved on purpose, they belong to the install), and **log lines** already emitted (the audit trail
carries card slugs). Filesystem backups of `VIBEHUB_DATA_DIR`, if the operator takes any, keep
whatever they captured until they rotate.

## Who can see what

An install has an **owner** — the person the setup wizard created — and the **members** they invite.
The split is not a permission matrix; it is one line: the owner owns the INSTALL, a member is given
WORK.

- Owner: every project and card, the Claude accounts, the vault, the MCP servers, the shared brain,
  the settings, the runner container, and the list of people. Also `/mcp` from a browser session —
  those tools reach every card on the board and can type into any of them.
- Member: what has been shared with them, their own password, and their own commit author and
  GitHub connection (`/api/me/git`). Nothing else is drawn in the UI, and nothing else answers on
  the API. An external MCP client a person connects through OAuth (`auth/oauth.ts`) acts as that
  person, with the same reach.

A **share** is `{ kind: "card" | "project", targetId, userId, level }` living in `board.json`
beside the cards. Two levels: `work` — their terminal types into the same tmux session yours does —
and `view` — the output streams to them and nothing they press reaches the pty (the websocket
attaches read-only, resizes included, because tmux sizes a window to its smallest client). Sharing a
PROJECT is the standing version of sharing a card: every card in it, including the ones created
afterwards. A card reached both ways takes the stronger of the two levels, and a share never
outlives the card, the project, or the person it names.

Fastify preHandlers in `auth/session.ts` and `auth/access.ts` carry it; which route wears which is
in [AGENTS.md §10](../AGENTS.md#10-segurança-autorização-e-escopo). Routes that act for nobody yet
or carry their own credential (login, logout and setup, the OAuth metadata, `/mcp`, the runner's
status hook) wear none and set their trust boundary themselves. `auth/access.ts` is also where the
board listings are narrowed (`visibleProjects`/`visibleCards`), so a member's board is filtered
rather than refused.

**What sharing does NOT reach yet: the agent inside the card.** Every card's Claude gets the vibehub
MCP registered with the RUNNER's token (`services/mcp/mcp.ts`), and that token is install-wide — the
maestro tools it unlocks can list, read and type into every terminal on the board, whoever is at the
keyboard. So a member working in a card they were given can ask its agent for what their browser
would refuse them. Scoping those tools to the card that holds them (a token per card) is the next
piece of this work; until then, share cards with people you would trust with the board.

`cardLevel` (`auth/access.ts`) is the one function that answers "what may this person do with this
card"; every card gate and every listing is built on it, which is why no route asks for a role.

## Credentials

- The **GitHub token** is handed to `git clone/fetch` per command as an environment-scoped http
  header. It never lands in `/work/<repo>/.git/config`, which the agent can read — and the agent
  processes untrusted repository content with network egress.
- **Whose** token and whose commit author: resolved field by field as **card actor → project →
  install** (`services/github/identity.ts`). The actor is whoever sent the card its latest ORDER at
  `work` level — a chat message, a keystroke in its terminal, a maestro relay, a delivery
  (`services/board/actor.ts`); opening or watching a card never takes the authorship. A card with no
  actor resolves from the project, then the install. So two people sharing a card each commit as
  themselves.
- That identity is enforced through per-card FILES read AT CALL TIME, never exported into a session
  (a process's environment is frozen at birth, so a `GH_TOKEN` exported then would push as the
  previous person after a switch). Every card process is born with `GIT_CONFIG_*` env including a
  per-card git config (author + a github.com-only credential helper that `cat`s the card's token
  file, after resetting the helper list), so it holds in the worktree and in any other repo the card
  clones; `/usr/local/bin/gh` is a wrapper that reads the same token file on every call
  (`services/github/runnerIdentity.ts`). Applications are serialized per card, and a chat message
  from a new author is held until that person's identity landed — no session restart, no lost
  conversation.
- The **runner service token** lives in the vault and is written by the runner setup script from
  INSIDE the container, through the same `docker exec` (`buildSetupScript` in `runtime/runner.ts`),
  to `/root/.vibehub-token` at mode 600. The outer shell is not necessarily the Docker host (with a
  local runner, vibehub itself runs in a container), so a write from there would land in vibehub's
  own filesystem. `/root` is a bind mount of the host, so the file survives a container recreate.
  The status hook reads it from disk at call time rather than having it baked into the runner's
  `settings.json`, and the vibehub MCP every card gets authenticates with it as a Bearer token.
- **Claude account tokens** (the long-lived `claude setup-token` value) live in the vault under
  `ACCOUNT_TOKEN_<SLUG>` and are written to `<profile>/.oauth-token` at mode 600, where the profile
  is `/root/.claude` for the default account and `/root/.claude-profiles/<slug>` for a named one
  (`services/accounts/token.ts`, and the card open in `services/board/workspace.ts`). The session
  exports `CLAUDE_CODE_OAUTH_TOKEN` from that file unless a newer refreshable `/login` sits in the
  same profile's `.credentials.json` (`oauthTokenGuard` in `services/accounts/profiles.ts`).
- Mode 600 keeps these files from other users, not from other cards: every card runs as `root` in
  the same runner, so any card can read every card's GitHub token, every planted Claude account and
  the runner service token. See [SECURITY.md](../SECURITY.md).
