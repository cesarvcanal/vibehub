import { describe, expect, it } from "vitest";
import { classificarBranches, filtrarBranches } from "@/features/board/lib/branches";

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
