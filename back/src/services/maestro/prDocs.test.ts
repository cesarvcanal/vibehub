import { describe, it, expect } from "vitest";
import {
  validatePrDocs, missingPrSections, canOpenPr, undocumentedOutput, freshComments, reviewPayload,
  MIN_COMMENT_CHARS, MAX_COMMENT_CHARS, PR_SECTIONS,
} from "./prDocs.js";

/** A body with every section the standard asks for, as an agent following the tool would write it. */
const BODY = [
  "## Contexto", "O deliver abre PRs para os cards.",
  "## Problema identificado", "O corpo saía do --fill: só a lista de commits.",
  "## Objetivo", "Todo PR aberto pelo vibehub chega documentado.",
  "## Solução implementada", "O deliver recebe título, corpo e comentários.",
  "## Detalhamento técnico", "prDocs.ts valida; deliver.ts publica.",
  "## Comportamento esperado", "PR novo sem documentação não abre.",
  "## Impactos", "Quem entrega por outro card precisa pedir a ele.",
  "## Testes e validações", "Executado: vitest de prDocs e deliver.",
  "## Pontos de atenção", "A linha do comentário precisa estar no diff.",
].join("\n\n");

/** A comment that explains its block — long enough to say what, why and how. */
const EXPLAINED =
  "Este trecho troca o --fill pelo título e corpo que a IA escreveu: sem isso o PR saía só com a lista " +
  "de commits, e o revisor não tinha contexto nenhum do porquê da mudança.";

const COMMENT = { path: "back/src/x.ts", line: 10, body: EXPLAINED };

describe("missingPrSections — the description has every section of the standard", () => {
  it("a body with all the sections misses nothing", () => {
    expect(missingPrSections(BODY)).toEqual([]);
  });

  it("names exactly the sections that are not there", () => {
    const body = BODY.replace("## Impactos", "Impactos (sem heading)").replace("## Pontos de atenção", "");
    expect(missingPrSections(body)).toEqual(["Impactos", "Pontos de atenção"]);
  });

  it("accepts any heading level, numbering, bold, accents or their absence, and English headings", () => {
    const body = [
      "# 1. Contexto", "### **Problema**", "## Objetivo:", "## Solucao", "## Technical details",
      "## Expected behavior", "## Impact", "## Tests", "## Pontos de atencao",
    ].join("\n");
    expect(missingPrSections(body)).toEqual([]);
  });

  it("a section named only in a paragraph does not count: it has to be a heading", () => {
    const flat = PR_SECTIONS.map((s) => `${s.label}: algo`).join("\n");
    expect(missingPrSections(flat)).toEqual(PR_SECTIONS.map((s) => s.label));
  });

  it("one heading counts for ONE section: '## Contexto e problema' does not stand for both", () => {
    const body = BODY.replace("## Contexto", "## Contexto e problema").replace("## Problema identificado", "Problema (sem heading)");
    expect(missingPrSections(body)).toEqual(["Problema identificado"]);
  });

  it("an ambiguous heading goes where it is needed: '## Problema e contexto' + '## Contexto' covers both", () => {
    const body = BODY.replace("## Problema identificado", "## Problema e contexto");
    expect(missingPrSections(body)).toEqual([]);
    const reversed = BODY.replace("## Contexto", "## Problema e contexto").replace("## Problema identificado", "## Contexto");
    expect(missingPrSections(reversed)).toEqual([]);
  });

  it("a # line inside a fenced code block is code, not a heading (``` and ~~~)", () => {
    for (const fence of ["```", "~~~"]) {
      const body = BODY.replace("## Objetivo", `${fence}bash\n# Objetivo\n${fence}`);
      expect(missingPrSections(body), fence).toEqual(["Objetivo"]);
    }
    // after the fence closes, headings count again
    const after = BODY.replace("## Contexto", "```\n# nada\n```\n## Contexto");
    expect(missingPrSections(after)).toEqual([]);
  });

  it("an empty body misses everything", () => {
    expect(missingPrSections("")).toHaveLength(PR_SECTIONS.length);
  });
});

