import { describe, it, expect } from "vitest";
import { relative } from "node:path";
import { lintChangedLines, findStrayMarkdown } from "./lintChanged.mjs";
import { git, writeRepoFile, createRepoWithBase } from "./testRepo.mjs";

const LEGACY = "let legacy = 1;\nlegacy += 1;\nexport { legacy };\n";

function reportedLines(repoDir, results) {
  return results
    .flatMap((result) => result.messages.map((message) => `${relative(repoDir, result.filePath)}:${message.line} ${message.ruleId}`))
    .sort();
}

describe("lintChangedLines", () => {
  it("reprova só a linha que a branch acrescentou, não o legado do mesmo arquivo", async () => {
    const repoDir = createRepoWithBase({ "back/src/legacy.ts": LEGACY });
    writeRepoFile(repoDir, "back/src/legacy.ts", `${LEGACY}let added = 2;\nadded += 1;\nexport { added };\n`);
    git(repoDir, "commit", "-qam", "change");

    const results = await lintChangedLines({ repoDir, baseRef: "main" });

    expect(reportedLines(repoDir, results)).toEqual(["back/src/legacy.ts:4 no-restricted-syntax"]);
  });

  it("vale para o .mjs dos scripts e o .js de config da raiz", async () => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, "scripts/lint/tool.mjs", "var tool = 1;\nexport { tool };\n");
    writeRepoFile(repoDir, "vitest.config.js", "// narrating comment\nexport default {};\n");

    const results = await lintChangedLines({ repoDir, baseRef: "main" });

    expect(reportedLines(repoDir, results)).toEqual(["scripts/lint/tool.mjs:1 no-var", "vitest.config.js:1 vibehub/no-unmarked-comment"]);
  });

  it("vale também o que ainda não foi commitado, inclusive arquivo não rastreado", async () => {
    const repoDir = createRepoWithBase({ "front/src/legacy.ts": LEGACY });
    writeRepoFile(repoDir, "front/src/legacy.ts", `${LEGACY}// narrating comment\n`);
    writeRepoFile(repoDir, "front/src/features/New View.tsx", "export const View = (props: any) => <div>{props.x}</div>;\n");

    const results = await lintChangedLines({ repoDir, baseRef: "main" });

    expect(reportedLines(repoDir, results)).toEqual([
      "front/src/features/New View.tsx:1 @typescript-eslint/no-explicit-any",
      "front/src/legacy.ts:4 vibehub/no-unmarked-comment",
    ]);
  });

  it("nada mudado, arquivo apagado e arquivo fora do recorte não reprovam", async () => {
    const repoDir = createRepoWithBase({ "back/src/gone.ts": LEGACY, "back/src/kept.ts": LEGACY });
    git(repoDir, "rm", "-q", "back/src/gone.ts");
    writeRepoFile(repoDir, "back/src/services/review/workflow.js", "var outside = 1;\n");
    writeRepoFile(repoDir, "scripts/run.sh", "var=1\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-qm", "change");

    expect(await lintChangedLines({ repoDir, baseRef: "main" })).toEqual([]);
  });

  it.each(["diff.noprefix", "diff.mnemonicPrefix"])("%s no git de quem roda não esconde a linha nova", async (gitConfigKey) => {
    const repoDir = createRepoWithBase({ "back/src/legacy.ts": LEGACY });
    writeRepoFile(repoDir, "back/src/legacy.ts", `${LEGACY}var added = 2;\nexport { added };\n`);
    git(repoDir, "config", gitConfigKey, "true");

    const results = await lintChangedLines({ repoDir, baseRef: "main" });

    expect(reportedLines(repoDir, results)).toEqual(["back/src/legacy.ts:4 no-var"]);
  });

  it("diff acima de 1 MiB, o buffer padrão do execFileSync, ainda é lido e reprovado", async () => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, "back/src/big.ts", `export const big = "${"x".repeat(2 * 1024 * 1024)}";\nvar added = 1;\nexport { added };\n`);
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-qm", "change");

    const results = await lintChangedLines({ repoDir, baseRef: "main" });

    expect(reportedLines(repoDir, results)).toEqual(["back/src/big.ts:2 no-var"]);
  });

  it("erro de sintaxe reprova mesmo fora das linhas novas", async () => {
    const repoDir = createRepoWithBase({ "back/src/broken.ts": "export const broken = (;\n" });
    writeRepoFile(repoDir, "back/src/broken.ts", "export const broken = (;\nexport const added = 1;\n");

    const results = await lintChangedLines({ repoDir, baseRef: "main" });

    expect(results.flatMap((result) => result.messages.map((message) => ({ line: message.line, fatal: message.fatal })))).toEqual([
      { line: 1, fatal: true },
    ]);
  });

  it("base que não existe falha à vista em vez de passar verde", async () => {
    const repoDir = createRepoWithBase({ "back/src/legacy.ts": LEGACY });

    await expect(lintChangedLines({ repoDir, baseRef: "origin/nao-existe" })).rejects.toThrow(/merge-base/);
  });
});

describe("findStrayMarkdown", () => {
  it("markdown commitado fora dos lugares previstos é solto; os previstos passam", () => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    [
      "docs/notes.md",
      "docs/superpowers/plans/plan.md",
      "back/src/services/brain/personas/reviewer.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      "back/src/services/board/NOTES.md",
      ".claude/rules.md",
    ].forEach((path) => writeRepoFile(repoDir, path, "text\n"));
    git(repoDir, "add", "-f", ".");
    git(repoDir, "commit", "-qm", "docs");

    expect(findStrayMarkdown({ repoDir, baseRef: "main" })).toEqual([
      ".claude/rules.md",
      "CONTRIBUTING.md",
      "back/src/services/board/NOTES.md",
      "docs/superpowers/plans/plan.md",
    ]);
  });

  it("mover um markdown previsto para fora dos lugares previstos também é solto", () => {
    const repoDir = createRepoWithBase({ "docs/API.md": "api\n" });
    git(repoDir, "mv", "docs/API.md", "API.md");
    git(repoDir, "commit", "-qm", "move");

    expect(findStrayMarkdown({ repoDir, baseRef: "main" })).toEqual(["API.md"]);
  });

  it("markdown que não foi commitado, como o CLAUDE.local.md do card, não conta", () => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, "CLAUDE.local.md", "local\n");

    expect(findStrayMarkdown({ repoDir, baseRef: "main" })).toEqual([]);
  });
});
