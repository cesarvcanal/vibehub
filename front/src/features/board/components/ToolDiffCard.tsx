import * as React from "react";
import { ChevronRight, FilePen, FilePlus, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { SdkDetailContext, StatusIcon, ToolResultText } from "@/features/board/components/SdkDetail";
import { toolStatus } from "@/features/board/lib/sdkDetail";
import { inlineMarks, type DiffLine, type InlineMark, type ToolDiff } from "@/features/board/lib/toolDiff";

/**
 * O código fica na cor normal do texto — verde/vermelho no texto inteiro cansa e apaga a sintaxe.
 * Quem diz o tipo da linha é o fundo, a barra à esquerda e o sinal; o trecho que mudou dentro da
 * linha ganha o fundo mais forte (`mark`).
 */
const LINE_STYLE: Record<DiffLine["kind"], { prefix: string; className: string; sign: string; mark: string }> = {
  add: {
    prefix: "+",
    className: "border-emerald-500/70 bg-emerald-500/10 text-foreground",
    sign: "text-emerald-600 dark:text-emerald-400",
    mark: "rounded-sm bg-emerald-500/30",
  },
  del: {
    prefix: "−",
    className: "border-red-500/70 bg-red-500/10 text-foreground/80",
    sign: "text-red-600 dark:text-red-400",
    mark: "rounded-sm bg-red-500/30 line-through decoration-red-500/50",
  },
  ctx: { prefix: " ", className: "border-transparent text-muted-foreground", sign: "", mark: "" },
};

function LineText({ text, mark, className }: { text: string; mark: InlineMark | null; className: string }) {
  if (!mark) return <>{text}</>;
  return (
    <>
      {text.slice(0, mark[0])}
      <span data-testid="sdk-diff-mark" className={className}>{text.slice(mark[0], mark[1])}</span>
      {text.slice(mark[1])}
    </>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function DiffBody({ diff }: { diff: ToolDiff }) {
  const t = useT();
  if (diff.hunks.length === 0 && !diff.hidden) return null;
  return (
    <div className="mt-2 max-h-96 overflow-auto rounded border border-border/60 bg-background/70 font-mono text-xs leading-relaxed">
      {/* min-w-max: a linha longa rola DENTRO do card e o fundo colorido acompanha até o fim dela. */}
      <div className="min-w-max py-0.5">
        {diff.hunks.map((hunk, h) => {
          const marks = inlineMarks(hunk);
          return (
            <React.Fragment key={h}>
              {h > 0 ? (
                <div aria-hidden data-testid="sdk-diff-gap" className="select-none border-y border-border/40 bg-muted/40 px-2 text-muted-foreground/60">⋯</div>
              ) : null}
              {hunk.map((line, i) => {
                const style = LINE_STYLE[line.kind];
                return (
                  <div key={i} data-testid="sdk-diff-line" data-kind={line.kind} className={cn("whitespace-pre border-l-2 pl-1.5 pr-2", style.className)}>
                    <span aria-hidden className={cn("inline-block w-4 select-none font-semibold", style.sign)}>{style.prefix}</span>
                    <LineText text={line.text} mark={marks[i] ?? null} className={style.mark} />
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
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
 * chevron). Nasce aberto — o que a IA mudou é o que se quer ver; o corpo tem altura máxima e rola.
 */
export function ToolDiffCard({ row, diff }: { row: Extract<SdkRow, { kind: "tool" }>; diff: ToolDiff }) {
  const t = useT();
  const [open, setOpen] = React.useState(true);
  const detail = React.useContext(SdkDetailContext);
  const status = toolStatus(row);
  // Uma edição que FALHOU (trecho não encontrado, arquivo mudou) não pode parecer feita.
  const failed = row.result?.isError === true;
  const Icon = diff.created ? FilePlus : FilePen;
  const badge = diff.created ? t("sdk.diffWrote") : diff.replaceAll ? t("sdk.diffReplaceAll") : null;

  return (
    <div
      data-testid="sdk-diff"
      data-tool={row.name}
      data-status={status}
      className="min-w-0 max-w-full rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <StatusIcon status={status} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span title={diff.file} className="min-w-0 truncate font-mono font-medium text-foreground/90">
          {basename(diff.file)}
        </span>
        {failed ? (
          <span data-testid="sdk-diff-failed" className="shrink-0 rounded border border-red-500/50 bg-red-500/10 px-1.5 py-px text-[10px] text-red-500">
            {t("sdk.detail.notApplied")}
          </span>
        ) : null}
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
      <button
        type="button"
        data-testid="sdk-diff-open"
        onClick={() => detail.open({ kind: "action", id: row.id })}
        className="mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Maximize2 className="h-3 w-3" />
        {t("sdk.detail.open")}
      </button>
      {failed ? <ToolResultText name={row.name} result={row.result} /> : null}
      {open ? <DiffBody diff={diff} /> : null}
    </div>
  );
}
