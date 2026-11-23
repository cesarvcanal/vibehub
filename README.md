<h1 align="center">vibehub</h1>

<p align="center"><strong>A kanban board where every card is a live Claude Code terminal — running on your server, not your laptop.</strong></p>

<p align="center">
  <a href="https://github.com/cesarvcanal/vibehub/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cesarvcanal/vibehub" alt="License" /></a>
  <a href="https://github.com/cesarvcanal/vibehub/actions"><img src="https://img.shields.io/github/actions/workflow/status/cesarvcanal/vibehub/ci.yml?branch=main" alt="CI" /></a>
</p>

---

## What it is

You run agents in terminals. Terminals die with the laptop, live in one tmux you cannot see from
your phone, and give you no idea which agent is working and which one has been waiting for you for
forty minutes.

vibehub is a small web app that fixes that. Point it at a machine with Docker, open it in a browser,
and you get:

- **A board.** Projects on the left, cards in columns. Every card is a real Claude Code session in
  its own git worktree.
- **Columns that move themselves.** Claude Code hooks report back on every prompt, stop, and
  permission request, so a card sits in **Working** while the agent runs and slides to **Waiting**
  the moment it needs you. `Backlog` and `Paused` never move on their own; a card in `Done` goes
  back to **Working** only when a new turn starts in it.
- **A native chat per card.** A card opens on its **Chat** tab, which by default is the native
  chat: the agent runs through the Claude Agent SDK (a driver process inside the runner) and its
  tools, questions and permission requests arrive as structured messages. The owner can switch it
  off in the settings, and the Chat tab of every card falls back to the classic chat read from the
  session transcript.
- **A terminal that is actually a terminal.** The **Terminal** tab is xterm over a websocket into
  tmux: colours, copy on select, paste, image paste, links. Close the tab, open it on another
  machine, the session is still there.
- **The conversations you were just in, one click away.** On the all-projects view, the top of the
  sidebar lists every card you have opened that is not in `Done`, across every project, newest
  first: ten at a time, with "show more" for the next ten. Opening a project, or a card in it,
  swaps that list for the project switcher.
- **Terminals that go cold on their own.** A card nobody has touched for a few hours (three, by
  default) has its session closed and turns grey where it stands — same column, same place, same
  conversation when you open it again. What you are working on now stops looking like what you
  walked away from yesterday.
- **The people you work with.** Create an account for a teammate and hand them one card — or a
  whole project — from its menu. They get that work and nothing else: no other card, no accounts, no
  settings. `Can work` puts them at the same terminal as you; `can view` lets them read it without
  touching the agent.
- **Several Claude accounts, side by side.** Each account is an isolated config profile; pick one
  per project or per card.
- **Your MCP servers, everywhere.** Register them once; every profile gets them injected.
- **A live browser per card**, when the agent needs to look at what it built.
- **Terminals that can coordinate each other.** vibehub registers itself as an MCP server inside every
  card, so an agent can list the other cards, delegate a task to one, and read back what it answered.
  They are real parallel terminals — separate processes, separate context, separate branches — not
  sub-agents sharing one context window.

It runs on a VPS, a homelab box, or your laptop. The state is a directory of JSON files and one
encrypted vault — no database to operate.

## Install

One line, on a laptop or a fresh VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/cesarvcanal/vibehub/main/scripts/install.sh | bash
```

Or from source:

```bash
git clone https://github.com/cesarvcanal/vibehub.git
cd vibehub
docker compose up -d
```

Open `http://localhost:3010` and follow the wizard: create the owner account, choose where the
runner lives, connect GitHub, sign in to Claude. It provisions the runner container for you.

Running it on a server? Put it behind your own TLS. Running it outside docker-compose (your own
orchestration, a remote Docker host)? Set `VIBEHUB_PUBLIC_URL` to an address the runner can route
to — the status hooks and the built-in MCP post back to it. See [`.env.example`](.env.example)
for every knob.

