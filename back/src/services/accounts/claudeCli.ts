import { shQuote } from "../../runtime/host.js";
import { SDK_DRIVER_DIR } from "../sdk/driver.js";

/**
 * WHICH `claude` A RUNNER SHELL RUNS, when nothing else in it needs the global CLI.
 *
 * The cards run on the SDK driver, which ships its OWN Claude binary under SDK_DRIVER_DIR — so a
 * runner whose global `npm i -g @anthropic-ai/claude-code` broke (it happened: an update interrupted
 * halfway left the package without its `/usr/local/bin/claude` link) keeps every card working and
 * nobody notices. The one place that still typed a bare `claude` was the account login terminal,
 * which then answered `claude: command not found` and nothing else.
 *
 * So the login resolves the binary: the global CLI when it is on PATH, else the SDK's (same Claude
 * Code, same `/login`, same `.credentials.json`), else a sentence that says what is missing and how
 * to fix it, instead of bash's.
 */

/** Glob of the SDK's per-platform Claude binary (linux-x64, linux-arm64, the musl builds…). */
export const SDK_CLAUDE_GLOB = `${SDK_DRIVER_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude`;

/** Shown when neither binary exists. Says the fix, not just the symptom. */
export const CLAUDE_MISSING_MESSAGE =
  "Claude Code is not installed in this runner — run `npm i -g @anthropic-ai/claude-code` in it (or re-run the runner setup).";

/**
 * Shell snippet that runs `claude <args>` with the first binary that exists. `args` is a FIXED
 * literal from our own code (e.g. "/login"), never user input. Returns non-zero when there is no
 * binary at all, after printing CLAUDE_MISSING_MESSAGE. `sdkGlob` exists for the tests. PURE.
 */
export function resolvedClaudeCommand(args: string, sdkGlob: string = SDK_CLAUDE_GLOB, runner: string = ""): string {
  const run = runner ? `${runner} ` : "";
  return (
    `VIBEHUB_CLAUDE="$(command -v claude || ls -1 ${sdkGlob} 2>/dev/null | head -1)"; ` +
    `if [ -n "$VIBEHUB_CLAUDE" ] && [ -x "$VIBEHUB_CLAUDE" ]; then ${run}"$VIBEHUB_CLAUDE" ${args}; ` +
    `else echo ${shQuote(CLAUDE_MISSING_MESSAGE)}; false; fi`
  );
}
