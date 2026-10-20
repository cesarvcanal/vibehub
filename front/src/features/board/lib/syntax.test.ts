import { describe, expect, it } from "vitest";
import { highlightDiff, highlightLines, langFromPath, splitByMark, type SynToken } from "./syntax";

describe("langFromPath", () => {
  it("acha a gramática pela extensão, sem diferenciar caixa", () => {
    expect(langFromPath("front/src/App.tsx")).toBe("tsx");
    expect(langFromPath("back/src/index.ts")).toBe("typescript");
    expect(langFromPath("C:\\repo\\SERVER.JS")).toBe("javascript");
    expect(langFromPath("docker/Dockerfile")).toBe("dockerfile");
    expect(langFromPath("Dockerfile.prod")).toBe("dockerfile");
    expect(langFromPath("Dockerfile.test.ts")).toBe("typescript");
    expect(langFromPath("dockerfile-notas.md")).toBe("markdown");
  });

  it("devolve null sem extensão conhecida ou sem caminho", () => {
    expect(langFromPath("LICENSE")).toBeNull();
    expect(langFromPath("dados.xyz")).toBeNull();
    expect(langFromPath("")).toBeNull();
    expect(langFromPath(undefined)).toBeNull();
  });
});

describe("highlightDiff", () => {
  const rows = [
    { kind: "hunk" as const, text: "@@ -1,3 +1,3 @@" },
    { kind: "ctx" as const, text: "/* começo" },
    { kind: "del" as const, text: "   antigo */" },
    { kind: "add" as const, text: "   novo */" },
    { kind: "ctx" as const, text: "const x = 1;" },
  ];

  it("cada linha pega o token do seu lado; o cabeçalho fica sem token", async () => {
    const out = await highlightDiff(rows, "typescript");
    expect(out!.map((t) => t?.map((p) => p.text).join("") ?? null)).toEqual([null, "/* começo", "   antigo */", "   novo */", "const x = 1;"]);
  });

  it("colore como o arquivo inteiro: o comentário aberto no contexto continua nas linhas seguintes", async () => {
    const out = await highlightDiff(rows, "typescript");
    const comment = out![1]![0]!.dark;
    expect(out![2]![0]!.dark).toBe(comment);
    expect(out![3]![0]!.dark).toBe(comment);
    expect(out![4]![0]!.dark).not.toBe(comment);
  });

  it("um comentário aberto num trecho não vaza para o trecho seguinte", async () => {
    const out = await highlightDiff([
      { kind: "ctx", text: "/* aberto" },
      { kind: "hunk", text: "⋯" },
      { kind: "add", text: "const y = 2;" },
    ], "typescript");
    expect(out![2]![0]!.dark).not.toBe(out![0]![0]!.dark);
    expect(out![1]).toBeNull();
  });

  it("sem gramática, não colore", async () => {
    expect(await highlightDiff(rows, null)).toBeNull();
  });
});

describe("splitByMark", () => {
  const tokens: SynToken[] = [{ text: "const ", dark: "#1" }, { text: "valor", dark: "#2" }, { text: " = 1", dark: "#3" }];

  it("sem trecho alterado, devolve os tokens como estão", () => {
    expect(splitByMark(tokens, null).map((p) => [p.text, p.marked])).toEqual([["const ", false], ["valor", false], [" = 1", false]]);
  });

  it("corta os tokens na borda do trecho e mantém a cor de cada pedaço", () => {
    const out = splitByMark(tokens, [3, 9]);
    expect(out.map((p) => [p.text, p.marked, p.dark])).toEqual([
      ["con", false, "#1"], ["st ", true, "#1"], ["val", true, "#2"], ["or", false, "#2"], [" = 1", false, "#3"],
    ]);
    expect(out.map((p) => p.text).join("")).toBe("const valor = 1");
  });
});

describe("highlightLines", () => {
  it("dá cor diferente à palavra reservada, à função e à string, nos dois temas", async () => {
    const lines = await highlightLines('function soma(a) {\n  return "x";\n}', "typescript");
    expect(lines).toHaveLength(3);
    const color = (text: string) => lines!.flat().find((t) => t.text === text);
    expect(color("function")?.dark).toBeTruthy();
    expect(color("function")?.light).toBeTruthy();
    expect(color("soma")?.dark).not.toBe(color("function")?.dark);
    expect(lines![1]!.map((t) => t.text).join("")).toBe('  return "x";');
  });

  it("sem gramática ou com texto grande demais, não colore", async () => {
    expect(await highlightLines("qualquer", null)).toBeNull();
    expect(await highlightLines("qualquer", "cobol")).toBeNull();
    expect(await highlightLines("x".repeat(200_001), "typescript")).toBeNull();
  });
});
