import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { parseAddedLines } from "./addedLines.mjs";

const CONFIG_FILE = join(import.meta.dirname, "..", "..", "eslint.config.js");
export const LINTED_EXTENSIONS = ["ts", "tsx", "mts", "cts", "mjs", "cjs", "jsx"];
const LINTED_PATHS = [...LINTED_EXTENSIONS.map((extension) => `:(glob)**/*.${extension}`), ":(glob)*.js"];
const EVERY_LINE = "every-line";
const ALLOWED_MARKDOWN = [
  /^AGENTS\.md$/,
  /^README\.md$/,
  /^SECURITY\.md$/,
  /^\.claude\/CLAUDE\.md$/,
  /^docs\/[^/]+\.md$/,
  /^back\/src\/services\/brain\/personas\/[^/]+\.md$/,
];
const BOARD_DIR = "front/src/features/board/";
const APPROVED_BOARD_FILES = [];

function git(repoDir, ...args) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: repoDir, encoding: "utf8", maxBuffer: Infinity });
}

function readChangedLines(repoDir, baseRef) {
  const base = git(repoDir, "merge-base", "HEAD", baseRef).trim();
  const diff = git(repoDir, "diff", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--diff-filter=d", base, "--", ...LINTED_PATHS);
  const untracked = git(repoDir, "ls-files", "-z", "--others", "--exclude-standard", "--", ...LINTED_PATHS)
    .split("\0")
    .filter(Boolean);
  return new Map([...parseAddedLines(diff), ...untracked.map((path) => [path, EVERY_LINE])]);
}

function keepChangedMessages(lintResult, changedLines) {
  const messages = lintResult.messages.filter(
    (message) => message.fatal || changedLines === EVERY_LINE || changedLines.has(message.line),
  );
  return {
    ...lintResult,
    messages,
    suppressedMessages: [],
    errorCount: messages.filter((message) => message.severity === 2).length,
    fatalErrorCount: messages.filter((message) => message.fatal).length,
    warningCount: messages.filter((message) => message.severity === 1).length,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
  };
}

export async function lintChangedLines({ repoDir, baseRef }) {
  const changedLinesByPath = readChangedLines(repoDir, baseRef);
  const pathsWithAddedLines = [...changedLinesByPath].filter(([, lines]) => lines === EVERY_LINE || lines.size > 0);
  if (pathsWithAddedLines.length === 0) return [];
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: repoDir, overrideConfigFile: CONFIG_FILE });
  const lintResults = await eslint.lintFiles(pathsWithAddedLines.map(([path]) => path));
  return lintResults
    .map((lintResult) => keepChangedMessages(lintResult, changedLinesByPath.get(relative(repoDir, lintResult.filePath))))
    .filter((lintResult) => lintResult.messages.length > 0);
}

function listAddedFiles(repoDir, baseRef, pathspec) {
  const base = git(repoDir, "merge-base", "HEAD", baseRef).trim();
  const committedOrStaged = git(repoDir, "diff", "-z", "--name-only", "--no-renames", "--diff-filter=A", base, "--", pathspec);
  const untracked = git(repoDir, "ls-files", "-z", "--others", "--exclude-standard", "--", pathspec);
  return [...committedOrStaged.split("\0"), ...untracked.split("\0")].filter(Boolean).sort();
}

export function findNewFilesOutsideBoardArea({ repoDir, baseRef, approvedBoardFiles = APPROVED_BOARD_FILES }) {
  return listAddedFiles(repoDir, baseRef, BOARD_DIR).filter((path) => !approvedBoardFiles.includes(path));
}

export function findStrayMarkdown({ repoDir, baseRef }) {
  const base = git(repoDir, "merge-base", "HEAD", baseRef).trim();
  const addedMarkdown = git(repoDir, "diff", "-z", "--name-only", "--no-renames", "--diff-filter=A", base, "--", ":(glob)**/*.md")
    .split("\0")
    .filter(Boolean);
  return addedMarkdown.filter((path) => !ALLOWED_MARKDOWN.some((allowed) => allowed.test(path))).sort();
}
