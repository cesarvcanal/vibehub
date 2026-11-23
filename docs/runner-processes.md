# Runner process hygiene

Context (design rationale): on a real installation, the `vibehub-runner` once piled up ~800
processes — ~180 orphaned `claude` processes (ppid 1, running for days) and hundreds of leaked
transcript watchers — and the host load (8 vCPUs) reached 55, leaving vibehub unusable. The
defences below exist so that this class of leak never comes back.

## The defences (in this repo)

1. **Transcript watcher with guaranteed death** (`back/src/services/chat/chat.ts`,
   `buildFollowCommand`): the follow loop runs under `docker exec -i` and uses `read -t 2` as its
   sleep — when stdin (the connection to the back end) closes, `read` returns EOF and the loop exits
   on its own, killing the `tail` through the trap. This is how it used to leak: killing the local
   `docker exec` client does NOT kill the process inside the container, and a heartbeat on stdout
   never fails because the daemon keeps consuming it. The loop also carries the
   `vibehub-transcript-follow` marker on its command line, so the reaper can recognise a leaked one.

2. **Process-tree kill** (`back/src/services/board/workspace.ts`,
   `buildKillSessionScript` / `killCardSession`): every path that ends a card's terminal (pause,
   hibernate, restart, restart-all, delete, model/account switch) kills the whole tree under the
   panes (SIGTERM → kill-session → SIGKILL on the survivors), not just the tmux session.
   `tmux kill-session` alone sends SIGHUP, which `claude` survives — that is how the orphans were
   born.

3. **Periodic reaper** (`back/src/services/reaper/reaper.ts`): every 10 minutes the back end lists
   the runner's processes and kills orphans (ppid 1) older than 1h that are `claude` or a
   transcript watcher. Since 2026-10-20 it also collects test/typecheck runs (vitest, jest, tsc
   outside watch mode, `npm test`) older than 2h, regardless of the parent (a process started by
   `docker exec` has ppid 0 whether alive or abandoned), and orphaned Chromium (ppid 0 or 1) older
   than 6h outside `/work/.browser/` (the cards' browsers never qualify). The native chat's SDK
   driver (command line containing `.vibehub-sdk/sdk-driver.mjs`) and PID 1 are never collected.
   It logs what it killed; a runner that is down only produces a warning. The latest count is
   exposed on `GET /api/runner` (field `processes`) — a count rising between sweeps signals a new
   leak.

4. **Deadline inside the container** (`back/src/runtime/host.ts`, `containerScriptCommand`):
   `runProcess`'s timeout kills only the local wrapper (`bash -s`/`ssh` and the `docker exec`
   client) — for the same reason as item 1, the work inside the container kept running. On card
   open this was serious: a clone that overran its 10 minutes released the provisioning lock and
   the next open ran on top of the still-running clone. The open script now enters the container as
   `docker exec -i <runner> timeout -s KILL <s> bash -s`, with `<s>` = the Node deadline minus
   `CONTAINER_DEADLINE_MARGIN_MS` (15s: ssh handshake + exec start). coreutils' `timeout` (always
   present in the runner's Debian image) puts bash in a process group of its own and kills the
   whole group at the deadline — bash and every `git` under it — before Node gives up. The tmux
   server, which detaches into a session of its own, is left out on purpose.

5. **Gate with a deadline, a queue and no duplicates** (`back/src/services/maestro/gate.ts`): the
   gate of `vibehub_deliver` (and of `vibehub_gate`) runs, in the card's worktree, the commands in
   `.vibehub/gate.json` when that file exists — `{ "checks": ["<command>", …] }`, up to 20, in
   order, stopping at the first failure, with `VIBEHUB_BASE_REF=origin/<card base>` in the
   environment so a repo can test only what the card changed. Without the file (or with `checks`
   empty or invalid), it runs whichever defaults exist in the worktree:
   `node_modules/.bin/tsc --noEmit` (with a `tsconfig.json` and a local tsc) and `npm test` (with a
   `test` script in `package.json`); with neither, the gate does not run and does not block. The
   gate used to run `npm test` through `docker exec` without `timeout` — when Node gave up
   (10 min), the suite kept running as an orphan in the runner. The maestro retried and stacked
   another suite on top; with 4-5 cards delivering at once (each vitest spawns workers = number of
   CPUs) the load went past 18 on 8 cores, a ~2 min suite (on CI) took over 20 and no gate ever
   finished (incident of 2026-10-20: 24 min for a 2-line fix). Now `timeout -s KILL` inside the
   container kills the whole group at the deadline and the result comes back as `timedOut`; a
   second call for the same card while its gate is running joins the same run; at most
   `GATE_MAX_CONCURRENT` (2) gates run together, the rest wait in a queue. Each run logs
   `waitedMs` (queue) and `durationMs` (suite) under `maestro.gate` — "why did it take so long" is
   answered in the back end's log.

## Zombies: the runner is born with `--init`

The runner's command is `sleep infinity`, which never calls `wait()`: without a real init as
PID 1, every orphan that dies becomes a zombie forever (~176 observed in the incident). A zombie
uses no CPU or memory, only a pid slot, and disappears when the container restarts.

That is why `buildRunScript` (`back/src/runtime/runner.ts`) creates the container with
**`--init`**: PID 1 becomes `docker-init` (tini), which reaps its children. It applies only to a
**new** container — an existing runner is only started (`docker start`), never recreated, because
recreating it kills every live tmux session. Installations from before this change keep
`sleep infinity` as PID 1 until the operator recreates the container (remove `vibehub-runner` and
provision again, or `init: true` in compose), in a scheduled window and not alongside an ordinary
deploy.
