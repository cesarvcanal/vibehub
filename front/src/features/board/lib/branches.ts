import type { BranchClassificada, DestaqueBranch } from "@/features/board/types/branches";

const NOMES_POR_DESTAQUE: Record<Exclude<DestaqueBranch, "padrao">, readonly string[]> = {
  producao: ["prod", "production", "producao"],
  principal: ["main", "master"],
  desenvolvimento: ["dev", "develop", "development", "staging", "homolog"],
};

const DESTAQUES_POR_NOME = ["producao", "principal", "desenvolvimento"] as const;

const ORDEM_DESTAQUE: readonly DestaqueBranch[] = ["padrao", ...DESTAQUES_POR_NOME];

function destaqueDe(nome: string, branchPadrao: string | null): DestaqueBranch | null {
  if (nome === branchPadrao) return "padrao";
  return DESTAQUES_POR_NOME.find((destaque) => NOMES_POR_DESTAQUE[destaque].includes(nome)) ?? null;
}

/** Destacadas (padrão do repo, produção, main/master, dev) na ordem de `ORDEM_DESTAQUE`; o resto em ordem alfabética. */
export function classificarBranches(
  branches: readonly string[],
  branchPadrao: string | null,
): { destacadas: BranchClassificada[]; demais: BranchClassificada[] } {
  const classificadas = branches.map((nome) => ({ nome, destaque: destaqueDe(nome, branchPadrao) }));
  const destacadas = ORDEM_DESTAQUE.flatMap((destaque) => classificadas.filter((b) => b.destaque === destaque));
  const demais = classificadas
    .filter((b) => b.destaque === null)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
  return { destacadas, demais };
}

/** Busca por pedaço do nome, sem caixa e sem acento. */
export function filtrarBranches(branches: readonly BranchClassificada[], busca: string): BranchClassificada[] {
  const termo = normalizar(busca.trim());
  if (!termo) return [...branches];
  return branches.filter((b) => normalizar(b.nome).includes(termo));
}

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
