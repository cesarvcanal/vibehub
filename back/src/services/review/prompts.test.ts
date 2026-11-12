import { describe, expect, it } from "vitest";
import type { Finding, Review } from "./model.js";
import {
  authorFixPrompt, authorSuggestionsPrompt, phaseNoticeText, reviewerApprovePrompt, reviewerDeltaPrompt, reviewerRoundPrompt,
} from "./prompts.js";

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
    expect(text).toMatch(/volta desnecessária, o que fica fora do escopo do PR/);
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

describe("prompts da revisão: o merge por ordem", () => {
  it("caso real (PR #215): autor e revisor sabem que, mandados mergear por quem tem papel, mergeiam pelo vibehub_deliver", () => {
    const ready = { ...review(), phase: "ready" as const, reviewedSha: "a".repeat(40) };
    for (const text of [authorFixPrompt(review()), reviewerRoundPrompt(review()), reviewerApprovePrompt(ready)]) {
      expect(text).toMatch(/Não mergeie o PR por conta própria/);
      expect(text).toMatch(/mandar mergear NESTE card, mergeie: chame vibehub_deliver com card e from = o \$VIBEHUB_CARD_ID/);
      expect(text).toMatch(/authorized: true/);
      expect(text).toMatch(/Nunca por `gh pr merge`/);
      expect(text).not.toMatch(/nada de vibehub_deliver|não chame vibehub_deliver/);
    }
  });
});

describe("prompts da revisão: tempo de cada rodada", () => {
  it("revisor e autor testam por recorte e deixam a suíte inteira com o CI", () => {
    const delta = { ...review(), round: 2, reviewedSha: "a".repeat(40) };
    for (const text of [reviewerRoundPrompt(review()), reviewerDeltaPrompt(delta), authorFixPrompt(review())]) {
      expect(text).toMatch(/rode só os testes do que o PR tocou/);
      expect(text).toMatch(/A suíte inteira é do CI: confira com `gh pr checks`/);
    }
  });

  it("palavra reservada na fala citada sai desarmada; branch, caminho e comandos do PR chegam intactos", () => {
    // Achado f1 da revisão do #264: desarmar o prompt inteiro trocava a branch do card e o push criava outra.
    const f: Finding = {
      id: "f1", severity: "blocking", title: "o ultracode some", status: "open", introducedInRound: 1,
      problem: "Sem o ULTRATHINK na barra.", fix: "Volte o ultracode em src/ultracode.ts.",
      proof: { kind: "failing_test", ref: "src/ultracode.test.ts:3", detail: "falha com ultrathink" },
      authorReply: "mantém o ultracode", reviewerReply: "o ultrathink segue",
    };
    const base = { ...review([f]), prBranch: "card/suporte-ultracode-ab12" };
    const delta = { ...base, round: 2, reviewedSha: "a".repeat(40) };
    for (const text of [reviewerDeltaPrompt(delta), authorFixPrompt(base)]) {
      expect(text).toContain("src/ultracode.test.ts:3");
      for (const piece of ["o ultra-code some", "Sem o ULTRA-THINK", "Volte o ultra-code em src/ultracode.ts", "falha com ultra-think",
        "mantém o ultra-code", "o ultra-think segue"]) expect(text).toContain(piece);
    }
    expect(reviewerDeltaPrompt(delta)).toContain("git reset --hard origin/card/suporte-ultracode-ab12");
    expect(authorFixPrompt(base)).toContain("git push origin HEAD:card/suporte-ultracode-ab12");
  });
});

