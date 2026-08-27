# Architecture

vibehub is two processes and a container.

```
                 browser
                    │  https  (session cookie)
                    ▼
        ┌───────────────────────────┐
        │  vibehub                  │   Fastify 5 + React, one image
        │                           │
        │  routes/     HTTP + WS    │
        │  services/   board, accounts, mcp, brain, github
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
        │  tmux    one session per card              │
        │  claude  one process per session           │
        └───────────┬───────────────┘
                    │  status hooks: POST /api/runner/status
                    └──────────────► back to vibehub
```

## Why a separate container

The agent needs a machine: apt packages, a browser, git worktrees, long-lived processes. Putting
that inside the app process would mean vibehub could not restart without killing every session, and
an agent bug would land in the app's blast radius. Keeping it in one container it manages means:

- vibehub restarts freely — every tmux session survives and reconnects.
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

Two invariants live here, and both exist because of real incidents:

1. **Scripts and file contents travel over stdin, never argv.** `ps` is world-readable, and these
   payloads carry tokens.
2. **Anything user-supplied is validated at the boundary, then shell-quoted.** Card ids, branch
   names, session uuids and container names all end up inside a `docker exec` line.

## The mirror rule

Columns are not a workflow the user drives by hand; three of them are, and two are a mirror.

- `backlog`, `paused`, `done` — **sticky**. Nothing but an explicit action moves a card in or out.
- `working`, `waiting` — **mirrored** from Claude Code hooks. A prompt moves the card to `working`;
  a stop, a permission request or an idle notification moves it to `waiting`.

Two deliberate exceptions:

- **Opening** a card in `backlog` or `paused` moves it to `waiting` — a terminal that just opened is
  waiting for you.
- **Typing** in a card that is `done` or `paused` (a `working` report, which only fires on a real
  prompt) brings it back to `working`. Idle reports never do this, so a `done` card stays done while
  the session merely exists.

## Two ways to read one session

A card is one `claude` process in one tmux session. The board shows it either way, switched by hand
from the card bar on every screen size:

- **Terminal** — an xterm attached to the pty. Everything works here, including what only the TUI
  can do: permission prompts, plan approval, `/login`, `/model`. The cost is that it ships a
  REPAINTING SCREEN — an idle spinner is thousands of frames an hour, and a phone rasterises each.
- **Chat** — the same session read from the transcript Claude Code already writes
  (`~/.claude/projects/<cwd>/<id>.jsonl`). The server follows the newest file with one `tail -F`,
  parses each line into an event (user message, assistant message, or a collapsed tool line) and
  pushes it over `WS /api/cards/:id/chat`. Sending goes through the maestro's `tmux send-keys`, so a
  message written in the chat lands at the same prompt the terminal types into.

Switching to chat UNMOUNTS the terminal, which closes its websocket — that is the point. What chat
cannot show is anything drawn only on the screen, so when the agent goes quiet mid-turn the view
says so and offers the terminal instead of pretending. The choice is remembered per card and per
device (localStorage), never inferred from the width of the screen.

A card nobody has switched opens in CHAT: opening a card is usually reading what the agent said, and
that is the view that neither repaints nor costs a pty. The terminal is one click away, and the
click is remembered. The tool calls in a turn — a dozen reads, four edits — fold into one expandable
block, so what the agent SAID is what fills the screen.

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
  rule would move. That call runs the provisioning script and is serialized per project, so firing
  it for every card you glance at is how the one card that genuinely needs provisioning ends up
  waiting behind a queue of cards that needed nothing. A live card needs none of it: the pane's own
  websocket provisions by itself if the session turns out to be gone.

## Hibernation — the third thing a session can be

Pausing MOVES a card (to `paused`); hibernating does not move it at all. A sweep every five minutes
kills the tmux session of every card that has had no sign of life for longer than
`idleHibernateMinutes` (default 180, `0` = off) and stamps `hibernatedAt`. The column, the position
and the conversation are untouched — the card simply loses its dot and goes grey, which is how the
board tells "what I am working on now" apart from "what I walked away from".

