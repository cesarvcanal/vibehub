import { describe, it, expect, onTestFinished } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { lintChangedLines } from "./lintChanged.mjs";

function git(repoDir, ...args) {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: repoDir, encoding: "utf8" });
}

function writeRepoFile(repoDir, path, content) {
  mkdirSync(dirname(join(repoDir, path)), { recursive: true });
  writeFileSync(join(repoDir, path), content);
}

function createRepoWithBase(files) {
  const repoDir = mkdtempSync(join(tmpdir(), "lint-changed-"));
  onTestFinished(() => rmSync(repoDir, { recursive: true, force: true }));
  git(repoDir, "init", "-q", "-b", "main");
  Object.entries(files).forEach(([path, content]) => writeRepoFile(repoDir, path, content));
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "base");
  git(repoDir, "checkout", "-q", "-b", "card");
  return repoDir;
}

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
