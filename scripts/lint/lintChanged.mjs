import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
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
const NAMED_SOURCE_DIRS = ["back/src/", "front/src/"];
const CODE_EXTENSIONS = [...LINTED_EXTENSIONS, "js"];
const COMPONENT_EXTENSIONS = ["tsx", "jsx"];
const CODE_FILE_NAME = /^(?<stem>[A-Za-z][A-Za-z0-9]*)(?<suffixes>(?:\.[a-z][A-Za-z0-9]*)*)\.(?<extension>[a-z]+)$/;
const SHADCN_UI_DIR = "front/src/components/ui/";
const LOCALE_FILE = /^front\/src\/i18n\/[a-z]{2}(?:-[A-Z]{2})?\.ts$/;
const GITMOJI_TABLE_ROW = /^\| (?<emoji>\S+) \| `:[a-z0-9_-]+:` \|/gm;
const VARIATION_SELECTOR = "\u{FE0F}";

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

function listAddedFiles(repoDir, baseRef, ...pathspecs) {
  const base = git(repoDir, "merge-base", "HEAD", baseRef).trim();
  const committedOrStaged = git(repoDir, "diff", "-z", "--name-only", "--no-renames", "--diff-filter=A", base, "--", ...pathspecs);
  const untracked = git(repoDir, "ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspecs);
  return [...committedOrStaged.split("\0"), ...untracked.split("\0")].filter(Boolean).sort();
}

export function findNewFilesOutsideBoardArea({ repoDir, baseRef, approvedBoardFiles = APPROVED_BOARD_FILES }) {
  return listAddedFiles(repoDir, baseRef, BOARD_DIR).filter((path) => !approvedBoardFiles.includes(path));
}

function isNameExempt(path) {
  return path.startsWith(SHADCN_UI_DIR) || path.endsWith(".d.ts") || LOCALE_FILE.test(path);
}

function followsNamingConvention(path) {
  const fileName = basename(path);
  const nameParts = CODE_FILE_NAME.exec(fileName);
  if (!nameParts) return false;
  const { stem, suffixes, extension } = nameParts.groups;
  const isCamelCase = /^[a-z]/.test(stem);
  const isComponentFile = COMPONENT_EXTENSIONS.includes(extension);
  const isTestFile = suffixes.split(".").includes("test");
  return isCamelCase || isComponentFile || isTestFile;
}

export function findMisnamedFiles({ repoDir, baseRef }) {
  const addedCodeFiles = listAddedFiles(repoDir, baseRef, ...NAMED_SOURCE_DIRS).filter((path) =>
    CODE_EXTENSIONS.includes(extname(path).slice(1)),
  );
  return addedCodeFiles.filter((path) => !isNameExempt(path) && !followsNamingConvention(path));
}

function readGitmojis(repoDir) {
  const agentsRules = readFileSync(join(repoDir, "AGENTS.md"), "utf8");
  const gitmojis = [...agentsRules.matchAll(GITMOJI_TABLE_ROW)].map((row) => withoutVariationSelector(row.groups.emoji));
  if (gitmojis.length === 0) throw new Error("lint: a tabela de emojis dos commits (AGENTS.md §14) não foi encontrada no AGENTS.md");
  return gitmojis;
}

function withoutVariationSelector(text) {
  return text.replaceAll(VARIATION_SELECTOR, "");
}

export function findCommitsWithoutGitmoji({ repoDir, baseRef }) {
  const base = git(repoDir, "merge-base", "HEAD", baseRef).trim();
  const commitTitles = git(repoDir, "log", "-z", "--no-merges", "--reverse", "--format=%s", `${base}..HEAD`).split("\0").filter(Boolean);
  if (commitTitles.length === 0) return [];
  const gitmojis = readGitmojis(repoDir);
  return commitTitles.filter((title) => !gitmojis.some((gitmoji) => withoutVariationSelector(title).startsWith(`${gitmoji} `)));
}

export function findStrayMarkdown({ repoDir, baseRef }) {
  const base = git(repoDir, "merge-base", "HEAD", baseRef).trim();
  const addedMarkdown = git(repoDir, "diff", "-z", "--name-only", "--no-renames", "--diff-filter=A", base, "--", ":(glob)**/*.md")
    .split("\0")
    .filter(Boolean);
  return addedMarkdown.filter((path) => !ALLOWED_MARKDOWN.some((allowed) => allowed.test(path))).sort();
}
