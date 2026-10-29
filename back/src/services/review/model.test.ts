import { describe, expect, it } from "vitest";
import {
  applyAuthorResponses,
  applyReviewerVerdicts,
  blockingOpen,
  normalizeSubmittedFindings,
  pendingQuestions,
  phaseAfterReviewerRound,
  type Finding,
  type Review,
} from "./model.js";

function finding(over: Partial<Finding> = {}): Finding {
  return { id: "f1", severity: "blocking", title: "t", status: "open", introducedInRound: 1, ...over };
}

function review(findings: Finding[], round = 1): Review {
  return {
    id: "r1", cardId: "c1", projectId: "p1", prNumber: 1, prUrl: "u", prBranch: "b", base: "dev",
    reviewerUserId: "a", authorUserId: "b", mergerUserId: "c", reviewerCardId: "c2",
    round, phase: "reviewing", findings, log: [], nudges: 0, createdAt: 0, updatedAt: 0,
  };
}

describe("normalizeSubmittedFindings", () => {
  it("bloqueante sem prova vira sugestão", () => {
    expect(normalizeSubmittedFindings([{ severity: "blocking", title: "x" }], 1, [])[0].severity).toBe("suggestion");
    const vazia = normalizeSubmittedFindings(
      [{ severity: "blocking", title: "x", proof: { kind: "rule", ref: "" } }], 1, []);
    expect(vazia[0].severity).toBe("suggestion");
    const ok = normalizeSubmittedFindings(
      [
        { severity: "blocking", title: "x", proof: { kind: "failing_test", ref: "a.test.ts:12" } },
        { severity: "blocking", title: "y", proof: { kind: "rule", ref: "CLAUDE.md#3" } },
      ], 1, []);
    expect(ok[0]).toMatchObject({ severity: "blocking", status: "open", introducedInRound: 1, id: "f1" });
    expect(ok[1].id).toBe("f2");
  });

  it("ids continuam depois dos já existentes", () => {
    const out = normalizeSubmittedFindings([{ severity: "suggestion", title: "n" }], 1, [finding(), finding({ id: "f2" })]);
    expect(out[0].id).toBe("f3");
  });

  it("rodada 2+ só aceita achado novo marcado como criado pela correção", () => {
    const proof = { kind: "scenario" as const, ref: "cenário X" };
    expect(() => normalizeSubmittedFindings([{ severity: "blocking", title: "n", proof }], 2, [finding()]))
      .toThrow(/lista fechada/);
    const out = normalizeSubmittedFindings(
      [{ severity: "blocking", title: "n", proof, introducedInRound: 2 }], 2, [finding()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "f2", introducedInRound: 2, severity: "blocking" });
  });

  it("campos do servidor enviados pela IA não chegam ao resultado", () => {
    const sujo = {
      severity: "question", title: "q", humanDecision: "keep", commit: "abc",
      authorReply: "x", reviewerReply: "y", status: "fixed", introducedInRound: 1,
    } as unknown as Parameters<typeof normalizeSubmittedFindings>[0][number];
    const [f] = normalizeSubmittedFindings([sujo], 1, []);
    expect(f).toEqual({ id: "f1", severity: "question", title: "q", status: "open", introducedInRound: 1 });
    expect(pendingQuestions([f]).map((x) => x.id)).toEqual(["f1"]);
  });

  it("copia file, line, proof e fix", () => {
    const proof = { kind: "rule" as const, ref: "r", detail: "d" };
    const [f] = normalizeSubmittedFindings(
      [{ severity: "blocking", title: "t", file: "a.ts", line: 3, proof, fix: "troque" }], 1, []);
    expect(f).toMatchObject({ file: "a.ts", line: 3, proof, fix: "troque", severity: "blocking" });
  });

  it("item com id já existente é pulado (é veredito, não achado novo)", () => {
    const out = normalizeSubmittedFindings(
      [{ id: "f1", severity: "suggestion", title: "de novo" }, { severity: "suggestion", title: "novo" }], 1, [finding()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "f2", title: "novo" });
  });

  it("id informado que não existe é regerado como f<n>", () => {
    const out = normalizeSubmittedFindings([{ id: "zzz", severity: "suggestion", title: "n" }], 1, [finding()]);
    expect(out[0].id).toBe("f2");
  });

  it("introducedInRound de outra rodada não vale como marca", () => {
    expect(() => normalizeSubmittedFindings([{ severity: "suggestion", title: "n", introducedInRound: 1 }], 2, []))
      .toThrow(/lista fechada/);
  });
});

