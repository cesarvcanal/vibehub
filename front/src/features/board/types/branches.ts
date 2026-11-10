export type DestaqueBranch = "padrao" | "producao" | "principal" | "desenvolvimento";

export interface BranchClassificada {
  nome: string;
  destaque: DestaqueBranch | null;
}

export interface PropsSeletorBranch {
  id: string;
  valor: string;
  aoEscolher: (branch: string) => void;
  branches: readonly string[];
  branchPadrao: string | null;
  atualizando: boolean;
  falhouAoAtualizar: boolean;
  truncada: boolean;
  aoAbrir: () => void;
  aoAtualizar: () => void;
  /** Linha que representa `valor === ""` (ex.: herdar a branch do projeto). Sem ela, não há linha vazia. */
  rotuloSemEscolha?: string;
}
