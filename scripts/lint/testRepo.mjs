import { onTestFinished } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export function git(repoDir, ...args) {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: repoDir, encoding: "utf8" });
}

export function writeRepoFile(repoDir, path, content) {
  mkdirSync(dirname(join(repoDir, path)), { recursive: true });
  writeFileSync(join(repoDir, path), content);
}

export function createRepoWithBase(files) {
  const repoDir = mkdtempSync(join(tmpdir(), "lint-changed-"));
  onTestFinished(() => rmSync(repoDir, { recursive: true, force: true }));
  git(repoDir, "init", "-q", "-b", "main");
  Object.entries(files).forEach(([path, content]) => writeRepoFile(repoDir, path, content));
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "base");
  git(repoDir, "checkout", "-q", "-b", "card");
  return repoDir;
}