A `working` card is never hibernated, whatever the clock says: the hooks go quiet while Claude
thinks, and a long task is not an abandoned one. Waking up is opening the card (or any hook report):
`hibernatedAt` is cleared and the attach recreates the session with `claude -c`, same conversation.

## State

No database. Under `VIBEHUB_DATA_DIR`:

| File | Holds |
|---|---|
| `board.json` | projects, cards, accounts, MCP servers |
| `outbox.json` | messages composed for a card that its agent has not received yet |
| `settings.json` | git identity, autonomy, setup stamp, idle-hibernation threshold |
| `users.json` | local accounts (scrypt hashes) |
| `secrets.enc` | AES-256-GCM vault: GitHub token, Claude tokens, MCP secrets, runner token |
| `master.key` | vault key, generated on first boot unless `VIBEHUB_SECRET_KEY` is set |
| `session.key` | cookie signing key |

Every write is atomic (tmp + rename) at mode 600, and mutations are serialized per document — the
status hooks are frequent and concurrent, and a lost update there would silently corrupt the board.

## The outbox

A card's terminal runs `claude; exec bash`, so a pane whose Claude exited is still attached and
still accepting keystrokes — into a SHELL. Typing a composed message into that moment executed it as
a command; typing one into a card that was never opened wrote it to nothing.

So the composer no longer writes into the terminal websocket. It POSTs to the card's outbox
(`services/board/outbox.ts`), which probes what the pane is really running
(`tmux list-panes -F '#{pane_current_command}'`) and either delivers with `send-keys` — the same
path the maestro uses — or keeps the message in `outbox.json` until it can. A flush is attempted on
enqueue, when a terminal attaches, when a status hook reports the agent went idle, and on a slow
ticker as the backstop.

Delivery is at-least-once (deliver, then remove): a crash between the two repeats a message, which
is visible, while the alternative loses one silently.

## Who can see what

An install has an **owner** — the person the setup wizard created — and the **members** they invite.
The split is not a permission matrix; it is one line: the owner owns the INSTALL, a member is given
WORK.

- Owner: every project and card, the Claude accounts, the vault, the MCP servers, the shared brain,
  the settings, the runner container, and the list of people. Also `/mcp` from a browser session —
  those tools reach every card on the board and can type into any of them.
- Member: what has been shared with them, and their own password. Nothing else is drawn in the UI,
  and nothing else answers on the API.

A **share** is `{ kind: "card" | "project", targetId, userId, level }` living in `board.json`
beside the cards. Two levels: `work` — their terminal types into the same tmux session yours does —
and `view` — the output streams to them and nothing they press reaches the pty (the websocket
attaches read-only, resizes included, because tmux sizes a window to its smallest client). Sharing a
PROJECT is the standing version of sharing a card: every card in it, including the ones created
afterwards. A card reached both ways takes the stronger of the two levels, and a share never
outlives the card, the project, or the person it names.

Two gates carry it, both Fastify preHandlers, and every route wears exactly one:
`requireOwner` (`auth/session.ts`) for what belongs to the install, and `requireCardAccess`
(`auth/access.ts`) for what belongs to a card. `auth/access.ts` is also where the board listings are
narrowed (`visibleProjects`/`visibleCards`), so a member's board is filtered rather than refused.

`cardLevel` is the one function that answers "what may this person do with this card"; every gate
and every listing is built on it, which is why no route asks for a role. The two preHandlers split
by verb, not by screen: reading a card is `requireCardAccess`, and anything that changes it or
reaches its session — typing, sending, uploading, pausing, renaming, the SDK bridge, the VNC relay —
is `requireCardWork`.

## Credentials

- The **GitHub token** is handed to `git clone/fetch` per command as an environment-scoped http
  header. It never lands in `/work/<repo>/.git/config`, which the agent can read — and the agent
  processes untrusted repository content with network egress.
- The **runner service token** is written host-side into the `/root` bind mount at mode 600, so it
  survives a container recreate, and the status hook reads it from disk at call time rather than
  having it baked into `settings.json`.
- **Claude account tokens** live in the vault and are planted per profile inside the runner.
