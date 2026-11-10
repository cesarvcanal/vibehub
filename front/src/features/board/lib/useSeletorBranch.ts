import * as React from "react";
import { classificarBranches, filtrarBranches } from "@/features/board/lib/branches";
import type { PropsSeletorBranch } from "@/features/board/types/branches";

/**
 * Estado do combobox de branch: aberto, busca, linha ativa no teclado e a lista filtrada. A linha
 * ativa é guardada pelo NOME, não pela posição: a lista se atualiza enquanto está aberta, e o Enter
 * tem de escolher a branch que estava marcada, não a que caiu na mesma posição.
 */
export function useSeletorBranch({
  idLista,
  valor,
  aoEscolher,
  branches,
  branchPadrao,
  aoAbrir,
  rotuloSemEscolha,
}: Pick<PropsSeletorBranch, "valor" | "aoEscolher" | "branches" | "branchPadrao" | "aoAbrir" | "rotuloSemEscolha"> & {
  idLista: string;
}) {
  const [aberto, setAberto] = React.useState(false);
  const [busca, setBusca] = React.useState("");
  const [nomeAtivo, setNomeAtivo] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const classificadas = React.useMemo(() => classificarBranches(branches, branchPadrao), [branches, branchPadrao]);
  const destacadas = filtrarBranches(classificadas.destacadas, busca);
  const demais = filtrarBranches(classificadas.demais, busca);
  const temLinhaSemEscolha = rotuloSemEscolha !== undefined && busca.trim() === "";
  const valoresNavegaveis = [
    ...(temLinhaSemEscolha ? [""] : []),
    ...destacadas.map((b) => b.nome),
    ...demais.map((b) => b.nome),
  ];
  const valorAtivo = nomeAtivo !== null && valoresNavegaveis.includes(nomeAtivo) ? nomeAtivo : valoresNavegaveis[0];

  React.useEffect(() => {
    if (!aberto) return;
    containerRef.current?.querySelector("[data-ativo]")?.scrollIntoView?.({ block: "nearest" });
  }, [aberto, valorAtivo]);

  const abrir = () => {
    setNomeAtivo(valor);
    setAberto(true);
    aoAbrir();
  };

  const fechar = () => {
    setAberto(false);
    setBusca("");
  };

  const escolher = (branch: string) => {
    aoEscolher(branch);
    fechar();
  };

  const mudarBusca = (texto: string) => {
    setBusca(texto);
    setNomeAtivo(null);
  };

  const tratarTeclaDaBusca = (evento: React.KeyboardEvent) => {
    if (evento.key === "ArrowDown" || evento.key === "ArrowUp") {
      evento.preventDefault();
      if (valorAtivo === undefined) return;
      const total = valoresNavegaveis.length;
      const passo = evento.key === "ArrowDown" ? 1 : -1;
      setNomeAtivo(valoresNavegaveis[(valoresNavegaveis.indexOf(valorAtivo) + passo + total) % total] ?? null);
      return;
    }
    if (evento.key === "Enter") {
      evento.preventDefault();
      if (valorAtivo !== undefined) escolher(valorAtivo);
    }
  };

  const fecharNoEsc = (evento: React.KeyboardEvent) => {
    if (evento.key === "Escape" && aberto) fechar();
  };

  // Clicar na barra de rolagem do diálogo (ou num espaço vazio dele) passa o foco ao próprio
  // diálogo, que é ancestral do seletor: isso é rolar para ver a lista, não sair dela.
  const fecharAoPerderFoco = (evento: React.FocusEvent) => {
    const destino = evento.relatedTarget;
    const container = containerRef.current;
    if (!container || !(destino instanceof Node)) return fechar();
    if (container.contains(destino) || destino.contains(container)) return;
    fechar();
  };

  const selecionada = classificadas.destacadas.find((b) => b.nome === valor)
    ?? classificadas.demais.find((b) => b.nome === valor);

  return {
    containerRef,
    aberto,
    busca,
    destacadas,
    demais,
    temLinhaSemEscolha,
    valorAtivo,
    idDaOpcaoAtiva: valorAtivo === undefined ? undefined : idDaOpcao(idLista, valorAtivo),
    selecionada,
    abrir,
    fechar,
    escolher,
    mudarBusca,
    tratarTeclaDaBusca,
    fecharNoEsc,
    fecharAoPerderFoco,
  };
}

/** Id estável de uma opção, para o `aria-activedescendant` da busca. Nome de branch não tem espaço. */
export function idDaOpcao(idLista: string, branch: string): string {
  return `${idLista}-opcao-${branch || "sem-escolha"}`;
}

/**
 * O Dialog do Radix escuta o Esc no document (fase de captura) e fecharia o formulário inteiro.
 * Com o seletor aberto, o Esc é dele: fecha só a lista.
 */
export function manterDialogoNoEscDoSeletor(evento: KeyboardEvent): void {
  if (evento.target instanceof Element && evento.target.closest("[data-seletor-branch-aberto]")) evento.preventDefault();
}
