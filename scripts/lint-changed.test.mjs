import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, writeRepoFile, createRepoWithBase } from "./lint/testRepo.mjs";

const LINT_FILES = [
  "scripts/lint-changed.mjs",
  "scripts/lint/addedLines.mjs",
  "scripts/lint/lintChanged.mjs",
  "scripts/lint/noUnmarkedComment.mjs",
  "eslint.config.js",
];

function createRepoWithLint() {
  const repoRoot = join(import.meta.dirname, "..");
  const lintFiles = Object.fromEntries(LINT_FILES.map((path) => [path, readFileSync(join(repoRoot, path), "utf8")]));
  return createRepoWithBase({ ...lintFiles, "README.md": "base\n" });
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
});
