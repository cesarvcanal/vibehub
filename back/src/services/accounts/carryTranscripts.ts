import { shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { CLAUDE_PROFILES_DIR, DEFAULT_CLAUDE_DIR } from "./profiles.js";

/**
 * A card's CONVERSATION FOLLOWS THE CARD across an account switch.
 *
 * Claude Code keeps a session's transcript in the PROFILE: `<CLAUDE_CONFIG_DIR>/projects/<cwd>/
 * <session>.jsonl` (plus `<session>/` with subagents and tool results). Switching a card from one
 * account to another restarts Claude with the other profile, and that profile has never seen the
 * card's conversation: the native chat's `--resume <id>` died with "No conversation found with
 * session ID", and the terminal's `claude -c` silently opened on an empty conversation.
 *
 * So, right before Claude starts, whatever OTHER profiles hold for THIS card's cwd is copied into
 * the profile the session is about to use. Only the card's own `projects/<cwd>` directory travels —
 * never credentials, settings or other projects. `cp -u` keeps the NEWEST copy of each file, which
 * is what makes A → B → A work: the transcript B extended is newer than A's stale one and wins,
 * while a profile already up to date is left untouched (`-a` keeps the mtime, so the next start
 * copies nothing).
 *
 * The default roots are every profile in the runner; tests pass their own.
 */
export const PROFILE_ROOTS: readonly string[] = [DEFAULT_CLAUDE_DIR, `${CLAUDE_PROFILES_DIR}/*`];

/**
 * ONE shell command that carries the card's transcripts into `profileDir`. `cwd` is a SHELL
 * EXPRESSION (the tmux session passes `"$PWD"`, the driver its quoted worktree); the directory name
 * follows `claudeProjectsDirName` — every non-alphanumeric character becomes `-`. Each root is a
 * validated path, optionally ending in `/*` (expanded by the shell).
 *
 * Never fatal: a copy that fails must not keep a card from opening — at worst it opens without the
 * old conversation, as before. Runs in a subshell, so its variables do not leak into the session.
 * PURE.
 */
export function carryTranscriptsCommand(profileDir: string, cwd: string, roots: readonly string[] = PROFILE_ROOTS): string {
  assertSafeRemotePath(profileDir);
  const globs = roots
    .map((root) => {
      const glob = root.endsWith("/*");
      const base = glob ? root.slice(0, -2) : root;
      assertSafeRemotePath(base);
      return glob ? `${shQuote(base)}/*` : shQuote(base);
    })
    .join(" ");
  const target = shQuote(profileDir);
  return (
    `( D="projects/$(printf %s ${cwd} | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"; ` +
    `for P in ${globs}; do ` +
    `if [ "$P" != ${target} ] && [ -d "$P/$D" ]; then mkdir -p ${target}/"$D" && cp -a -u "$P/$D/." ${target}/"$D"/; fi; ` +
    `done ) >/dev/null 2>&1 || true`
  );
}
