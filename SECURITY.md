# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/cesarvcanal/vibehub/security/advisories/new) on
this repository. Please do not open a public issue for something exploitable.

## What vibehub assumes

vibehub gives an AI agent a container with your repositories, your tokens and network egress. That
is the product, so the interesting question is not "can the agent do things" — it is "what can it
reach, and what can it read".

**What the agent can reach.** Whatever you mounted and configured: the repositories you connected,
the MCP servers you registered, the accounts whose tokens you planted. The runner is a container
with no host mounts beyond its own `/root` and `/work`.

**What the agent cannot read.** The vault and the master key: they stay in vibehub's process. What
a card needs to work is written into the runner, over stdin and at mode 600:

- **GitHub tokens**, one file per card at `/root/.vibehub/gh/<card>.token`. The card's git
  credential helper and the `gh` wrapper read it on every call, so a change of author reaches
  processes already running. No token is written into `/work/<repo>/.git/config`.
- **Claude account tokens**, per profile under `/root/.claude-profiles/<account>/`: the long-lived
  token in `.oauth-token`, or the `.credentials.json` that a `/login` in the card creates.
- The **runner service token** at `/root/.vibehub-token`, written from inside the container by the
  setup (`docker exec`) into `/root`, which is bind-mounted from the host so it survives a container
  recreate. The status hook reads it at call time, so it is never baked into `settings.json`.

Every card runs as `root` in the same runner container, so mode 600 separates nothing between
cards: **any card can read every one of these files** — the GitHub token of every other card, every
Claude account planted in the runner, and the runner service token. Treat everything the runner
holds as reachable by every agent on the install, including one that a repository's untrusted
content talks into reading it.

**Cards can reach each other.** vibehub registers itself as an MCP server inside every card, so an
agent can list the other cards, type an instruction into one, and read its answers. That is the
feature — one terminal coordinating the others — but it means the trust boundary is the *install*,
not the card: an agent that goes wrong, or a repository that talks it into something, can act
through any other terminal on the board. The credential behind it is the runner service token, and
anything holding that token has the same reach. If you need two workloads that must not touch each
other, run two installs.

**Autonomy is a choice.** By default the agent runs without permission prompts inside the runner
(`bypassPermissions` + `IS_SANDBOX=1`), because the container is the sandbox. The setup wizard asks,
and you can turn it off in Settings — the agent then prompts, and cards land in `waiting` until you
answer.

## Deployment expectations

- **Put it behind something.** vibehub has local accounts, signed session cookies and a sign-in
  throttle, but no general rate limiting, MFA or audit console. Expose it on a VPN, a private network, or behind an authenticating
  proxy — not on the open internet.
- **Serve it over TLS.** `VIBEHUB_INSECURE_COOKIES=1` exists for LAN and localhost installs; on
  anything public it means session cookies travel in the clear.
- **Behind a gateway (the usual way to get TLS), set `VIBEHUB_TRUST_PROXY`** to the gateway's
  address/CIDR (or `loopback`/`uniquelocal`, or a hop count). Without it vibehub trusts no
  `X-Forwarded-For` and sees every client as the gateway: the per-address sign-in ceiling stays off
  and the per-account limit is keyed by `ip|account` — the gateway's ip — so somebody else's wrong
  passwords can keep a browser that never signed in before out of that account for 15 minutes. A
  direct install (no gateway) sets `0`, which turns the per-address ceiling on. **Once a gateway is
  trusted it must be the only way in**: publish the port to it alone (`127.0.0.1:3010:3010` in
  `docker-compose.yml` with the gateway on the same host). A client reaching the port directly
  arrives from docker's bridge address — trusted by a hop count and by `uniquelocal` — and can forge
  `X-Forwarded-For` for a fresh sign-in count on every try. vibehub logs a warning at boot.
- **The Docker socket is root.** A `local` runner means vibehub can create containers on that host.
  If that is too much authority for the box, use `VIBEHUB_RUNNER_KIND=ssh` and point it at a machine
  you are willing to hand over.
- **Back up the data directory *and* the master key.** Without `master.key` (or the matching
  `VIBEHUB_SECRET_KEY`) an encrypted vault is unrecoverable.

## Invariants worth keeping in review

The rules every change is reviewed against (payloads over stdin, input validated at the boundary
and shell-quoted, the runner token compared in constant time with no session cookie accepted) live
in [`AGENTS.md`](AGENTS.md) §10.
