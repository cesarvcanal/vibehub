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

/**
 * Below this a comment cannot say what changed, why and how — "Adicionada validação para verificar os
 * dados antes de continuar." (the standard's own example of a forbidden comment) is 66 characters.
 */
export const MIN_COMMENT_CHARS = 120;
/** GitHub's own limits: a PR title, and a PR body or comment body. */
const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 65_536;
/** One review is one API call; past this the agent is commenting lines, not blocks. */
const MAX_COMMENTS = 100;

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

/** Where a comment points, for messages. PURE. */
function where(c: { path: string; line: number }): string {
  return `${c.path || "?"}:${c.line}`;
}

/** The problems with one comment; empty when it can be posted. PURE. */
function commentProblems(c: PrComment, body: string): string[] {
  const out: string[] = [];
  const path = String(c.path ?? "").trim();
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    out.push(`comentário em "${path}": path tem que ser relativo à raiz do repositório`);
  }
  if (!Number.isInteger(c.line) || c.line < 1) out.push(`${where(c)}: line tem que ser um número de linha (inteiro ≥ 1)`);
  if (c.startLine !== undefined && (!Number.isInteger(c.startLine) || c.startLine < 1 || c.startLine >= c.line)) {
    out.push(`${where(c)}: startLine tem que ser inteiro ≥ 1 e menor que line`);
  }
  if (c.side !== undefined && c.side !== "RIGHT" && c.side !== "LEFT") out.push(`${where(c)}: side é RIGHT ou LEFT`);
  if (body.length < MIN_COMMENT_CHARS) {
    out.push(
      `${where(c)}: comentário raso (${body.length} caracteres, mínimo ${MIN_COMMENT_CHARS}) — explique o que mudou, ` +
        "por que, como funciona, a responsabilidade do trecho, o impacto e as regras envolvidas",
    );
  }
  if (body.length > MAX_BODY_CHARS) out.push(`${where(c)}: comentário passa do limite do GitHub (${MAX_BODY_CHARS} caracteres)`);
  return out;
}

/**
 * Validates and normalizes what the caller sent. Every problem is reported at once (an agent fixes them
 * in one pass), in Portuguese — it is relayed to the person. Repeated comments (same file and text)
 * are dropped: posting the same explanation twice is noise, not documentation. PURE.
 */
export function validatePrDocs(docs: PrDocs | undefined): { ok: true; docs: CleanPrDocs } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const clean: CleanPrDocs = { comments: [] };

  // Blank = not sent: MCP clients fill optional fields with "". A new PR then lacks it (canOpenPr says
  // so); an open PR keeps its text.
  const title = String(docs?.title ?? "").replace(/\s+/g, " ").trim();
  if (title) {
    if (title.length > MAX_TITLE_CHARS) problems.push(`title passa do limite do GitHub (${MAX_TITLE_CHARS} caracteres)`);
    else clean.title = title;
  }

  const body = String(docs?.body ?? "").trim();
  if (body) {
    if (body.length > MAX_BODY_CHARS) problems.push(`body passa do limite do GitHub (${MAX_BODY_CHARS} caracteres)`);
    else {
      const missing = missingPrSections(body);
      if (missing.length) problems.push(`body sem as seções (como headings markdown): ${missing.join(", ")}`);
      else clean.body = body;
    }
  }

  const comments = docs?.comments ?? [];
  if (comments.length > MAX_COMMENTS) {
    problems.push(`${comments.length} comentários: o máximo é ${MAX_COMMENTS} — comente blocos, não linhas soltas`);
  }
  const seen = new Set<string>();
  for (const c of comments.slice(0, MAX_COMMENTS)) {
    const text = String(c.body ?? "").trim();
    const found = commentProblems(c, text);
    if (found.length) {
      problems.push(...found);
      continue;
    }
    const path = c.path.trim();
    const key = `${path}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.comments.push({
      path, line: c.line, side: c.side ?? "RIGHT", body: text,
      ...(c.startLine !== undefined ? { startLine: c.startLine } : {}),
    });
  }

  return problems.length ? { ok: false, problems } : { ok: true, docs: clean };
}

