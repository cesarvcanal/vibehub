import type { AccountUsage } from "@/features/board/api";
import { formatResetIn } from "@/features/board/lib/usage";
import { getLanguage, t } from "@/i18n";

/**
 * QUANTO DO PLANO JÁ FOI, para quem trabalha no card — o medidor do topo e o aviso do chat.
 *
 * Duas fontes, a mesma conta: a leitura periódica (`GET /cards/:id/usage`, cache de 60s no back) e o
 * aviso AO VIVO do CLI (`rate_limit`, o "You've used 91% of your session limit" do rodapé do
 * terminal). O ao vivo é mais novo, então vence na janela que ele cobre; a leitura dá as janelas
 * sobre as quais o CLI ainda não falou. Nada aqui toca React nem rede.
 */

/** O aviso ao vivo como o back o entrega: percentual 0..100 e epoch em ms. */
export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  window: string;
  utilization?: number;
  resetsAt?: number;
}

/**
 * Quatro tons, porque são quatro recados: tranquilo, fique de olho, está acabando, acabou (ou quase).
 * Amarelo e laranja são os dois degraus do "ainda tem, mas está indo" que o dono pediu.
 */
export type UsageTone = "ok" | "yellow" | "orange" | "red";

export const YELLOW_AT = 70;
export const ORANGE_AT = 85;
export const RED_AT = 95;

/** O tom de um percentual; `rejected` (limite estourado) é vermelho seja qual for o número. PURE. */
export function usageTone(utilization: number | null | undefined, rejected = false): UsageTone {
  if (rejected) return "red";
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return "ok";
  if (utilization >= RED_AT) return "red";
  if (utilization >= ORANGE_AT) return "orange";
  if (utilization >= YELLOW_AT) return "yellow";
  return "ok";
}

const TONE_RANK: Record<UsageTone, number> = { ok: 0, yellow: 1, orange: 2, red: 3 };

/** Uma janela medida, já com o que a tela escreve. */
export interface PlanWindow {
  /** A chave do CLI: `five_hour`, `seven_day`, `seven_day_opus`, … */
  key: string;
  label: string;
  /** 0..100 */
  utilization: number;
  /** Epoch ms em que renova, ou null quando ninguém disse. */
  resetsAt: number | null;
}

/** As janelas da leitura periódica, na ordem de leitura, com a chave do CLI. */
const POLLED: readonly { key: string; field: "fiveHour" | "sevenDay" | "sevenDayOpus" }[] = [
  { key: "five_hour", field: "fiveHour" },
  { key: "seven_day", field: "sevenDay" },
  { key: "seven_day_opus", field: "sevenDayOpus" },
];

/** O nome de uma janela, na frase "Sessão (5h)", "Semana", … Desconhecida = a própria chave. PURE. */
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

/** O nome do LIMITE de uma janela, dentro de uma frase ("limite da sessão"). PURE. */
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

/** Um aviso ao vivo ainda vale: sem data, ou com a renovação no futuro. PURE. */
function liveStillValid(info: RateLimitInfo, now: number): boolean {
  return info.resetsAt === undefined || info.resetsAt > now;
}

/**
 * As janelas a desenhar: as da leitura periódica, com o aviso ao vivo por cima onde ele tiver
 * número, mais as janelas que só o ao vivo conhece (o modelo médio, o excedente). PURE.
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

/** A janela mais cheia — o número que o medidor do topo mostra. Null sem nenhuma. PURE. */
export function peakWindow(windows: readonly PlanWindow[]): PlanWindow | null {
  let peak: PlanWindow | null = null;
  for (const w of windows) if (!peak || w.utilization > peak.utilization) peak = w;
  return peak;
}

/** O aviso acima do campo do chat. */
export interface PlanAlert {
  window: string;
  tone: Exclude<UsageTone, "ok">;
  /** O limite estourou: o próximo turno não roda até renovar. */
  rejected: boolean;
  utilization: number | null;
  resetsAt: number | null;
}

/**
 * O aviso a mostrar, ou null quando está tudo tranquilo. Um limite ESTOURADO (ao vivo) vem antes de
 * tudo; senão, a janela de tom mais grave (empate: a mais cheia). Um `allowed_warning` do CLI sem
 * número ainda é aviso — amarelo, o degrau mais baixo. PURE.
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
 * Quando a janela renova, em hora local: "17:59" se for hoje, "seg., 20/10 01:59" se não. PURE
 * (dado o fuso do navegador, que é o que a pessoa lê no relógio dela).
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

/** Uma espera de um dia ou mais: "1d 02h" — "26h 10m" obriga a fazer a conta de cabeça. PURE. */
function formatDays(ms: number): string {
  const totalHours = Math.floor(ms / 3_600_000);
  return `${Math.floor(totalHours / 24)}d ${String(totalHours % 24).padStart(2, "0")}h`;
}

/** "renova em 1h 02m (17:59)" — ou "renova em instantes" quando a contagem já acabou. Null sem data. PURE. */
export function resetPhrase(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const at = formatResetAt(resetsAt, now);
  const inTime = resetsAt - now >= DAY_MS ? formatDays(resetsAt - now) : formatResetIn(new Date(resetsAt).toISOString(), now);
  return inTime ? t("plan.resetsInAt", { time: inTime, at }) : t("plan.resetsSoon");
}

/** A frase do aviso do chat. PURE. */
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
