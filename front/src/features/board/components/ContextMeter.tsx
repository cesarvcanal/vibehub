import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CONTEXT_DANGER_AT,
  CONTEXT_WARN_AT,
  contextColor,
  contextGradient,
  contextZone,
  type ContextUsageInfo,
  type ContextZone,
} from "@/features/board/lib/contextUsage";
import { formatTokens } from "@/features/board/lib/sdkDetail";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

/**
 * O MEDIDOR DE CONTEXTO — quanto da janela a conversa já ocupa, ao lado do "está digitando".
 *
 * A pílula carrega a cor CONTÍNUA do percentual (borda, fundo e a barrinha), e o número fica na cor
 * do texto para ler em qualquer tema. Passar o mouse (ou focar) abre o guia: a régua inteira com o
 * ponto de agora e as três faixas — inteligente, preocupante, perigoso — com a de agora em destaque.
 */

const ZONES: readonly { zone: ContextZone; mid: number }[] = [
  { zone: "smart", mid: 0 },
  { zone: "warn", mid: (CONTEXT_WARN_AT + CONTEXT_DANGER_AT) / 2 },
  { zone: "danger", mid: 80 },
];

export function ContextMeter({ usage, className }: { usage: ContextUsageInfo | null; className?: string }) {
  const t = useT();
  if (!usage) return null;
  const pct = usage.percent;
  const zone = contextZone(pct);
  const shown = Math.round(pct);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="context-meter"
          data-zone={zone}
          aria-label={t("context.aria", { n: shown })}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium tabular-nums text-foreground/90 transition-colors duration-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none",
            className,
          )}
          style={{ borderColor: contextColor(pct, 0.55), backgroundColor: contextColor(pct, 0.1) }}
        >
          <span aria-hidden className="relative h-1.5 w-6 overflow-hidden rounded-full bg-muted-foreground/20">
            <span
              data-testid="context-meter-fill"
              className="absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-700 motion-reduce:transition-none"
              style={{ width: `${pct}%`, backgroundColor: contextColor(pct) }}
            />
          </span>
          <span data-testid="context-meter-value">{shown}%</span>
          <span className="font-normal opacity-70">{t("context.short")}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="w-72 p-0" data-testid="context-guide">
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 px-3 py-2">
          <span className="text-xs font-medium text-foreground">{t("context.title")}</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t("context.tokens", { used: formatTokens(usage.usedTokens), max: formatTokens(usage.maxTokens) })}
          </span>
        </div>

        {/* A régua: o degradê que a cor do medidor percorre, as fronteiras e o ponto de agora. */}
        <div className="px-3 pb-1 pt-3">
          <div className="relative h-2 rounded-full" style={{ backgroundImage: contextGradient() }}>
            {[CONTEXT_WARN_AT, CONTEXT_DANGER_AT].map((at) => (
              <span key={at} aria-hidden className="absolute inset-y-0 w-px bg-background/90" style={{ left: `${at}%` }} />
            ))}
            <span
              data-testid="context-guide-marker"
              aria-hidden
              className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow"
              style={{ left: `${pct}%`, backgroundColor: contextColor(pct) }}
            />
          </div>
          <div className="relative mt-1 h-3 text-[10px] tabular-nums text-muted-foreground">
            <span className="absolute left-0">0</span>
            <span className="absolute -translate-x-1/2" style={{ left: `${CONTEXT_WARN_AT}%` }}>{CONTEXT_WARN_AT}</span>
            <span className="absolute -translate-x-1/2" style={{ left: `${CONTEXT_DANGER_AT}%` }}>{CONTEXT_DANGER_AT}</span>
            <span className="absolute right-0">100</span>
          </div>
        </div>

        <ul className="space-y-0.5 px-1.5 pb-1.5 pt-1">
          {ZONES.map(({ zone: z, mid }) => {
            const current = z === zone;
            return (
              <li
                key={z}
                data-testid="context-zone"
                data-zone={z}
                data-current={current ? "true" : undefined}
                className={cn("flex gap-2 rounded px-1.5 py-1", current ? "bg-muted" : "opacity-70")}
              >
                <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: contextColor(mid) }} />
                <span className="min-w-0">
                  <span className="flex items-baseline gap-1.5 text-[11px]">
                    <span className="font-medium text-foreground">{t(`context.zone.${z}`)}</span>
                    <span className="tabular-nums text-muted-foreground">{t(`context.range.${z}`)}</span>
                    {current ? <span className="text-[10px] font-medium text-foreground/80">· {t("context.now")}</span> : null}
                  </span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">{t(`context.desc.${z}`)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
