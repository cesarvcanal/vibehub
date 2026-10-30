import { describe, it, expect } from "vitest";
import { applyReportedProblems, reportedForReviewer, reportedSummary, REPORTED_MAX, type ReportedProblem } from "./reported.js";

const NOW = 1_000;

const fixed = { kind: "fixed" as const, title: "push recusado com stale info depois do merge", detail: "o lease comparava com um ref velho", commit: "046cd15" };
const outOfScope = { kind: "out_of_scope" as const, title: "teste de tempo instável no sdk-driver", detail: "falha também na main; fica para outro card" };

describe("applyReportedProblems — o que a IA do autor encontrou no trabalho", () => {
  it("numera os novos a1, a2… na ordem em que chegam", () => {
    const out = applyReportedProblems([], [fixed, outOfScope], NOW);
    expect(out.map((p) => [p.id, p.kind, p.title])).toEqual([
      ["a1", "fixed", fixed.title],
      ["a2", "out_of_scope", outOfScope.title],
    ]);
    expect(out[0]).toMatchObject({ commit: "046cd15", at: NOW });
    expect(out[1]?.commit).toBeUndefined();
  });

  it("continua a numeração de onde parou, mesmo com buraco", () => {
    const existing: ReportedProblem[] = [{ id: "a3", kind: "fixed", title: "x", detail: "y", commit: "abc", at: 1 }];
    expect(applyReportedProblems(existing, [outOfScope], NOW).map((p) => p.id)).toEqual(["a3", "a4"]);
  });

  it("com id, atualiza o item: o fora do escopo que acabou corrigido neste PR", () => {
    const first = applyReportedProblems([], [outOfScope], NOW);
    const out = applyReportedProblems(first, [{ id: "a1", kind: "fixed", title: outOfScope.title, detail: "corrigido afinal", commit: "3873715" }], NOW + 5);
    expect(out).toEqual([{ id: "a1", kind: "fixed", title: outOfScope.title, detail: "corrigido afinal", commit: "3873715", at: NOW + 5 }]);
  });

  it("o mesmo título de novo (chamada repetida) atualiza, não duplica — sem diferenciar maiúsculas nem espaços", () => {
    const first = applyReportedProblems([], [fixed], NOW);
    const out = applyReportedProblems(first, [{ ...fixed, title: `  ${fixed.title.toUpperCase()} ` }], NOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("a1");
  });

  it("corrigido exige o commit; título e detalhe são obrigatórios", () => {
    expect(() => applyReportedProblems([], [{ ...fixed, commit: undefined }], NOW)).toThrow(/commit/);
    expect(() => applyReportedProblems([], [{ ...fixed, commit: "  " }], NOW)).toThrow(/commit/);
    expect(() => applyReportedProblems([], [{ ...outOfScope, title: " " }], NOW)).toThrow(/título/);
    expect(() => applyReportedProblems([], [{ ...outOfScope, detail: "" }], NOW)).toThrow(/detalhe/);
  });

  it("fora do escopo não guarda commit (não há correção neste PR)", () => {
    const [p] = applyReportedProblems([], [{ ...outOfScope, commit: "abc1234" }], NOW);
    expect(p?.commit).toBeUndefined();
  });

  it("id desconhecido é erro, não item novo com id inventado", () => {
    expect(() => applyReportedProblems([], [{ ...fixed, id: "a9" }], NOW)).toThrow(/a9/);
  });

  it("título vira uma linha só; arquivo e linha vão junto quando vêm", () => {
    const [p] = applyReportedProblems([], [{ ...fixed, title: "linha um\nlinha   dois", file: "back/x.ts", line: 12 }], NOW);
    expect(p).toMatchObject({ title: "linha um linha dois", file: "back/x.ts", line: 12 });
  });

  it(`tem teto de ${REPORTED_MAX} por PR`, () => {
    const many = Array.from({ length: REPORTED_MAX }, (_, i) => ({ ...outOfScope, title: `p${i}` }));
    const full = applyReportedProblems([], many, NOW);
    expect(full).toHaveLength(REPORTED_MAX);
    expect(() => applyReportedProblems(full, [{ ...outOfScope, title: "mais um" }], NOW)).toThrow(/limite/);
    // atualizar um que já existe continua valendo com a lista cheia
    expect(applyReportedProblems(full, [{ ...outOfScope, title: "p0", detail: "novo detalhe" }], NOW)[0]?.detail).toBe("novo detalhe");
  });

  it("não muta a lista recebida", () => {
    const existing = applyReportedProblems([], [outOfScope], NOW);
    const snapshot = JSON.stringify(existing);
    applyReportedProblems(existing, [{ id: "a1", ...fixed }], NOW + 1);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

describe("reportedSummary — a fala do autor na conversa da revisão", () => {
  it("diz o que foi corrigido (com commit) e o que ficou fora do escopo", () => {
    const list = applyReportedProblems([], [fixed, outOfScope], NOW);
    expect(reportedSummary(list)).toBe(
      "Relatei 2 problemas que encontrei no trabalho, além do que o revisor apontou (aba Achados): " +
        `a1 corrigido neste PR (046cd15): ${fixed.title}; a2 fora do escopo: ${outOfScope.title}`,
    );
    expect(reportedSummary(list.slice(0, 1))).toMatch(/^Relatei 1 problema que encontrei/);
  });
});

describe("reportedForReviewer — o bloco do prompt do revisor", () => {
  it("vazio quando o autor não relatou nada", () => {
    expect(reportedForReviewer([])).toBe("");
  });

  it("lista cada relato com o detalhe, e diz o que conferir", () => {
    const text = reportedForReviewer(applyReportedProblems([], [fixed, { ...outOfScope, file: "back/x.ts", line: 9 }], NOW));
    expect(text).toContain("O autor relatou o que encontrou no trabalho");
    expect(text).toContain(`a1 corrigido neste PR (046cd15): ${fixed.title} — ${fixed.detail}`);
    expect(text).toContain(`a2 fora do escopo (back/x.ts:9): ${outOfScope.title} — ${outOfScope.detail}`);
    // não são achados do revisor: ele confere, não reabre como seus
    expect(text).toMatch(/não são achados seus/);
  });
});
