import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git, writeRepoFile, createRepoWithBase } from "./lint/testRepo.mjs";

const LINT_INPUT_FILES = [
  "scripts/lint-changed.mjs",
  "scripts/lint/addedLines.mjs",
  "scripts/lint/lintChanged.mjs",
  "scripts/lint/noUnmarkedComment.mjs",
  "eslint.config.js",
  "AGENTS.md",
];

const REPO_ROOT = join(import.meta.dirname, "..");

function createRepoWithLint() {
  const lintFiles = Object.fromEntries(LINT_INPUT_FILES.map((path) => [path, readFileSync(join(REPO_ROOT, path), "utf8")]));
  return createRepoWithBase({ ...lintFiles, "README.md": "base\n" });
}

function createRepoWithLintInstalled() {
  const repoDir = createRepoWithLint();
  symlinkSync(join(REPO_ROOT, "node_modules"), join(repoDir, "node_modules"));
  return repoDir;
}

function runLintChanged(repoDir) {
  return spawnSync(process.execPath, ["scripts/lint-changed.mjs"], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...process.env, VIBEHUB_BASE_REF: "main" },
  });
}

describe("npm run lint:changed", () => {
  it("branch só de documentação passa sem node_modules na raiz", () => {
    const repoDir = createRepoWithLint();
    writeRepoFile(repoDir, "README.md", "base\nmore docs\n");
    git(repoDir, "commit", "-qam", "📝 docs(readme): mais documentação");

    const run = runLintChanged(repoDir);

    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    expect(run.stdout).toContain("nenhuma linha acrescentada desde main");
  });

  it("linha nova que fere a regra sai 1, com a regra e a linha na saída", () => {
    const repoDir = createRepoWithLintInstalled();
    writeRepoFile(repoDir, "back/src/added.ts", "export const kept = 1;\nvar added = 2;\nexport { added };\n");

    const run = runLintChanged(repoDir);

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/back\/src\/added\.ts\n\s+2:1\s+error\s+.+\s+no-var/);
  });

  it("linha nova que segue as regras sai 0", () => {
    const repoDir = createRepoWithLintInstalled();
    writeRepoFile(repoDir, "back/src/added.ts", "export const added = 1;\n");

    const run = runLintChanged(repoDir);

    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    expect(run.stdout).toContain("nenhuma linha acrescentada desde main");
  });

  it("markdown solto commitado sai 1, com o caminho e a regra na saída", () => {
    const repoDir = createRepoWithLint();
    writeRepoFile(repoDir, "NOTES.md", "notes\n");
    git(repoDir, "add", "NOTES.md");
    git(repoDir, "commit", "-qm", "📝 docs: notas");

    const run = runLintChanged(repoDir);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("NOTES.md");
    expect(run.stdout).toContain("AGENTS.md §15");
  });

  it("arquivo novo em features/board sai 1, com o caminho, a regra e o teste mental na saída", () => {
    const repoDir = createRepoWithLintInstalled();
    writeRepoFile(repoDir, "front/src/features/board/components/FleetChat.tsx", "export const fleetChat = 1;\n");

    const run = runLintChanged(repoDir);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("front/src/features/board/components/FleetChat.tsx");
    expect(run.stdout).toContain("AGENTS.md §4");
    expect(run.stdout).toContain("qual pasta de back/src/services/ atende isto?");
  });

  it("arquivo novo com nome fora da convenção sai 1, com o caminho e a regra na saída", () => {
    const repoDir = createRepoWithLintInstalled();
    writeRepoFile(repoDir, "back/src/services/sdk/sdk-driver.ts", "export const sdkDriver = 1;\n");

    const run = runLintChanged(repoDir);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("back/src/services/sdk/sdk-driver.ts");
    expect(run.stdout).toContain("AGENTS.md §2");
  });

  it("commit da branch sem emoji da tabela sai 1, com o título e a regra na saída", () => {
    const repoDir = createRepoWithLint();
    writeRepoFile(repoDir, "README.md", "base\nmore docs\n");
    git(repoDir, "commit", "-qam", "docs: mais documentação");

    const run = runLintChanged(repoDir);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("docs: mais documentação");
    expect(run.stdout).toContain("AGENTS.md §14");
  });
});
