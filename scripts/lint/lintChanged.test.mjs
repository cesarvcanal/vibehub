import { describe, it, expect } from "vitest";
import { relative } from "node:path";
import { lintChangedLines, findStrayMarkdown, findNewFilesOutsideBoardArea, findMisnamedFiles, findCommitsWithoutGitmoji } from "./lintChanged.mjs";
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

  it.each(["scripts/e2e/harness.mts", "scripts/tool.cts", "scripts/tool.cjs", "front/src/Legacy.jsx"])("vale também em %s", async (path) => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, path, "var added = 1;\nexport { added };\n");

    const results = await lintChangedLines({ repoDir, baseRef: "main" });

    expect(reportedLines(repoDir, results)).toEqual([`${path}:1 no-var`]);
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

  it("markdown solto removido com git rm, antes do commit, já não conta: o hook de commit libera a correção", () => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, "NOTES.md", "notes\n");
    git(repoDir, "add", "NOTES.md");
    git(repoDir, "commit", "-qm", "notes");
    git(repoDir, "rm", "-q", "NOTES.md");

    expect(findStrayMarkdown({ repoDir, baseRef: "main" })).toEqual([]);
  });

  it("markdown solto adicionado ao índice, antes do commit, já conta: o hook de commit barra o commit que o traria", () => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, "NOTES.md", "notes\n");
    git(repoDir, "add", "NOTES.md");

    expect(findStrayMarkdown({ repoDir, baseRef: "main" })).toEqual(["NOTES.md"]);
  });

  it("markdown que não foi commitado, como o CLAUDE.local.md do card, não conta", () => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, "CLAUDE.local.md", "local\n");

    expect(findStrayMarkdown({ repoDir, baseRef: "main" })).toEqual([]);
  });
});

describe("findNewFilesOutsideBoardArea", () => {
  it("arquivo novo em features/board reprova, commitado ou ainda não rastreado; o legado e o de outra área passam", () => {
    const repoDir = createRepoWithBase({ "front/src/features/board/components/Legacy.tsx": "legacy\n" });
    writeRepoFile(repoDir, "front/src/features/board/components/AgentTaskPanel.tsx", "panel\n");
    writeRepoFile(repoDir, "front/src/features/waits/lib/cardWait.ts", "wait\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-qm", "add");
    writeRepoFile(repoDir, "front/src/features/board/lib/cardWait.ts", "wait\n");
    writeRepoFile(repoDir, "front/src/features/board/components/Legacy.tsx", "legacy changed\n");

    expect(findNewFilesOutsideBoardArea({ repoDir, baseRef: "main" })).toEqual([
      "front/src/features/board/components/AgentTaskPanel.tsx",
      "front/src/features/board/lib/cardWait.ts",
    ]);
  });

  it("arquivo novo cujo caminho exato está na lista de aprovados do board passa", () => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, "front/src/features/board/components/DeckColumn.tsx", "deck\n");
    writeRepoFile(repoDir, "front/src/features/board/components/DeckRow.tsx", "row\n");

    const approvedBoardFiles = ["front/src/features/board/components/DeckColumn.tsx"];

    expect(findNewFilesOutsideBoardArea({ repoDir, baseRef: "main", approvedBoardFiles })).toEqual([
      "front/src/features/board/components/DeckRow.tsx",
    ]);
  });

  it("teste novo ao lado de um arquivo que já existe no board passa; teste sem o testado ao lado reprova", () => {
    const repoDir = createRepoWithBase({ "front/src/features/board/components/ReviewColumn.tsx": "legacy\n" });
    writeRepoFile(repoDir, "front/src/features/board/components/ReviewColumn.test.tsx", "test\n");
    writeRepoFile(repoDir, "front/src/features/board/components/ReviewColumn.merge.test.tsx", "test\n");
    writeRepoFile(repoDir, "front/src/features/board/components/FleetChat.test.tsx", "test\n");

    expect(findNewFilesOutsideBoardArea({ repoDir, baseRef: "main" })).toEqual([
      "front/src/features/board/components/FleetChat.test.tsx",
    ]);
  });
});

