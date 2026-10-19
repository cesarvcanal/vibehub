import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban } from "lucide-react";
import { boardApi, cardUsageKey, profilePathFor, type CardUsageResponse } from "@/features/board/api";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { minutesSince, usageErrorText } from "@/features/board/lib/usage";
import {
  ORANGE_AT,
  RED_AT,
  YELLOW_AT,
  alertSentence,
  peakWindow,
  planWindows,
  resetPhrase,
  usageTone,
  type PlanAlert,
  type PlanWindow,
  type RateLimitInfo,
  type UsageTone,
} from "@/features/board/lib/planUsage";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

/**
 * QUANTO DO PLANO JÁ FOI — o medidor do topo do card e o aviso acima do campo do chat.
 *
 * O medidor é um anel: o número de uma janela só (a mais cheia) cabe na barra sem brigar com os
 * pills, e a cor diz o recado antes do número. Clicar abre as janelas uma a uma, cada barra com as
 * marcas onde o tom muda — o mesmo que o `/usage` do terminal mostra, legível.
 */

/** A cor de cada tom: o traço do anel e o preenchimento da barra. SEMÂNTICA, nunca o acento. */
const TONE_TEXT: Record<UsageTone, string> = {
  ok: "text-emerald-500",
  yellow: "text-yellow-500",
  orange: "text-orange-500",
  red: "text-red-500",
};
const TONE_FILL: Record<UsageTone, string> = {
  ok: "bg-emerald-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
};

/** Os avisos do plano ao vivo de um card, compartilhados entre o chat (que os recebe) e o topo. */
export const cardRateLimitsKey = (cardId: string) => ["board", "card", cardId, "rateLimits"] as const;

/**
 * A leitura do plano da conta deste card (60s, o mesmo cache do back — o endpoint de uso limita por
 * quem chama) mais os avisos ao vivo que o chat publicou. Uma consulta só por card, o topo e o chat
 * a dividem pela chave.
 */
export function useCardPlanUsage(cardId: string, enabled: boolean) {
  const usage = useQuery({
    queryKey: cardUsageKey(cardId),
    queryFn: () => boardApi.cardUsage(cardId),
    enabled,
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: false,
  });
  // Sem queryFn de verdade: quem escreve é o chat (`setQueryData`), aqui só se lê.
  const live = useQuery<Record<string, RateLimitInfo>>({
    queryKey: cardRateLimitsKey(cardId),
    queryFn: () => ({}),
    enabled: false,
    initialData: {},
  });
  return { data: usage.data as CardUsageResponse | undefined, live: live.data ?? {} };
}

/** O anel: trilho apagado, arco na cor do tom. `size` em px; o traço acompanha. */
function Ring({ value, tone, size, stroke }: { value: number; tone: UsageTone; size: number; stroke: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90 shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted-foreground/20" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        className={cn("stroke-current transition-[stroke-dasharray] duration-500 motion-reduce:transition-none", TONE_TEXT[tone])}
      />
    </svg>
  );
}

