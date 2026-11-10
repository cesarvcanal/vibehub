import { describe, expect, it } from "vitest";
import type { Finding, Review } from "./model.js";
import { authorFixPrompt, authorSuggestionsPrompt, phaseNoticeText, reviewerApprovePrompt, reviewerRoundPrompt } from "./prompts.js";

function review(findings: Finding[] = []): Review {
  return {
    id: "r1", cardId: "c1", projectId: "p1", prNumber: 7, prUrl: "u", prBranch: "b", base: "main",
    reviewerUserId: "a", authorUserId: "b", mergerUserId: "c", reviewerCardId: "c2",
    round: 1, phase: "reviewing", findings, log: [], nudges: 0, createdAt: 0, updatedAt: 0,
  };
}

describe("prompts da revisão: achado explicado", () => {
  it("o revisor é instruído a mandar o problema e como resolver, não só o título", () => {
    const text = reviewerRoundPrompt(review());
    expect(text).toMatch(/title, problem,/);
    expect(text).toMatch(/- problem: o problema em português claro/);
    expect(text).toMatch(/- fix: como resolver/);
  });

  it("o autor recebe o problema e como resolver de cada sugestão pedida", () => {
    const f: Finding = {
      id: "f1", severity: "suggestion", title: "cache sem teto", status: "open", introducedInRound: 1,
      problem: "O mapa cresce sem limite.", fix: "Use um LRU de 500.",
    };
    const text = authorSuggestionsPrompt(review([f]), [f], { by: "cesar" });
    expect(text).toContain("problema: O mapa cresce sem limite.");
    expect(text).toContain("como resolver: Use um LRU de 500.");
  });

  it("problema e como resolver longos e em passos chegam inteiros, com as quebras indentadas sob o achado", () => {
    const fix = `1. Troque o Map por um LRU.\n2. Teste o teto.\n${"detalhe ".repeat(100)}`;
    const f: Finding = { id: "f1", severity: "suggestion", title: "t", status: "open", introducedInRound: 1, problem: "p", fix };
    const text = authorSuggestionsPrompt(review([f]), [f], { by: "cesar" });
    expect(text).toContain("como resolver: 1. Troque o Map por um LRU.\n      2. Teste o teto.");
    expect(text).toContain("detalhe ".repeat(100).trim());
  });

  it("a lista publicada no GitHub também leva o problema", () => {
    expect(reviewerRoundPrompt(review())).toMatch(/\(severidade, arquivo:linha, problema, prova, como resolver\)/);
  });

  it("achado antigo, sem problema, segue saindo sem a parte vazia", () => {
    const f: Finding = { id: "f1", severity: "suggestion", title: "t", status: "open", introducedInRound: 1 };
    expect(authorSuggestionsPrompt(review([f]), [f], { by: "cesar" })).not.toContain("problema:");
  });

  it("sugestão já pedida ao autor sai marcada no texto, com quem pediu", () => {
    const f: Finding = {
      id: "f1", severity: "suggestion", title: "t", status: "open", introducedInRound: 1, requested: { by: "mussa", at: 1 },
    };
    expect(authorSuggestionsPrompt(review([f]), [f], { by: "mussa" })).toContain("- f1 [suggestion, aberto, pedida ao autor por mussa] t");
  });
});

describe("autonomia corretiva: bug no que o PR fez se corrige, melhoria fora do escopo é sugestão", () => {
  const suggestion: Finding = { id: "f1", severity: "suggestion", title: "t", status: "open", introducedInRound: 1 };

  it("o revisor classifica bug ou incongruência no que o PR fez como bloqueante ou dúvida, nunca como sugestão", () => {
    const text = reviewerRoundPrompt(review());
    expect(text).toContain("Bug ou incongruência no que o PR fez não é sugestão");
    expect(text).toMatch(/fora do escopo do PR, volta desnecessária/);
  });

  it("o autor corrige sem perguntar o que é bug, não amplia escopo, e na dúvida de intenção explica em vez de aplicar", () => {
    for (const text of [
      authorFixPrompt(review([suggestion])),
      authorSuggestionsPrompt(review([suggestion]), [suggestion], { by: "cesar" }),
    ]) {
      expect(text).toContain("Bug ou incongruência no que o PR fez: corrija sem perguntar");
      expect(text).toContain("dúvida sobre a intenção");
    }
  });

  it("toda sugestão pedida precisa de resposta na mesma chamada", () => {
    const text = authorSuggestionsPrompt(review([suggestion]), [suggestion], { by: "cesar" });
    expect(text).toContain("Responda TODAS as sugestões pedidas");
  });
});

describe("merge autorizado com sugestão em pé: os textos não dizem 'nada em aberto'", () => {
  const suggestion: Finding = { id: "f1", severity: "suggestion", title: "renomear", status: "open", introducedInRound: 1 };
  const ready = (r: Partial<Review> = {}): Review => ({ ...review([suggestion]), phase: "ready", reviewedSha: "a".repeat(40), ...r });

  it("aviso de fase e prompt do Approve contam as sugestões que não seguram", () => {
    const r = ready({ mergeAuthorized: true });
    expect(phaseNoticeText(r)).toMatch(/merge autorizado por quem mergeia; 1 sugestão em aberto não segura/);
    expect(phaseNoticeText(r)).not.toMatch(/nada em aberto/);
    expect(reviewerApprovePrompt(r)).toMatch(/merge autorizado por quem mergeia; 1 sugestão em aberto não segura/);
  });

  it("sem sugestão em pé, o texto de sempre", () => {
    expect(phaseNoticeText({ ...ready({ mergeAuthorized: true }), findings: [] })).toMatch(/nada em aberto/);
  });
});
