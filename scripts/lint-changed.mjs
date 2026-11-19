import { join } from "node:path";
import { ESLint } from "eslint";
import { lintChangedLines } from "./lint/lintChanged.mjs";

const repoDir = join(import.meta.dirname, "..");
const baseRef = process.env.VIBEHUB_BASE_REF ?? "origin/main";
const results = await lintChangedLines({ repoDir, baseRef });

if (results.length === 0) {
  console.log(`lint: nenhuma linha acrescentada desde ${baseRef} fere as regras do AGENTS.md`);
} else {
  const formatter = await new ESLint({ cwd: repoDir }).loadFormatter("stylish");
  console.log(await formatter.format(results));
  process.exitCode = 1;
}
