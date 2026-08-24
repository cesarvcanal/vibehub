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

## Terminals stay attached

Switching cards in the browser is a change of which pane is VISIBLE, not a reconnect. Every card you
open joins a deck of live panes (`front/src/features/board/lib/deck.ts`): the xterm stays mounted,
the websocket stays open, and the scrollback stays where you left it — so hopping between agents
costs nothing and the board is usable as a set of tabs. Going back to the kanban parks the whole
deck off screen, still connected.

Two consequences worth knowing:

- **One websocket, one `tmux attach` process per live pane** — up to 6 on a desktop and 3 on a phone
  (a WebGL context each, which browsers cap). The least recently used card leaves the deck when it
  is full; nothing is lost, because the tmux session is in the runner and reattaching is what
  opening a card always did.
- **Hidden panes are hidden, not disabled.** A pane that is not on top keeps its socket but gives up
  everything that reaches outside it: the tab title, the phone's scroll lock, the keyboard (`inert`,
  so a reconnect cannot steal it), the microphone, and the polls that only feed its own bar. Pausing
  a card, or deleting it anywhere, drops its pane rather than leaving a socket retrying at a session
  that no longer exists.

## State

No database. Under `VIBEHUB_DATA_DIR`:

| File | Holds |
|---|---|
| `board.json` | projects, cards, accounts, MCP servers |
| `settings.json` | git identity, autonomy, setup stamp |
| `users.json` | local accounts (scrypt hashes) |
| `secrets.enc` | AES-256-GCM vault: GitHub token, Claude tokens, MCP secrets, runner token |
| `master.key` | vault key, generated on first boot unless `VIBEHUB_SECRET_KEY` is set |
| `session.key` | cookie signing key |

Every write is atomic (tmp + rename) at mode 600, and mutations are serialized per document — the
status hooks are frequent and concurrent, and a lost update there would silently corrupt the board.

## Credentials

- The **GitHub token** is handed to `git clone/fetch` per command as an environment-scoped http
  header. It never lands in `/work/<repo>/.git/config`, which the agent can read — and the agent
  processes untrusted repository content with network egress.
- The **runner service token** is written host-side into the `/root` bind mount at mode 600, so it
  survives a container recreate, and the status hook reads it from disk at call time rather than
  having it baked into `settings.json`.
- **Claude account tokens** live in the vault and are planted per profile inside the runner.
