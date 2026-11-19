import { describe, it, expect } from "vitest";
import { parseAddedLines } from "./addedLines.mjs";

const diffOf = (...sections) => sections.join("\n") + "\n";

describe("parseAddedLines", () => {
  it("guarda as linhas acrescentadas de cada hunk pelo caminho novo do arquivo", () => {
    const diff = diffOf(
      "diff --git a/back/src/a.ts b/back/src/a.ts",
      "--- a/back/src/a.ts",
      "+++ b/back/src/a.ts",
      "@@ -3,2 +3,3 @@ function x() {",
      "-old",
      "+new 3",
      "+new 4",
      "+new 5",
      "@@ -20 +21 @@",
      "-old",
      "+new 21",
    );

    expect(parseAddedLines(diff)).toEqual(new Map([["back/src/a.ts", new Set([3, 4, 5, 21])]]));
  });

  it("hunk só de remoção não marca linha nenhuma", () => {
    const diff = diffOf(
      "diff --git a/front/src/b.tsx b/front/src/b.tsx",
      "--- a/front/src/b.tsx",
      "+++ b/front/src/b.tsx",
      "@@ -7,2 +6,0 @@",
      "-gone",
      "-gone",
    );

    expect(parseAddedLines(diff)).toEqual(new Map([["front/src/b.tsx", new Set()]]));
  });

  it("arquivo novo, renomeado e apagado: vale o caminho novo, e o apagado não entra", () => {
    const diff = diffOf(
      "diff --git a/back/src/new.ts b/back/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/back/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "diff --git a/back/src/old name.ts b/back/src/new name.ts",
      "similarity index 90%",
      "rename from back/src/old name.ts",
      "rename to back/src/new name.ts",
      "--- a/back/src/old name.ts\t",
      "+++ b/back/src/new name.ts\t",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/back/src/gone.ts b/back/src/gone.ts",
      "deleted file mode 100644",
      "--- a/back/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    );

    expect(parseAddedLines(diff)).toEqual(
      new Map([
        ["back/src/new.ts", new Set([1, 2])],
        ["back/src/new name.ts", new Set([1])],
      ]),
    );
  });

  it("caminho que o git cita (aspas, barra invertida, tab) falha à vista em vez de sumir do recorte", () => {
    const diff = diffOf(
      'diff --git "a/back/src/a\\"b.ts" "b/back/src/a\\"b.ts"',
      'new file mode 100644',
      "--- /dev/null",
      '+++ "b/back/src/a\\"b.ts"',
      "@@ -0,0 +1 @@",
      "+let added = 1;",
    );

    expect(() => parseAddedLines(diff)).toThrow('+++ "b/back/src/a\\"b.ts"');
  });

  it("linha acrescentada que começa com ++ \" é conteúdo, não cabeçalho", () => {
    const diff = diffOf(
      "diff --git a/back/src/a.ts b/back/src/a.ts",
      "--- a/back/src/a.ts",
      "+++ b/back/src/a.ts",
      "@@ -1,0 +2 @@",
      '+++ "x";',
    );

    expect(parseAddedLines(diff)).toEqual(new Map([["back/src/a.ts", new Set([2])]]));
  });

  it("mudança só de modo, sem linha +++, não entra", () => {
    const diff = diffOf("diff --git a/scripts/run.mjs b/scripts/run.mjs", "old mode 100644", "new mode 100755");

    expect(parseAddedLines(diff)).toEqual(new Map());
  });

  it("diff vazio não tem arquivo nenhum", () => {
    expect(parseAddedLines("")).toEqual(new Map());
  });
});
