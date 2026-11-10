import * as React from "react";
import { classificarBranches, filtrarBranches } from "@/features/board/lib/branches";
import type { PropsSeletorBranch } from "@/features/board/types/branches";

/** Estado do combobox de branch: aberto, busca, linha ativa no teclado e a lista filtrada. */
export function useSeletorBranch({
  valor,
  aoEscolher,
  branches,
  branchPadrao,
  aoAbrir,
  rotuloSemEscolha,
}: Pick<PropsSeletorBranch, "valor" | "aoEscolher" | "branches" | "branchPadrao" | "aoAbrir" | "rotuloSemEscolha">) {
  const [aberto, setAberto] = React.useState(false);
  const [busca, setBusca] = React.useState("");
  const [indiceAtivo, setIndiceAtivo] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!aberto) return;
    const fecharSeClicouFora = (evento: PointerEvent) => {
      if (containerRef.current?.contains(evento.target as Node)) return;
      setAberto(false);
      setBusca("");
    };
    document.addEventListener("pointerdown", fecharSeClicouFora);
    return () => document.removeEventListener("pointerdown", fecharSeClicouFora);
  }, [aberto]);

  const classificadas = React.useMemo(() => classificarBranches(branches, branchPadrao), [branches, branchPadrao]);
  const destacadas = filtrarBranches(classificadas.destacadas, busca);
  const demais = filtrarBranches(classificadas.demais, busca);
  const temLinhaSemEscolha = rotuloSemEscolha !== undefined && busca.trim() === "";
  const valoresNavegaveis = [
    ...(temLinhaSemEscolha ? [""] : []),
    ...destacadas.map((b) => b.nome),
    ...demais.map((b) => b.nome),
  ];
  const valorAtivo = valoresNavegaveis[indiceAtivo];

  React.useEffect(() => {
    if (!aberto) return;
    containerRef.current?.querySelector("[data-ativo]")?.scrollIntoView?.({ block: "nearest" });
  }, [aberto, indiceAtivo]);

  const abrir = () => {
    const posicaoAtual = valoresNavegaveis.indexOf(valor);
    setIndiceAtivo(posicaoAtual >= 0 ? posicaoAtual : 0);
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
    setIndiceAtivo(0);
  };

  const tratarTecla = (evento: React.KeyboardEvent) => {
    if (evento.key === "Escape") {
      fechar();
      return;
    }
    if (evento.key === "ArrowDown" || evento.key === "ArrowUp") {
      evento.preventDefault();
      const total = valoresNavegaveis.length;
      if (total === 0) return;
      const passo = evento.key === "ArrowDown" ? 1 : -1;
      setIndiceAtivo((atual) => (atual + passo + total) % total);
      return;
    }
    if (evento.key === "Enter") {
      evento.preventDefault();
      if (valorAtivo !== undefined) escolher(valorAtivo);
    }
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
    selecionada,
    abrir,
    fechar,
    escolher,
    mudarBusca,
    tratarTecla,
  };
}

/**
 * O Dialog do Radix escuta o Esc no document (fase de captura) e fecharia o formulário inteiro.
 * Com o seletor aberto, o Esc é dele: fecha só a lista.
 */
export function manterDialogoNoEscDoSeletor(evento: KeyboardEvent): void {
  if (evento.target instanceof Element && evento.target.closest("[data-seletor-branch-aberto]")) evento.preventDefault();
}
