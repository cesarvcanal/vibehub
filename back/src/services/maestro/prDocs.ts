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
  /** Comments dropped because the same call already had them (same file and text); absent when none. */
  repeated?: number;
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
/** GitHub's own limits: a PR title, and a PR body. */
const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 65_536;
/** One review is one API call; past this the agent is commenting lines, not blocks. */
const MAX_COMMENTS = 100;
/**
 * A comment explains ONE block — 8 000 characters is plenty. It also BOUNDS the review, which travels
 * as one base64 payload inside the script's heredoc (parsed by the host's bash and the container's):
 * at GitHub's own 65 536 per comment, 100 comments would be ~8.7 MB of base64 and blow the 60 s the
 * post gets; capped here, the worst case is ~1 MB, a few seconds.
 */
export const MAX_COMMENT_CHARS = 8_000;

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

/**
 * The markdown headings of a body, normalized. A line inside a fenced code block (``` or ~~~) is code —
 * a `# comment` in a bash sample is not a section. PURE.
 */
function headingsOf(body: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line)?.[1];
    if (heading !== undefined) out.push(normalizeHeading(heading));
  }
  return out;
}

/**
 * The sections of {@link PR_SECTIONS} that have no heading in `body`, by label. Each heading stands for
 * ONE section ("## Contexto e problema" is not both): a bipartite matching (augmenting paths), so an
 * ambiguous heading goes to the section that needs it — "## Problema e contexto" plus "## Contexto"
 * covers both, whichever comes first. Nine sections and a handful of headings: trivially cheap. PURE.
 */
export function missingPrSections(body: string): string[] {
  const headings = headingsOf(body);
  /** headingOwner[h] = the section heading h stands for. */
  const headingOwner: (number | undefined)[] = headings.map(() => undefined);
  const fits = (section: number, h: number) => PR_SECTIONS[section]!.match.some((m) => headings[h]!.includes(m));
  const assign = (section: number, tried: Set<number>): boolean => {
    for (let h = 0; h < headings.length; h++) {
      if (tried.has(h) || !fits(section, h)) continue;
      tried.add(h);
      const owner = headingOwner[h];
      if (owner === undefined || assign(owner, tried)) {
        headingOwner[h] = section;
        return true;
      }
    }
    return false;
  };
  return PR_SECTIONS.filter((_, section) => !assign(section, new Set())).map((s) => s.label);
}

/** Where a comment points, for messages. PURE. */
function where(c: { path: string; line: number }): string {
  return `${c.path || "?"}:${c.line}`;
}

/**
 * The first line of a block, or undefined for a one-line comment: 0 (what a client that fills numeric
 * defaults sends) and a value equal to `line` both mean "just this line". PURE.
 */
function blockStart(c: PrComment): number | undefined {
  return c.startLine === undefined || c.startLine === 0 || c.startLine === c.line ? undefined : c.startLine;
}

/** A comment's path as the diff names it: trimmed, a leading `./` (any number of them) dropped. PURE. */
function cleanPath(raw: unknown): string {
  return String(raw ?? "").trim().replace(/^(\.\/)+/, "");
}

/**
 * The problems with one comment; empty when it can be posted. The path must be the diff's own spelling
 * (`back/src/x.ts`): GitHub resolves nothing else, and refusing here costs no push. PURE.
 */
