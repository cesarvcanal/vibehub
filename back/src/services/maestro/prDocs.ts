/**
 * PR DOCUMENTATION — what a pull request opened by `vibehub_deliver` must carry.
 *
 * The standard (a global rule of the team, for every PR of every repository): a DESCRIPTION with the
 * sections below, written for a reviewer who never saw the code, and REVIEW COMMENTS on the relevant
 * blocks of the diff saying what changed, why, how it works, its responsibility, impact and rules.
 *
 * The deliver used to open PRs with `gh pr create --fill`, whose body is the list of commits — the
 * very PR the standard forbids. Text in a prompt is advice; this module is the guarantee: a NEW pull
 * request opens only with a title, a body that has every section, and at least one comment on the
 * diff (`canOpenPr`). An existing PR is reused as it is unless the caller sends new text.
 *
 * Everything here is PURE: validation, the refusal message, the dedupe of comments already on the PR
 * and the review payload. The scripts that talk to GitHub live in deliver.ts.
 */

/** One comment on the PR's diff, as the deliver accepts it. `line` is the line in the file version of `side`. */
export interface PrComment {
  path: string;
  line: number;
  body: string;
  /** RIGHT = the new version of the file (added or kept lines); LEFT = the old one (removed lines). */
  side?: "RIGHT" | "LEFT";
  /** First line of a multi-line block, on the same side; must come before `line`. */
  startLine?: number;
}

/** What the caller sends: any of the three, or none (an existing PR reused untouched). */
export interface PrDocs {
  title?: string;
  body?: string;
  comments?: PrComment[];
}

/** A comment after validation: trimmed, side resolved. */
export type CleanComment = Required<Pick<PrComment, "path" | "line" | "body" | "side">> & Pick<PrComment, "startLine">;

/** Validated documentation: absent fields stay absent, comments always a list. */
export interface CleanPrDocs {
  title?: string;
  body?: string;
  comments: CleanComment[];
}

/**
 * The sections the description must have, as markdown headings. `match` are accent-free, lower-case
 * fragments: a heading counts when its text contains one of them, so "## 7. Impactos", "### Testes e
 * validações" and "## Technical details" all count. English is accepted for repositories written in it.
 */
export const PR_SECTIONS: ReadonlyArray<{ label: string; match: string[] }> = [
  { label: "Contexto", match: ["contexto", "context"] },
  { label: "Problema identificado", match: ["problema", "problem"] },
  { label: "Objetivo", match: ["objetivo", "goal", "objective"] },
  { label: "Solução implementada", match: ["solucao", "solution"] },
  { label: "Detalhamento técnico", match: ["detalhamento tecnico", "technical detail"] },
  { label: "Comportamento esperado", match: ["comportamento esperado", "expected behavio"] },
  { label: "Impactos", match: ["impacto", "impact"] },
  { label: "Testes e validações", match: ["teste", "test"] },
  { label: "Pontos de atenção", match: ["pontos de atencao", "points of attention", "caveat"] },
];

/** Lower-case, accents stripped, markdown decoration and numbering gone. PURE. */
function normalizeHeading(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[*_`:]/g, "")
    .replace(/^[\s\d.)-]+/, "")
    .trim();
}

/** The sections of {@link PR_SECTIONS} that have no heading in `body`, by label. PURE. */
export function missingPrSections(body: string): string[] {
  const headings = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => /^\s{0,3}#{1,6}\s+(.+)$/.exec(line)?.[1])
    .filter((h): h is string => h !== undefined)
    .map(normalizeHeading);
  return PR_SECTIONS.filter((s) => !headings.some((h) => s.match.some((m) => h.includes(m)))).map((s) => s.label);
}

