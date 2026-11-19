// Claude Code's CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (code.claude.com/docs/en/env-vars; CLI 2.1.328: threshold = min(usable window × pct/100, usable window − 13k), the usable window being the raw one minus the output reserve).
const AUTO_COMPACT_PERCENT = 60;

export function autoCompactExport(): string {
  return `export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${AUTO_COMPACT_PERCENT}; `;
}

export const AFTER_COMPACT_REMINDER =
  "The conversation was just compacted and Claude Code already reloaded the project-root CLAUDE.md. If the repository " +
  "you are working in has an AGENTS.md, or a CLAUDE.md in a subfolder you were working in, that is not in your context " +
  "now, read it to recover the project rules. Then resume the task exactly where it stopped, without asking for confirmation.";