function commentProblems(c: PrComment, body: string): string[] {
  const out: string[] = [];
  const path = cleanPath(c.path);
  const segments = path.split("/");
  if (!path || path.startsWith("/") || path.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) {
    out.push(
      `comentário em "${String(c.path ?? "")}": path tem que ser o caminho do arquivo no diff, relativo à raiz ` +
        "(ex.: back/src/x.ts — sem / no início ou no fim, sem //, sem . ou .., sem barra invertida)",
    );
  }
  if (!Number.isInteger(c.line) || c.line < 1) out.push(`${where(c)}: line tem que ser um número de linha (inteiro ≥ 1)`);
  const start = blockStart(c);
  if (start !== undefined && (!Number.isInteger(start) || start < 1 || start > c.line)) {
    out.push(`${where(c)}: startLine tem que ser inteiro ≥ 1 e menor que line (ou ausente, num comentário de uma linha)`);
  }
  if (c.side !== undefined && c.side !== "RIGHT" && c.side !== "LEFT") out.push(`${where(c)}: side é RIGHT ou LEFT`);
  if (body.length < MIN_COMMENT_CHARS) {
    out.push(
      `${where(c)}: comentário raso (${body.length} caracteres, mínimo ${MIN_COMMENT_CHARS}) — explique o que mudou, ` +
        "por que, como funciona, a responsabilidade do trecho, o impacto e as regras envolvidas",
    );
  }
  if (body.length > MAX_COMMENT_CHARS) {
    out.push(`${where(c)}: comentário longo demais (${body.length} caracteres, máximo ${MAX_COMMENT_CHARS}) — um comentário explica UM bloco`);
  }
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
    const path = cleanPath(c.path);
    const key = `${path}\n${text}`;
    if (seen.has(key)) {
      clean.repeated = (clean.repeated ?? 0) + 1;
      continue;
    }
    seen.add(key);
    clean.comments.push({
      path, line: c.line, side: c.side ?? "RIGHT", body: text,
      ...(blockStart(c) !== undefined ? { startLine: blockStart(c) } : {}),
    });
  }

  return problems.length ? { ok: false, problems } : { ok: true, docs: clean };
}

/** A NEW pull request needs all three: title, a sectioned body and at least one comment on the diff. PURE. */
export function canOpenPr(docs: CleanPrDocs): boolean {
  return docs.title !== undefined && docs.body !== undefined && docs.comments.length > 0;
}

/** What a refused opening tells the agent: what is missing and the shape to send it in. PURE. */
export function undocumentedOutput(docs: CleanPrDocs): string {
  const missing = [
    docs.title === undefined ? "title" : null,
    docs.body === undefined ? "body" : null,
    docs.comments.length === 0 ? "comments" : null,
  ].filter(Boolean);
  return [
    `PR novo só abre documentado: falta ${missing.join(", ")}. O push foi feito; o PR NÃO foi aberto.`,
    "Chame o vibehub_deliver de novo com:",
    "- title: o título do PR;",
    `- body: markdown com as seções (headings) ${PR_SECTIONS.map((s) => s.label).join(", ")};`,
    "- comments: um comentário por bloco relevante do diff ({ path, line, body, side?, startLine? }), dizendo o que " +
      "mudou, por que, como funciona, a responsabilidade do trecho, o impacto e as regras envolvidas.",
  ].join("\n");
}

/** A comment already on the PR, as GitHub lists it. */
export interface PostedComment {
  path?: string;
  body?: string;
}

/**
 * The comments not yet on the PR. Same file and same text = already posted, wherever its line is now
 * (a later push moves lines; the explanation is the same). Makes a repeated delivery idempotent. PURE.
 */
export function freshComments(posted: PostedComment[], wanted: CleanComment[]): CleanComment[] {
  const have = new Set(posted.map((p) => `${String(p.path ?? "")}\n${String(p.body ?? "").trim()}`));
  return wanted.filter((c) => !have.has(`${c.path}\n${c.body}`));
}

/** The body of the review that carries the comments (GitHub wants one on a COMMENT review). */
const REVIEW_BODY = "Explicação trecho a trecho desta mudança, pelo autor: o que cada bloco faz, por que mudou e o impacto.";

/** The `POST /pulls/{n}/reviews` payload: one COMMENT review, pinned to the commit the lines refer to. PURE. */
export function reviewPayload(commitId: string, comments: CleanComment[]) {
  return {
    commit_id: commitId,
    event: "COMMENT" as const,
    body: REVIEW_BODY,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: c.side } : {}),
      body: c.body,
    })),
  };
}
