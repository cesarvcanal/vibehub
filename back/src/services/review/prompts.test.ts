import { describe, expect, it } from "vitest";
import type { Finding, Review } from "./model.js";
import { authorFixPrompt, authorSuggestionsPrompt, reviewerDeltaPrompt, reviewerRoundPrompt } from "./prompts.js";
import { applyReportedProblems } from "./reported.js";

function finding(over: Partial<Finding> = {}): Finding {
  return { id: "f1", severity: "suggestion", title: "t", status: "open", introducedInRound: 1, ...over };
}

function review(over: Partial<Review> = {}): Review {
  return {
    id: "r1", cardId: "c1", projectId: "p1", prNumber: 7, prUrl: "u", prBranch: "card/x", base: "main",
    reviewerUserId: "a", authorUserId: "b", mergerUserId: "c", reviewerCardId: "c2",
    round: 1, phase: "reviewing", findings: [], log: [], nudges: 0, createdAt: 0, updatedAt: 0, ...over,
  };
}

const reported = applyReportedProblems([], [
  { kind: "fixed", title: "push recusado depois do merge", detail: "lease com ref velho", commit: "046cd15" },
  { kind: "out_of_scope", title: "teste instável no sdk-driver", detail: "falha também na main" },
], 1);

describe("prompts — o que o autor encontrou no trabalho", () => {
  it("o revisor recebe os relatos do autor na rodada 1 e no delta, para conferir os corrigidos", () => {
    for (const text of [reviewerRoundPrompt(review(), reported), reviewerDeltaPrompt(review({ round: 2, phase: "reviewing" }), reported)]) {
      expect(text).toContain("O autor relatou o que encontrou no trabalho");
      expect(text).toContain("a1 corrigido neste PR (046cd15): push recusado depois do merge — lease com ref velho");
      expect(text).toContain("a2 fora do escopo: teste instável no sdk-driver");
    }
  });

  it("sem relato, o prompt do revisor não ganha o bloco", () => {
    expect(reviewerRoundPrompt(review())).not.toContain("O autor relatou");
    expect(reviewerDeltaPrompt(review({ round: 2 }))).not.toContain("O autor relatou");
  });

  it("o autor é instruído a relatar com vibehub_pr_report, ao corrigir a lista e ao aplicar sugestões", () => {
    const fix = authorFixPrompt(review({ phase: "fixing", findings: [finding({ severity: "blocking" })] }));
    const suggestions = authorSuggestionsPrompt(review({ phase: "ready" }), [finding()], { by: "mussa" });
    for (const text of [fix, suggestions]) {
      expect(text).toContain("vibehub_pr_report");
      expect(text).toMatch(/não deixe só no chat/i);
    }
  });
});
