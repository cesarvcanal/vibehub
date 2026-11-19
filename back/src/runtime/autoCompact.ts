// Claude Code's CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (code.claude.com/docs/en/env-vars; CLI 2.1.328: threshold = min(window × pct/100, window − 13k)).
const AUTO_COMPACT_PERCENT = 60;

export function autoCompactExport(): string {
  return `export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${AUTO_COMPACT_PERCENT}; `;
}

export const AFTER_COMPACT_REMINDER =
  "The conversation was just compacted. Before going on, re-read the CLAUDE.md and the AGENTS.md of the repository " +
  "you are working in (the worktree root and its .claude/ folder) to recover the project rules, then resume the task " +
  "exactly where it stopped, without asking for confirmation.";
