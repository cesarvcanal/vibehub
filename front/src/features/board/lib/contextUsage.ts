/**
 * HOW MUCH OF THE CONTEXT WINDOW THE CONVERSATION ALREADY TAKES — the meter next to "está digitando"
 * in the chat.
 *
 * The scale is about QUALITY, not capacity: the model does not "lock up" near the end of the window,
 * it gets worse well before that — forgets instructions from the start, repeats mistakes, mixes up
 * files. That is why the bands are low compared with the limit (the CLI's auto-compact only kicks in
 * near ~80%):
 *
 *   0–30%   smart         the conversation fits comfortably; the model holds everything that was said
 *   30–60%  worrying      already losing detail from the start; good moment to close the step or /compact
 *   60%+    dangerous     worse answers and more mistakes; /compact or a new card
 *
 * The colour does NOT jump at the boundary: the hue glides between anchors (green → yellow at 30% →
 * orange → red at 60%), so the meter warms up as the conversation grows.
 */

import { interpolateHue } from "@/features/board/lib/planUsage";

/** The conversation stops being comfortable here. */
export const CONTEXT_WARN_AT = 30;
/** From here up the quality really drops. */
export const CONTEXT_DANGER_AT = 60;

export type ContextZone = "smart" | "warn" | "danger";

/** The last reading the back sent (see back/src/services/sdk/contextUsage.ts). */
export interface ContextUsageInfo {
  usedTokens: number;
  maxTokens: number;
  /** 0..100 */
  percent: number;
  model?: string;
}

/** The band of a percentage. PURE. */
export function contextZone(percent: number): ContextZone {
  const pct = Number.isFinite(percent) ? percent : 0;
  if (pct >= CONTEXT_DANGER_AT) return "danger";
  if (pct >= CONTEXT_WARN_AT) return "warn";
  return "smart";
}

/**
 * Hue anchors. Solid green up to 15%; from there it glides to reach YELLOW at 30% (the boundary of
 * worrying), orange in the middle of the band and RED at 60%, where dangerous begins.
 */
const HUE_STOPS: readonly (readonly [pct: number, hue: number])[] = [
  [15, 142],
  [30, 48],
  [45, 30],
  [60, 6],
  [100, 0],
];

/** The hue (hsl) of a percentage, continuous. PURE. */
export function contextHue(percent: number): number {
  return interpolateHue(HUE_STOPS, percent);
}

/** `hsl(…)` of the percentage, with optional alpha (0..1). PURE. */
export function contextColor(percent: number, alpha = 1): string {
  return `hsl(${contextHue(percent)} 80% 48% / ${alpha})`;
}

/** The ruler's whole gradient, from cold to hot — the same path the meter's colour travels. */
export function contextGradient(): string {
  const stops = [0, 15, 30, 45, 60, 100].map((p) => `${contextColor(p)} ${p}%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/**
 * What arrived on the socket as a reading, or null when the shape does not match. The percentage is the back's
 * (back/src/services/sdk/contextUsage.ts, where the rule lives); here only the shape is checked. PURE.
 */
export function parseContextUsage(raw: { usedTokens?: unknown; maxTokens?: unknown; percent?: unknown; model?: unknown }): ContextUsageInfo | null {
  const { usedTokens, maxTokens, percent, model } = raw;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!finite(usedTokens) || usedTokens < 0) return null;
  if (!finite(maxTokens) || maxTokens <= 0) return null;
  if (!finite(percent) || percent < 0 || percent > 100) return null;
  return { usedTokens, maxTokens, percent, ...(typeof model === "string" && model ? { model } : {}) };
}
