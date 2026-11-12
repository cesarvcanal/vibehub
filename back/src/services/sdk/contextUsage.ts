/**
 * HOW MUCH OF THE CONTEXT WINDOW THE SESSION ALREADY TAKES — the number from Claude Code's `/context`.
 * The driver asks the session at the end of each turn (`getContextUsage`) and passes it on as
 * `context_usage`.
 *
 * Normalised HERE, on the side that talks to the browser: the screen always gets whole tokens and a
 * 0..100 percentage computed over the model's RAW window (200k, 1M), the same denominator as the
 * "84k/200k" it writes next to it.
 */

export interface ContextUsageInfo {
  /** Tokens the conversation takes right now. */
  usedTokens: number;
  /** The model's window size, raw. */
  maxTokens: number;
  /** 0..100. */
  percent: number;
  model?: string;
}

export interface ContextUsageEvent extends ContextUsageInfo { type: "context_usage" }

function tokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

/** What arrived from the driver as `ContextUsageInfo`, or null when there is no window to measure. PURE. */
export function normalizeContextUsage(raw: unknown): ContextUsageInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const used = tokens(o.usedTokens);
  const max = tokens(o.maxTokens);
  if (used === undefined || max === undefined || max === 0) return null;
  const percent = Math.min(100, (used / max) * 100);
  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim().slice(0, 128) : undefined;
  return { usedTokens: used, maxTokens: max, percent, ...(model ? { model } : {}) };
}