describe("validatePrDocs", () => {
  it("nothing given is valid and empty: an existing PR is reused untouched", () => {
    expect(validatePrDocs({})).toEqual({ ok: true, docs: { comments: [] } });
    expect(validatePrDocs(undefined)).toEqual({ ok: true, docs: { comments: [] } });
  });

  it("normalizes: trims, collapses the title to one line, defaults the side to RIGHT, drops repeated comments", () => {
    const v = validatePrDocs({
      title: "  feat(deliver):\n PR documentado  ",
      body: `\n${BODY}\n`,
      comments: [COMMENT, { ...COMMENT, body: `  ${EXPLAINED}  ` }, { ...COMMENT, path: "y.ts", side: "LEFT" }],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.docs.title).toBe("feat(deliver): PR documentado");
    expect(v.docs.body).toBe(BODY);
    expect(v.docs.comments).toEqual([
      { path: "back/src/x.ts", line: 10, side: "RIGHT", body: EXPLAINED },
      { path: "y.ts", line: 10, side: "LEFT", body: EXPLAINED },
    ]);
    // the repeated one is counted, not silently lost
    expect(v.docs.repeated).toBe(1);
  });

  it("a body without the sections is refused, naming what is missing", () => {
    const v = validatePrDocs({ title: "t", body: "## Contexto\nsó isso" });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems.join("\n")).toContain("Problema identificado");
    expect(v.problems.join("\n")).toContain("Pontos de atenção");
  });

  it("a shallow comment is refused — 'Adicionada validação' is exactly what the standard forbids", () => {
    const v = validatePrDocs({ comments: [{ ...COMMENT, body: "Adicionada validação para verificar os dados antes de continuar." }] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems[0]).toContain("back/src/x.ts:10");
    expect(v.problems[0]).toContain(String(MIN_COMMENT_CHARS));
  });

  it("refuses positions GitHub cannot resolve: absolute or escaping paths, line < 1, a range that ends before it starts", () => {
    const bad = [
      { ...COMMENT, path: "/etc/passwd" },
      { ...COMMENT, path: "../outside.ts" },
      { ...COMMENT, path: "" },
      { ...COMMENT, line: 0 },
      { ...COMMENT, line: 2.5 },
      { ...COMMENT, line: 5, startLine: 9 },
      { ...COMMENT, line: 5, startLine: -1 },
      { ...COMMENT, line: 5, startLine: 1.5 },
    ];
    for (const c of bad) expect(validatePrDocs({ comments: [c] }).ok, JSON.stringify(c)).toBe(false);
    expect(validatePrDocs({ comments: [{ ...COMMENT, line: 9, startLine: 5 }] }).ok).toBe(true);
  });

  it("a comment past MAX_COMMENT_CHARS is refused: the whole review travels in one script", () => {
    const at = (n: number) => validatePrDocs({ comments: [{ ...COMMENT, body: `${EXPLAINED} ${"x".repeat(n)}`.slice(0, n) }] });
    expect(at(MAX_COMMENT_CHARS).ok).toBe(true);
    const over = at(MAX_COMMENT_CHARS + 1);
    expect(over.ok).toBe(false);
    expect(!over.ok && over.problems[0]).toContain(String(MAX_COMMENT_CHARS));
  });

  it("startLine 0 (a client filling the default) or equal to line is a one-line comment, not an error", () => {
    for (const startLine of [0, 10]) {
      const v = validatePrDocs({ comments: [{ ...COMMENT, line: 10, startLine }] });
      expect(v.ok, String(startLine)).toBe(true);
      expect(v.ok && v.docs.comments[0], String(startLine)).not.toHaveProperty("startLine");
    }
  });

  it("a path GitHub would not resolve is refused before the push; a leading ./ is just dropped", () => {
    for (const path of ["x//y.ts", "back\\src\\x.ts", "a/./b.ts", "a/../b.ts", "src/", "./"]) {
      expect(validatePrDocs({ comments: [{ ...COMMENT, path }] }).ok, path).toBe(false);
    }
    const v = validatePrDocs({ comments: [{ ...COMMENT, path: "././back/src/x.ts" }] });
    expect(v.ok && v.docs.comments[0]!.path).toBe("back/src/x.ts");
  });

  it("a blank title or body counts as not sent (MCP clients fill optional fields with \"\"): an open PR is reused", () => {
    expect(validatePrDocs({ title: "   ", body: "", comments: [] })).toEqual({ ok: true, docs: { comments: [] } });
  });

  it("refuses sizes past GitHub's limits", () => {
    expect(validatePrDocs({ title: "x".repeat(257) }).ok).toBe(false);
    expect(validatePrDocs({ body: `${BODY}\n${"x".repeat(65_536)}` }).ok).toBe(false);
  });
});

describe("canOpenPr — a NEW pull request opens only fully documented", () => {
  const docs = (d: Parameters<typeof validatePrDocs>[0]) => {
    const v = validatePrDocs(d);
    if (!v.ok) throw new Error(v.problems.join("; "));
    return v.docs;
  };
  it("title, body and at least one comment: opens", () => {
    expect(canOpenPr(docs({ title: "t", body: BODY, comments: [COMMENT] }))).toBe(true);
  });
  it("any of the three missing: does not", () => {
    expect(canOpenPr(docs({ body: BODY, comments: [COMMENT] }))).toBe(false);
    expect(canOpenPr(docs({ title: "t", comments: [COMMENT] }))).toBe(false);
    expect(canOpenPr(docs({ title: "t", body: BODY }))).toBe(false);
  });
  it("the refusal names what is missing and how to send it", () => {
    const out = undocumentedOutput(docs({ title: "t", body: BODY }));
    expect(out).toContain("comments");
    expect(out).not.toMatch(/falta.*title/);
    expect(out).toContain("O push foi feito");
  });
});

describe("freshComments — a re-delivery does not post the same explanation twice", () => {
  const wanted = [
    { path: "a.ts", line: 3, side: "RIGHT" as const, body: EXPLAINED },
    { path: "b.ts", line: 8, side: "RIGHT" as const, body: EXPLAINED },
  ];
  it("skips what is already on the PR (same file and text, wherever the line moved to)", () => {
    expect(freshComments([{ path: "a.ts", body: `${EXPLAINED}\n` }], wanted)).toEqual([wanted[1]]);
  });
  it("the same text on ANOTHER file is still new", () => {
    expect(freshComments([{ path: "c.ts", body: EXPLAINED }], wanted)).toEqual(wanted);
  });
  it("a PR with no comments gets them all", () => {
    expect(freshComments([], wanted)).toEqual(wanted);
  });
});

describe("reviewPayload", () => {
  it("one COMMENT review pinned to the pushed commit, ranges as GitHub expects them", () => {
    const sha = "a".repeat(40);
    const p = reviewPayload(sha, [
      { path: "a.ts", line: 9, side: "RIGHT", body: EXPLAINED, startLine: 5 },
      { path: "b.ts", line: 2, side: "LEFT", body: EXPLAINED },
    ]);
    expect(p).toMatchObject({ commit_id: sha, event: "COMMENT" });
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.comments).toEqual([
      { path: "a.ts", line: 9, side: "RIGHT", start_line: 5, start_side: "RIGHT", body: EXPLAINED },
      { path: "b.ts", line: 2, side: "LEFT", body: EXPLAINED },
    ]);
  });
});
