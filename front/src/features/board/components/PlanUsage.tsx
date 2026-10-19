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
  planWindows,
  resetPhrase,
  usageColor,
  usageTone,
  weeklyWindow,
  type PlanAlert,
  type PlanWindow,
  type RateLimitInfo,
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

/**
 * O anel: trilho apagado, arco na cor CONTÍNUA do percentual (verde → vermelho). Sem leitura, ou em
 * 0%, só o trilho — a ponta arredondada de um arco de comprimento zero virava um ponto solto.
 */
function Ring({ value, size, stroke }: { value: number | null; size: number; stroke: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value === null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90 shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted-foreground/20" />
      {pct > 0 ? (
        <circle
          data-testid="plan-ring-arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          style={{ stroke: usageColor(pct) }}
          className="transition-[stroke-dasharray,stroke] duration-500 motion-reduce:transition-none"
        />
      ) : null}
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
        <span
          className="shrink-0 font-semibold tabular-nums transition-colors"
          style={tone === "ok" ? undefined : { color: usageColor(w.utilization) }}
        >
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
          className="h-full rounded-full transition-[width,background-color] duration-500 motion-reduce:transition-none"
          style={{ width: `${Math.min(100, Math.max(0, w.utilization))}%`, backgroundColor: usageColor(w.utilization) }}
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
 * O medidor do topo: anel + % do limite SEMANAL — é por ele que se acompanha se a semana vai
 * fechar. A cor esquenta junto com o número (verde → amarelo → laranja → vermelho); o clique abre
 * todas as janelas. Sem leitura ele ainda abre, para dizer por quê.
 */
export function PlanUsageMeter({
  cardId,
  accountName,
  active,
  isOwner,
  className,
}: {
  cardId: string;
  accountName: string;
  /** Só o card na tela consulta: seis cards escondidos fazendo poll é tráfego que ninguém vê. */
  active: boolean;
  /** Só o dono tem o shell do runner: só para ele a falta de leitura vira um comando. */
  isOwner: boolean;
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
  const weekly = weeklyWindow(windows);
  const weekLive = live.seven_day;
  const blown = weekLive?.status === "rejected" && (weekLive.resetsAt === undefined || weekLive.resetsAt > now);
  const value = blown ? 100 : (weekly?.utilization ?? null);
  const tone = usageTone(value, blown);
  const label = value === null ? null : `${Math.round(value)}%`;
  const failed = Boolean(data?.usage && !data.usage.available && windows.length === 0);
  // A pílula ganha a cor quando a semana começa a apertar; antes disso fica discreta como as vizinhas.
  const heated = value !== null && value >= 60;

  return (
    <DropdownMenu onOpenChange={(open) => open && setNow(Date.now())}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="plan-meter"
          data-tone={tone}
          aria-label={label ? `${t("plan.weekly")}: ${label}` : `${t("plan.weekly")}: ${t("plan.noReading")}`}
          title={label ? t("plan.meterHint") : t("plan.noReadingHint")}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium tabular-nums transition-colors duration-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            !heated && "border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground",
            className,
          )}
          style={heated ? { borderColor: usageColor(value, 0.55), backgroundColor: usageColor(value, 0.12), color: usageColor(value) } : undefined}
        >
          <Ring value={value} size={14} stroke={2.5} />
          {label ? (
            <>
              <span data-testid="plan-meter-value">{label}</span>
              <span className="font-normal opacity-70">{t("plan.weekShort")}</span>
            </>
          ) : (
            <span className="font-normal">{failed ? t("plan.noReading") : "…"}</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-80 p-0" data-testid="plan-panel">
        <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
          <div className="relative grid place-items-center">
            <Ring value={value} size={48} stroke={5} />
            <span
              className="absolute text-xs font-semibold tabular-nums text-foreground transition-colors"
              style={heated ? { color: usageColor(value) } : undefined}
            >
              {label ?? "—"}
            </span>
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground" title={accountName}>{accountName}</div>
            <div className="text-xs text-muted-foreground">{t("plan.weekly")}</div>
          </div>
        </div>
        <div className="space-y-4 px-4 py-3">
          {windows.length > 0 ? (
            windows.map((w) => <WindowRow key={w.key} window={w} now={now} />)
          ) : (
            <p data-testid="plan-no-reading" className="text-xs leading-snug text-muted-foreground">
              {failed
                ? isOwner
                  ? usageErrorText(data!.usage, profilePathFor(data!.slug), now)
                  : t("plan.noReadingMember")
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
            {/* A escala da cor, do frio ao quente — a mesma que o anel e as barras percorrem. */}
            <span
              aria-hidden
              title={t("plan.thresholds")}
              className="h-1.5 w-16 rounded-full"
              style={{ backgroundImage: `linear-gradient(to right, ${usageColor(50)}, ${usageColor(70)}, ${usageColor(85)}, ${usageColor(100)})` }}
            />
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
