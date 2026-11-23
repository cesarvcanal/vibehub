import { join } from "node:path";
import { lintChangedLines, findStrayMarkdown, findNewFilesOutsideBoardArea } from "./lint/lintChanged.mjs";

const repoDir = join(import.meta.dirname, "..");
const baseRef = process.env.VIBEHUB_BASE_REF ?? "origin/main";
const lintResults = await lintChangedLines({ repoDir, baseRef });
const ruleViolations = [
  {
    rule: `markdown fora dos lugares previstos (AGENTS.md §15, "Onde cada coisa vive"); regra vai no AGENTS.md, e o resto fica fora do repositório`,
    items: findStrayMarkdown({ repoDir, baseRef }),
  },
  {
    rule: `arquivo novo em front/src/features/board/, que guarda só o board: colunas, card, projeto, seleção e deck (AGENTS.md §4, "Áreas: um nome nos dois pacotes"). Teste mental: "qual pasta de back/src/services/ atende isto?" O nome dela é a pasta do front, front/src/features/<área>/. Arquivo que é mesmo do board entra pelo caminho exato em APPROVED_BOARD_FILES (scripts/lint/lintChanged.mjs), no mesmo PR`,
    items: findNewFilesOutsideBoardArea({ repoDir, baseRef }),
  },
].filter((violation) => violation.items.length > 0);

if (lintResults.length === 0 && ruleViolations.length === 0) {
  console.log(`lint: nenhuma linha acrescentada desde ${baseRef} fere as regras do AGENTS.md`);
} else {
  process.exitCode = 1;
}
if (lintResults.length > 0) {
  const { ESLint } = await import("eslint");
  const formatter = await new ESLint({ cwd: repoDir }).loadFormatter("stylish");
  console.log(await formatter.format(lintResults));
}
ruleViolations.forEach(({ rule, items }) => {
  console.log(`lint: ${rule}:\n${items.map((item) => `  ${item}`).join("\n")}`);
});
