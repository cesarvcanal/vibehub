import { config } from "../../config/env.js";
import { hostExecutor, shQuote } from "../../runtime/host.js";
import { hasLiveSession, type Card } from "./registry.js";

/**
 * Whether Claude is alive in a card's terminal — shared by the OUTBOX (deliver now or queue) and the
 * SESSION view (tell the person "Claude parou" instead of a silent bare shell). It lives on its own
 * because both of those consult it and neither owns it.
 */

/** What the card's pane is running. `none` = no session (never opened, paused, runner restarted). */
export type AgentState = "running" | "shell" | "none";

/**
 * Commands that mean "the agent is NOT here". Everything else is taken to be Claude — it ships both
 * as a native binary (`claude`) and as a node script (`node`), and a whitelist of those two would
 * turn every future packaging change into silently undelivered messages. A shell is the thing we
 * can name with certainty, so that is the thing that is named.
 */
const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "dash", "ash", "ksh", "fish", "login", "tmux", "tmux: server",
]);

/**
 * Read-only probe of a card's agent. It reports the command of every process in the process TREE of
 * the session's panes, not just the one in the foreground. This matters: Claude spends much of its
 * life with a shell in the FOREGROUND — every Bash tool it runs makes `pane_current_command` read
 * `bash` — so a foreground-only probe reads a busy, healthy agent as "gone" and wrongly queues
 * messages that should have gone straight through (the bug that made the composer feel broken).
 * Walking the tree finds the `claude` process living under that shell, so the agent is seen whether
 * it is idle at its prompt or mid-tool. `|| true` on purpose: a missing session, a stopped tmux
 * server and a downed container all mean the same thing here — the agent is not reachable — and
 * none of them is an error worth a stack trace. PURE.
 */
export function buildAgentProbeScript(containerName: string, tmuxSession: string): string {
  // Runs inside the runner. The session name is passed as an ARGUMENT ($1), never interpolated into
  // the script body, so a hostile name cannot break out. For each pane's root pid we print the
  // command of every process descended from it (ps + awk, both present in the runner image); the
  // awk closes the parent→child relation so a `claude` at any depth is found. classifyAgentState
  // reads the lines.
  const inner =
    `sess="$1"; ` +
    `roots="$(tmux list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null | tr '\\n' ' ')"; ` +
    `[ -z "$roots" ] && exit 0; ` +
    `ps -eo pid=,ppid=,comm= 2>/dev/null | awk -v roots="$roots" '` +
    `BEGIN{n=split(roots,a," ");for(i=1;i<=n;i++)if(a[i]!="")w[a[i]]=1}` +
    `{P[NR]=$1;Q[NR]=$2;c=$3;for(j=4;j<=NF;j++)c=c" "$j;C[NR]=c}` +
    `END{ch=1;while(ch){ch=0;for(i=1;i<=NR;i++)if(!w[P[i]]&&w[Q[i]]){w[P[i]]=1;ch=1}}` +
    `for(i=1;i<=NR;i++)if(w[P[i]])print C[i]}` +
    `'`;
  return (
    `docker exec ${shQuote(containerName)} sh -c ${shQuote(inner)} _ ${shQuote(tmuxSession)} ` +
    `2>/dev/null || true`
  );
}

/** What the probe's output means. Empty = no session; any non-shell process in the tree = the agent
 * is up (a tree that is nothing but shells is Claude having exited to its prompt). PURE. */
export function classifyAgentState(stdout: string): AgentState {
  const commands = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (commands.length === 0) return "none";
  return commands.some((c) => !SHELL_COMMANDS.has(c)) ? "running" : "shell";
}

/**
 * The state of a card's agent right now. A card that was never opened (or is paused) is answered
 * from the board without touching the host — there is nothing to probe, and the runner is the
 * expensive part of this call.
 */
export async function cardAgentState(card: Pick<Card, "openedAt" | "pausedAt" | "tmuxSession">): Promise<AgentState> {
  if (!hasLiveSession(card)) return "none";
  try {
    const { stdout } = await hostExecutor().runScript(
      buildAgentProbeScript(config.runner.container, card.tmuxSession),
      { timeoutMs: 15_000 },
    );
    return classifyAgentState(stdout);
  } catch {
    // The host is unreachable: that is emphatically not "the agent is ready".
    return "none";
  }
}
