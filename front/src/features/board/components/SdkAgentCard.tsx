import * as React from "react";
import { Bot, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { subagentAction, subagentLabel, toolHeadline, type SdkRow } from "@/features/board/lib/sdkChat";
import { SdkThreadContext } from "@/features/board/components/sdkThreadContext";

/**
 * UM SUBAGENTE (Agent/Task) NO CHAT: a chamada, e debaixo dela o que ELE fez.
 *
 * Antes, as ferramentas e o texto do subagente caíam no fio da conversa como se fossem do agente
 * principal — a IA parecia perdida, mudando de assunto no meio do turno. Aqui elas ficam recuadas
 * sob o card que as disparou, recolhidas por padrão: o contador de ações e a última delas dizem que
 * ele está trabalhando e em quê, sem enterrar a conversa principal.
 */
export function SdkAgentCard({ row }: { row: Extract<SdkRow, { kind: "tool" }> }) {
  const t = useT();
  const { subagentRows, renderRow } = React.useContext(SdkThreadContext);
  const [open, setOpen] = React.useState(false);
  const headline = toolHeadline(row.name, row.input);
  const children = subagentRows.get(row.id) ?? [];
  const actions = children.filter((child) => child.kind === "tool").length;
  const last = children[children.length - 1];
  const lastAction = last ? subagentAction(last) : null;
  const who = subagentLabel(row.name, row.input);
  return (
    <div data-testid="sdk-agent" data-tool={row.name} className="min-w-0 pl-0.5 text-xs">
      {/* O mesmo desenho de uma ferramenta (manchete + "rodando em segundo plano"), com o robô no
          lugar da chave: é um agente, não um comando. */}
      <div data-testid="sdk-tool" data-tool={row.name}>
        <div className="flex items-baseline gap-1.5 text-muted-foreground">
          <Bot className="h-3 w-3 shrink-0 translate-y-0.5 opacity-70" />
          <span data-testid="sdk-tool-title" className="min-w-0 truncate font-medium text-foreground/90">
            {headline.title}
          </span>
        </div>
        <div
          data-testid="sdk-tool-detail"
          data-background="true"
          className="mt-0.5 flex min-w-0 items-baseline gap-1 pl-[1.1rem] text-muted-foreground/75"
        >
          <span aria-hidden className="shrink-0 select-none opacity-60">⌊</span>
          <span className="min-w-0 truncate">{t("sdk.toolBackground")}</span>
        </div>
      </div>
      {children.length > 0 ? (
        <div className="mt-0.5 pl-[1.1rem]">
          <button
            type="button"
            data-testid="sdk-subagent-summary"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex w-full min-w-0 items-center gap-1.5 rounded text-left text-muted-foreground/80 hover:text-foreground"
          >
            <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
            <span className="shrink-0 font-medium">{t("sdk.subagentActions", { n: actions })}</span>
            {!open && lastAction ? (
              <span className="min-w-0 truncate opacity-70">{`${who} · ${lastAction}`}</span>
            ) : null}
          </button>
          {open ? (
            <div data-testid="sdk-subagent-rows" className="mt-1 space-y-1 border-l border-border/60 pl-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{t("sdk.byAgent")}</div>
              {children.map((child) => (
                <React.Fragment key={child.id}>
                  {child.kind === "assistant" ? (
                    <div
                      data-testid="sdk-subagent-text"
                      className="select-text whitespace-pre-wrap break-words text-muted-foreground"
                    >
                      {child.text}
                    </div>
                  ) : (
                    renderRow(child)
                  )}
                </React.Fragment>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
