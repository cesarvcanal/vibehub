import type { BranchClassificada, DestaqueBranch } from "@/features/board/types/branches";

/** Branches de desenvolvimento que servem de base de projeto; staging/homolog só ganham destaque. */
const NOMES_DESENVOLVIMENTO_BASE = ["dev", "develop", "development"] as const;

const NOMES_POR_DESTAQUE: Record<Exclude<DestaqueBranch, "padrao">, readonly string[]> = {
  producao: ["prod", "production", "producao"],
  principal: ["main", "master"],
  desenvolvimento: [...NOMES_DESENVOLVIMENTO_BASE, "staging", "homolog"],
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

/** Branch base para um projeto novo: a de desenvolvimento, senão main/master, senão a padrão do repo. */
export function branchBaseSugerida(branches: readonly string[], branchPadrao: string | null): string | undefined {
  const preferidas = [...NOMES_DESENVOLVIMENTO_BASE, ...NOMES_POR_DESTAQUE.principal];
  return preferidas.find((nome) => branches.includes(nome)) ?? branchPadrao ?? branches[0];
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

/**
 * A branch name the server will accept — the same rule as `assertBranchName` in the registry, which
 * is what the card's open would hit later. Checked in the dialog so a typo is a red line under the
 * field instead of a card that refuses to open minutes afterwards, in the runner, with a git message.
 * PURE.
 */
export function isBranchName(name: string): boolean {
  const v = name.trim();
  return v !== "" && !v.startsWith("-") && !v.includes("..") && /^[\w./-]{1,80}$/.test(v);
}

export type NewCardBranchIssue = "invalid" | "isBase" | "exists";

/**
 * What is wrong with the branch a new card would be created ON, if anything. Three answers, and
 * they do NOT weigh the same:
 *  - `invalid` and `isBase` BLOCK the creation — the first would be refused by the server, and
 *    the second would put the card's commits straight on the branch it is meant to deliver to
 *    (a locked card pointed at `prod` would be working IN `prod`);
 *  - `exists` only WARNS: opening a card on a branch that already exists is a real thing to want
 *    (picking work back up), it just is not "create a new one", and the person should know which
 *    of the two they are getting.
 * PURE.
 */
export function newCardBranchIssue(
  branch: string,
  effectiveBase: string,
  repoBranches: readonly string[] | undefined,
): NewCardBranchIssue | null {
  const name = branch.trim();
  if (!name) return null;
  if (!isBranchName(name)) return "invalid";
  if (name === effectiveBase) return "isBase";
  if (repoBranches?.includes(name)) return "exists";
  return null;
}
