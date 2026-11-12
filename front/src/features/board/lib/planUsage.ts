import type { AccountUsage } from "@/api/types";
import { formatResetIn } from "@/features/board/lib/usage";
import { getLanguage, t } from "@/i18n";

/**
 * HOW MUCH OF THE PLAN IS ALREADY GONE, for whoever works on the card — the top meter and the chat
 * warning.
 *
 * Two sources, the same count: the periodic reading (`GET /cards/:id/usage`, 60s cache in the back)
 * and the CLI's LIVE warning (`rate_limit`, the "You've used 91% of your session limit" in the
 * terminal's footer). The live one is newer, so it wins in the window it covers; the reading gives
 * the windows the CLI has not spoken about yet. Nothing here touches React or the network.
 */

/** The live warning as the back delivers it: percentage 0..100 and epoch in ms. */
export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  window: string;
  utilization?: number;
  resetsAt?: number;
}

/**
 * Four tones, because there are four messages: calm, keep an eye on it, running out, gone (or nearly).
 * Yellow and orange are the two steps of "there is still some, but it is going" that the owner asked for.
 */
export type UsageTone = "ok" | "yellow" | "orange" | "red";

export const YELLOW_AT = 70;
export const ORANGE_AT = 85;
export const RED_AT = 95;

/** The tone of a percentage; `rejected` (limit blown) is red whatever the number. PURE. */
export function usageTone(utilization: number | null | undefined, rejected = false): UsageTone {
  if (rejected) return "red";
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return "ok";
  if (utilization >= RED_AT) return "red";
  if (utilization >= ORANGE_AT) return "orange";
  if (utilization >= YELLOW_AT) return "yellow";
  return "ok";
}

const TONE_RANK: Record<UsageTone, number> = { ok: 0, yellow: 1, orange: 2, red: 3 };

/** A measured window, already with what the screen writes. */
export interface PlanWindow {
  /** The CLI's key: `five_hour`, `seven_day`, `seven_day_opus`, … */
  key: string;
  label: string;
  /** 0..100 */
  utilization: number;
  /** Epoch ms at which it renews, or null when nobody said. */
  resetsAt: number | null;
}

/** The windows of the periodic reading, in reading order, with the CLI's key. */
const POLLED: readonly { key: string; field: "fiveHour" | "sevenDay" | "sevenDayOpus" }[] = [
  { key: "five_hour", field: "fiveHour" },
  { key: "seven_day", field: "sevenDay" },
  { key: "seven_day_opus", field: "sevenDayOpus" },
];

/** The name of a window, in the sentence "Sessão (5h)", "Semana", … Unknown = the key itself. PURE. */
export function windowLabel(key: string): string {
  switch (key) {
    case "five_hour":
      return t("plan.window.fiveHour");
    case "seven_day":
      return t("plan.window.sevenDay");
    case "seven_day_opus":
      return t("plan.window.sevenDayOpus");
    case "seven_day_sonnet":
      return t("plan.window.sevenDaySonnet");
    case "overage":
    case "seven_day_overage_included":
      return t("plan.window.overage");
    default:
      return key;
  }
}

/** The name of a window's LIMIT, inside a sentence ("limite da sessão"). PURE. */
function limitName(key: string): string {
  switch (key) {
    case "five_hour":
      return t("plan.limit.fiveHour");
    case "seven_day":
      return t("plan.limit.sevenDay");
    case "seven_day_opus":
      return t("plan.limit.sevenDayOpus");
    case "seven_day_sonnet":
      return t("plan.limit.sevenDaySonnet");
    default:
      return t("plan.limit.other", { name: windowLabel(key) });
  }
}

/** A live warning still holds: no date, or with the renewal in the future. PURE. */
function liveStillValid(info: RateLimitInfo, now: number): boolean {
  return info.resetsAt === undefined || info.resetsAt > now;
}

/**
 * The windows to draw: the ones from the periodic reading, with the live warning on top where it
 * has a number, plus the windows only the live one knows (the mid model, the overage). PURE.
 */
export function planWindows(
  usage: AccountUsage | undefined,
  live: Readonly<Record<string, RateLimitInfo>>,
  now: number,
): PlanWindow[] {
  const out: PlanWindow[] = [];
  const seen = new Set<string>();
  for (const { key, field } of POLLED) {
    const polled = usage?.available ? usage[field] : undefined;
    const info = live[key];
    const fresh = info && liveStillValid(info, now) && typeof info.utilization === "number" ? info : undefined;
    if (!polled && !fresh) continue;
    const polledReset = polled?.resetsAt ? Date.parse(polled.resetsAt) : NaN;
    out.push({
      key,
      label: windowLabel(key),
      utilization: fresh ? fresh.utilization! : polled!.utilization,
      resetsAt: fresh?.resetsAt ?? (Number.isFinite(polledReset) ? polledReset : null),
    });
    seen.add(key);
  }
  for (const info of Object.values(live)) {
    if (seen.has(info.window) || !liveStillValid(info, now) || typeof info.utilization !== "number") continue;
    out.push({ key: info.window, label: windowLabel(info.window), utilization: info.utilization, resetsAt: info.resetsAt ?? null });
  }
  return out;
}

/**
 * The WEEKLY window (all models) — the number the top meter shows: it is the one that says whether
 * the week will close out, and it is the one the owner follows the plan by. Null without a reading. PURE.
 */
export function weeklyWindow(windows: readonly PlanWindow[]): PlanWindow | null {
  return windows.find((w) => w.key === "seven_day") ?? null;
}

