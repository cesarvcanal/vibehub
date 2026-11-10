import { Check, ChevronDown, GitBranch, RefreshCw, Search } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { idDaOpcao, useSeletorBranch } from "@/features/board/lib/useSeletorBranch";
import type { BranchClassificada, DestaqueBranch, PropsSeletorBranch } from "@/features/board/types/branches";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

const TOM_DO_DESTAQUE: Record<DestaqueBranch, BadgeTone> = {
  padrao: "info",
  producao: "critical",
  principal: "ok",
  desenvolvimento: "warn",
};

// O nome trunca com reticências na largura do diálogo; o tooltip devolve o nome inteiro no hover.
function NomeBranch({ nome }: { nome: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="min-w-0 flex-1 truncate font-mono">{nome}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(32rem,90vw)] break-all font-mono">{nome}</TooltipContent>
    </Tooltip>
  );
}

export default function SeletorBranch({
  id,
  valor,
  aoEscolher,
  branches,
  branchPadrao,
  atualizando,
  falhouAoAtualizar,
  truncada,
  aoAbrir,
  aoAtualizar,
  rotuloSemEscolha,
}: PropsSeletorBranch) {
  const t = useT();
  const idLista = `${id}-lista`;
  const seletor = useSeletorBranch({ idLista, valor, aoEscolher, branches, branchPadrao, aoAbrir, rotuloSemEscolha });

  const linha = (branch: BranchClassificada) => (
    <li
      key={branch.nome}
      id={idDaOpcao(idLista, branch.nome)}
      role="option"
      aria-selected={branch.nome === valor}
      data-ativo={branch.nome === seletor.valorAtivo || undefined}
      onClick={() => seletor.escolher(branch.nome)}
      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm data-[ativo]:bg-accent"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <NomeBranch nome={branch.nome} />
      {branch.destaque ? (
        <Badge tone={TOM_DO_DESTAQUE[branch.destaque]} className="px-1.5 py-0 text-[10px]">
          {t(`branchPicker.badge.${branch.destaque}`)}
        </Badge>
      ) : null}
      {branch.nome === valor ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
    </li>
  );

  const nadaEncontrado = seletor.destacadas.length === 0 && seletor.demais.length === 0;

  return (
    <div
      ref={seletor.containerRef}
      data-seletor-branch-aberto={seletor.aberto || undefined}
      onKeyDown={seletor.fecharNoEsc}
      onBlur={seletor.fecharAoPerderFoco}
      // Sem conter a largura, o nome de branch mais longo (texto sem quebra) vira a largura mínima
      // da coluna do grid do Dialog, que estoura para o lado e ganha rolagem horizontal.
      className="space-y-1.5 [contain:inline-size]"
    >
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={seletor.aberto}
        aria-controls={idLista}
        onClick={seletor.aberto ? seletor.fechar : seletor.abrir}
        onKeyDown={(e) => {
          if (seletor.aberto || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
          e.preventDefault();
          seletor.abrir();
        }}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background/60 px-3 text-left text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          seletor.aberto && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        )}
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {seletor.selecionada ? (
          <>
            <NomeBranch nome={seletor.selecionada.nome} />
            {seletor.selecionada.destaque ? (
              <Badge tone={TOM_DO_DESTAQUE[seletor.selecionada.destaque]} className="px-1.5 py-0 text-[10px]">
                {t(`branchPicker.badge.${seletor.selecionada.destaque}`)}
              </Badge>
            ) : null}
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {valor || rotuloSemEscolha || t("branchPicker.placeholder")}
          </span>
        )}
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", seletor.aberto && "rotate-180")} />
      </button>

      {seletor.aberto ? (
        <div
          onPointerDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
          className="overflow-hidden rounded-md border border-border/60 bg-popover shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              type="search"
              autoComplete="off"
              role="searchbox"
              aria-label={t("branchPicker.search")}
              aria-controls={idLista}
              aria-activedescendant={seletor.idDaOpcaoAtiva}
              placeholder={t("branchPicker.search")}
              value={seletor.busca}
              onChange={(e) => seletor.mudarBusca(e.target.value)}
              onKeyDown={seletor.tratarTeclaDaBusca}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={aoAtualizar}
              aria-busy={atualizando}
              aria-label={t("branchPicker.refresh")}
              title={t("branchPicker.refresh")}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", atualizando && "animate-spin")} />
            </button>
          </div>

          <ul id={idLista} role="listbox" aria-label={t("branchPicker.search")} className="max-h-64 overflow-y-auto p-1">
            {seletor.temLinhaSemEscolha ? (
              <li
                id={idDaOpcao(idLista, "")}
                role="option"
                aria-selected={valor === ""}
                data-ativo={seletor.valorAtivo === "" || undefined}
                onClick={() => seletor.escolher("")}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground data-[ativo]:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">{rotuloSemEscolha}</span>
                {valor === "" ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
              </li>
            ) : null}

            {seletor.destacadas.length ? (
              <>
                <li role="presentation" className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("branchPicker.featured")}
                </li>
                {seletor.destacadas.map(linha)}
              </>
            ) : null}

            {seletor.demais.length ? (
              <>
                <li role="presentation" className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("branchPicker.others", { n: seletor.demais.length })}
                </li>
                {seletor.demais.map(linha)}
              </>
            ) : null}

            {nadaEncontrado ? (
              <li role="presentation" className="px-2 py-3 text-center text-xs text-muted-foreground">
                {t("branchPicker.empty")}
              </li>
            ) : null}
          </ul>

          <div className="space-y-0.5 border-t border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>
                {truncada ? t("branchPicker.truncated", { n: branches.length }) : t("branchPicker.total", { n: branches.length })}
              </span>
              {atualizando ? <span>{t("branchPicker.refreshing")}</span> : null}
            </div>
            {falhouAoAtualizar && !atualizando ? (
              <p role="alert" className="text-amber-600 dark:text-amber-400">
                {t("branchPicker.refreshFailed")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
