import * as React from "react";
import { AlertTriangle, Check, FoldVertical } from "lucide-react";
import { compactionElapsed, compactionSummary } from "@/features/board/lib/compaction";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { useT } from "@/i18n";

type CompactionRow = Extract<SdkRow, { kind: "compaction" }>;

/**
 * A LINHA DA COMPACTAÇÃO no chat — o /compact da pessoa ou a automática do CLI.
 *
 * Rodando: um cartão com a barra indeterminada correndo e o relógio — o CLI passa de segundos a um
 * minuto resumindo sem soltar uma palavra, e sem isto o chat parecia travado. Terminada: vira um
 * DIVISOR de ponta a ponta, porque é isso que ela é na conversa ("daqui para cima, o modelo só
 * tem o resumo"), com quanto a conversa ocupava antes e depois. Falhou: o divisor em âmbar, com
 * o motivo.
 */
export const SdkCompactionRow = React.memo(function SdkCompactionRow({ row }: { row: CompactionRow }) {
  useT(); // o resumo lê o idioma: trocar de idioma redesenha a linha
  const { title, parts } = compactionSummary(row);

  if (row.status === "running") return <RunningCompaction title={title} startedAt={row.startedAt} />;

  const failed = row.status === "failed";
  const Icon = failed ? AlertTriangle : Check;
  return (
    <div
      data-testid="sdk-compaction"
      data-status={row.status}
      role="separator"
      aria-label={[title, ...parts].join(" · ")}
      className={`flex items-center gap-2 py-1 text-xs animate-in fade-in duration-500 ${failed ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
    >
      <span className={`h-px flex-1 ${failed ? "bg-amber-500/40" : "bg-border"}`} />
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${failed ? "" : "text-emerald-500"}`} />
        <span className="font-medium">{title}</span>
        {parts.map((part) => (
          <React.Fragment key={part}>
            <span aria-hidden className="opacity-50">·</span>
            <span className="truncate tabular-nums">{part}</span>
          </React.Fragment>
        ))}
      </span>
      <span className={`h-px flex-1 ${failed ? "bg-amber-500/40" : "bg-border"}`} />
    </div>
  );
});

/** A compactação em andamento: a barra correndo e o relógio, que anda sozinho a cada segundo. */
function RunningCompaction({ title, startedAt }: { title: string; startedAt?: number }) {
  const t = useT();
  // Sem `startedAt` (um back antigo), o relógio conta de quando a linha apareceu nesta aba.
  const [since] = React.useState(() => startedAt ?? Date.now());
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      data-testid="sdk-compaction"
      data-status="running"
      role="status"
      aria-live="polite"
      className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs animate-in fade-in duration-300"
    >
      <div className="flex items-center gap-2">
        <FoldVertical className="h-3.5 w-3.5 shrink-0 animate-pulse text-primary" />
        <span className="font-medium text-foreground">{title}</span>
        <span data-testid="sdk-compaction-elapsed" className="ml-auto font-mono tabular-nums text-muted-foreground">
          {compactionElapsed(since, now)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={title}
        className="relative mt-2 h-1 overflow-hidden rounded-full bg-primary/15"
      >
        <div className="absolute inset-y-0 left-0 w-2/5 animate-compact-slide rounded-full bg-primary" />
      </div>
      <div className="mt-1.5 text-muted-foreground">{t("sdk.compactRunningHint")}</div>
    </div>
  );
}
