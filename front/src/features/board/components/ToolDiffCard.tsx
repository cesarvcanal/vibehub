import * as React from "react";
import { ChevronRight, FilePen, FilePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import type { DiffLine, ToolDiff } from "@/features/board/lib/toolDiff";

/** Acima disto o card nasce recolhido: um diff longo empurraria a conversa inteira pra cima. */
const OPEN_BY_DEFAULT_MAX = 20;

const LINE_STYLE: Record<DiffLine["kind"], { prefix: string; className: string }> = {
  add: { prefix: "+", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  del: { prefix: "−", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  ctx: { prefix: " ", className: "text-muted-foreground" },
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function DiffBody({ diff }: { diff: ToolDiff }) {
  const t = useT();
  if (diff.hunks.length === 0 && !diff.hidden) return null;
  return (
    <div className="mt-2 max-h-64 overflow-auto rounded border border-border/60 bg-background/70 font-mono text-[11px] leading-relaxed">
      {/* min-w-max: a linha longa rola DENTRO do card e o fundo colorido acompanha até o fim dela. */}
      <div className="min-w-max py-0.5">
        {diff.hunks.map((hunk, h) => (
          <React.Fragment key={h}>
            {h > 0 ? (
              <div aria-hidden data-testid="sdk-diff-gap" className="select-none px-2 text-muted-foreground/60">⋯</div>
            ) : null}
            {hunk.map((line, i) => {
              const style = LINE_STYLE[line.kind];
              return (
                <div key={i} data-testid="sdk-diff-line" data-kind={line.kind} className={cn("whitespace-pre px-2", style.className)}>
                  <span aria-hidden className="inline-block w-3 select-none opacity-70">{style.prefix}</span>
                  {line.text}
                </div>
              );
            })}
          </React.Fragment>
        ))}
        {diff.hidden ? (
          <div data-testid="sdk-diff-truncated" className="px-2 italic text-muted-foreground/80">
            {t("sdk.diffTruncated", { n: diff.hidden })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * O card de uma ferramenta que alterou código, no estilo do Cursor: o arquivo, o contador `+N −M`
 * e só os trechos alterados. Mesmo esqueleto visual do `SdkWorkflowCard` (cabeçalho-botão com
 * chevron), aberto por padrão só quando o diff é curto.
 */
export function ToolDiffCard({ row, diff }: { row: Extract<SdkRow, { kind: "tool" }>; diff: ToolDiff }) {
  const t = useT();
  const [open, setOpen] = React.useState(diff.added + diff.removed <= OPEN_BY_DEFAULT_MAX);
  const Icon = diff.created ? FilePlus : FilePen;
  const badge = diff.created ? t("sdk.diffWrote") : diff.replaceAll ? t("sdk.diffReplaceAll") : null;

  return (
    <div
      data-testid="sdk-diff"
      data-tool={row.name}
      className="min-w-0 max-w-full rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span title={diff.file} className="min-w-0 truncate font-mono font-medium text-foreground/90">
          {basename(diff.file)}
        </span>
        {badge ? (
          <span className="shrink-0 rounded border border-border/70 bg-background/60 px-1.5 py-px text-[10px] text-muted-foreground">
            {badge}
          </span>
        ) : null}
        <span className="flex-1" />
        <span
          data-testid="sdk-diff-added"
          aria-label={t("sdk.diffAdded", { n: diff.added })}
          className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400"
        >
          +{diff.added}
        </span>
        <span
          data-testid="sdk-diff-removed"
          aria-label={t("sdk.diffRemoved", { n: diff.removed })}
          className="shrink-0 tabular-nums text-red-500"
        >
          −{diff.removed}
        </span>
        <span className="sr-only">{open ? t("sdk.diffHide") : t("sdk.diffShow")}</span>
      </button>
      {open ? <DiffBody diff={diff} /> : null}
    </div>
  );
}