/**
 * The colour of a percentage on a CONTINUOUS scale, green → yellow → orange → red: the meter warms
 * up as the week fills, instead of jumping colour in steps. Green up to 50%; after that the hue
 * glides between anchors that match the warning's tones — yellow at 70%, orange at 85%, red from
 * 95% on. PURE.
 */
const HUE_STOPS: readonly (readonly [pct: number, hue: number])[] = [
  [50, 142],
  [70, 50],
  [85, 28],
  [95, 4],
  [100, 0],
];

export function usageHue(utilization: number): number {
  return interpolateHue(HUE_STOPS, utilization);
}

/**
 * The hue of a percentage (clamped to 0..100) between `[pct, hue]` anchors in ascending order: before
 * the first, its hue; between two, linear; after the last, the last one's hue. PURE.
 */
export function interpolateHue(stops: readonly (readonly [pct: number, hue: number])[], percent: number): number {
  const pct = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  if (pct <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [p1, h1] = stops[i]!;
    if (pct <= p1) {
      const [p0, h0] = stops[i - 1]!;
      return Math.round(h0 + ((pct - p0) / (p1 - p0)) * (h1 - h0));
    }
  }
  return stops[stops.length - 1]![1];
}

/** `hsl(…)` of the percentage, with optional alpha (0..1). PURE. */
export function usageColor(utilization: number, alpha = 1): string {
  return `hsl(${usageHue(utilization)} 80% 50% / ${alpha})`;
}

/** The fullest window. Null when there is none. PURE. */
export function peakWindow(windows: readonly PlanWindow[]): PlanWindow | null {
  let peak: PlanWindow | null = null;
  for (const w of windows) if (!peak || w.utilization > peak.utilization) peak = w;
  return peak;
}

/** The warning above the chat's input field. */
export interface PlanAlert {
  window: string;
  tone: Exclude<UsageTone, "ok">;
  /** The limit is blown: the next turn does not run until it renews. */
  rejected: boolean;
  utilization: number | null;
  resetsAt: number | null;
}

/**
 * The warning to show, or null when all is calm. A BLOWN limit (live) comes before
 * everything; otherwise, the window with the most severe tone (tie: the fullest). A CLI `allowed_warning` with no
 * number is still a warning — yellow, the lowest step. PURE.
 */
export function planAlert(
  windows: readonly PlanWindow[],
  live: Readonly<Record<string, RateLimitInfo>>,
  now: number,
): PlanAlert | null {
  for (const info of Object.values(live)) {
    if (info.status === "rejected" && liveStillValid(info, now)) {
      return { window: info.window, tone: "red", rejected: true, utilization: info.utilization ?? null, resetsAt: info.resetsAt ?? null };
    }
  }
  let best: PlanAlert | null = null;
  for (const w of windows) {
    const tone = usageTone(w.utilization);
    if (tone === "ok") continue;
    if (
      !best ||
      TONE_RANK[tone] > TONE_RANK[best.tone] ||
      (TONE_RANK[tone] === TONE_RANK[best.tone] && w.utilization > (best.utilization ?? 0))
    ) {
      best = { window: w.key, tone, rejected: false, utilization: w.utilization, resetsAt: w.resetsAt };
    }
  }
  if (best) return best;
  for (const info of Object.values(live)) {
    if (info.status === "allowed_warning" && liveStillValid(info, now)) {
      return { window: info.window, tone: "yellow", rejected: false, utilization: info.utilization ?? null, resetsAt: info.resetsAt ?? null };
    }
  }
  return null;
}

/**
 * When the window renews, in local time: "17:59" if it is today, "seg., 20/10 01:59" if not. PURE
 * (given the browser's timezone, which is what the person reads on their own clock).
 */
export function formatResetAt(at: number, now: number): string {
  const lang = getLanguage();
  const date = new Date(at);
  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(date);
  if (new Date(now).toDateString() === date.toDateString()) return time;
  const day = new Intl.DateTimeFormat(lang, { weekday: "short", day: "2-digit", month: "2-digit" }).format(date);
  return `${day} ${time}`;
}

const DAY_MS = 86_400_000;

/** A wait of a day or more: "1d 02h" — "26h 10m" forces you to do the math in your head. PURE. */
function formatDays(ms: number): string {
  const totalHours = Math.floor(ms / 3_600_000);
  return `${Math.floor(totalHours / 24)}d ${String(totalHours % 24).padStart(2, "0")}h`;
}

/** "renova em 1h 02m (17:59)" — or "renova em instantes" when the countdown is already over. Null without a date. PURE. */
export function resetPhrase(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const at = formatResetAt(resetsAt, now);
  const inTime = resetsAt - now >= DAY_MS ? formatDays(resetsAt - now) : formatResetIn(new Date(resetsAt).toISOString(), now);
  return inTime ? t("plan.resetsInAt", { time: inTime, at }) : t("plan.resetsSoon");
}

/** The sentence of the chat warning. PURE. */
export function alertSentence(alert: PlanAlert, now: number): string {
  const limit = limitName(alert.window);
  const reset = resetPhrase(alert.resetsAt, now);
  const head = alert.rejected
    ? t("plan.alert.rejected", { limit })
    : alert.utilization !== null
      ? t("plan.alert.used", { n: Math.round(alert.utilization), limit })
      : t("plan.alert.near", { limit });
  return reset ? `${head} — ${reset}` : head;
}