describe("prompts da revisão: bug não é sugestão", () => {
  it("o revisor é instruído a bloquear bug real no escopo do PR (com cenário) e a deixar como sugestão só o que não é bug", () => {
    for (const text of [reviewerRoundPrompt(review()), authorFixPrompt(review())]) {
      expect(text).toMatch(/Bug no código deste PR \(comportamento errado, falha, quebra, brecha de segurança, perda de dado, regressão\) TEM essa prova: é bloqueante/);
      expect(text).toMatch(/Sugestão é só o que não é bug no escopo/);
    }
    const round = reviewerRoundPrompt(review());
    expect(round).toMatch(/- suggestion: SÓ o que não é bug no escopo do PR/);
    expect(round).toContain("blocking com proof.kind = scenario (ref = arquivo:linha, detail = o caso que dá errado)");
  });
});

describe("quem age em cada achado: revisor e autor leem as mesmas classes", () => {
  const improvement: Finding = {
    id: "f1", severity: "improvement", title: "tira a duplicação", status: "open", introducedInRound: 1, file: "src/a.ts", fix: "x",
  };

  it("o mesmo bloco de classes chega ao revisor (rodada e delta) e ao autor (correção e sugestões)", () => {
    const delta = { ...review([improvement]), round: 2, reviewedSha: "a".repeat(40) };
    const texts = [
      reviewerRoundPrompt(review()), reviewerDeltaPrompt(delta), authorFixPrompt(review([improvement])),
      authorSuggestionsPrompt(review([improvement]), [improvement], { by: "cesar" }),
    ];
    for (const text of texts) {
      expect(text).toContain("Autonomia técnica não é autonomia de produto");
      expect(text).toMatch(/- improvement — a IA do autor aplica sozinha/);
      expect(text).toMatch(/- question — espera a decisão de uma pessoa/);
    }
  });

  it("dúvida só para decisão de intenção ou produto, inclusive colisão com o que já funcionava; nunca como saída fácil", () => {
    const text = reviewerRoundPrompt(review());
    expect(text).toMatch(/mudar regra de negócio ou o comportamento esperado/);
    expect(text).toMatch(/altera algo que já funcionava sem deixar claro que era a intenção, ou pode colidir com uma funcionalidade existente/);
    expect(text).toMatch(/Dúvida não é saída fácil: erro comprovado com uma solução coerente com o que foi pedido é blocking/);
    expect(text).toMatch(/Os exemplos ilustram o critério; não são uma lista fechada/);
  });

  it("melhoria presa ao escopo: o revisor ancora no arquivo do PR e o autor não sai dele", () => {
    expect(reviewerRoundPrompt(review())).toMatch(/file obrigatório, num arquivo que o PR altera/);
    expect(reviewerRoundPrompt(review())).toContain('severity: "blocking" | "improvement" | "suggestion" | "question" | "refuted"');
    const text = authorFixPrompt(review([improvement]));
    expect(text).toMatch(/Melhorias autônomas \(aplique agora, sem esperar ninguém/);
    expect(text).toContain("- f1 [improvement, aberto] tira a duplicação (src/a.ts)");
    expect(text).toMatch(/só nos arquivos que o PR já altera/);
    expect(text).toMatch(/wontfix só em sugestão e melhoria/);
  });

  it("o autor decide como resolver, não o que o sistema faz", () => {
    expect(authorFixPrompt(review())).toMatch(/Você decide COMO resolver, não O QUE o sistema deve fazer/);
  });

  it("no delta o revisor confere a melhoria aplicada e trata como bug novo a que saiu do escopo", () => {
    const answered = { ...improvement, authorReply: "apliquei", commit: "abc" };
    const r: Review = {
      ...review([answered]), round: 2, reviewedSha: "a".repeat(40),
      log: [{ at: 1, round: 1, who: "author", text: "x", items: [{ id: "f1", status: "open" }] }],
    };
    const text = reviewerDeltaPrompt(r);
    expect(text).toMatch(/Melhorias que o autor respondeu/);
    expect(text).toContain("- f1 [improvement, aberto] tira a duplicação");
    expect(text).toMatch(/saiu do escopo do PR ou mudou comportamento: achado novo blocking com introducedInRound: 2/);
  });
});
