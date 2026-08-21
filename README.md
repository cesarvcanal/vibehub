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
  the moment it needs you. `Backlog`, `Paused` and `Done` never move on their own.
- **A terminal that is actually a terminal.** xterm over a websocket into tmux: colours, copy on
  select, paste, image paste, links. Close the tab, open it on another machine, the session is
  still there.
- **Several Claude accounts, side by side.** Each account is an isolated config profile; pick one
  per project or per card.
- **Your MCP servers, everywhere.** Register them once; every profile gets them injected.
- **A live browser per card**, when the agent needs to look at what it built.

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

Running it on a server? Set `VIBEHUB_PUBLIC_URL` to an address the runner can reach and put it
behind your own TLS. See [`.env.example`](.env.example) for every knob.

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
                   └── tmux    one session per card, Claude Code inside
                        │
                        └── status hooks ──► POST /api/runner/status
```

vibehub never runs an agent in its own process. It provisions one container, opens a tmux session
per card inside it, and bridges that session to your browser. If vibehub restarts, every session is
still running and reconnects.

**On credentials:** the GitHub token lives in an encrypted local vault and is handed to
`git clone/fetch` per command, as an environment-scoped http header. It is never written into
`.git/config` inside the runner, where the agent — which reads untrusted repository content and has
network access — could read it back.

## Configuration

Everything is an environment variable with a working default. The ones that matter:

| Variable | Default | What it does |
|---|---|---|
| `VIBEHUB_PUBLIC_URL` | `http://127.0.0.1:3010` | Where the runner posts card status. Must be reachable **from the runner**. |
| `VIBEHUB_RUNNER_KIND` | `local` | `local` (Docker socket) or `ssh` (remote Docker host). |
| `VIBEHUB_RUNNER_BASE_DIR` | `/opt/vibehub/runner` | Host path for the runner's persistent `/root` and `/work`. |
| `VIBEHUB_DATA_DIR` | `data` | Board, settings, users, encrypted vault. **Back this up.** |
| `VIBEHUB_SECRET_KEY` | generated | Vault master key. Lose it and the stored tokens are gone. |
| `VIBEHUB_INSECURE_COOKIES` | `0` | Set to `1` when serving over plain http. |

## Development

```bash
npm run install:all
npm --prefix back run dev     # API on :3010
npm --prefix front run dev    # UI on :5173, proxying /api
npm test                      # back + front
```

The API contract lives in [`docs/API.md`](docs/API.md).

## Status

Early. It runs the author's daily work, which is a stronger claim than a version number, but the
API will move. Issues and PRs welcome.

## License

MIT
