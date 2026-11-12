/**
 * THE PLAN LIMIT WARNING, live — the "You've used 91% of your session limit" that Claude Code
 * paints in the terminal's footer. The CLI emits a `rate_limit_event` whenever the reading of a window
 * changes (5h session, week, the strong model's week), and the driver passes it on as `rate_limit`.
 *
 * Normalised HERE, on the side that talks to the browser: in the CLI's event `utilization` is a FRACTION (0..1,
 * it multiplies by 100 itself when writing) and `resetsAt` is epoch in SECONDS (it comes from the
 * API's header). The screen always gets a 0..100 percentage and epoch in ms — the same unit as `usage.ts`.
 */

const STATUSES = ["allowed", "allowed_warning", "rejected"] as const;

export type RateLimitStatus = (typeof STATUSES)[number];

export interface RateLimitInfo {
  status: RateLimitStatus;
  /** The window: `five_hour`, `seven_day`, `seven_day_opus`, … — free text, the screen translates the ones it knows. */
  window: string;
  /** 0..100, when the CLI said so. */
  utilization?: number;
  /** Epoch in ms at which the window renews, when the CLI said so. */
  resetsAt?: number;
}

export interface RateLimitEvent extends RateLimitInfo { type: "rate_limit" }

/** Fraction (0..1) or percentage (>1) → 0..100. PURE. */
function toPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const pct = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, pct));
}

/** Epoch in seconds or ms → ms. PURE. */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/**
 * What arrived from the driver (or the CLI's raw `rate_limit_info`) as `RateLimitInfo`, or null when
 * nothing can be said (unknown status, no window). PURE.
 */
export function normalizeRateLimit(raw: unknown): RateLimitInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const status = o.status;
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return null;
  const windowRaw = typeof o.window === "string" ? o.window : o.rateLimitType;
  const window = typeof windowRaw === "string" && windowRaw.trim() ? windowRaw.trim().slice(0, 64) : "";
  if (!window) return null;
  const utilization = toPercent(o.utilization);
  const resetsAt = toEpochMs(o.resetsAt);
  return {
    status: status as RateLimitStatus,
    window,
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}
