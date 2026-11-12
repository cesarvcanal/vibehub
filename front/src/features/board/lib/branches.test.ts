import { describe, expect, it } from "vitest";
import { suggestedBaseBranch, rankBranches, filterBranches, isBranchName, newCardBranchIssue } from "@/features/board/lib/branches";

describe("rankBranches", () => {
  it("destaca padrão, produção, main e dev nessa ordem; o resto vai em ordem alfabética", () => {
    const { featured, others } = rankBranches(["feat/z", "dev", "prod", "Fix/a", "main", "develop"], "dev");
    expect(featured).toEqual([
      { name: "dev", highlight: "padrao" },
      { name: "prod", highlight: "producao" },
      { name: "main", highlight: "principal" },
      { name: "develop", highlight: "desenvolvimento" },
    ]);
    expect(others.map((b) => b.name)).toEqual(["feat/z", "Fix/a"].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })));
  });

  it("sem branch padrão conhecida, nada ganha o selo de padrão", () => {
    const { featured } = rankBranches(["main", "prod"], null);
    expect(featured.map((b) => b.highlight)).toEqual(["producao", "principal"]);
  });

  it("nome parecido não é destaque: prod-old e devtools ficam no resto", () => {
    const { featured, others } = rankBranches(["prod-old", "devtools"], "main");
    expect(featured).toEqual([]);
    expect(others).toHaveLength(2);
  });

  it("lista vazia devolve dois grupos vazios", () => {
    expect(rankBranches([], "main")).toEqual({ featured: [], others: [] });
  });
});

describe("filterBranches", () => {
  const branches = [
    { name: "feat/conciliação", highlight: null },
    { name: "fix/caixa", highlight: null },
  ];

  it("ignora caixa e acento", () => {
    expect(filterBranches(branches, "CONCILIACAO").map((b) => b.name)).toEqual(["feat/conciliação"]);
  });

  it("busca em branco devolve tudo", () => {
    expect(filterBranches(branches, "   ")).toHaveLength(2);
  });
});

describe("suggestedBaseBranch", () => {
  it("prefere a de desenvolvimento, depois main/master, depois a padrão do repo", () => {
    expect(suggestedBaseBranch(["main", "develop", "feat/x"], "main")).toBe("develop");
    expect(suggestedBaseBranch(["master", "feat/x"], "feat/x")).toBe("master");
    expect(suggestedBaseBranch(["trunk", "feat/x"], "trunk")).toBe("trunk");
  });

  it("staging e homolog não viram base sugerida: main ganha deles", () => {
    expect(suggestedBaseBranch(["main", "homolog", "staging"], "main")).toBe("main");
    expect(suggestedBaseBranch(["homolog", "feat/x"], "feat/x")).toBe("feat/x");
  });

  it("sem padrão conhecida cai na primeira; lista vazia não sugere nada", () => {
    expect(suggestedBaseBranch(["feat/x"], null)).toBe("feat/x");
    expect(suggestedBaseBranch([], null)).toBeUndefined();
  });
});

describe("isBranchName", () => {
  it("accepts what the server's assertBranchName accepts", () => {
    expect(isBranchName("feat/x-1.2")).toBe(true);
    expect(isBranchName("  dev  ")).toBe(true);
  });

  it("refuses empty, a leading dash, '..', spaces and names over 80 chars", () => {
    expect(isBranchName("   ")).toBe(false);
    expect(isBranchName("-x")).toBe(false);
    expect(isBranchName("a..b")).toBe(false);
    expect(isBranchName("a b")).toBe(false);
    expect(isBranchName("a".repeat(81))).toBe(false);
  });
});

describe("newCardBranchIssue", () => {
  it("no branch typed is no issue", () => {
    expect(newCardBranchIssue("  ", "dev", ["dev"])).toBeNull();
  });

  it("an invalid name wins over everything else", () => {
    expect(newCardBranchIssue("a..b", "a..b", ["a..b"])).toBe("invalid");
  });

  it("the base itself blocks, trimmed", () => {
    expect(newCardBranchIssue(" dev ", "dev", [])).toBe("isBase");
  });

  it("a branch that already exists only warns", () => {
    expect(newCardBranchIssue("feat/x ", "dev", ["feat/x"])).toBe("exists");
  });

  it("a new name, or no list to check against, is fine", () => {
    expect(newCardBranchIssue("feat/y", "dev", ["feat/x"])).toBeNull();
    expect(newCardBranchIssue("feat/y", "", undefined)).toBeNull();
  });
});
