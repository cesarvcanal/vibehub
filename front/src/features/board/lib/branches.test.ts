import { describe, expect, it } from "vitest";
import { branchBaseSugerida, classificarBranches, filtrarBranches, isBranchName, newCardBranchIssue } from "@/features/board/lib/branches";

describe("classificarBranches", () => {
  it("destaca padrão, produção, main e dev nessa ordem; o resto vai em ordem alfabética", () => {
    const { destacadas, demais } = classificarBranches(["feat/z", "dev", "prod", "Fix/a", "main", "develop"], "dev");
    expect(destacadas).toEqual([
      { nome: "dev", destaque: "padrao" },
      { nome: "prod", destaque: "producao" },
      { nome: "main", destaque: "principal" },
      { nome: "develop", destaque: "desenvolvimento" },
    ]);
    expect(demais.map((b) => b.nome)).toEqual(["feat/z", "Fix/a"].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })));
  });

  it("sem branch padrão conhecida, nada ganha o selo de padrão", () => {
    const { destacadas } = classificarBranches(["main", "prod"], null);
    expect(destacadas.map((b) => b.destaque)).toEqual(["producao", "principal"]);
  });

  it("nome parecido não é destaque: prod-old e devtools ficam no resto", () => {
    const { destacadas, demais } = classificarBranches(["prod-old", "devtools"], "main");
    expect(destacadas).toEqual([]);
    expect(demais).toHaveLength(2);
  });

  it("lista vazia devolve dois grupos vazios", () => {
    expect(classificarBranches([], "main")).toEqual({ destacadas: [], demais: [] });
  });
});

describe("filtrarBranches", () => {
  const branches = [
    { nome: "feat/conciliação", destaque: null },
    { nome: "fix/caixa", destaque: null },
  ];

  it("ignora caixa e acento", () => {
    expect(filtrarBranches(branches, "CONCILIACAO").map((b) => b.nome)).toEqual(["feat/conciliação"]);
  });

  it("busca em branco devolve tudo", () => {
    expect(filtrarBranches(branches, "   ")).toHaveLength(2);
  });
});

describe("branchBaseSugerida", () => {
  it("prefere a de desenvolvimento, depois main/master, depois a padrão do repo", () => {
    expect(branchBaseSugerida(["main", "develop", "feat/x"], "main")).toBe("develop");
    expect(branchBaseSugerida(["master", "feat/x"], "feat/x")).toBe("master");
    expect(branchBaseSugerida(["trunk", "feat/x"], "trunk")).toBe("trunk");
  });

  it("staging e homolog não viram base sugerida: main ganha deles", () => {
    expect(branchBaseSugerida(["main", "homolog", "staging"], "main")).toBe("main");
    expect(branchBaseSugerida(["homolog", "feat/x"], "feat/x")).toBe("feat/x");
  });

  it("sem padrão conhecida cai na primeira; lista vazia não sugere nada", () => {
    expect(branchBaseSugerida(["feat/x"], null)).toBe("feat/x");
    expect(branchBaseSugerida([], null)).toBeUndefined();
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
