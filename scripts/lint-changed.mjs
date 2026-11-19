import { join } from "node:path";
import { lintChangedLines, findStrayMarkdown } from "./lint/lintChanged.mjs";

const repoDir = join(import.meta.dirname, "..");
const baseRef = process.env.VIBEHUB_BASE_REF ?? "origin/main";
const results = await lintChangedLines({ repoDir, baseRef });
const strayMarkdown = findStrayMarkdown({ repoDir, baseRef });

if (results.length === 0 && strayMarkdown.length === 0) {
  console.log(`lint: nenhuma linha acrescentada desde ${baseRef} fere as regras do AGENTS.md`);
} else {
  process.exitCode = 1;
}
if (results.length > 0) {
  const { ESLint } = await import("eslint");
  const formatter = await new ESLint({ cwd: repoDir }).loadFormatter("stylish");
  console.log(await formatter.format(results));
}
if (strayMarkdown.length > 0) {
  console.log(
    `lint: markdown fora dos lugares previstos (AGENTS.md §15, "Onde cada coisa vive"); regra vai no AGENTS.md, e o resto fica fora do repositório:\n${strayMarkdown.map((path) => `  ${path}`).join("\n")}`,
  );
}
