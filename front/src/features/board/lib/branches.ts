import type { BranchHighlight, RankedBranch } from "@/features/board/types/branches";

/** Development branches that serve as a project's base; staging/homolog only get a badge. */
const DEVELOPMENT_BASE_NAMES = ["dev", "develop", "development"] as const;

const NAMES_BY_HIGHLIGHT: Record<Exclude<BranchHighlight, "padrao">, readonly string[]> = {
  producao: ["prod", "production", "producao"],
  principal: ["main", "master"],
  desenvolvimento: [...DEVELOPMENT_BASE_NAMES, "staging", "homolog"],
};

const NAMED_HIGHLIGHTS = ["producao", "principal", "desenvolvimento"] as const;

const HIGHLIGHT_ORDER: readonly BranchHighlight[] = ["padrao", ...NAMED_HIGHLIGHTS];

function highlightOf(name: string, defaultBranch: string | null): BranchHighlight | null {
  if (name === defaultBranch) return "padrao";
  return NAMED_HIGHLIGHTS.find((highlight) => NAMES_BY_HIGHLIGHT[highlight].includes(name)) ?? null;
}

/** Featured (the repo's default, production, main/master, dev) in `HIGHLIGHT_ORDER`; the rest alphabetically. */
export function rankBranches(
  branches: readonly string[],
  defaultBranch: string | null,
): { featured: RankedBranch[]; others: RankedBranch[] } {
  const ranked = branches.map((name) => ({ name, highlight: highlightOf(name, defaultBranch) }));
  const featured = HIGHLIGHT_ORDER.flatMap((highlight) => ranked.filter((b) => b.highlight === highlight));
  const others = ranked
    .filter((b) => b.highlight === null)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
  return { featured, others };
}

/** Base branch for a new project: the development one, else main/master, else the repo's default. */
export function suggestedBaseBranch(branches: readonly string[], defaultBranch: string | null): string | undefined {
  const preferred = [...DEVELOPMENT_BASE_NAMES, ...NAMES_BY_HIGHLIGHT.principal];
  return preferred.find((name) => branches.includes(name)) ?? defaultBranch ?? branches[0];
}

/** Search by any part of the name, ignoring case and accents. */
export function filterBranches(branches: readonly RankedBranch[], search: string): RankedBranch[] {
  const term = normalizeForSearch(search.trim());
  if (!term) return [...branches];
  return branches.filter((b) => normalizeForSearch(b.name).includes(term));
}

function normalizeForSearch(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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
