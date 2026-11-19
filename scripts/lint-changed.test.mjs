import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git, writeRepoFile, createRepoWithBase } from "./lint/testRepo.mjs";

const LINT_FILES = [
  "scripts/lint-changed.mjs",
  "scripts/lint/addedLines.mjs",
  "scripts/lint/lintChanged.mjs",
  "scripts/lint/noUnmarkedComment.mjs",
  "eslint.config.js",
];

const REPO_ROOT = join(import.meta.dirname, "..");

function createRepoWithLint() {
  const lintFiles = Object.fromEntries(LINT_FILES.map((path) => [path, readFileSync(join(REPO_ROOT, path), "utf8")]));
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
    git(repoDir, "commit", "-qam", "docs");

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
});