describe("applyAuthorResponses", () => {
  it("autor contesta sem resposta é recusado", () => {
    const r = review([finding()]);
    expect(() => applyAuthorResponses(r, [{ id: "f1", status: "contested", reply: "" }])).toThrow();
    expect(() => applyAuthorResponses(r, [{ id: "f1", status: "contested", reply: "   " }])).toThrow();
  });
  it("aplica fix e contestação sem mutar a revisão", () => {
    const r = review([finding(), finding({ id: "f2" })]);
    const out = applyAuthorResponses(r, [
      { id: "f1", status: "fixed", commit: "abc", reply: "feito" },
      { id: "f2", status: "contested", reply: "não procede" },
    ]);
    expect(out[0]).toMatchObject({ status: "fixed", commit: "abc", authorReply: "feito" });
    expect(out[1]).toMatchObject({ status: "contested", authorReply: "não procede" });
    expect(r.findings[0].status).toBe("open");
  });
  it("id desconhecido lança", () => {
    expect(() => applyAuthorResponses(review([finding()]), [{ id: "zz", status: "fixed", reply: "x" }])).toThrow();
  });
});

describe("applyReviewerVerdicts", () => {
  it("atualiza status e resposta; id desconhecido lança", () => {
    const r = review([finding()], 2);
    const out = applyReviewerVerdicts(r, [{ id: "f1", status: "fixed", reviewerReply: "ok" }]);
    expect(out[0]).toMatchObject({ status: "fixed", reviewerReply: "ok" });
    expect(r.findings[0].status).toBe("open");
    expect(() => applyReviewerVerdicts(r, [{ id: "zz", status: "fixed" }])).toThrow();
  });
});

describe("phaseAfterReviewerRound", () => {
  it("ready só sem bloqueante aberto e sem dúvida pendente", () => {
    const done = [
      finding({ status: "fixed" }),
      finding({ id: "f2", status: "accepted_risk" }),
      finding({ id: "f3", status: "dropped" }),
      finding({ id: "f4", severity: "question", humanDecision: "keep" }),
    ];
    expect(phaseAfterReviewerRound(review(done)).phase).toBe("ready");
    expect(phaseAfterReviewerRound(review([finding()], 1)).phase).toBe("fixing");
    expect(phaseAfterReviewerRound(review([finding({ status: "contested" })], 2)).phase).toBe("fixing");
    expect(phaseAfterReviewerRound(review([finding()], 3))).toEqual({ phase: "impasse", impasseReason: "rodadas" });
    expect(phaseAfterReviewerRound(review([finding({ severity: "question" })], 1)).phase).toBe("reviewing");
  });
  it("dúvida pendente não gasta rodada nem ganha de bloqueante aberto", () => {
    const q = finding({ id: "f2", severity: "question" });
    expect(phaseAfterReviewerRound(review([finding(), q], 3))).toEqual({ phase: "impasse", impasseReason: "rodadas" });
    expect(phaseAfterReviewerRound(review([finding(), q], 1)).phase).toBe("fixing");
  });
  it("dúvida decidida como block segura; drop libera", () => {
    const blocked = finding({ severity: "question", humanDecision: "block" });
    expect(phaseAfterReviewerRound(review([blocked], 1)).phase).toBe("fixing");
    expect(phaseAfterReviewerRound(review([blocked], 3)).phase).toBe("impasse");
    expect(phaseAfterReviewerRound(review([finding({ severity: "question", humanDecision: "drop" })])).phase).toBe("ready");
  });
  it("sugestão nunca segura o ready", () => {
    const sug = [finding({ severity: "suggestion" }), finding({ id: "f2", severity: "suggestion" })];
    expect(phaseAfterReviewerRound(review(sug, 3)).phase).toBe("ready");
  });
  it("helpers", () => {
    const fs = [finding(), finding({ id: "f2", status: "contested" }), finding({ id: "f3", status: "fixed" }),
      finding({ id: "f4", severity: "question" }), finding({ id: "f5", severity: "question", humanDecision: "keep" })];
    expect(blockingOpen(fs).map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(pendingQuestions(fs).map((f) => f.id)).toEqual(["f4"]);
  });
});
