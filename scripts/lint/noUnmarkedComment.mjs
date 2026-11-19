const EXCEPTION_MARKERS = ["external:", "limitation:", "legacy-name:"];
const DIRECTIVE_NEEDING_REASON = /^eslint-disable(-next-line|-line)?\b/;
const DIRECTIVE_WITHOUT_REASON = [/^eslint-enable\b/, /^@ts-expect-error\b/, /^\/ <reference /, /^@vite-ignore$/];
const PLAIN_JS_FILE = /\.(mjs|cjs|js|jsx)$/;
const JSDOC_TYPE_TAG = /^@(param|returns?|type|typedef|property|template|callback|satisfies|import)\b/;

function isJsDocTypeBlock(comment) {
  if (comment.type !== "Block" || !comment.value.startsWith("*")) return false;
  const tagLines = comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*+\s?/, "").trim())
    .filter(Boolean);
  return tagLines.length > 0 && tagLines.every((line) => JSDOC_TYPE_TAG.test(line));
}

function classifyComment(comment, isPlainJs) {
  if (isPlainJs && isJsDocTypeBlock(comment)) return null;
  const text = comment.value.trim();
  if (DIRECTIVE_NEEDING_REASON.test(text)) return text.includes(" -- ") ? null : "directiveWithoutReason";
  if (DIRECTIVE_WITHOUT_REASON.some((directive) => directive.test(text))) return null;
  const marker = EXCEPTION_MARKERS.find((candidate) => text.startsWith(candidate));
  if (!marker) return "unmarked";
  if (text.slice(marker.length).trim() === "") return "emptyMarker";
  if (comment.loc.start.line !== comment.loc.end.line) return "multiline";
  return null;
}

export const noUnmarkedComment = {
  meta: {
    type: "suggestion",
    docs: { description: "Comentário novo só nas exceções da §3 do AGENTS.md, com marcador, como diretiva ou como tipo JSDoc num .mjs" },
    schema: [],
    messages: {
      unmarked:
        "AGENTS.md §3: o código se explica pelo nome; o porquê vai para o commit e o PR. Comentário só nas exceções, com marcador: `external:` (regra externa + referência), `limitation:` (limitação técnica) ou `legacy-name:` (nome legado que não pode mudar).",
      directiveWithoutReason: "AGENTS.md §3: diretiva de ferramenta sempre com o motivo: `eslint-disable-next-line <regra> -- <motivo>`.",
      emptyMarker: "AGENTS.md §3: o marcador de exceção precisa dizer a referência ou o motivo depois dos dois-pontos.",
      multiline: "AGENTS.md §3: a exceção cabe em uma linha.",
    },
  },
  create(context) {
    return {
      Program() {
        const isPlainJs = PLAIN_JS_FILE.test(context.filename);
        const reports = context.sourceCode
          .getAllComments()
          .filter((comment) => comment.type !== "Shebang")
          .map((comment) => ({ comment, messageId: classifyComment(comment, isPlainJs) }))
          .filter((classified) => classified.messageId !== null);
        reports.forEach(({ comment, messageId }) => context.report({ loc: comment.loc, messageId }));
      },
    };
  },
};