/** Uma janela no painel: nome, %, a barra com as marcas dos tons, e quando renova. */
function WindowRow({ window: w, now }: { window: PlanWindow; now: number }) {
  const t = useT();
  const tone = usageTone(w.utilization);
  const reset = resetPhrase(w.resetsAt, now);
  return (
    <div data-testid="plan-window" data-window={w.key} data-tone={tone} className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-foreground/90">{w.label}</span>
        <span className={cn("shrink-0 font-semibold tabular-nums", tone === "ok" ? "text-foreground/80" : TONE_TEXT[tone])}>
          {t("plan.used", { n: Math.round(w.utilization) })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={w.label}
        aria-valuenow={Math.round(w.utilization)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", TONE_FILL[tone])}
          style={{ width: `${Math.min(100, Math.max(0, w.utilization))}%` }}
        />
        {/* Onde o tom muda: amarelo, laranja, vermelho. Dizem "falta quanto até apertar". */}
        {[YELLOW_AT, ORANGE_AT, RED_AT].map((at) => (
          <span key={at} aria-hidden className="absolute inset-y-0 w-px bg-background/80" style={{ left: `${at}%` }} />
        ))}
      </div>
      {reset ? <div className="text-[11px] text-muted-foreground">{reset}</div> : null}
    </div>
  );
}

/**
 * O medidor do topo: anel + % da janela mais cheia; o clique abre o painel com todas. Sem número
 * nenhum (conta sem `/login`, endpoint limitado) ele ainda abre — para dizer por quê.
 */
export function PlanUsageMeter({
  cardId,
  accountName,
  active,
  className,
}: {
  cardId: string;
  accountName: string;
  /** Só o card na tela consulta: seis cards escondidos fazendo poll é tráfego que ninguém vê. */
  active: boolean;
  className?: string;
}) {
  const t = useT();
  const { data, live } = useCardPlanUsage(cardId, active);
  const [now, setNow] = React.useState(() => Date.now());
  // As contagens são em minutos; um relógio por minuto basta.
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const windows = planWindows(data?.usage, live, now);
  const peak = peakWindow(windows);
  const rejected = Object.values(live).some((i) => i.status === "rejected" && (i.resetsAt === undefined || i.resetsAt > now));
  const tone = usageTone(peak?.utilization, rejected);
  const label = peak ? `${Math.round(rejected ? 100 : peak.utilization)}%` : "—";

  return (
    <DropdownMenu onOpenChange={(open) => open && setNow(Date.now())}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="plan-meter"
          data-tone={tone}
          aria-label={peak ? `${t("plan.meter")}: ${peak.label} ${label}` : t("plan.meter")}
          title={t("plan.meterHint")}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            tone === "ok" && "border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground",
            tone === "yellow" && "border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
            tone === "orange" && "border-orange-500/60 bg-orange-500/10 text-orange-700 dark:text-orange-300",
            tone === "red" && "border-red-500/60 bg-red-500/15 text-red-600 dark:text-red-300",
            className,
          )}
        >
          <Ring value={rejected ? 100 : (peak?.utilization ?? 0)} tone={tone} size={14} stroke={2.5} />
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-80 p-0" data-testid="plan-panel">
        <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
          <div className="relative grid place-items-center">
            <Ring value={rejected ? 100 : (peak?.utilization ?? 0)} tone={tone} size={48} stroke={5} />
            <span className={cn("absolute text-xs font-semibold tabular-nums", tone === "ok" ? "text-foreground" : TONE_TEXT[tone])}>
              {label}
            </span>
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground" title={accountName}>{accountName}</div>
            <div className="text-xs text-muted-foreground">{t("plan.meter")}</div>
          </div>
        </div>
        <div className="space-y-4 px-4 py-3">
          {windows.length > 0 ? (
            windows.map((w) => <WindowRow key={w.key} window={w} now={now} />)
          ) : (
            <p className="text-xs leading-snug text-muted-foreground">
              {data?.usage && !data.usage.available
                ? usageErrorText(data.usage, profilePathFor(data.slug), now)
                : t("usage.loading")}
            </p>
          )}
        </div>
        {data?.usage?.available ? (
          <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
            <span>
              {minutesSince(data.usage.fetchedAt, now) < 1
                ? t("plan.updatedNow")
                : t("plan.updated", { n: minutesSince(data.usage.fetchedAt, now) })}
            </span>
            <span className="flex items-center gap-1" title={t("plan.thresholds")}>
              {(["yellow", "orange", "red"] as const).map((x) => (
                <span key={x} aria-hidden className={cn("h-1.5 w-1.5 rounded-full", TONE_FILL[x])} />
              ))}
            </span>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * O AVISO acima do campo do chat, no canto direito da faixa do "está digitando": o recado que o
 * Claude Code escreve no rodapé do terminal quando a cota aperta. Amarelo e laranja enquanto ainda
 * há margem, vermelho no fim — e, estourado, um ícone de bloqueio, porque o próximo turno não roda.
 */
export function PlanUsageAlert({ alert, now, className }: { alert: PlanAlert | null; now: number; className?: string }) {
  if (!alert) return null;
  const Icon = alert.rejected ? Ban : AlertTriangle;
  return (
    <div
      role="status"
      data-testid="plan-alert"
      data-tone={alert.tone}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        alert.tone === "yellow" && "border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
        alert.tone === "orange" && "border-orange-500/60 bg-orange-500/10 text-orange-700 dark:text-orange-300",
        alert.tone === "red" && "border-red-500/60 bg-red-500/15 text-red-600 dark:text-red-300",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{alertSentence(alert, now)}</span>
    </div>
  );
}
