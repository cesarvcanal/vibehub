import { join } from "node:path";
import { lintChangedLines, findStrayMarkdown, findNewFilesOutsideBoardArea, findMisnamedFiles, findCommitsWithoutGitmoji } from "./lint/lintChanged.mjs";

const repoDir = join(import.meta.dirname, "..");
const baseRef = process.env.VIBEHUB_BASE_REF ?? "origin/main";
const skipsCommitTitles = process.argv.includes("--skip-commit-titles");
const lintResults = await lintChangedLines({ repoDir, baseRef });
const ruleViolations = [
  {
    rule: `markdown fora dos lugares previstos (AGENTS.md §15, "Onde cada coisa vive"); regra vai no AGENTS.md, e o resto fica fora do repositório`,
    items: findStrayMarkdown({ repoDir, baseRef }),
  },
  {
    rule: `arquivo novo em front/src/features/board/, que guarda só o board: colunas, card, projeto, seleção e deck (AGENTS.md §4, "Áreas: um nome nos dois pacotes"). Teste mental: "qual pasta de back/src/services/ atende isto?" O nome dela é a pasta do front, front/src/features/<área>/. Arquivo que é mesmo do board entra pelo caminho exato em APPROVED_BOARD_FILES (scripts/lint/lintChanged.mjs), no mesmo PR; o teste ao lado de um arquivo que já existe ali passa sem a lista`,
    items: findNewFilesOutsideBoardArea({ repoDir, baseRef }),
  },
  {
    rule: `arquivo novo com nome fora da convenção (AGENTS.md §2, "Idioma e nomenclatura"): camelCase.ts, ou PascalCase.tsx quando exporta componente; o teste é o nome do testado, que fica ao lado, mais .test, com sufixo de cenário opcional (cardSdk.lifecycle.test.ts). Ficam de fora front/src/components/ui/ (kebab-case do shadcn), *.d.ts e os idiomas de front/src/i18n/ (pt-BR.ts)`,
    items: findMisnamedFiles({ repoDir, baseRef }),
  },
  {
    rule: `commit da branch cujo título não abre com um emoji da tabela de Gitmoji seguido de espaço (AGENTS.md §14, "Commits"): <emoji> <tipo>(<area>): <título>. Commit ainda não enviado se corrige com git commit --amend ou rebase; enviado, reescrever é operação de risco (§12) e pede o aval do usuário`,
    items: skipsCommitTitles ? [] : findCommitsWithoutGitmoji({ repoDir, baseRef }),
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