describe("findMisnamedFiles", () => {
  it.each([
    "back/src/services/sdk/cardSdk.ts",
    "back/src/services/sdk/cardSdk.lifecycle.test.ts",
    "back/src/runtime/sdkDriver.mjs",
    "front/src/features/sdk/components/SdkChatView.tsx",
    "front/src/features/sdk/components/SdkChatView.test.tsx",
    "front/src/features/sdk/components/SdkChatView.stories.tsx",
    "front/src/test/render.tsx",
    "front/src/components/ui/dropdown-menu.tsx",
    "front/src/types/vite-env.d.ts",
    "front/src/i18n/pt-PT.ts",
    "front/src/styles/app-theme.css",
    "scripts/lint-changed.mjs",
  ])("%s passa", (path) => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, path, "text\n");

    expect(findMisnamedFiles({ repoDir, baseRef: "main" })).toEqual([]);
  });

  it.each([
    "back/src/services/sdk/sdk-driver.mjs",
    "back/src/services/sdk/card_sdk.ts",
    "back/src/services/sdk/CardSdk.ts",
    "back/src/services/sdk/cardSdk.Lifecycle.test.ts",
    "front/src/features/sdk/components/sdk-chat-view.tsx",
    "front/src/features/sdk/lib/ContextUsage.mjs",
    "front/src/i18n/en_US.ts",
    "front/src/features/sdk/components/ui/drop-down.tsx",
    "front/src/features/sdk/components/SdkChatView.test.ts",
  ])("%s reprova", (path) => {
    const repoDir = createRepoWithBase({ "README.md": "base\n" });
    writeRepoFile(repoDir, path, "text\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-qm", "add");

    expect(findMisnamedFiles({ repoDir, baseRef: "main" })).toEqual([path]);
  });

  it("teste com o nome de um arquivo que já existe ao lado passa, mesmo com o nome dele fora da convenção", () => {
    const repoDir = createRepoWithBase({
      "back/src/runtime/sdk-driver.mjs": "legacy\n",
      "front/src/features/board/components/ProjectSidebar.tsx": "sidebar\n",
    });
    writeRepoFile(repoDir, "back/src/runtime/sdk-driver.resume.test.ts", "test\n");
    writeRepoFile(repoDir, "front/src/features/board/components/ProjectSidebar.test.ts", "test\n");

    expect(findMisnamedFiles({ repoDir, baseRef: "main" })).toEqual([]);
  });

  it("arquivo antigo fora do padrão que a branch só altera não conta", () => {
    const repoDir = createRepoWithBase({ "back/src/runtime/sdk-driver.mjs": "legacy\n" });
    writeRepoFile(repoDir, "back/src/runtime/sdk-driver.mjs", "legacy changed\n");

    expect(findMisnamedFiles({ repoDir, baseRef: "main" })).toEqual([]);
  });
});

const GITMOJI_TABLE = [
  "### Commits",
  "",
  "| Emoji | Código | Quando usar |",
  "|---|---|---|",
  "| ⚡️ | `:zap:` | Melhora a performance |",
  "| 🐛 | `:bug:` | Corrige um bug |",
  "| 🧑‍💻 | `:technologist:` | Melhora a experiência de quem desenvolve |",
  "| 🦖 | `:t-rex:` | Código que adiciona compatibilidade com versões anteriores |",
  "",
].join("\n");

function commitEmpty(repoDir, title) {
  git(repoDir, "commit", "-q", "--allow-empty", "-m", title);
}

describe("findCommitsWithoutGitmoji", () => {
  it("título sem emoji, com emoji fora da tabela ou colado no texto reprova; os da tabela passam, com ou sem o seletor de variação", () => {
    const repoDir = createRepoWithBase({ "AGENTS.md": GITMOJI_TABLE });
    [
      "🐛 fix(sdk): login novo vale",
      "⚡️ perf(board): menos docker exec",
      "⚡ perf(board): sem o seletor de variação",
      "🧑‍💻 chore(claude): hook novo",
      "🦖 fix(board): board.json antigo continua lido",
      "fix(sdk): sem emoji",
      "🎉 feat(board): emoji fora da tabela",
      "🐛fix(sdk): emoji colado",
    ].forEach((title) => commitEmpty(repoDir, title));

    expect(findCommitsWithoutGitmoji({ repoDir, baseRef: "main" })).toEqual([
      "fix(sdk): sem emoji",
      "🎉 feat(board): emoji fora da tabela",
      "🐛fix(sdk): emoji colado",
    ]);
  });

  it("commit de merge e commit anterior à base não contam", () => {
    const repoDir = createRepoWithBase({ "AGENTS.md": GITMOJI_TABLE });
    git(repoDir, "checkout", "-q", "-b", "side", "main");
    commitEmpty(repoDir, "🐛 fix(sdk): do lado");
    git(repoDir, "checkout", "-q", "card");
    git(repoDir, "merge", "-q", "--no-ff", "-m", "Merge branch 'side' into card", "side");

    expect(findCommitsWithoutGitmoji({ repoDir, baseRef: "main" })).toEqual([]);
  });

  it("emoji que a própria branch acrescenta à tabela ainda não vale: entra por PR antes de ser usado", () => {
    const repoDir = createRepoWithBase({ "AGENTS.md": GITMOJI_TABLE });
    writeRepoFile(repoDir, "AGENTS.md", `${GITMOJI_TABLE}| 🎉 | \`:tada:\` | Comemora |\n`);
    git(repoDir, "commit", "-qam", "🐛 fix(agents): emoji novo na tabela");
    commitEmpty(repoDir, "🎉 feat(board): usa o emoji novo");

    expect(findCommitsWithoutGitmoji({ repoDir, baseRef: "main" })).toEqual(["🎉 feat(board): usa o emoji novo"]);
  });

  it("AGENTS.md sem a tabela de emojis falha à vista em vez de passar verde", () => {
    const repoDir = createRepoWithBase({ "AGENTS.md": "# AGENTS.md\n" });
    commitEmpty(repoDir, "🐛 fix(sdk): login novo vale");

    expect(() => findCommitsWithoutGitmoji({ repoDir, baseRef: "main" })).toThrow(/tabela/);
  });
});
