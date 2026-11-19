/**
 * Where every card session compacts its conversation on its own: Claude Code's
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (docs: code.claude.com/docs/en/env-vars; checked on CLI 2.1.328 —
 * the threshold is `min(window × pct/100, window − 13k)` and the turn goes on after the compaction).
 */
export const AUTO_COMPACT_PERCENT = 60;

/** `export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<n>; ` — a fixed number, nothing to quote. PURE. */
export function autoCompactExport(): string {
  return `export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${AUTO_COMPACT_PERCENT}; `;
}