### Requirements

- Docker on the machine that will host the runner (the same box, or a remote host over SSH).
- A Claude Code account. The agent runs inside the runner container — nothing is installed on your
  workstation.

## How it works

```
browser ── https ──► vibehub (API + UI)
                        │  docker exec / ssh
                        ▼
                 runner container
                   ├── /work   clones + one git worktree per card
                   ├── tmux    one session per card, Claude Code inside (Terminal tab)
                   └── SDK driver   one per card, the native chat (Chat tab)
                        │
                        └── status hooks ──► POST /api/runner/status
```

vibehub never runs an agent in its own process. It provisions one container, opens a tmux session
per card inside it, and bridges that session to your browser; the native chat's SDK driver runs in
the same container, started through `docker exec`. If vibehub restarts, every tmux session is still
running and reconnects. The SDK drivers do not survive it: on boot, vibehub writes a line in the
chat of every card whose turn was interrupted and, with automatic resume on (the default), resumes
that turn once.

**On credentials:** GitHub tokens live in an encrypted local vault. `git clone` and `git fetch` get
the token per command, as an environment-scoped http header; it is never written into
`.git/config`. The agent's own `git` and `gh` act as the person who gave the card its latest order
(or through the project's GitHub connection): that token is written to a per-card file inside the
runner (mode 600), read on every call by a credential helper scoped to `github.com` and by a `gh`
wrapper. The agent runs as the same user, so it can read that file: a card's token is a token you
hand to its agent.

## Configuration

Everything is an environment variable with a working default. The ones that matter:

| Variable | Default | What it does |
|---|---|---|
| `VIBEHUB_PUBLIC_URL` | `http://127.0.0.1:3010` | Where the runner posts card status. Must be reachable **from the runner**. |
| `VIBEHUB_RUNNER_KIND` | `local` | `local` (Docker socket) or `ssh` (remote Docker host). |
| `VIBEHUB_RUNNER_BASE_DIR` | `/opt/vibehub/runner` | Host path for the runner's persistent `/root` and `/work` (macOS: use a path under `$HOME`). |
| `VIBEHUB_RUNNER_NETWORK` | `vibehub` (compose) | Docker network the runner joins, so `http://vibehub:3010` resolves from inside it. |
| `VIBEHUB_DATA_DIR` | `data` (`/data` in the image) | Board, settings, users, encrypted vault. **Back this up.** |
| `VIBEHUB_SECRET_KEY` | generated | Vault master key. Lose it and the stored tokens are gone. |
| `VIBEHUB_INSECURE_COOKIES` | `0` | Set to `1` when serving over plain http. |
| `VIBEHUB_TRUST_PROXY` | unset | Who the sign-in client is. Behind a gateway, name it (its address/CIDR, `loopback`, `uniquelocal`, or a hop count) so `X-Forwarded-For` is honoured — otherwise every request shares the gateway's address and ten wrong passwords from anyone lock that account out for 15 minutes in every browser that has not signed in as it before (a browser that has keeps its own count). `docker-compose.yml` passes it through from `.env`. `0` = no gateway (the peer is the client). Any other value requires the gateway to be the only way in — publish the port as `127.0.0.1:3010:3010` — or a client reaching it directly forges `X-Forwarded-For` past the throttle (warned at boot). Set either way, it also enables the per-address ceiling on failed sign-ins (30/min across usernames); unset, that ceiling stays off, because behind an undeclared gateway it would let anyone switch sign-in off for everybody. |

## Development

```bash
npm run install:all
npm --prefix back run dev     # API on :3010
npm --prefix front run dev    # UI on :5183, proxying /api
npm test                      # back + front
```

The API contract lives in [`docs/API.md`](docs/API.md).

## Status

Early. It runs the author's daily work, which is a stronger claim than a version number, but the
API will move. Issues and PRs welcome.

## License

MIT
