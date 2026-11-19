import tseslint from "typescript-eslint";
import { noUnmarkedComment } from "./scripts/lint/noUnmarkedComment.mjs";
import { LINTED_EXTENSIONS } from "./scripts/lint/lintChanged.mjs";

const EMPTY_CATCH_CALLBACK =
  "CallExpression[callee.property.name='catch']" +
  ":not(AssignmentExpression:matches([left.name='queue'], [left.object.type='ThisExpression'][left.property.name='queue']) > CallExpression)" +
  ":not(MemberExpression[property.name='then'] > CallExpression:matches([callee.object.name='queue'], [callee.object.name='previous'], [callee.object.object.type='ThisExpression'][callee.object.property.name='queue']))" +
  " > :matches(ArrowFunctionExpression, FunctionExpression).arguments:matches(" +
  "[body.type='BlockStatement'][body.body.length=0], [body.type='Identifier'][body.name='undefined'], " +
  "[body.type='Literal'][body.raw='null'], [body.type='UnaryExpression'][body.operator='void'])";

const PRODUCTION_SYNTAX = [
  {
    selector: "VariableDeclaration[kind='let']",
    message:
      "AGENTS.md §3: só `const` nas linhas novas. Estado vivo (exceção fechada) leva `// eslint-disable-next-line no-restricted-syntax -- <motivo>`.",
  },
  {
    selector: "CatchClause > BlockStatement[body.length=0]",
    message:
      "AGENTS.md §9: catch vazio engole o erro, com ou sem comentário. Só em melhor esforço, com `// eslint-disable-next-line no-restricted-syntax -- <motivo>`.",
  },
  {
    selector: EMPTY_CATCH_CALLBACK,
    message:
      "AGENTS.md §9: catch vazio engole o erro. Só em melhor esforço, com `// eslint-disable-next-line no-restricted-syntax -- <motivo>`; a fila `queue = next.catch(() => undefined)` já é aceita.",
  },
];

const TEST_SYNTAX = [
  {
    selector:
      "CallExpression[callee.name='afterEach'] CallExpression[callee.property.name='splice'], " +
      "CallExpression[callee.name='afterEach'] AssignmentExpression[left.property.name='length']",
    message: "AGENTS.md §11: limpeza registrada por teste é `onTestFinished` do Vitest, não um array esvaziado no afterEach.",
  },
  {
    selector: "FunctionDeclaration[id.name=/^waitFor/], VariableDeclarator[id.name=/^waitFor/] > :function",
    message: "AGENTS.md §11: esperar uma condição é `vi.waitFor` do Vitest, não um laço à mão.",
  },
  {
    selector: "CallExpression[callee.property.name='then'][callee.object.callee.name='access']",
    message: "AGENTS.md §11: saber se um caminho existe é `existsSync` do Node, não `access().then(...)`.",
  },
];

export default tseslint.config(
  {
    files: [`**/*.{${LINTED_EXTENSIONS.join(",")}}`, "*.js"],
    ignores: ["**/dist/**"],
    extends: [tseslint.configs.base],
    plugins: { vibehub: { rules: { "no-unmarked-comment": noUnmarkedComment } } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-var": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-restricted-syntax": ["error", ...PRODUCTION_SYNTAX],
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description" }],
      "vibehub/no-unmarked-comment": "error",
    },
  },
  {
    files: ["**/*.test.{ts,tsx,mjs}", "back/src/testkit/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...PRODUCTION_SYNTAX, ...TEST_SYNTAX],
    },
  },
);
